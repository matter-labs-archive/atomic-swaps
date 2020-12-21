import * as zksync from 'zksync';
import { pubKeyHash } from 'zksync-crypto';
import { ethers, utils } from 'ethers';
import { MusigSigner } from './signer';
import { SwapData, Network } from './types';
import { transpose } from './utils';

export class Swap {
    constructor(
        public data: SwapData,
        public address: string,
        public finishTx: zksync.types.Transfer,
        public cancelTx: zksync.types.Transfer,
        private provider: zksync.Provider
    ) {}

    async finish() {
        const receipt = await zksync.wallet.submitSignedTransaction({ tx: this.finishTx }, this.provider);
        await receipt.awaitReceipt();
        return receipt.txHash;
    }

    async cancel() {
        const receipt = await zksync.wallet.submitSignedTransaction({ tx: this.cancelTx }, this.provider);
        await receipt.awaitReceipt();
        return receipt.txHash;
    }

    async wait(hash: string) {
        return await this.provider.notifyTransaction(hash, 'COMMIT');
    }
}

export class SwapClient {
    private signer: MusigSigner;
    private signatures: Uint8Array[];
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
        return new SwapClient(ethWallet.privateKey, ethWallet.publicKey, syncWallet);
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
        this.swapAddress = ethers.utils.getCreate2Address(
            this.syncWallet.address(),
            utils.keccak256(utils.concat([this.pubKeyHash, data.create2.salt])),
            data.create2.hash
        );
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
        for (let i = 0; i < 5; i++) {
            const bytes =
                i == 0
                    ? this.syncWallet.signer.changePubKeySignBytes(data.transactions[i])
                    : this.syncWallet.signer.transferSignBytes(data.transactions[i]);
            this.signatures.push(this.signer.sign(this.privateKey, bytes, i));
        }
        const signatures = this.signatures.map((share, i) =>
            this.signer.receiveSignatureShares([data.signatures[i], share], i)
        );
        data.transactions.forEach((tx, i) => (tx.signature = signatures[i]));
        // TODO check that signatures are correct before we transfer funds
        this.syncWallet.syncTransfer({
            to: this.swapAddress,
            amount: this.swapData.sell.amount,
            token: this.swapData.sell.token
        });
        const swap = new Swap(
            this.swapData,
            this.swapAddress,
            data.transactions[1],
            data.transactions[3],
            this.syncWallet.provider
        );
        return { swap, signatures: this.signatures };
    }
}
