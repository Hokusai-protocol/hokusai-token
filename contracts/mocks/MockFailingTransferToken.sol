// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @dev Mock ERC20 whose transferFrom always returns false without reverting.
 *
 * Used to verify that HokusaiAMM.sell() correctly wraps the transferFrom
 * return value in a require(), so a non-reverting-false token causes the
 * sell() call to revert with "Token transfer failed".
 */
contract MockFailingTransferToken is ERC20 {
    constructor() ERC20("Mock Failing Token", "MFT") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    /// @dev Always returns false to simulate a broken ERC20 implementation
    function transferFrom(address, address, uint256) public pure override returns (bool) {
        return false;
    }
}
