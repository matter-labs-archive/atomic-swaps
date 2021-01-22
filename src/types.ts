import * as zksync from 'zksync';
import { ethers } from 'ethers';

export type Deal = {
    token: zksync.types.TokenLike;
    amount: ethers.BigNumber;
};

export interface SwapData {
    sell: Deal;
    buy: Deal;
    timeout: number;
    withdrawType: 'L1' | 'L2';
    create2: {
        salt: string;
        hash: string;
    };
}

export interface SchnorrData {
    precommitments?: Uint8Array[];
    commitments?: Uint8Array[];
}
