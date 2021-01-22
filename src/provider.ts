import * as zksync from 'zksync';
import { pubKeyHash } from 'zksync-crypto';
import { ethers, utils } from 'ethers';
import { MusigSigner } from './signer';
import { SwapData, SchnorrData } from './types';
import { transpose, getSyncKeys, getSignBytes, getTransactions, TOTAL_TRANSACTIONS } from './utils';

const PROVIDER_NUMBER = 0;

export class SwapProvider {
    private signer: MusigSigner;
    private transactions: any[];
    private shares: Uint8Array[];
    private swapData: SwapData;
    private schnorrData: SchnorrData = {};
    private pubKeyHash: Uint8Array;
    private swapAddress: string;
    private clientAddress: string;
    constructor(private privateKey: string, private publicKey: string, private syncWallet: zksync.Wallet) {}

    static async init(privateKey: string, ethProvider: ethers.providers.Provider, syncProvider: zksync.Provider) {
        const ethWallet = new ethers.Wallet(privateKey).connect(ethProvider);
        const syncWallet = await zksync.Wallet.fromEthSigner(ethWallet, syncProvider);
        const { privkey, pubkey } = await getSyncKeys(ethWallet);
        return new SwapProvider(utils.hexlify(privkey), utils.hexlify(pubkey), syncWallet);
    }

    address() {
        return this.syncWallet.address();
    }

    pubkey() {
        return this.publicKey;
    }

    async prepareSwap(data: SwapData, publicKey: string, clientAddress: string) {
        this.signer = new MusigSigner([this.publicKey, publicKey], PROVIDER_NUMBER, TOTAL_TRANSACTIONS);
        this.schnorrData.precommitments = this.signer.computePrecommitments();
        this.swapData = data;
        this.clientAddress = clientAddress;
        this.pubKeyHash = pubKeyHash(this.signer.computePubkey());
        this.swapAddress = zksync.utils.getCREATE2AddressAndSalt(utils.hexlify(this.pubKeyHash), {
            creatorAddress: this.clientAddress,
            saltArg: data.create2.salt,
            codeHash: data.create2.hash
        }).address;
        return {
            publicKey: this.publicKey,
            address: this.address(),
            precommitments: this.schnorrData.precommitments
        };
    }

    async signSwap(data: SchnorrData) {
        this.schnorrData.commitments = this.signer.receivePrecommitments(
            transpose([this.schnorrData.precommitments, data.precommitments])
        );
        this.signer.receiveCommitments(transpose([this.schnorrData.commitments, data.commitments]));
        this.transactions = await getTransactions(
            this.swapData,
            this.clientAddress,
            this.address(),
            this.swapAddress,
            this.pubKeyHash,
            this.syncWallet.provider
        );
        const privateKey = utils.arrayify(this.privateKey);
        this.shares = [];
        this.transactions.forEach((tx, i) => {
            const bytes = getSignBytes(tx, this.syncWallet.signer);
            this.shares.push(this.signer.sign(privateKey, bytes, i));
        });

        return {
            commitments: this.schnorrData.commitments,
            shares: this.shares
        };
    }

    async checkSwap(signatureShares: Uint8Array[]) {
        let signatures = signatureShares.map((share, i) => {
            const signature = this.signer.receiveSignatureShares([this.shares[i], share], i);
            const bytes = getSignBytes(this.transactions[i], this.syncWallet.signer);
            if (!this.signer.verify(bytes, signature)) {
                throw new Error('Provided signature shares were invalid');
            }
            return {
                pubKey: utils.hexlify(this.signer.computePubkey()).substr(2),
                signature: utils.hexlify(signature).substr(2)
            };
        });
        this.transactions.forEach((tx, i) => {
            tx.signature = signatures[i];
            tx.feeToken = tx.feeTokenId;
            tx.token = tx.tokenId;
            if (tx.amount) {
                tx.amount = ethers.BigNumber.from(tx.amount).toString();
            }
            tx.fee = ethers.BigNumber.from(tx.fee).toString();
        });
        const swapAccount = await this.syncWallet.provider.getState(this.swapAddress);
        const necessaryDeposit = this.swapData.sell.amount.add(this.transactions[0].fee).add(this.transactions[2].fee);
        if (swapAccount.committed.balances[this.swapData.sell.token] < necessaryDeposit) {
            throw new Error('Client did not deposit funds');
        }
    }

    async depositFunds() {
        const handle = await this.syncWallet.syncTransfer({
            to: this.swapAddress,
            amount: this.swapData.buy.amount.add(this.transactions[1].fee),
            token: this.swapData.buy.token
        });
        await handle.awaitReceipt();
    }

    async finalizeSwap() {
        for (const tx of this.transactions.slice(0, 3)) {
            const handle = await zksync.wallet.submitSignedTransaction({ tx }, this.syncWallet.provider);
            await handle.awaitReceipt();
        }
    }
}
