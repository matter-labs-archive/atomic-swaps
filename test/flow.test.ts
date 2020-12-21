import { expect } from 'chai';
import { SwapProvider } from '../src/provider';
import { SwapClient } from '../src/client';
import { SwapData } from '../src/types';
import { ethers, utils } from 'ethers';

describe('Test suite', () => {
    const providerSK = ethers.Wallet.createRandom().privateKey;
    const clientSK = ethers.Wallet.createRandom().privateKey;

    let client: SwapClient;
    let provider: SwapProvider;

    before('Init client and provider', async () => {
        client = await SwapClient.init(clientSK, 'localhost');
        provider = await SwapProvider.init(providerSK, 'localhost');
    })

    it('should perform an atomic swap', async () => {
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
                salt: '',
                hash: ''
            }
        };
        let response = await provider.createSwap(swapData, client.getPubkey());
        let data = await client.prepareSwap(swapData, response.publicKey, response.precommitments);
        let txs = await provider.getTransactions(data, 'L2');
        let { swap, signatures } = await client.createSwap(txs);
        let hashes = provider.finalize(signatures);
        await swap.wait(hashes[0]) // or swap.cancel() or swap.finish()
    });
});
