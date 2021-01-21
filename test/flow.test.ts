import { expect } from 'chai';
import { SwapProvider } from '../src/provider';
import { SwapClient } from '../src/client';
import { SwapData } from '../src/types';
import { ethers, utils, BigNumber } from 'ethers';
import * as zksync from 'zksync';
import fs from 'fs';

const RICH_PRIVATE_KEY = '0x7726827caac94a7f9e1b160f7ea819f172f7b6f9d2a97f992c38edeab82d4110';

describe('Test suite', () => {
    let client: SwapClient;
    let provider: SwapProvider;
    const swapData: SwapData = {
        sell: {
            token: 'ETH',
            amount: utils.parseEther('1.0')
        },
        buy: {
            token: 'DAI',
            amount: utils.parseUnits('1000.0', 18)
        },
        timeout: 600,
        create2: {
            salt: utils.keccak256('0xdeadbeef'),
            hash: utils.keccak256('0x' + fs.readFileSync('build/Rescuer.bin').toString())
        }
    };

    before('Init client and provider', async () => {
        const ethProvider = new ethers.providers.JsonRpcProvider();
        const syncProvider = await zksync.getDefaultProvider('localhost', 'HTTP');
        const providerWallet = ethers.Wallet.createRandom().connect(ethProvider);
        const clientWallet = ethers.Wallet.createRandom().connect(ethProvider);
        const richWallet = await zksync.Wallet.fromEthSigner(
            new ethers.Wallet(RICH_PRIVATE_KEY).connect(ethProvider),
            syncProvider
        );

        client = await SwapClient.init(clientWallet.privateKey, 'localhost');
        provider = await SwapProvider.init(providerWallet.privateKey, 'localhost');

        const depositETH = await richWallet.depositToSyncFromEthereum({
            depositTo: clientWallet.address,
            token: 'ETH',
            amount: utils.parseEther('2.0')
        });
        await depositETH.awaitReceipt();
        const depositDAI = await richWallet.depositToSyncFromEthereum({
            depositTo: providerWallet.address,
            token: 'DAI',
            amount: utils.parseUnits('2000.0', 18),
            approveDepositAmountForERC20: true
        });
        await depositDAI.awaitReceipt();

        const syncClientWallet = await zksync.Wallet.fromEthSigner(clientWallet, syncProvider);
        const syncProviderWallet = await zksync.Wallet.fromEthSigner(providerWallet, syncProvider);

        if (!(await syncClientWallet.isSigningKeySet())) {
            const changepubkey = await syncClientWallet.setSigningKey({
                feeToken: 'ETH',
                ethAuthType: 'ECDSA'
            });
            await changepubkey.awaitReceipt();
        }
        if (!(await syncProviderWallet.isSigningKeySet())) {
            const changepubkey = await syncProviderWallet.setSigningKey({
                feeToken: 'DAI',
                ethAuthType: 'ECDSA'
            });
            await changepubkey.awaitReceipt();
        }
    });

    it('should perform atomic swap', async () => {
        const syncProvider = await zksync.getDefaultProvider('localhost', 'HTTP');
        const providerBalance = (await syncProvider.getState(provider.address())).committed.balances;
        const clientBalance = (await syncProvider.getState(client.address())).committed.balances;
        expect(providerBalance.ETH).to.not.exist;
        expect(clientBalance.DAI).to.not.exist;

        let response = await provider.prepareSwap(swapData, client.pubkey(), client.address());
        console.log('    provider prepared for the swap');
        let data = await client.prepareSwap(swapData, response.publicKey, response.precommitments);
        console.log('    client prepared for the swap');
        let txs = await provider.signSwap(data);
        console.log('    provider signed transactions');
        let { swap, shares } = await client.signSwap(txs);
        console.log('    client signed transactions');
        await provider.checkSwap(shares);
        console.log('    provider checked swap validity');
        await Promise.all([swap.wait(), (async () => {
            await new Promise(r => setTimeout(r, 5000));
            await provider.depositFunds();
            await provider.finalizeSwap();
        })()]);
        console.log('    provider finalized the swap');

        const newProviderBalance = (await syncProvider.getState(provider.address())).committed.balances;
        const newClientBalance = (await syncProvider.getState(client.address())).committed.balances;
        expect(newProviderBalance.ETH).to.eq(utils.parseEther('1.0').toString());
        expect(newClientBalance.DAI).to.eq(utils.parseUnits('1000.0', 18).toString());
    });
});
