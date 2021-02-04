/**
 * This file provides Swap and SwapClient classes - essentially a client-side part of the SDK
 * @packageDocumentation
 */

import * as zksync from 'zksync';
import { pubKeyHash } from 'zksync-crypto';
import { ethers, utils } from 'ethers';
import { MusigSigner } from './signer';
import { SwapData, TxType } from './types';
import {
    transpose,
    getSyncKeys,
    getSignBytes,
    getTransactions,
    formatTx,
    isSigningKeySet,
    TOTAL_TRANSACTIONS,
    SYNC_TX_PREFIX
} from './utils';

enum State {
    empty,
    prepared,
    signed,
    deposited
}

/**
 * Swap objects are used to either manually finish the swap, cancel the swap,
 * or wait until the final tx is executed by provider.
 * Swap objects are returned by [[SwapClient.signSwap]] method.
 */
export class Swap {
    constructor(
        private changePubKeyTx: zksync.types.ChangePubKey,
        private finalTx: zksync.types.Transfer,
        private cancelTx: zksync.types.Transfer,
        private finalHash: string,
        private provider: zksync.Provider
    ) {}

    /**
     * Sends the transaction to receive the bought token from the multisig.
     * Only use this when you know that provider has deposited funds, but not completed the swap.
     */
    async finalize() {
        if (!(await isSigningKeySet(this.finalTx.from, this.provider))) {
            const handle = await zksync.wallet.submitSignedTransaction({ tx: this.changePubKeyTx }, this.provider);
            await handle.awaitReceipt();
        }
        const handle = await zksync.wallet.submitSignedTransaction({ tx: this.finalTx }, this.provider);
        await handle.awaitReceipt();
        return handle.txHash;
    }

    /**
     * Sends the transaction that cancels the swap and returns funds deposited to the multisig.
     * This will only work after the timeout (set in [[SwapData]]) has been reached.
     */
    async cancel() {
        if (!(await isSigningKeySet(this.cancelTx.from, this.provider))) {
            const handle = await zksync.wallet.submitSignedTransaction({ tx: this.changePubKeyTx }, this.provider);
            await handle.awaitReceipt();
        }
        const handle = await zksync.wallet.submitSignedTransaction({ tx: this.cancelTx }, this.provider);
        await handle.awaitReceipt();
        return handle.txHash;
    }

    /** Waits for provider to deposit the funds and complete the swap. */
    async wait() {
        await this.provider.notifyTransaction(this.finalHash, 'COMMIT');
        return this.finalHash;
    }
}

// This is the client's position in schnorr-musig protocol
const CLIENT_MUSIG_POSITION = 1;

/** SwapClient class provides all necessary methods to prepare, sign and complete the swap on the client side. */
export class SwapClient {
    private signer: MusigSigner;
    private commitments: Uint8Array[];
    private swapData: SwapData;
    private create2Info: {
        salt: string;
        address: string;
    };
    private pubKeyHash: Uint8Array;
    private transactions: any[];
    private state: State;
    private constructor(private privateKey: string, private publicKey: string, private syncWallet: zksync.Wallet) {
        this.state = State.empty;
    }

    /** SwapClient's async constructor */
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
     * This method generates precommitments and commitments for schnorr-musig protocol,
     * makes a 0-transfer to the multisig account so that the server assigns an ID to it, and generates
     * all 5 transactions needed for the swap.
     * @returns precommitments and commitments for schnorr-musig protocol
     */
    async prepareSwap(
        data: SwapData,
        providerPubkey: string,
        providerAddress: string,
        providerPrecommitments: Uint8Array[]
    ) {
        if (this.state != State.empty) {
            throw new Error("SwapClient is in the middle of a swap - can't start a new one");
        }
        this.swapData = data;
        this.signer = new MusigSigner([providerPubkey, this.publicKey], CLIENT_MUSIG_POSITION, TOTAL_TRANSACTIONS);
        const precommitments = this.signer.computePrecommitments();
        this.commitments = this.signer.receivePrecommitments(transpose([providerPrecommitments, precommitments]));
        this.pubKeyHash = pubKeyHash(this.signer.computePubkey());
        this.create2Info = zksync.utils.getCREATE2AddressAndSalt(utils.hexlify(this.pubKeyHash), {
            creatorAddress: data.create2.creator,
            saltArg: data.create2.salt,
            codeHash: data.create2.hash
        });
        this.state = State.prepared;

        // if the swapAccount has not yet been created (has no id)
        // we have to make a 0-transfer to it so it will be created,
        // otherwise we won't be able to sign outcoming transactions
        const swapAccount = await this.syncWallet.provider.getState(this.swapAddress());
        if (!swapAccount.id) {
            const tx = await this.syncWallet.syncTransfer({
                to: this.swapAddress(),
                token: data.sell.token,
                amount: 0
            });
            await tx.awaitReceipt();
        }

        // generate swap transactions
        this.transactions = await getTransactions(
            this.swapData,
            this.address(),
            providerAddress,
            this.swapAddress(),
            this.pubKeyHash,
            this.syncWallet.provider
        );
        return {
            precommitments,
            commitments: this.commitments
        };
    }

    /**
     * This method receives commitments and signature shares generated by the provider,
     * generates client's signature shares and combines them into full transaction signatures.
     *
     * If signatures are correct, method transfers client's funds to the multisig, otherwise an error is thrown.
     * @returns signature shares to send to the provider and a [[Swap]] object with necessary data to finish or cancel the swap
     */
    async signSwap(data: { commitments: Uint8Array[]; shares: Uint8Array[] }) {
        if (this.state != State.prepared) {
            throw new Error('SwapClient is not prepared for the swap');
        }
        this.signer.receiveCommitments(transpose([data.commitments, this.commitments]));
        const musigPubkey = this.signer.computePubkey();
        let shares = [];

        // sign all transactions
        this.transactions.forEach((tx, i) => {
            const bytes = getSignBytes(tx, this.syncWallet.signer);
            const share = this.signer.sign(this.privateKey, bytes, i);
            const signature = this.signer.receiveSignatureShares([data.shares[i], share], i);
            shares.push(share);
            // this could mean that either provider sent incorrect signature shares
            // or provider signed transactions containing wrong data
            if (!this.signer.verify(bytes, signature)) {
                throw new Error('Provided signature shares were invalid');
            }
            formatTx(tx, signature, musigPubkey);
        });

        // calculate the hash of the transaction that finalizes the swap
        const finalHash = utils.sha256(getSignBytes(this.transactions[1], this.syncWallet.signer));

        const swap = new Swap(
            this.transactions[0],
            this.transactions[1],
            this.transactions[3],
            finalHash.replace('0x', SYNC_TX_PREFIX),
            this.syncWallet.provider
        );

        this.state = State.signed;
        return { swap, shares };
    }

    async depositFunds(depositType: TxType, approveDeposit: boolean = true) {
        if (this.state != State.signed) {
            throw new Error("SwapClient has not yet signed the transactions - can't deposit funds");
        }
        const amount = this.swapData.sell.amount.add(this.transactions[0].fee).add(this.transactions[2].fee);
        const token = this.swapData.sell.token;
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

    reset() {
        this.state = State.empty;
    }
}
