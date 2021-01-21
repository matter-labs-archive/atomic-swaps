import * as zksync from 'zksync';
import { pubKeyHash, rescueHashTx } from 'zksync-crypto';
import { ethers, utils } from 'ethers';
import { MusigSigner } from './signer';
import { SwapData, Network } from './types';
import { transpose, getSyncKeys } from './utils';

export class Swap {
    constructor(
        public data: SwapData,
        public address: string,
        public finishTx: zksync.types.Transfer,
        public cancelTx: zksync.types.Transfer,
        private provider: zksync.Provider
    ) {

    }

    async finish() {
        const handle = await zksync.wallet.submitSignedTransaction({ tx: this.finishTx }, this.provider);
        await handle.awaitReceipt();
        return handle.txHash;
    }

    async cancel() {
        const handle = await zksync.wallet.submitSignedTransaction({ tx: this.cancelTx }, this.provider);
        await handle.awaitReceipt();
        return handle.txHash;
    }

    async wait(hash: string) {
        return await this.provider.notifyTransaction(hash, 'COMMIT');
    }
}

export class SwapClient {
    private signer: MusigSigner;
    private commitments: Uint8Array[];
    private swapData: SwapData;
    private swapAddress: string;
    private pubKeyHash: Uint8Array;
    constructor(private privateKey: string, private publicKey: string, private syncWallet: zksync.Wallet) {}

    static async init(privateKey: string, network: Network) {
        const ethProvider =
            network == 'localhost'
                ? new ethers.providers.JsonRpcProvider('http://localhost:8545')
                : ethers.getDefaultProvider(network);

        const syncProvider = await zksync.getDefaultProvider(network, 'HTTP');
        const ethWallet = new ethers.Wallet(privateKey).connect(ethProvider);
        const syncWallet = await zksync.Wallet.fromEthSigner(ethWallet, syncProvider);
        const { privkey, pubkey } = await getSyncKeys(ethWallet);
        return new SwapClient(utils.hexlify(privkey), utils.hexlify(pubkey), syncWallet);
    }

    getPubkey() {
        return this.publicKey;
    }

    getAddress() {
        return this.syncWallet.address();
    }

    async prepareSwap(data: SwapData, providerPubkey: string, providerPrecommitments: Uint8Array[]) {
        this.swapData = data;
        this.signer = new MusigSigner([providerPubkey, this.publicKey], 1, 5);
        const precommitments = this.signer.computePrecommitments();
        this.commitments = this.signer.receivePrecommitments(transpose([providerPrecommitments, precommitments]));
        this.pubKeyHash = pubKeyHash(this.signer.computePubkey());
        this.swapAddress = zksync.utils.getCREATE2AddressAndSalt(
            utils.hexlify(this.pubKeyHash),
            {
                creatorAddress: this.syncWallet.address(),
                saltArg: data.create2.salt,
                codeHash: data.create2.hash
            }
        ).address;
        const swapAccount = await this.syncWallet.provider.getState(this.swapAddress);
        if (!swapAccount.id) {
            const tx = await this.syncWallet.syncTransfer({
                to: this.swapAddress,
                token: data.sell.token,
                amount: 0
            });
            await tx.awaitReceipt();
        }
        return {
            precommitments,
            commitments: this.commitments
        };
    }

    async createSwap(data: {
        commitments: Uint8Array[];
        signatures: Uint8Array[];
        transactions: any[];
    }) {
        // TODO check that transactions are correct before we sign them
        this.signer.receiveCommitments(transpose([data.commitments, this.commitments]));
        let signatures = [];
        let shares = [];
        for (let i = 0; i < 5; i++) {
            let bytes: Uint8Array;
            if (data.transactions[i].type == 'Transfer') {
                bytes = this.syncWallet.signer.transferSignBytes(data.transactions[i], 'contracts-4');
            } else if (data.transactions[i].type == 'Withdraw') {
                bytes = this.syncWallet.signer.withdrawSignBytes(data.transactions[i], 'contracts-4');
            } else if (data.transactions[i].type = 'ChangePubKey') {
                bytes = this.syncWallet.signer.changePubKeySignBytes(data.transactions[i], 'contracts-4')
            }
            const share = this.signer.sign(this.privateKey, bytes, i);
            const signature = this.signer.receiveSignatureShares([data.signatures[i], share], i); 
            shares.push(share);
            signatures.push(signature);
            if (!this.signer.verify(bytes, signature)) {
                throw new Error('Provided signature shares were invalid');
            }
        }
        data.transactions.forEach((tx, i) => { 
            tx.signature = signatures[i];
            tx.feeToken = tx.feeTokenId;
            tx.token = tx.tokenId;
            if (tx.amount) {
                tx.amount = ethers.BigNumber.from(tx.amount).toString();
            }
            tx.fee = ethers.BigNumber.from(tx.fee).toString();
        });
        const transfer = await this.syncWallet.syncTransfer({
            to: this.swapAddress,
            amount: this.swapData.sell.amount.add(data.transactions[0].fee).add(data.transactions[2].fee),
            token: this.swapData.sell.token
        });
        await transfer.awaitReceipt();
        console.log('client deposited funds');
        const swap = new Swap(
            this.swapData,
            this.swapAddress,
            data.transactions[1],
            data.transactions[3],
            this.syncWallet.provider
        );
        return { swap, signatures: shares };
    }
}
