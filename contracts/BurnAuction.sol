// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "./HokusaiToken.sol";

contract BurnAuction {
    address public token;

    constructor(address tokenAddress) {
        token = tokenAddress;
    }

    function burn(uint256 amount) external {
        HokusaiToken(token).burn(amount);
    }
}
