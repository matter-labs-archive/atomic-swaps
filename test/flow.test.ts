import { expect } from 'chai';
import { SwapProvider } from '../src/provider';
import { SwapClient } from '../src/client';
import { SwapData } from '../src/types';
import { ethers, utils } from 'ethers';
import * as zksync from 'zksync';

describe('Test suite', () => {
    let client: SwapClient;
    let provider: SwapProvider;
    const swapData: SwapData = {
        sell: {
            token: 'ETH',
            amount: 1
        },
        buy: {
            token: 'DAI',
            amount: 500
        },
        timeout: 600,
        create2: {
            salt: utils.keccak256('0x1234'),
            hash: utils.keccak256('0x5678')
        }
    };

    before('Init client and provider', async () => {
        const ethProvider = new ethers.providers.JsonRpcProvider();
        const providerWallet = ethers.Wallet.createRandom().connect(ethProvider);
        const clientWallet = ethers.Wallet.createRandom().connect(ethProvider);
        const richWallet = new ethers.Wallet("0x7726827caac94a7f9e1b160f7ea819f172f7b6f9d2a97f992c38edeab82d4110").connect(ethProvider);

        client = await SwapClient.init(clientWallet.privateKey, 'localhost');
        provider = await SwapProvider.init(providerWallet.privateKey, 'localhost');
        const tx = await richWallet.sendTransaction({ 
            to: clientWallet.address, 
            value: utils.parseEther('1.1') 
        });
        await tx.wait();
        const syncWallet = await zksync.Wallet.fromEthSigner(
            clientWallet,
            await zksync.getDefaultProvider('localhost', 'HTTP')
        )
        const deposit = await syncWallet.depositToSyncFromEthereum({
            depositTo: syncWallet.address(),
            token: 'ETH',
            amount: ethers.utils.parseEther('1.0')
        })
        console.log('deposited');
        await deposit.awaitReceipt();
        if (!await syncWallet.isSigningKeySet()) {
            const changepubkey = await syncWallet.setSigningKey({ 
                feeToken: 'ETH',
                ethAuthType: 'ECDSA'
            })
            await changepubkey.awaitReceipt();
            console.log('changepubkeyed')
        }
    })

    it('should perform atomic swap', async () => {
        let response = await provider.createSwap(swapData, client.getPubkey(), client.getAddress());
        console.log('provider received swap data');
        let data = await client.prepareSwap(swapData, response.publicKey, response.precommitments);
        console.log('client prepared for swap');
        let txs = await provider.getTransactions(data);
        console.log('client received semi-signed transactions');
        let { swap, signatures } = await client.createSwap(txs);
        console.log('swap created');
        let hashes = await provider.finalize(signatures);
        console.log('swap finalized');
        console.log('hashes:', hashes)
        await swap.wait(hashes[0]) // or swap.cancel() or swap.finish()
        console.log('swap committed');
    });
});
