// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract MockTokenManagerForAMM {
    uint256 private redeemableSupply;

    function setRedeemableSupply(uint256 newSupply) external {
        redeemableSupply = newSupply;
    }

    function getRedeemableSupply(string memory) external view returns (uint256) {
        return redeemableSupply;
    }

    function mintTokens(string memory, address, uint256) external pure {}

    function burnAMMTokens(string memory, address, uint256) external pure {}
}
