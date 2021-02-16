import { ethers, utils } from 'ethers';
import * as zksync from 'zksync';
import { private_key_to_pubkey, privateKeyFromSeed } from 'zksync-crypto';
import { SwapData, Transaction } from './types';

export const TOTAL_TRANSACTIONS = 5;
export const SYNC_PREFIX = 'sync:';
export const SYNC_TX_PREFIX = 'sync-tx:';

export function transpose<T>(matrix: T[][]): T[][] {
    return matrix[0].map((_, index) => matrix.map((row) => row[index]));
}

export async function getSyncKeys(ethWallet: ethers.Wallet) {
    let chainID = 1;
    if (ethWallet.provider) {
        const network = await ethWallet.provider.getNetwork();
        chainID = network.chainId;
    }
    let message = 'Access zkSync account.\n\nOnly sign this message for a trusted client!';
    if (chainID !== 1) {
        message += `\nChain ID: ${chainID}.`;
    }
    const signedBytes = zksync.utils.getSignedBytesFromMessage(message, false);
    const signature = await zksync.utils.signMessagePersonalAPI(ethWallet, signedBytes);
    const seed = utils.arrayify(signature);
    const privkey = privateKeyFromSeed(seed);
    const pubkey = private_key_to_pubkey(privkey);
    return { privkey, pubkey };
}

export function formatTx(tx: Transaction, signature: Uint8Array, pubkey: Uint8Array) {
    tx.signature = {
        pubKey: utils.hexlify(pubkey).substr(2),
        signature: utils.hexlify(signature).substr(2)
    };
    tx.fee = ethers.BigNumber.from(tx.fee).toString();
    if ('amount' in tx) {
        tx.amount = ethers.BigNumber.from(tx.amount).toString();
    }
}

export async function getTransactions(
    swapData: SwapData,
    clientAddress: string,
    providerAddress: string,
    swapAddress: string,
    pubKeyHash: Uint8Array,
    syncProvider: zksync.Provider
): Promise<Transaction[]> {
    const swapAccount = await syncProvider.getState(swapAddress);
    if (!swapAccount.id) {
        throw new Error("Swap Account ID not set - can't sign transactions");
    }
    const buyTokenId = syncProvider.tokenSet.resolveTokenId(swapData.buy.token);
    const sellTokenId = syncProvider.tokenSet.resolveTokenId(swapData.sell.token);
    const nonce = swapAccount.committed.nonce;

    return [
        {
            type: 'ChangePubKey',
            accountId: swapAccount.id,
            account: swapAccount.address,
            newPkHash: utils.hexlify(pubKeyHash).replace('0x', SYNC_PREFIX),
            nonce,
            feeToken: sellTokenId,
            fee: 0,
            validFrom: 0,
            validUntil: zksync.utils.MAX_TIMESTAMP,
            ethAuthData: {
                type: 'CREATE2',
                creatorAddress: swapData.create2.creator,
                saltArg: swapData.create2.salt,
                codeHash: swapData.create2.hash
            }
        },

        {
            type: 'Transfer',
            token: buyTokenId,
            accountId: swapAccount.id,
            from: swapAccount.address,
            to: clientAddress,
            amount: swapData.buy.amount,
            fee: 0,
            nonce: nonce + 1,
            validFrom: 0,
            validUntil: swapData.timeout
        },

        {
            type: 'Transfer',
            token: sellTokenId,
            accountId: swapAccount.id,
            from: swapAccount.address,
            to: providerAddress,
            amount: swapData.sell.amount,
            fee: 0,
            nonce: nonce + 2,
            validFrom: 0,
            validUntil: zksync.utils.MAX_TIMESTAMP
        },

        {
            type: 'Transfer',
            token: sellTokenId,
            accountId: swapAccount.id,
            from: swapAccount.address,
            to: clientAddress,
            amount: swapData.sell.amount,
            fee: 0,
            nonce: nonce + 1,
            validFrom: swapData.timeout + 1,
            validUntil: zksync.utils.MAX_TIMESTAMP
        },

        {
            type: 'Transfer',
            token: buyTokenId,
            accountId: swapAccount.id,
            from: swapAccount.address,
            to: providerAddress,
            amount: swapData.buy.amount,
            fee: 0,
            nonce: nonce + 2,
            validFrom: swapData.timeout + 1,
            validUntil: zksync.utils.MAX_TIMESTAMP
        }
    ];
}
