import { ethers, utils } from 'ethers';
import * as zksync from 'zksync';
import { private_key_to_pubkey, privateKeyFromSeed } from 'zksync-crypto';
import { SwapData } from './types';

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

export function getTargetAddress(transaction: any) {
    switch (transaction.type) {
        case 'Transfer':
            return transaction.to;
        case 'ChangePubKey':
            return transaction.account;
        case 'Withdraw':
            return transaction.ethAddress;
        default:
            throw new Error('Invalid transaction type');
    }
}

export function getFeeType(transaction: any) {
    if (transaction.type == 'ChangePubKey') {
        return {
            ChangePubKey: { onchainPubkeyAuth: false }
            // ChangePubKey: transaction.ethAuthData.type
        };
    }
    return transaction.type;
}

export function formatTx(tx: any, signature: Uint8Array, pubkey: Uint8Array) {
    tx.signature = {
        pubKey: utils.hexlify(pubkey).substr(2),
        signature: utils.hexlify(signature).substr(2)
    };
    tx.fee = ethers.BigNumber.from(tx.fee).toString();
    if ('ethAddress' in tx) {
        tx.to = tx.ethAddress;
    }
    if ('feeTokenId' in tx) {
        tx.feeToken = tx.feeTokenId;
    }
    if ('tokenId' in tx) {
        tx.token = tx.tokenId;
    }
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
): Promise<any[]> {
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
            feeTokenId: sellTokenId,
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
            tokenId: buyTokenId,
            accountId: swapAccount.id,
            from: swapAccount.address,
            to: clientAddress,
            amount: swapData.buy.amount,
            fee: 0,
            feeTokenId: buyTokenId,
            nonce: nonce + 1,
            validFrom: 0,
            validUntil: swapData.timeout
        },

        {
            type: 'Transfer',
            tokenId: sellTokenId,
            accountId: swapAccount.id,
            from: swapAccount.address,
            to: providerAddress,
            amount: swapData.sell.amount,
            fee: 0,
            feeTokenId: sellTokenId,
            nonce: nonce + 2,
            validFrom: 0,
            validUntil: zksync.utils.MAX_TIMESTAMP
        },

        {
            type: 'Transfer',
            tokenId: sellTokenId,
            accountId: swapAccount.id,
            from: swapAccount.address,
            to: clientAddress,
            amount: swapData.sell.amount,
            fee: 0,
            feeTokenId: sellTokenId,
            nonce: nonce + 1,
            validFrom: swapData.timeout + 1,
            validUntil: zksync.utils.MAX_TIMESTAMP
        },

        {
            type: 'Transfer',
            tokenId: buyTokenId,
            accountId: swapAccount.id,
            from: swapAccount.address,
            to: providerAddress,
            amount: swapData.buy.amount,
            fee: 0,
            feeTokenId: buyTokenId,
            nonce: nonce + 2,
            validFrom: swapData.timeout + 1,
            validUntil: zksync.utils.MAX_TIMESTAMP
        }
    ];
}
