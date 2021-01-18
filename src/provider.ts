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
        // this.clientAddress = ethers.utils.computeAddress(publicKey);
        this.clientAddress = clientAddress;
        this.pubKeyHash = pubKeyHash(this.signer.computePubkey());
        this.swapAddress = ethers.utils.getCreate2Address(
            this.clientAddress,
            utils.keccak256(utils.concat([this.pubKeyHash, data.create2.salt])),
            data.create2.hash
        );
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
        const { totalFee: transferFee } = await this.syncWallet.provider.getTransactionFee(
            'Transfer',
            this.syncWallet.address(),
            this.swapData.sell.token
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
        const tokenSet = this.syncWallet.provider.tokenSet;
        const now = Math.floor(Date.now() / 1000);
        const feeTokenId = tokenSet.resolveTokenId(this.swapData.sell.token);
        this.transactions = [];
        this.transactions.push({
            type: 'ChangePubKey',
            accountId: swapAccount.id,
            account: swapAccount.address,
            newPkHash: 'sync:'+utils.hexlify(this.pubKeyHash).slice(2),
            nonce: 0,
            feeTokenId,
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
            tokenId: tokenSet.resolveTokenId(this.swapData.buy.token),
            accountId: swapAccount.id,
            from: swapAccount.address,
            to: this.clientAddress,
            amount: this.swapData.buy.amount,
            fee: transferFee,
            feeTokenId,
            nonce: 1,
            validFrom: now,
            validUntil: now + timeout
        });

        if (withdraw == 'L1') {
            this.transactions.push({
                type: 'Withdraw',
                tokenId: tokenSet.resolveTokenId(this.swapData.sell.token),
                accoundId: swapAccount.id,
                from: swapAccount.address,
                ethAddress: this.syncWallet.address(),
                amount: this.swapData.sell.amount,
                fee: withdrawFee,
                feeTokenId,
                nonce: 2,
                validFrom: now,
                validUntil: zksync.utils.MAX_TIMESTAMP
            });
        } else {
            this.transactions.push({
                type: 'Transfer',
                tokenId: tokenSet.resolveTokenId(this.swapData.sell.token),
                accountId: swapAccount.id,
                from: swapAccount.address,
                to: this.syncWallet.address(),
                amount: this.swapData.sell.amount,
                fee: transferFee,
                feeTokenId,
                nonce: 2,
                validFrom: now,
                validUntil: zksync.utils.MAX_TIMESTAMP
            });
        }

        this.transactions.push({
            type: 'Transfer',
            tokenId: tokenSet.resolveTokenId(this.swapData.sell.token),
            accountId: swapAccount.id,
            from: swapAccount.address,
            to: this.clientAddress,
            amount: this.swapData.sell.amount,
            fee: transferFee,
            feeTokenId,
            nonce: 1,
            validFrom: now + timeout,
            validUntil: zksync.utils.MAX_TIMESTAMP
        });
        this.transactions.push({
            type: 'Transfer',
            tokenId: tokenSet.resolveTokenId(this.swapData.buy.token),
            accountId: swapAccount.id,
            from: swapAccount.address,
            to: this.syncWallet.address(),
            amount: 0,
            fee: transferFee,
            feeTokenId,
            nonce: 2,
            validFrom: now + timeout,
            validUntil: zksync.utils.MAX_TIMESTAMP
        });

        const privateKey = utils.arrayify(this.privateKey);
        this.signatures = [];

        for (let i = 0; i < 5; i++) {
            const bytes =
                i == 0
                    ? this.syncWallet.signer.changePubKeySignBytes(this.transactions[i])
                    // TODO: or withdrawSignBytes
                    : this.syncWallet.signer.transferSignBytes(this.transactions[i]);
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
        const signatures = signaturesPacked.map(sig => Object.fromEntries([
            ['pubKey', utils.hexlify(this.signer.computePubkey()).substr(2)],
            ['signature', utils.hexlify(sig).substr(2)]
        ]));

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
        // TODO calculate hash before sending
        // check that client's funds are in place
        const swapAccount = await this.syncWallet.provider.getState(this.swapAddress);
        if (swapAccount.committed.balances[this.swapData.sell.token] < this.swapData.sell.amount) {
            throw new Error('Client did not deposit funds');
        }
        // TODO provider push pay their part of swap
        console.log('submitting txs')
        let hashes = [];
        for (const tx of this.transactions) {
            console.log(tx);
            const hash = await this.syncWallet.provider.submitTx(tx);
            hashes.push(hash);
            console.log(hash)
        }
        return hashes;
    }
}
