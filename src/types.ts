import { types } from 'zksync';
import { BigNumber } from 'ethers';

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
