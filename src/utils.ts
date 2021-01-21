import * as ethers from 'ethers';
import * as zksync from 'zksync';
import { private_key_to_pubkey, privateKeyFromSeed } from 'zksync-crypto';

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
