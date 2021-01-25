import { expect } from 'chai';
import { SwapProvider } from '../src/provider';
import { SwapClient } from '../src/client';
import { SwapData } from '../src/types';
import { ethers, utils } from 'ethers';
import * as zksync from 'zksync';
import * as crypto from 'crypto';
import fs from 'fs';

const RICH_PRIVATE_KEY = '0x7726827caac94a7f9e1b160f7ea819f172f7b6f9d2a97f992c38edeab82d4110';

describe('Test suite', () => {
    let client: SwapClient;
    let provider: SwapProvider;
    let ethProvider: ethers.providers.Provider;
    let syncProvider: zksync.Provider;

    const swapData: SwapData = {
        sell: {
            token: 'ETH',
            amount: utils.parseEther('1.0')
        },
        buy: {
            token: 'DAI',
            amount: utils.parseUnits('1000.0', 18)
        },
        // ten minutes since now
        timeout: Math.floor(Date.now() / 1000) + 600,
        // L2 is transfer, L1 is withdraw
        withdrawType: 'L2',
        create2: {
            salt: null,
            hash: utils.keccak256('0x' + fs.readFileSync('build/rescuer_sol_Rescuer.bin').toString())
        }
    };

    async function createWallet(richWallet: zksync.Wallet, token: zksync.types.TokenLike, amount: ethers.BigNumber) {
        const ethWallet = ethers.Wallet.createRandom().connect(ethProvider);
        const syncWallet = await zksync.Wallet.fromEthSigner(ethWallet, syncProvider);
        const deposit = await richWallet.depositToSyncFromEthereum({
            depositTo: syncWallet.address(),
            token,
            amount,
            approveDepositAmountForERC20: true
        });
        await deposit.awaitReceipt();
        const changepubkey = await syncWallet.setSigningKey({
            feeToken: token,
            ethAuthType: 'ECDSA'
        });
        await changepubkey.awaitReceipt();
        return ethWallet.privateKey;
    }

    async function exchangeSwapInfo(client: SwapClient, provider: SwapProvider) {
        const response = await provider.prepareSwap(swapData, client.pubkey(), client.address());
        console.log('    provider prepared for the swap');
        const data = await client.prepareSwap(swapData, response.publicKey, response.address, response.precommitments);
        console.log('    client prepared for the swap');
        const txs = await provider.signSwap(data);
        console.log('    provider signed transactions');
        const { swap, shares } = await client.signSwap(txs);
        console.log('    client signed transactions');
        await provider.checkSwap(shares);
        console.log('    provider checked swap validity');
        return swap;
    }

    before('Init client and provider', async () => {
        ethProvider = new ethers.providers.JsonRpcProvider();
        syncProvider = await zksync.getDefaultProvider('localhost', 'HTTP');
        const richWallet = await zksync.Wallet.fromEthSigner(
            new ethers.Wallet(RICH_PRIVATE_KEY).connect(ethProvider),
            syncProvider
        );
        const clientKey = await createWallet(richWallet, 'ETH', utils.parseEther('5.0'));
        const providerKey = await createWallet(richWallet, 'DAI', utils.parseUnits('5000.0', 18));
        client = await SwapClient.init(clientKey, ethProvider, syncProvider);
        provider = await SwapProvider.init(providerKey, ethProvider, syncProvider);
    });

    beforeEach('Change CREATE2 salt', () => {
        const seed = crypto.randomFillSync(new Uint8Array(4));
        swapData.create2.salt = utils.keccak256(seed);
        client.reset();
        provider.reset();
    });

    it('should perform atomic swap, finalized by provider', async () => {
        const providerBalance = (await syncProvider.getState(provider.address())).committed.balances;
        const clientBalance = (await syncProvider.getState(client.address())).committed.balances;
        expect(providerBalance.ETH).to.not.exist;
        expect(clientBalance.DAI).to.not.exist;

        const swap = await exchangeSwapInfo(client, provider);
        await Promise.all([
            swap.wait(),
            (async () => {
                await new Promise((r) => setTimeout(r, 3000));
                await provider.depositFunds();
                await provider.finalizeSwap();
            })()
        ]);

        const newProviderBalance = (await syncProvider.getState(provider.address())).committed.balances;
        const newClientBalance = (await syncProvider.getState(client.address())).committed.balances;
        expect(newProviderBalance.ETH).to.eq(utils.parseEther('1.0').toString());
        expect(newClientBalance.DAI).to.eq(utils.parseUnits('1000.0', 18).toString());
    });

    it('should perform atomic swap, finalized by client', async () => {
        const swap = await exchangeSwapInfo(client, provider);
        await provider.depositFunds();
        await swap.finalize();

        const clientBalance = (await syncProvider.getState(client.address())).committed.balances;
        expect(clientBalance.DAI).to.eq(utils.parseUnits('2000.0', 18).toString());
    });

    it('should perform atomic swap, withdraw to L1', async () => {
        swapData.withdrawType = 'L1';
        const _swap = await exchangeSwapInfo(client, provider);
        await provider.depositFunds();
        await provider.finalizeSwap();
    });
});
