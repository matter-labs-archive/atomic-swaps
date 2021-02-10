# Atomic Swaps on zkSync

This is a prototype of the Atomic Swap SDK. The implementation contains code for both server and client side.

### Building

`yarn && yarn build` will install dependencies, compile all TS and Solidity code.

### Documentation

To generate docs, run `yarn doc`. This will output HTML docs into the `docs/` folder.

### Testing

#### Setup

For testing, a local **zkSync** setup is necessary.
[https://github.com/matter-labs/zksync/blob/master/docs/setup-dev.md](See our docs).

After setup is complete, run `zk init`.

#### Simple tests

`yarn test` launches the test suite. More tests are on the way.

A local **zkSync** server has to be running (`zk server`).

#### Exodus mode test

Preparation:

1. Compile configs (`zk config compile`)
2. Modify the configs (in `etc/env/dev/*`):
    - set `dummy_verifier` and `easy_exodus` to `true` in `contracts.toml`
    - set `block_commit_deadline`, `block_prove_deadline` and `block_execute_deadline` to `10` in `chain.toml`
3. Initialize the environment (`zk init`)
4. Start the server (`zk server`)
5. Start the prover (`zk dummy_prover run`)

`yarn exodus` launches the test. After test is complete, server is no longer usable (since it is in exodus mode) and will have to be re-`init`ed.

### Example usage

// TODO

