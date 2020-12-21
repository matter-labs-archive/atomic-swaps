import * as zksync from 'zksync';
import { pubKeyHash } from 'zksync-crypto';
import { ethers, utils } from 'ethers';
import { MusigSigner } from './signer';
import { SwapData, SchnorrData, Network } from './types';
import { transpose } from './utils';

export class SwapProvider {
    private signer: MusigSigner;
    private transactions: any[];
    private signatures: Uint8Array[];
    private swapData: SwapData;
    private schnorrData: SchnorrData;
    private pubKeyHash: Uint8Array;
    private swapAddress: string;
    private clientAddress: string;
    constructor(private privateKey: string, private publicKey: string, private syncWallet: zksync.Wallet) {}

    static async init(privateKey: string, network: Network) {
        const ethProvider =
            network == 'localhost'
                ? new ethers.providers.JsonRpcProvider('http://localhost:8545')
                : ethers.getDefaultProvider(network);

        const syncProvider = await zksync.getDefaultProvider(network, 'HTTP');
        const ethWallet = new ethers.Wallet(privateKey).connect(ethProvider);

        const syncWallet = await zksync.Wallet.fromEthSigner(ethWallet, syncProvider);
        return new SwapProvider(ethWallet.privateKey, ethWallet.publicKey, syncWallet);
    }

    getAddress() {
        return this.syncWallet.address();
    }

    getPubkey() {
        return this.publicKey;
    }

    async createSwap(data: SwapData, publicKey: string, checkBargain?: any) {
        if (checkBargain && !checkBargain(data.sell, data.buy)) {
            throw new Error('Swap is not profitable, alter token amounts');
        }
        this.signer = new MusigSigner([this.publicKey, publicKey], 0, 5);
        this.schnorrData.precommitments = this.signer.computePrecommitments();
        this.swapData = data;
        this.clientAddress = ethers.utils.computeAddress(publicKey);
        this.pubKeyHash = pubKeyHash(this.signer.computePubkey());
        this.swapAddress = ethers.utils.getCreate2Address(
            this.clientAddress,
            utils.keccak256(utils.concat([this.pubKeyHash, data.create2.salt])),
            data.create2.hash
        );
        return {
            publicKey: this.publicKey,
            precommitments: this.schnorrData.precommitments
        };
    }

    async getTransactions(data: SchnorrData, withdraw: 'L1' | 'L2' = 'L2') {
        this.schnorrData.commitments = this.signer.receivePrecommitments(
            transpose([this.schnorrData.precommitments, data.precommitments])
        );
        this.signer.receiveCommitments(transpose([this.schnorrData.commitments, data.commitments]));
        const swapAccount = await this.syncWallet.provider.getState(this.swapAddress);
        if (!swapAccount.id) {
            throw new Error("Swap Account ID not set - can't sign transactions");
        }
        const { totalFee: transferFee } = await this.syncWallet.provider.getTransactionFee(
            'Transfer',
            this.syncWallet.address(),
            this.swapData.sell.token
        );
        const { totalFee: cpkFee } = await this.syncWallet.provider.getTransactionFee(
            { ChangePubKey: { onchainPubkeyAuth: false } },
            this.syncWallet.address(),
            this.swapData.sell.token
        );
        const { totalFee: withdrawFee } = await this.syncWallet.provider.getTransactionFee(
            'Withdraw',
            this.syncWallet.address(),
            this.swapData.sell.token
        );
        const resolveTokenId = this.syncWallet.provider.tokenSet.resolveTokenId;
        this.transactions = [];
        this.transactions.push({
            accountId: swapAccount.id,
            account: swapAccount.address,
            newPkHash: this.pubKeyHash,
            nonce: 0,
            feeTokenId: resolveTokenId(this.swapData.sell.token),
            fee: cpkFee,
            changePubkeyType: {
                type: 'Create2Contract',
                creatorAddress: this.clientAddress,
                saltArg: this.swapData.create2.salt,
                codeHash: this.swapData.create2.hash
            }
        });
        // TODO: add timeouts
        this.transactions.push({
            type: 'Transfer',
            tokenId: resolveTokenId(this.swapData.buy.token),
            accoundId: swapAccount.id,
            from: swapAccount.address,
            to: this.clientAddress,
            amount: this.swapData.buy.amount,
            fee: transferFee,
            nonce: 1
        });

        if (withdraw == 'L1') {
            this.transactions.push({
                type: 'Withdraw',
                tokenId: resolveTokenId(this.swapData.sell.token),
                accoundId: swapAccount.id,
                from: swapAccount.address,
                ethAddress: this.syncWallet.address(),
                amount: this.swapData.sell.amount,
                fee: withdrawFee,
                nonce: 2
            });
        } else {
            this.transactions.push({
                type: 'Transfer',
                tokenId: resolveTokenId(this.swapData.sell.token),
                accoundId: swapAccount.id,
                from: swapAccount.address,
                to: this.syncWallet.address(),
                amount: this.swapData.sell.amount,
                fee: transferFee,
                nonce: 2
            });
        }

        this.transactions.push({
            type: 'Transfer',
            tokenId: resolveTokenId(this.swapData.sell.token),
            accoundId: swapAccount.id,
            from: swapAccount.address,
            to: this.clientAddress,
            amount: this.swapData.sell.amount,
            fee: transferFee,
            nonce: 3
        });
        this.transactions.push({
            type: 'Transfer',
            tokenId: resolveTokenId(this.swapData.buy.token),
            accoundId: swapAccount.id,
            from: swapAccount.address,
            to: this.syncWallet.address(),
            amount: 0,
            fee: transferFee,
            nonce: 4
        });

        const privateKey = utils.arrayify(this.privateKey);
        this.signatures = [];

        for (let i = 0; i < 5; i++) {
            const bytes =
                i == 0
                    ? this.syncWallet.signer.changePubKeySignBytes(this.transactions[i])
                    : this.syncWallet.signer.transferSignBytes(this.transactions[i]);
            this.signatures.push(this.signer.sign(privateKey, bytes, i));
        }
        return {
            commitments: this.schnorrData.commitments,
            signatures: this.signatures,
            transactions: this.transactions
        };
    }

    async finalize(signatureShares: Uint8Array[]) {
        const signatures = signatureShares.map((share, i) =>
            this.signer.receiveSignatureShares([this.signatures[i], share], i)
        );
        this.transactions.forEach((tx, i) => (tx.signature = signatures[i]));
        // TODO check that signatures are correct
        // check that client's funds are in place
        const swapAccount = await this.syncWallet.provider.getState(this.swapAddress);
        if (swapAccount.commited.balances[this.swapData.sell.token] < this.swapData.sell.amount) {
            throw new Error('Client did not deposit funds');
        }
        let hashes = [];
        for (const tx of this.transactions) {
            const transaction = await zksync.wallet.submitSignedTransaction({ tx }, this.syncWallet.provider);
            hashes.push(transaction.txHash);
        }
        return hashes;
    }
}
