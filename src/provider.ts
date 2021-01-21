import * as zksync from 'zksync';
import { pubKeyHash, private_key_to_pubkey, privateKeyFromSeed } from 'zksync-crypto';
import { ethers, utils } from 'ethers';
import { MusigSigner } from './signer';
import { SwapData, SchnorrData, Network } from './types';
import { transpose } from './utils';

export class SwapProvider {
    private signer: MusigSigner;
    private transactions: any[] = [];
    private signatures: Uint8Array[];
    private swapData: SwapData;
    private schnorrData: SchnorrData = {};
    private pubKeyHash: Uint8Array;
    private swapAddress: string;
    private clientAddress: string;
    constructor(private privateKey: string, private publicKey: string, private syncWallet: zksync.Wallet) {}

    static async init(privateKey: string, network: Network) {
        const ethProvider =
            network == 'localhost'
                ? new ethers.providers.JsonRpcProvider('http://localhost:8545')
                : ethers.getDefaultProvider(network);

        const syncProvider = await zksync.getDefaultProvider(network, 'HTTP');
        const ethWallet = new ethers.Wallet(privateKey).connect(ethProvider);

        const syncWallet = await zksync.Wallet.fromEthSigner(ethWallet, syncProvider);
        let chainID = 1;
        if (ethWallet.provider) {
            const network = await ethWallet.provider.getNetwork();
            chainID = network.chainId;
        }
        let message = "Access zkSync account.\n\nOnly sign this message for a trusted client!";
        if (chainID !== 1) {
            message += `\nChain ID: ${chainID}.`;
        }
        const signedBytes = zksync.utils.getSignedBytesFromMessage(message, false);
        const signature = await zksync.utils.signMessagePersonalAPI(ethWallet, signedBytes);
        const seed = ethers.utils.arrayify(signature);
        const privkey = privateKeyFromSeed(seed);
        const pubkey = private_key_to_pubkey(privkey);
        return new SwapProvider(utils.hexlify(privkey), utils.hexlify(pubkey), syncWallet);
    }

    getAddress() {
        return this.syncWallet.address();
    }

    getPubkey() {
        return this.publicKey;
    }

    async createSwap(data: SwapData, publicKey: string, clientAddress: string, checkBargain?: any) {
        if (checkBargain && !checkBargain(data.sell, data.buy)) {
            throw new Error('Swap is not profitable, alter token amounts');
        }
        this.signer = new MusigSigner([this.publicKey, publicKey], 0, 5);
        this.schnorrData.precommitments = this.signer.computePrecommitments();
        this.swapData = data;
        this.clientAddress = clientAddress;
        this.pubKeyHash = pubKeyHash(this.signer.computePubkey());
        this.swapAddress = zksync.utils.getCREATE2AddressAndSalt(
            utils.hexlify(this.pubKeyHash),
            {
                creatorAddress: this.clientAddress,
                saltArg: data.create2.salt,
                codeHash: data.create2.hash
            }
        ).address;
        return {
            publicKey: this.publicKey,
            precommitments: this.schnorrData.precommitments
        };
    }

    async getTransactions(data: SchnorrData, timeout: number = 120, withdraw: 'L1' | 'L2' = 'L2') {
        this.schnorrData.commitments = this.signer.receivePrecommitments(
            transpose([this.schnorrData.precommitments, data.precommitments])
        );
        this.signer.receiveCommitments(transpose([this.schnorrData.commitments, data.commitments]));
        const swapAccount = await this.syncWallet.provider.getState(this.swapAddress);
        if (!swapAccount.id) {
            throw new Error("Swap Account ID not set - can't sign transactions");
        }
        const { totalFee: transferFeeInSoldToken } = await this.syncWallet.provider.getTransactionFee(
            'Transfer',
            this.syncWallet.address(),
            this.swapData.sell.token
        );
        const { totalFee: transferFeeInBoughtToken } = await this.syncWallet.provider.getTransactionFee(
            'Transfer',
            this.syncWallet.address(),
            this.swapData.buy.token
        );
        const { totalFee: cpkFee } = await this.syncWallet.provider.getTransactionFee(
            { ChangePubKey: { onchainPubkeyAuth: false } },
            this.syncWallet.address(),
            this.swapData.sell.token
        );
        const { totalFee: withdrawFee } = await this.syncWallet.provider.getTransactionFee(
            'Withdraw',
            this.syncWallet.address(),
            this.swapData.sell.token
        );
        const buyTokenId = this.syncWallet.provider.tokenSet.resolveTokenId(this.swapData.buy.token);
        const sellTokenId = this.syncWallet.provider.tokenSet.resolveTokenId(this.swapData.sell.token);
        const now = Math.floor(Date.now() / 1000);
        this.transactions = [];
        this.transactions.push({
            type: 'ChangePubKey',
            accountId: swapAccount.id,
            account: swapAccount.address,
            newPkHash: 'sync:'+utils.hexlify(this.pubKeyHash).slice(2),
            nonce: 0,
            feeTokenId: sellTokenId,
            fee: cpkFee,
            validFrom: now,
            validUntil: zksync.utils.MAX_TIMESTAMP,
            ethAuthData: {
                type: 'CREATE2',
                creatorAddress: this.clientAddress,
                saltArg: this.swapData.create2.salt,
                codeHash: this.swapData.create2.hash
            }
        });
        this.transactions.push({
            type: 'Transfer',
            tokenId: buyTokenId,
            accountId: swapAccount.id,
            from: swapAccount.address,
            to: this.clientAddress,
            amount: this.swapData.buy.amount,
            fee: transferFeeInBoughtToken,
            feeTokenId: buyTokenId,
            nonce: 1,
            validFrom: now,
            validUntil: now + timeout
        });

        if (withdraw == 'L1') {
            this.transactions.push({
                type: 'Withdraw',
                tokenId: sellTokenId,
                accoundId: swapAccount.id,
                from: swapAccount.address,
                ethAddress: this.syncWallet.address(),
                amount: this.swapData.sell.amount,
                fee: withdrawFee,
                feeTokenId: sellTokenId,
                nonce: 2,
                validFrom: now,
                validUntil: zksync.utils.MAX_TIMESTAMP
            });
        } else {
            this.transactions.push({
                type: 'Transfer',
                tokenId: sellTokenId,
                accountId: swapAccount.id,
                from: swapAccount.address,
                to: this.syncWallet.address(),
                amount: this.swapData.sell.amount,
                fee: transferFeeInSoldToken,
                feeTokenId: sellTokenId,
                nonce: 2,
                validFrom: now,
                validUntil: zksync.utils.MAX_TIMESTAMP
            });
        }

        this.transactions.push({
            type: 'Transfer',
            tokenId: sellTokenId,
            accountId: swapAccount.id,
            from: swapAccount.address,
            to: this.clientAddress,
            amount: this.swapData.sell.amount,
            fee: transferFeeInSoldToken,
            feeTokenId: sellTokenId,
            nonce: 1,
            validFrom: now + timeout,
            validUntil: zksync.utils.MAX_TIMESTAMP
        });
        this.transactions.push({
            type: 'Transfer',
            tokenId: buyTokenId,
            accountId: swapAccount.id,
            from: swapAccount.address,
            to: this.syncWallet.address(),
            amount: 0,
            fee: transferFeeInBoughtToken,
            feeTokenId: buyTokenId,
            nonce: 2,
            validFrom: now + timeout,
            validUntil: zksync.utils.MAX_TIMESTAMP
        });

        const privateKey = utils.arrayify(this.privateKey);
        this.signatures = [];

        for (let i = 0; i < 5; i++) {
            let bytes: Uint8Array;
            if (this.transactions[i].type == 'Transfer') {
                bytes = this.syncWallet.signer.transferSignBytes(this.transactions[i], 'contracts-4');
            } else if (this.transactions[i].type == 'Withdraw') {
                bytes = this.syncWallet.signer.withdrawSignBytes(this.transactions[i], 'contracts-4');
            } else if (this.transactions[i].type = 'ChangePubKey') {
                bytes = this.syncWallet.signer.changePubKeySignBytes(this.transactions[i], 'contracts-4')
            }
            this.signatures.push(this.signer.sign(privateKey, bytes, i));
        }
        return {
            commitments: this.schnorrData.commitments,
            signatures: this.signatures,
            transactions: this.transactions
        };
    }

    async finalize(signatureShares: Uint8Array[]) {
        const signaturesPacked = signatureShares.map((share, i) =>
            this.signer.receiveSignatureShares([this.signatures[i], share], i)
        );
        const signatures = signaturesPacked.map(sig => {
            return {
                pubKey: utils.hexlify(this.signer.computePubkey()).substr(2),
                signature: utils.hexlify(sig).substr(2)
            };
        });

        this.transactions.forEach((tx, i) => {
            tx.signature = signatures[i];
            tx.feeToken = tx.feeTokenId;
            tx.token = tx.tokenId;
            if (tx.amount) {
                tx.amount = ethers.BigNumber.from(tx.amount).toString();
            }
            tx.fee = ethers.BigNumber.from(tx.fee).toString();
        });
        // TODO check that signatures are correct
        // TODO client must pay the fees
        // TODO add more tests
        // TODO client must store hashes to track txs - let signer return them
        // check that client's funds are in place
        const swapAccount = await this.syncWallet.provider.getState(this.swapAddress);
        if (swapAccount.committed.balances[this.swapData.sell.token] < this.swapData.sell.amount) {
            throw new Error('Client did not deposit funds');
        }
        const handle = await this.syncWallet.syncTransfer({
            to: this.swapAddress,
            amount: this.swapData.buy.amount.add(this.transactions[1].fee),
            token: this.swapData.buy.token
        });
        await handle.awaitReceipt();
        console.log('provider deposited funds');
        console.log('submitting txs')
        for (const tx of this.transactions.slice(0, 3)) {
            const handle = await zksync.wallet.submitSignedTransaction({ tx }, this.syncWallet.provider);
            await handle.awaitReceipt();
            console.log(handle.txHash);
        }
    }
}
