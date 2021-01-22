/**
 * This file contains an implementation if SwapProvider class - essentially a server-side part of the SDK
 * @packageDocumentation
 */

import * as zksync from 'zksync';
import { pubKeyHash } from 'zksync-crypto';
import { ethers, utils } from 'ethers';
import { MusigSigner } from './signer';
import { SwapData, SchnorrData } from './types';
import { transpose, getSyncKeys, getSignBytes, getTransactions, formatTx, TOTAL_TRANSACTIONS } from './utils';

// This is the provider's position in schnorr-musig protocol
const PROVIDER_MUSIG_POSITION = 0;

export class SwapProvider {
    private signer: MusigSigner;
    private transactions: any[];
    private shares: Uint8Array[];
    private swapData: SwapData;
    private schnorrData: SchnorrData = {};
    private pubKeyHash: Uint8Array;
    private swapAddress: string;
    private clientAddress: string;
    private constructor(private privateKey: string, private publicKey: string, private syncWallet: zksync.Wallet) {}

    /** SwapProvider's async constructor */
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

    /**
     * Generates precommitments for the schnorr-musig protocol
     */
    async prepareSwap(data: SwapData, clientPubkey: string, clientAddress: string) {
        this.signer = new MusigSigner([this.publicKey, clientPubkey], PROVIDER_MUSIG_POSITION, TOTAL_TRANSACTIONS);
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

    /**
     * Generates all 5 transactions needed for the swap and signature shares for them
     */
    async signSwap(data: SchnorrData) {
        this.schnorrData.commitments = this.signer.receivePrecommitments(
            transpose([this.schnorrData.precommitments, data.precommitments])
        );
        this.signer.receiveCommitments(transpose([this.schnorrData.commitments, data.commitments]));
        // generate transactions
        this.transactions = await getTransactions(
            this.swapData,
            this.clientAddress,
            this.address(),
            this.swapAddress,
            this.pubKeyHash,
            this.syncWallet.provider
        );
        this.shares = [];
        this.transactions.forEach((tx, i) => {
            const bytes = getSignBytes(tx, this.syncWallet.signer);
            this.shares.push(this.signer.sign(this.privateKey, bytes, i));
        });

        return {
            commitments: this.schnorrData.commitments,
            shares: this.shares
        };
    }

    /**
     * Receives client's signature shares, combines with provider's own to get fully signed transactions.
     * Verifies that produces signatures are correct, otherwise an error is thrown.
     * Verifies that client has deposited funds to the multisig, otherwise an error is thrown.
     */
    async checkSwap(signatureShares: Uint8Array[]) {
        const musigPubkey = this.signer.computePubkey();
        this.transactions.forEach((tx, i) => {
            const signature = this.signer.receiveSignatureShares([this.shares[i], signatureShares[i]], i);
            const bytes = getSignBytes(this.transactions[i], this.syncWallet.signer);
            // this could mean that either client sent incorrect signature shares
            // or client signed transactions containing wrong data
            if (!this.signer.verify(bytes, signature)) {
                throw new Error('Provided signature shares were invalid');
            }
            formatTx(tx, signature, musigPubkey);
        });
        const swapAccountBalance = (await this.syncWallet.provider.getState(this.swapAddress)).committed.balances;
        const necessaryDeposit = this.swapData.sell.amount.add(this.transactions[0].fee).add(this.transactions[2].fee);
        if (necessaryDeposit.gt(swapAccountBalance[this.swapData.sell.token])) {
            throw new Error('Client did not deposit funds');
        }
    }

    /** Deposits provider's funds to the multisig account */
    async depositFunds() {
        const handle = await this.syncWallet.syncTransfer({
            to: this.swapAddress,
            amount: this.swapData.buy.amount.add(this.transactions[1].fee),
            token: this.swapData.buy.token
        });
        await handle.awaitReceipt();
    }

    /** Sends 3 transactions that will finalize the swap */
    async finalizeSwap() {
        for (const tx of this.transactions.slice(0, 3)) {
            const handle = await zksync.wallet.submitSignedTransaction({ tx }, this.syncWallet.provider);
            await handle.awaitReceipt();
        }
    }
}
