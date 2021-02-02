import { expect } from 'chai';
import { SwapProvider } from '../src/provider';
import { SwapClient } from '../src/client';
import { SwapData } from '../src/types';
import { ethers, utils, BigNumber } from 'ethers';
import * as zksync from 'zksync';
import * as crypto from 'crypto';
import fs from 'fs';

const RICH_PRIVATE_KEY = '0x7726827caac94a7f9e1b160f7ea819f172f7b6f9d2a97f992c38edeab82d4110';
const CONTRACT = 'build/contracts_Rescuer_sol_Rescuer.bin';

describe('Tests', () => {
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
            // address of the factory contract that will deploy the escrow contract using create2
            creator: utils.hexlify(crypto.randomBytes(20)),
            salt: null,
            hash: null
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

    async function getBalance(address: string, token: zksync.types.TokenLike) {
        const state = await syncProvider.getState(address);
        return BigNumber.from(state.committed.balances[token] || '0');
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
        await client.depositFunds('L2');
        console.log('    client deposited funds');
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

        const bytecode = fs.readFileSync(CONTRACT).toString();
        // address of the deployed DAI contract would go here
        const daiAddress = utils.hexlify(crypto.randomBytes(20));
        // we use zero-address if the token is ETH
        const ethAddress = utils.hexlify(new Uint8Array(20));
        const args = client.address() + provider.address() + ethAddress + daiAddress;
        // compute the hash of the to-be-deployed code of escrow contract
        swapData.create2.hash = utils.keccak256('0x' + bytecode + args.replace(/0x/g, ''));
    });

    beforeEach('Change CREATE2 salt', () => {
        swapData.create2.salt = utils.hexlify(crypto.randomFillSync(new Uint8Array(32)));
        client.reset();
        provider.reset();
    });

    it('should perform atomic swap, finalized by provider', async () => {
        const providerBalance = await getBalance(provider.address(), 'ETH');
        const clientBalance = await getBalance(client.address(), 'DAI');

        const swap = await exchangeSwapInfo(client, provider);
        await Promise.all([
            swap.wait(),
            (async () => {
                await new Promise((r) => setTimeout(r, 3000));
                await provider.depositFunds('L2');
                await provider.finalizeSwap();
            })()
        ]);

        const newProviderBalance = await getBalance(provider.address(), 'ETH');
        const newClientBalance = await getBalance(client.address(), 'DAI');
        expect(newProviderBalance.sub(providerBalance).eq(utils.parseEther('1.0'))).to.be.true;
        expect(newClientBalance.sub(clientBalance).eq(utils.parseUnits('1000.0', 18))).to.be.true;
    });

    it('should perform atomic swap, finalized by client', async () => {
        const clientBalance = await getBalance(client.address(), 'DAI');

        const swap = await exchangeSwapInfo(client, provider);
        await provider.depositFunds('L2');
        await swap.finalize();

        const newClientBalance = await getBalance(client.address(), 'DAI');
        expect(newClientBalance.sub(clientBalance).eq(utils.parseUnits('1000.0', 18))).to.be.true;
    });

    it('should perform atomic swap, withdraw to L1', async () => {
        const clientBalance = await getBalance(client.address(), 'DAI');

        swapData.withdrawType = 'L1';
        await exchangeSwapInfo(client, provider);
        await provider.depositFunds('L2');
        await provider.finalizeSwap();

        const newClientBalance = await getBalance(client.address(), 'DAI');
        expect(newClientBalance.sub(clientBalance).eq(utils.parseUnits('1000.0', 18))).to.be.true;
    });

    it('should cancel an atomic swap', async () => {
        const clientBalance = (await syncProvider.getState(client.address())).committed.balances;

        swapData.timeout = Math.floor(Date.now() / 1000);
        const swap = await exchangeSwapInfo(client, provider);
        await swap.cancel();

        const newClientBalance = (await syncProvider.getState(client.address())).committed.balances;
        const difference = BigNumber.from(clientBalance.ETH).sub(newClientBalance.ETH);
        expect(difference.lt(utils.parseEther('0.1'))).to.be.true;
    });
});
