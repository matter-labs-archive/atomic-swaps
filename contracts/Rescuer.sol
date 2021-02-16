// SPDX-License-Identifier: MIT OR Apache-2.0

pragma solidity ^0.7.0;

import './IERC20.sol';

interface ZkSync {
    function requestFullExit(uint32 accountId, address token) external;
}

contract Rescuer {
    address payable public client;
    address payable public provider;

    address public clientToken;
    address public providerToken;

    uint64 public timeout;
    ZkSync zksync;

    constructor(
        address _client,
        address _provider,
        address _clientToken,
        address _providerToken,
        uint64 _timeout,
        address _zksync
    ) {
        client = payable(_client);
        provider = payable(_provider);
        clientToken = _clientToken;
        providerToken = _providerToken;
        timeout = _timeout;
        zksync = ZkSync(_zksync);
    }

    function clientWithdraw() external {
        withdraw(client, clientToken);
    }

    function providerWithdraw() external {
        withdraw(provider, providerToken);
    }

    function withdraw(address payable recipient, address token) internal {
        bool success;
        if (token == address(0)) {
            uint256 balance = address(this).balance;
            (success, ) = recipient.call{value: balance}('');
        } else {
            IERC20 erc20 = IERC20(token);
            uint256 balance = erc20.balanceOf(address(this));
            (bool callSuccess, bytes memory returnedValue) =
                token.call(abi.encodeWithSelector(erc20.transfer.selector, recipient, balance));
            // `.transfer()` may optionally return bool
            bool returnedSuccess = returnedValue.length == 0 || abi.decode(returnedValue, (bool));
            success = callSuccess && returnedSuccess;
        }
        require(success, 'Transfer failed');
    }

    function clientExit(uint32 accountId) external {
        require(block.timestamp > timeout, 'Too early');
        require(msg.sender == client, 'Invalid sender');
        zksync.requestFullExit(accountId, clientToken);
    }

    function providerExit(uint32 accountId) external {
        require(block.timestamp > timeout, 'Too early');
        require(msg.sender == provider, 'Invalid sender');
        zksync.requestFullExit(accountId, providerToken);
    }

    receive() external payable {}
}
