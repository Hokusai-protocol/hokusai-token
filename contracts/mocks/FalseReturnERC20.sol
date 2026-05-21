// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract FalseReturnERC20 is ERC20 {
    constructor() ERC20("False Return Token", "FRT") {}

    function mint(address account, uint256 amount) external {
        _mint(account, amount);
    }

    function transferFrom(address, address, uint256) public pure override returns (bool) {
        return false;
    }
}
