# Atomic Swaps on zkSync

This is a prototype of the Atomic Swap SDK. The implementation contains code for both server and client side.

### Building

`yarn && yarn build` will install dependencies, compile the TS code into JS and compile the `Rescuer` contract.

### Documentation

To generate docs, run `yarn doc`. This will output HTML docs into the `docs/` folder.

### Testing

`yarn test` launches the test suite. More tests are on the way.

A local zkSync server has to be running. Currently this depends on an unreleased version of the zkSync server.
