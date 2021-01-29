// SPDX-License-Identifier: MIT OR Apache-2.0

pragma solidity ^0.7.0;

import "./Rescuer.sol";

contract Deployer {
    event Deployed(address);

    // deploys rescuer contract using CREATE2
    function deploy(
        bytes32 _salt,
        address client,
        address provider,
        address clientToken,
        address providerToken
    ) external {
        Rescuer rescuer = new Rescuer{salt: _salt}(client, provider, clientToken, providerToken);
        emit Deployed(address(rescuer));
    }
}
