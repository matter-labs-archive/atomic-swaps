pragma solidity ^0.5.8;

contract Rescuer {
    address payable owner;

    constructor(address payable _owner) public {
        owner = _owner;
    }

    // this works for ETH only
    // for ERC20 we'll have to use approve() & transferFrom()
    function rescue() external {
        require(msg.sender == owner);
        owner.transfer(address(this).balance);
    }
}
