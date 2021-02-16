# Atomic Swaps on zkSync

This is a prototype of the Atomic Swap SDK. The implementation contains code for both server and client side.

### Building

`yarn && yarn build` will install dependencies, compile all TS and Solidity code.

### Documentation

To generate docs, run `yarn doc`. This will output HTML docs into the `docs/` folder.

### Testing

#### Setup

For testing, a local **zkSync** setup is necessary.
[See our docs](https://github.com/matter-labs/zksync/blob/master/docs/setup-dev.md).

After setup is complete, run `zk init`.

#### Simple tests

`yarn test` launches the test suite. More tests are on the way.

A local **zkSync** server has to be running (`zk server`).

#### Exodus mode test

Preparation:

1. Compile config (`zk config compile`)
2. Modify the config (in `etc/env/dev/contracts.toml`):
   - set `dummy_verifier` and `easy_exodus` to `true`
3. Initialize the environment (`zk init`)
4. Start the server (`zk server`)
5. Start the prover (`zk dummy-prover run`)

`yarn exodus` launches the test. After test is complete, server is no longer usable (since exodus mode is activated) and will have to be reset.

To reset the server:

- Stop it
- Run `zk contract redeploy`
- Run `zk server --genesis`
- Start the server again with `zk server`
- Restart the dummy-prover

### Troubleshooting

- Check `zk dummy-prover status`, it should be `enabled`. Otherwise, run `zk dummy-prover enable`.
- Make sure you are using `master` branch, not `dev`.
- Make sure you are using latest `zksync.js`. Use `yarn upgrade --latest zksync` to upgrade.
- Make sure you are using latest `zksync` server from our public repo.

### Example usage

// TODO
