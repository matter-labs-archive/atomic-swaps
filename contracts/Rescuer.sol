// SPDX-License-Identifier: MIT OR Apache-2.0

pragma solidity ^0.7.0;

import "./IERC20.sol";

contract Rescuer {
    address payable public client;
    address payable public provider;

    address public clientToken;
    address public providerToken;

    constructor(
        address _client,
        address _provider,
        address _clientToken,
        address _providerToken
    ) {
        client = payable(_client);
        provider = payable(_provider);
        clientToken = _clientToken;
        providerToken = _providerToken;
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
            (success, ) = msg.sender.call{value: balance}("");
        } else {
            IERC20 erc20 = IERC20(token);
            uint256 balance = erc20.balanceOf(address(this));
            success = erc20.transfer(recipient, balance);
        }
        require(success, "Transfer failed");
    }

    receive() external payable {}
}
