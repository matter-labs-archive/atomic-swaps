import * as zksync from 'zksync';
import { ethers } from 'ethers';

export interface SwapData {
    sell: {
        token: zksync.types.TokenLike;
        amount: ethers.BigNumber;
    };
    buy: {
        token: zksync.types.TokenLike;
        amount: ethers.BigNumber;
    };
    timeout: number;
    create2: {
        salt: string;
        hash: string;
    };
}

export interface SchnorrData {
    precommitments?: Uint8Array[];
    commitments?: Uint8Array[];
}

export type Network = 'localhost' | 'mainnet' | 'ropsten' | 'rinkeby';
