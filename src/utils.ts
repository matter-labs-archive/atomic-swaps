import { ethers, utils } from 'ethers';
import * as zksync from 'zksync';
import { private_key_to_pubkey, privateKeyFromSeed } from 'zksync-crypto';
import { SwapData } from './types';

export const TOTAL_TRANSACTIONS = 5;
export const SYNC_PREFIX = 'sync:';
export const SYNC_TX_PREFIX = 'sync-tx:';
const DEFAULT_PUBKEY_HASH = 'sync:0000000000000000000000000000000000000000';

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
    const seed = ethers.utils.arrayify(signature);
    const privkey = privateKeyFromSeed(seed);
    const pubkey = private_key_to_pubkey(privkey);
    return { privkey, pubkey };
}

export async function isSigningKeySet(address: zksync.types.Address, provider: zksync.Provider) {
    const account = await provider.getState(address);
    return account.committed.pubKeyHash != DEFAULT_PUBKEY_HASH;
}

export function getSignBytes(transaction: any, signer: zksync.Signer): Uint8Array {
    if (transaction.type == 'Transfer') {
        return signer.transferSignBytes(transaction, 'contracts-4');
    } else if (transaction.type == 'Withdraw') {
        return signer.withdrawSignBytes(transaction, 'contracts-4');
    } else if (transaction.type == 'ChangePubKey') {
        return signer.changePubKeySignBytes(transaction, 'contracts-4');
    } else {
        throw new Error('Invalid transaction type');
    }
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
    const { totalFee: transferSold } = await syncProvider.getTransactionFee(
        'Transfer',
        providerAddress,
        swapData.sell.token
    );
    const { totalFee: transferBought } = await syncProvider.getTransactionFee(
        'Transfer',
        providerAddress,
        swapData.buy.token
    );
    const { totalFee: changePubKey } = await syncProvider.getTransactionFee(
        { ChangePubKey: { onchainPubkeyAuth: false } },
        providerAddress,
        swapData.sell.token
    );
    const { totalFee: withdraw } = await syncProvider.getTransactionFee(
        'Withdraw',
        providerAddress,
        swapData.sell.token
    );
    const fees = { transferSold, transferBought, changePubKey, withdraw };

    const swapAccount = await syncProvider.getState(swapAddress);
    if (!swapAccount.id) {
        throw new Error("Swap Account ID not set - can't sign transactions");
    }
    const buyTokenId = syncProvider.tokenSet.resolveTokenId(swapData.buy.token);
    const sellTokenId = syncProvider.tokenSet.resolveTokenId(swapData.sell.token);
    const nonce = swapAccount.committed.nonce;

    // prettier-ignore
    return [
    {
        type: 'ChangePubKey',
        accountId: swapAccount.id,
        account: swapAccount.address,
        newPkHash: utils.hexlify(pubKeyHash).replace('0x', SYNC_PREFIX),
        nonce,
        feeTokenId: sellTokenId,
        fee: fees.changePubKey,
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
        fee: fees.transferBought,
        feeTokenId: buyTokenId,
        nonce: nonce + 1,
        validFrom: 0,
        validUntil: swapData.timeout
    },

    (swapData.withdrawType == 'L1') ? {
        type: 'Withdraw',
        tokenId: sellTokenId,
        accountId: swapAccount.id,
        from: swapAccount.address,
        ethAddress: providerAddress,
        amount: swapData.sell.amount,
        fee: fees.withdraw,
        feeTokenId: sellTokenId,
        nonce: nonce + 2,
        validFrom: 0,
        validUntil: zksync.utils.MAX_TIMESTAMP
    } : {
        type: 'Transfer',
        tokenId: sellTokenId,
        accountId: swapAccount.id,
        from: swapAccount.address,
        to: providerAddress,
        amount: swapData.sell.amount,
        fee: fees.transferSold,
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
        fee: fees.transferSold,
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
        fee: fees.transferBought,
        feeTokenId: buyTokenId,
        nonce: nonce + 2,
        validFrom: swapData.timeout + 1,
        validUntil: zksync.utils.MAX_TIMESTAMP
    }];
}
