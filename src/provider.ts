/**
 * This file contains an implementation if SwapProvider class - essentially a server-side part of the SDK
 * @packageDocumentation
 */

import * as zksync from 'zksync';
import { pubKeyHash } from 'zksync-crypto';
import { ethers, utils } from 'ethers';
import { MusigSigner } from './signer';
import { SwapData, SchnorrData, TxType } from './types';
import {
    transpose,
    getSyncKeys,
    getSignBytes,
    getTransactions,
    formatTx,
    isSigningKeySet,
    TOTAL_TRANSACTIONS
} from './utils';

enum State {
    empty,
    prepared,
    signed,
    checked,
    deposited,
    finalized
}

// This is the provider's position in schnorr-musig protocol
const PROVIDER_MUSIG_POSITION = 0;

export class SwapProvider {
    private signer: MusigSigner;
    private transactions: any[];
    private shares: Uint8Array[];
    private swapData: SwapData;
    private schnorrData: SchnorrData = {};
    private pubKeyHash: Uint8Array;
    private create2Info: {
        salt: string;
        address: string;
    };
    private clientAddress: string;
    private state: State;
    private constructor(private privateKey: string, private publicKey: string, private syncWallet: zksync.Wallet) {
        this.state = State.empty;
    }

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

    id() {
        return this.syncWallet.getAccountId();
    }

    swapAddress() {
        if (this.state == State.empty) {
            throw new Error('No active swaps present');
        }
        return this.create2Info.address;
    }

    swapSalt() {
        if (this.state == State.empty) {
            throw new Error('No active swaps present');
        }
        return this.create2Info.salt;
    }

    /**
     * Generates precommitments for the schnorr-musig protocol
     */
    async prepareSwap(data: SwapData, clientPubkey: string, clientAddress: string) {
        if (this.state != State.empty) {
            throw new Error("SwapProvider is in the middle of a swap - can't start a new one");
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
        this.state = State.prepared;
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
        if (this.state != State.prepared) {
            throw new Error('SwapProvider is not prepared for the swap');
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
            const bytes = getSignBytes(tx, this.syncWallet.signer);
            this.shares.push(this.signer.sign(this.privateKey, bytes, i));
        });
        this.state = State.signed;
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
        if (this.state != State.signed) {
            throw new Error('SwapProvider has not yet signed the swap transactions');
        }
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
        const swapAccountBalance = (await this.syncWallet.provider.getState(this.swapAddress())).committed.balances;
        const necessaryDeposit = this.swapData.sell.amount.add(this.transactions[0].fee).add(this.transactions[2].fee);
        if (necessaryDeposit.gt(swapAccountBalance[this.swapData.sell.token])) {
            throw new Error('Client did not deposit funds');
        }
        this.state = State.checked;
    }

    /** Deposits provider's funds to the multisig account */
    async depositFunds(depositType: TxType, approveDeposit: boolean = true) {
        if (this.state != State.checked) {
            throw new Error("SwapProvider has not yet checked the signatures - can't deposit funds");
        }
        const amount = this.swapData.buy.amount.add(this.transactions[1].fee);
        const token = this.swapData.buy.token;
        let hash: string;
        if (depositType == 'L2') {
            const handle = await this.syncWallet.syncTransfer({ to: this.swapAddress(), amount, token });
            await handle.awaitReceipt();
            hash = handle.txHash;
        } else {
            const handle = await this.syncWallet.depositToSyncFromEthereum({
                depositTo: this.swapAddress(),
                amount,
                token,
                approveDepositAmountForERC20: approveDeposit
            });
            await handle.awaitReceipt();
            hash = handle.ethTx.hash;
        }
        this.state = State.deposited;
        return hash;
    }

    /** Sends 3 transactions that will finalize the swap */
    async finalizeSwap() {
        if (this.state != State.deposited) {
            throw new Error("SwapProvider has not yet deposited funds - can't finalize swap");
        }
        if (!(await isSigningKeySet(this.swapAddress(), this.syncWallet.provider))) {
            const handle = await zksync.wallet.submitSignedTransaction(
                { tx: this.transactions[0] },
                this.syncWallet.provider
            );
            await handle.awaitReceipt();
        }
        for (const tx of this.transactions.slice(1, 3)) {
            const handle = await zksync.wallet.submitSignedTransaction({ tx }, this.syncWallet.provider);
            await handle.awaitReceipt();
        }
        this.state = State.finalized;
    }

    reset() {
        this.state = State.empty;
    }
}
