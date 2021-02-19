/**
 * This file contains an implementation of SwapProvider class - essentially a server-side part of the SDK
 * @packageDocumentation
 */

import * as zksync from 'zksync';
import { pubKeyHash } from 'zksync-crypto';
import { utils, providers } from 'ethers';
import { MusigSigner } from './signer';
import { SwapData, SchnorrData, SwapState, Transaction } from './types';
import { transpose, getTransactions, formatTx, TOTAL_TRANSACTIONS } from './utils';

import { SwapParty } from './abstract-party';

// This is the provider's position in schnorr-musig protocol
const PROVIDER_MUSIG_POSITION = 0;

export class SwapProvider extends SwapParty {
    private shares: Uint8Array[];
    private schnorrData: SchnorrData = {};
    private clientAddress: string;

    /** async factory method */
    static async init(privateKey: string, ethProvider: providers.Provider, syncProvider: zksync.Provider) {
        return (await super.init(privateKey, ethProvider, syncProvider)) as SwapProvider;
    }

    async loadSwap(swapData: SwapData, signedTransactions: Transaction[]) {
        if (this.state != SwapState.empty) {
            throw new Error("In the middle of a swap - can't switch to a new one");
        }
        this.swapData = swapData;
        this.transactions = signedTransactions;
        // @ts-ignore
        const swapAddress = (this.create2Info.address = signedTransactions[0].account);
        const swapAccount = await this.syncWallet.provider.getState(swapAddress);
        const balance = swapAccount.committed.balances[swapData.buy.token] || 0;
        this.state = swapData.buy.amount.gt(balance) ? SwapState.checked : SwapState.deposited;
    }

    signedTransactions() {
        if (this.state != SwapState.checked && this.state != SwapState.deposited) {
            throw new Error('Transactions are not signed yet');
        }
        return this.transactions;
    }

    /**
     * Generates precommitments for the schnorr-musig protocol
     */
    async prepareSwap(data: SwapData, clientPubkey: string, clientAddress: string) {
        if (this.state != SwapState.empty) {
            throw new Error("In the middle of a swap - can't start a new one");
        }
        this.signer = new MusigSigner([this.publicKey, clientPubkey], PROVIDER_MUSIG_POSITION, TOTAL_TRANSACTIONS);
        this.schnorrData.precommitments = this.signer.computePrecommitments();
        this.swapData = data;
        this.clientAddress = clientAddress;
        this.pubKeyHash = pubKeyHash(this.signer.computePubkey());
        this.create2Info = zksync.utils.getCREATE2AddressAndSalt(utils.hexlify(this.pubKeyHash), {
            creatorAddress: data.create2.creator,
            saltArg: data.create2.salt,
            codeHash: data.create2.hash
        });
        this.state = SwapState.prepared;
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
        if (this.state != SwapState.prepared) {
            throw new Error('Not prepared for the swap');
        }
        this.schnorrData.commitments = this.signer.receivePrecommitments(
            transpose([this.schnorrData.precommitments, data.precommitments])
        );
        this.signer.receiveCommitments(transpose([this.schnorrData.commitments, data.commitments]));
        // generate transactions
        this.transactions = await getTransactions(
            this.swapData,
            this.clientAddress,
            this.address(),
            this.swapAddress(),
            this.pubKeyHash,
            this.syncWallet.provider
        );
        this.shares = [];
        this.transactions.forEach((tx, i) => {
            const bytes = zksync.utils.serializeTx(tx);
            this.shares.push(this.signer.sign(this.privateKey, bytes, i));
        });
        this.state = SwapState.signed;
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
        if (this.state != SwapState.signed) {
            throw new Error('Not yet signed the swap transactions');
        }
        const musigPubkey = this.signer.computePubkey();
        this.transactions.forEach((tx, i) => {
            const signature = this.signer.receiveSignatureShares([this.shares[i], signatureShares[i]], i);
            const bytes = zksync.utils.serializeTx(this.transactions[i]);
            // this could mean that either client sent incorrect signature shares
            // or client signed transactions containing wrong data
            if (!this.signer.verify(bytes, signature)) {
                throw new Error('Provided signature shares are invalid');
            }
            formatTx(tx, signature, musigPubkey);
        });
        const swapAccount = await this.syncWallet.provider.getState(this.swapAddress());
        const balance = swapAccount.committed.balances[this.swapData.sell.token] || 0;
        if (this.swapData.sell.amount.gt(balance)) {
            throw new Error('Client did not deposit enough funds');
        }
        this.state = SwapState.checked;
    }

    /** Sends transactions that will finalize the swap */
    async finalizeSwap() {
        if (this.state != SwapState.checked) {
            throw new Error('Not yet checked the signatures - not safe to deposit funds');
        }
        const hashes = await this.sendBatch(
            this.transactions.slice(0, 3),
            this.swapData.buy.token,
            this.swapData.buy.amount
        );
        this.state = SwapState.finalized;
        return hashes;
    }
}
