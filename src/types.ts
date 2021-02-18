import { types } from 'zksync';
import { BigNumber } from 'ethers';

/**
 * Type that contains all information about the Atomic Swap:
 * - token pair
 * - token amounts
 * - timeout, after which swap can be cancelled
 * - CREATE2 data regarding the multisig swap account
 */
export interface SwapData {
    sell: {
        token: types.TokenLike;
        amount: BigNumber;
    };
    buy: {
        token: types.TokenLike;
        amount: BigNumber;
    };
    timeout: number;
    create2: {
        salt: string;
        hash: string;
        creator: string;
    };
}

export interface SchnorrData {
    precommitments?: Uint8Array[];
    commitments?: Uint8Array[];
}

export enum SwapState {
    empty,
    prepared,
    signed,
    checked,
    deposited,
    finalized
}

export type Transaction = types.Transfer | types.Withdraw | types.ChangePubKey;
export type SignedTransaction = {
    tx: Transaction;
    ethereumSignature?: types.TxEthSignature;
};
