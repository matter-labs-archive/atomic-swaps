import { expect } from 'chai';
import { SwapProvider } from '../src/provider';
import { SwapClient } from '../src/client';
import { SwapData } from '../src/types';
import { ethers, utils, BigNumber } from 'ethers';
import * as zksync from 'zksync';
import * as crypto from 'crypto';
import fs from 'fs';
import { exec as _exec } from 'child_process';
import { promisify } from 'util';

const exec = promisify(_exec);
const RICH_PRIVATE_KEY = '0x7726827caac94a7f9e1b160f7ea819f172f7b6f9d2a97f992c38edeab82d4110';
const RESCUER_CONTRACT = 'build/contracts_Rescuer_sol_Rescuer.bin';
const DEPLOYER_CONTRACT = 'build/contracts_Deployer_sol_Deployer.bin';

describe('Tests', () => {
    let client: SwapClient;
    let provider: SwapProvider;
    let rich: ethers.Wallet;
    let ethProvider: ethers.providers.Provider;
    let syncProvider: zksync.Provider;
    let deployer: ethers.Contract;

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
        create2: {
            creator: null,
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

    async function exchangeSwapInfo(client: SwapClient, provider: SwapProvider, verify: boolean = false) {
        const response = await provider.prepareSwap(swapData, client.pubkey(), client.address());
        console.log('    provider prepared for the swap');
        const data = await client.prepareSwap(swapData, response.publicKey, response.address, response.precommitments);
        console.log('    client prepared for the swap');
        const txs = await provider.signSwap(data);
        console.log('    provider signed transactions');
        const shares = await client.signSwap(txs);
        console.log('    client signed transactions');
        const hash = await client.depositFunds('L2');
        console.log('    client deposited funds');
        await provider.checkSwap(shares);
        console.log('    provider checked swap validity');
        if (verify) {
            await syncProvider.notifyTransaction(hash, 'VERIFY');
        }
    }

    before('Init client and provider', async () => {
        // connect to providers
        ethProvider = new ethers.providers.JsonRpcProvider();
        syncProvider = await zksync.getDefaultProvider('localhost', 'HTTP');

        // create helper wallets, client and provider
        rich = new ethers.Wallet(RICH_PRIVATE_KEY).connect(ethProvider);
        const richWallet = await zksync.Wallet.fromEthSigner(rich, syncProvider);
        const clientKey = await createWallet(richWallet, 'ETH', utils.parseEther('50.0'));
        const providerKey = await createWallet(richWallet, 'DAI', utils.parseUnits('50000.0', 18));
        client = (await SwapClient.init(clientKey, ethProvider, syncProvider)) as SwapClient;
        provider = (await SwapProvider.init(providerKey, ethProvider, syncProvider)) as SwapProvider;

        // extract CREATE2 data
        const rescuerBytecode = '0x' + fs.readFileSync(RESCUER_CONTRACT).toString();
        // address of the deployed DAI contract goes here
        const daiAddress = syncProvider.tokenSet.resolveTokenAddress('DAI');
        // we use zero-address if the token is ETH
        const ethAddress = syncProvider.tokenSet.resolveTokenAddress('ETH');
        const args = [client.address(), provider.address(), ethAddress, daiAddress].map((address) =>
            utils.hexlify(utils.zeroPad(address, 32))
        );
        // compute the hash of the to-be-deployed code of escrow contract
        swapData.create2.hash = utils.keccak256(rescuerBytecode + args.join('').replace(/0x/g, ''));

        // deploy the factory contract
        const abi = ['function deploy(bytes32, address, address, address, address)'];
        const deployerBytecode = '0x' + fs.readFileSync(DEPLOYER_CONTRACT).toString();
        const factory = new ethers.ContractFactory(abi, deployerBytecode, rich);
        deployer = await factory.deploy();
        await deployer.deployed();
        swapData.create2.creator = deployer.address;
    });

    beforeEach('Change CREATE2 salt', () => {
        swapData.create2.salt = utils.hexlify(crypto.randomFillSync(new Uint8Array(32)));
        client.reset();
        provider.reset();
    });

    it('should perform atomic swap, finalized by provider', async () => {
        const providerBalance = await getBalance(provider.address(), 'ETH');
        const clientBalance = await getBalance(client.address(), 'DAI');

        await exchangeSwapInfo(client, provider);
        await Promise.all([
            client.wait(),
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

        await exchangeSwapInfo(client, provider);
        await provider.depositFunds('L2');
        await client.finalizeSwap();

        const newClientBalance = await getBalance(client.address(), 'DAI');
        expect(newClientBalance.sub(clientBalance).eq(utils.parseUnits('1000.0', 18))).to.be.true;
    });

    it('should cancel an atomic swap', async () => {
        const clientBalance = (await syncProvider.getState(client.address())).committed.balances;

        swapData.timeout = Math.floor(Date.now() / 1000);
        await exchangeSwapInfo(client, provider);
        await client.cancelSwap();

        const newClientBalance = (await syncProvider.getState(client.address())).committed.balances;
        const difference = BigNumber.from(clientBalance.ETH).sub(newClientBalance.ETH);
        // fees are the difference
        expect(difference.lt(utils.parseEther('0.1'))).to.be.true;

        swapData.timeout = Math.floor(Date.now() / 1000) + 600;
    });

    describe('Exodus mode test', () => {
        it('should rescue funds in case of exodus mode', async () => {
            // zk dummy-prover enable --no-redeploy
            // EASY_EXODUS=true zk init
            // zk server
            // zk dummy-prover run
            const syncContract = new ethers.Contract(
                syncProvider.contractAddress.mainContract,
                zksync.utils.SYNC_MAIN_CONTRACT_INTERFACE,
                rich
            );

            let verifyTxHash = '';
            ethProvider.on(syncContract.filters.BlockVerification(), (event) => {
                verifyTxHash = event.transactionHash;
            });

            await exchangeSwapInfo(client, provider, true);
            const hash = await provider.depositFunds('L2');

            // wait until the deposits are verified
            await syncProvider.notifyTransaction(hash, 'VERIFY');
            console.log('      transactions verified');

            // enter exodus mode
            const activate = await syncContract.activateExodusMode();
            const tx = await activate.wait();
            expect(tx.events[0].event).to.equal('ExodusMode');
            console.log('      exodus mode entered');

            // generate exit proof
            const swapAccount = await syncProvider.getState(client.swapAddress());
            const command = `zk run exit-proof --account ${swapAccount.id} --token ETH`;
            const { stdout } = await exec(command);
            const exitData = JSON.parse(stdout.slice(stdout.indexOf('{')));
            console.log('      exit proof generated');

            // fetch data about last verified block
            const verifyTx = await ethProvider.getTransaction(verifyTxHash);
            const blockInfoBytes = utils.arrayify(verifyTx.data);
            const blockInfo = {
                blockNumber: utils.hexlify(blockInfoBytes.slice(100, 132)),
                priorityOperations: utils.hexlify(blockInfoBytes.slice(132, 164)),
                pendingOnchainOperationsHash: blockInfoBytes.slice(164, 196),
                timestamp: utils.hexlify(blockInfoBytes.slice(196, 228)),
                stateHash: blockInfoBytes.slice(228, 260),
                commitment: blockInfoBytes.slice(260, 292)
            };
            console.log('      verified block info fetched');

            // post exit proof onchain
            const exit = await syncContract.performExodus(
                blockInfo,
                exitData.account_address,
                exitData.account_id,
                exitData.token_id,
                exitData.amount,
                exitData.proof.proof,
                {
                    gasLimit: 1_000_000
                }
            );
            await exit.wait();
            console.log('      exit performed');

            // withdraw funds to the escrow contract
            const withdraw = await syncContract.withdrawPendingBalance(
                client.swapAddress(),
                syncProvider.tokenSet.resolveTokenAddress('ETH'),
                exitData.amount
            );
            await withdraw.wait();

            // verify that costs are accrued
            const balance = await ethProvider.getBalance(client.swapAddress());
            expect(balance.gte(utils.parseEther('1.0'))).to.be.true;
            console.log('      funds withdrawn to the escrow contract');

            // deploy escrow contract
            const deploy = await deployer.deploy(
                client.swapSalt(),
                client.address(),
                provider.address(),
                syncProvider.tokenSet.resolveTokenAddress('ETH'),
                syncProvider.tokenSet.resolveTokenAddress('DAI')
            );
            await deploy.wait();
            console.log('      escrow contract deployed');

            const abi = ['function clientWithdraw()', 'function providerWithdraw()'];
            const rescuer = new ethers.Contract(client.swapAddress(), abi, rich);

            // rescue the funds and verify that transfer is correct
            const rescue = await rescuer.clientWithdraw();
            await rescue.wait();

            const clientBalance = await ethProvider.getBalance(client.address());
            expect(clientBalance.gte(utils.parseEther('1.0'))).to.be.true;
            console.log('      funds rescued from the escrow contract');
        });
    });
});
