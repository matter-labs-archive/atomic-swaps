// This file provides Swap and SwapClient classes - essentially a client part of the SDK

import * as zksync from 'zksync';
import { pubKeyHash } from 'zksync-crypto';
import { ethers, utils } from 'ethers';
import { MusigSigner } from './signer';
import { SwapData } from './types';
import { transpose, getSyncKeys, getSignBytes, getTransactions, TOTAL_TRANSACTIONS } from './utils';

const CLIENT_NUMBER = 1;

// Swap objects are used to either manually finish the swap, cancel the swap, 
// or wait until the final tx is executed by provider.
// Swap objects are returned by SwapClient.signSwap method after client
// sends signature shares to provider.
export class Swap {
    constructor(
        private finalTx: zksync.types.Transfer,
        private cancelTx: zksync.types.Transfer,
        private finalHash: string,
        private provider: zksync.Provider
    ) {}

    // Send the transaction to receive the bought token from the multisig.
    // Only use this when you know that provider has deposited funds, but not completed the swap.
    async finalize() {
        const handle = await zksync.wallet.submitSignedTransaction({ tx: this.finalTx }, this.provider);
        await handle.awaitReceipt();
        return handle.txHash;
    }

    // Send the transaction that cancels the swap and returns funds deposited to the multisig.
    // This will only work after the timeout (set in SwapData) has been reached.
    async cancel() {
        const handle = await zksync.wallet.submitSignedTransaction({ tx: this.cancelTx }, this.provider);
        await handle.awaitReceipt();
        return handle.txHash;
    }

    // Wait for provider to deposit the funds and complete the swap.
    async wait() {
        await this.provider.notifyTransaction(this.finalHash, 'COMMIT');
        return this.finalHash;
    }
}

// SwapClient class provides all necessary methods to prepare, sign and complete the swap.
// This is the main class to be used on the client side.
export class SwapClient {
    private signer: MusigSigner;
    private commitments: Uint8Array[];
    private swapData: SwapData;
    private swapAddress: string;
    private pubKeyHash: Uint8Array;
    private transactions: any[];
    constructor(private privateKey: string, private publicKey: string, private syncWallet: zksync.Wallet) {}

    static async init(privateKey: string, ethProvider: ethers.providers.Provider, syncProvider: zksync.Provider) {
        const ethWallet = new ethers.Wallet(privateKey).connect(ethProvider);
        const syncWallet = await zksync.Wallet.fromEthSigner(ethWallet, syncProvider);
        const { privkey, pubkey } = await getSyncKeys(ethWallet);
        return new SwapClient(utils.hexlify(privkey), utils.hexlify(pubkey), syncWallet);
    }

    pubkey() {
        return this.publicKey;
    }

    address() {
        return this.syncWallet.address();
    }

    async prepareSwap(
        data: SwapData,
        providerPubkey: string,
        providerAddress: string,
        providerPrecommitments: Uint8Array[]
    ) {
        this.swapData = data;
        this.signer = new MusigSigner([providerPubkey, this.publicKey], CLIENT_NUMBER, TOTAL_TRANSACTIONS);
        const precommitments = this.signer.computePrecommitments();
        this.commitments = this.signer.receivePrecommitments(transpose([providerPrecommitments, precommitments]));
        this.pubKeyHash = pubKeyHash(this.signer.computePubkey());
        this.swapAddress = zksync.utils.getCREATE2AddressAndSalt(utils.hexlify(this.pubKeyHash), {
            creatorAddress: this.address(),
            saltArg: data.create2.salt,
            codeHash: data.create2.hash
        }).address;
        const swapAccount = await this.syncWallet.provider.getState(this.swapAddress);
        if (!swapAccount.id) {
            const tx = await this.syncWallet.syncTransfer({
                to: this.swapAddress,
                token: data.sell.token,
                amount: 0
            });
            await tx.awaitReceipt();
        }

        this.transactions = await getTransactions(
            this.swapData,
            this.address(),
            providerAddress,
            this.swapAddress,
            this.pubKeyHash,
            this.syncWallet.provider
        );
        return {
            precommitments,
            commitments: this.commitments
        };
    }

    async signSwap(data: { commitments: Uint8Array[]; shares: Uint8Array[] }) {
        this.signer.receiveCommitments(transpose([data.commitments, this.commitments]));
        let signatures = [];
        let shares = [];

        this.transactions.forEach((tx, i) => {
            const bytes = getSignBytes(tx, this.syncWallet.signer);
            const share = this.signer.sign(this.privateKey, bytes, i);
            const signature = this.signer.receiveSignatureShares([data.shares[i], share], i);
            shares.push(share);
            if (!this.signer.verify(bytes, signature)) {
                throw new Error('Provided signature shares were invalid');
            }
            signatures.push({
                pubKey: utils.hexlify(this.signer.computePubkey()).substr(2),
                signature: utils.hexlify(signature).substr(2)
            });

            tx.signature = signatures[i];
            tx.feeToken = tx.feeTokenId;
            tx.token = tx.tokenId;
            tx.fee = ethers.BigNumber.from(tx.fee).toString();
            if (tx.amount) {
                tx.amount = ethers.BigNumber.from(tx.amount).toString();
            }
        });

        const transfer = await this.syncWallet.syncTransfer({
            to: this.swapAddress,
            amount: this.swapData.sell.amount.add(this.transactions[0].fee).add(this.transactions[2].fee),
            token: this.swapData.sell.token
        });
        await transfer.awaitReceipt();
        const finalHash = utils.sha256(getSignBytes(this.transactions[1], this.syncWallet.signer));
        const swap = new Swap(
            this.transactions[1],
            this.transactions[3],
            'sync-tx:' + finalHash.slice(2),
            this.syncWallet.provider
        );
        return { swap, shares };
    }
}
