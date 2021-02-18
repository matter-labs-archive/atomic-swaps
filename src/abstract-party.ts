import * as zksync from 'zksync';
import { ethers, utils, BigNumber } from 'ethers';
import { MusigSigner } from './signer';
import { SwapData, SwapState, SignedTransaction, Transaction } from './types';
import { getSyncKeys, SYNC_TX_PREFIX } from './utils';

export class SwapParty {
    protected signer: MusigSigner;
    protected transactions: Transaction[];
    protected swapData: SwapData;
    protected pubKeyHash: Uint8Array;
    protected state: SwapState;
    protected create2Info: {
        salt: string;
        address: string;
    };

    protected constructor(
        protected privateKey: string,
        public readonly publicKey: string,
        public readonly syncWallet: zksync.Wallet
    ) {
        this.state = SwapState.empty;
    }

    protected static async init(
        privateKey: string,
        ethProvider: ethers.providers.Provider,
        syncProvider: zksync.Provider
    ) {
        const ethWallet = new ethers.Wallet(privateKey).connect(ethProvider);
        const syncWallet = await zksync.Wallet.fromEthSigner(ethWallet, syncProvider);
        const { privkey, pubkey } = await getSyncKeys(ethWallet);
        return new this(utils.hexlify(privkey), utils.hexlify(pubkey), syncWallet);
    }

    address() {
        return this.syncWallet.address();
    }

    /** @returns zkSync account ID */
    id() {
        return this.syncWallet.getAccountId();
    }

    /** @returns address of the swap account */
    swapAddress() {
        if (this.state == SwapState.empty) {
            throw new Error('No active swaps present');
        }
        return this.create2Info.address;
    }

    /** @returns actual salt that will be used for CREATE2 */
    swapSalt() {
        if (this.state == SwapState.empty) {
            throw new Error('No active swaps present');
        }
        return this.create2Info.salt;
    }

    /** resets the state */
    reset() {
        this.state = SwapState.empty;
    }

    protected async isTxExecuted(transacion: Transaction) {
        const hash = utils.sha256(zksync.utils.serializeTx(transacion)).replace('0x', SYNC_TX_PREFIX);
        const receipt = await this.syncWallet.provider.getTxReceipt(hash);
        return receipt.executed && receipt.success;
    }

    async deposit(
        token: zksync.types.TokenLike,
        amount: BigNumber,
        depositType: 'L1' | 'L2' = 'L2',
        autoApprove: boolean = true
    ) {
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
                approveDepositAmountForERC20: autoApprove
            });
            await handle.awaitReceipt();
            hash = handle.ethTx.hash;
        }
        return hash;
    }

    protected async sendBatch(
        txs: Transaction[],
        token: zksync.types.TokenLike,
        depositAmount: ethers.BigNumberish = 0
    ) {
        let batch: SignedTransaction[] = [];
        for (const tx of txs) {
            if (!(await this.isTxExecuted(tx))) {
                batch.push({ tx });
            }
        }
        if (batch.length == 0) {
            return [];
        }
        const fee = await this.syncWallet.provider.getTransactionsBatchFee(
            [...batch.map((tx) => getFeeType(tx.tx)), 'Transfer'],
            [...batch.map((tx) => getTargetAddress(tx.tx)), this.swapAddress()],
            token
        );
        const feePayingTx = (await this.syncWallet.signSyncTransfer({
            to: this.swapAddress(),
            token,
            amount: depositAmount,
            fee,
            nonce: await this.syncWallet.getNonce()
        })) as SignedTransaction;
        if (batch[0].tx.type == 'ChangePubKey') {
            batch.splice(1, 0, feePayingTx);
        } else {
            batch.unshift(feePayingTx);
        }
        const handles = await zksync.wallet.submitSignedTransactionsBatch(this.syncWallet.provider, batch, []);
        await Promise.all(handles.map((handle) => handle.awaitReceipt()));
        return handles.map((handle) => handle.txHash);
    }
}

function getTargetAddress(transaction: Transaction) {
    if (transaction.type == 'ChangePubKey') {
        return transaction.account;
    }
    return transaction.to;
}

function getFeeType(transaction: Transaction) {
    if (transaction.type == 'ChangePubKey') {
        return {
            ChangePubKey: transaction.ethAuthData.type
        };
    }
    return transaction.type;
}
