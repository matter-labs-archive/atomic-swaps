import * as zksync from 'zksync';
import { ethers, utils } from 'ethers';
import { MusigSigner } from './signer';
import { SwapData, SwapState } from './types';
import { getSyncKeys, SYNC_TX_PREFIX, getFeeType, getTargetAddress } from './utils';

export class SwapParty {
    protected signer: MusigSigner;
    protected transactions: any[];
    protected swapData: SwapData;
    protected pubKeyHash: Uint8Array;
    protected state: SwapState;
    protected create2Info: {
        salt: string;
        address: string;
    };

    protected constructor(
        protected privateKey: string,
        protected publicKey: string,
        protected syncWallet: zksync.Wallet
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

    pubkey() {
        return this.publicKey;
    }

    /** @returns zkSync account ID */
    id() {
        return this.syncWallet.getAccountId();
    }

    /** @returns */
    swapAddress() {
        if (this.state == SwapState.empty) {
            throw new Error('No active swaps present');
        }
        return this.create2Info.address;
    }

    swapSalt() {
        if (this.state == SwapState.empty) {
            throw new Error('No active swaps present');
        }
        return this.create2Info.salt;
    }

    reset() {
        this.state = SwapState.empty;
    }

    protected getSignBytes(transaction: any): Uint8Array {
        switch (transaction.type) {
            case 'Transfer':
                return this.syncWallet.signer.transferSignBytes(transaction);
            case 'ChangePubKey':
                return this.syncWallet.signer.changePubKeySignBytes(transaction);
            case 'Withdraw':
                return this.syncWallet.signer.withdrawSignBytes(transaction);
            default:
                throw new Error('Invalid transaction type');
        }
    }

    protected async isTxExecuted(transacion: any) {
        const hash = utils.sha256(this.getSignBytes(transacion)).replace('0x', SYNC_TX_PREFIX);
        const receipt = await this.syncWallet.provider.getTxReceipt(hash);
        return receipt.executed && receipt.success;
    }

    protected async deposit(
        token: zksync.types.TokenLike,
        amount: ethers.BigNumber,
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

    protected async sendBatch(txs: any[], token: zksync.types.TokenLike) {
        let batch = [];
        for (const tx of txs) {
            if (!(await this.isTxExecuted(tx))) {
                batch.push({ tx });
            }
        }
        if (batch.length == 0) {
            return [];
        }
        const fee = await this.syncWallet.provider.getTransactionsBatchFee(
            batch.map((tx) => getFeeType(tx.tx)).concat(['Transfer']),
            batch.map((tx) => getTargetAddress(tx.tx)).concat([this.address()]),
            token
        );
        const feePayingTx = await this.syncWallet.signSyncTransfer({
            to: this.address(),
            token,
            amount: 0,
            fee,
            nonce: await this.syncWallet.getNonce()
        });
        batch.push(feePayingTx);
        const handles = await zksync.wallet.submitSignedTransactionsBatch(this.syncWallet.provider, batch, []);
        await Promise.all(handles.map((handle) => handle.awaitReceipt()));
        return handles.map((handle) => handle.txHash);
    }
}
