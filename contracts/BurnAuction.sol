// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "./HokusaiToken.sol";

contract BurnAuction {
    address public token;

    constructor(address tokenAddress) {
        token = tokenAddress;
    }

    function burn(uint256 amount) external {
        // Transfer tokens from user to this contract first
        HokusaiToken(token).transferFrom(msg.sender, address(this), amount);
        // Then burn the tokens from this contract's balance
        HokusaiToken(token).burn(amount);
    }
}
