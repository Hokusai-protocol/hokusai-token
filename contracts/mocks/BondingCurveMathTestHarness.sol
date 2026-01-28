// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "../libraries/BondingCurveMath.sol";

/**
 * @title BondingCurveMathTestHarness
 * @dev Test harness for BondingCurveMath library
 */
contract BondingCurveMathTestHarness {
    uint256 public constant PRECISION = 1e18;

    // Core math functions
    function testPow(uint256 base, uint256 exponent) external pure returns (uint256) {
        return BondingCurveMath.pow(base, exponent);
    }

    function testLn(uint256 x) external pure returns (int256) {
        return BondingCurveMath.ln(x);
    }

    function testExp(int256 x) external pure returns (uint256) {
        return BondingCurveMath.exp(x);
    }

    // Bonding curve calculations
    function testCalculateBuy(
        uint256 supply,
        uint256 reserve,
        uint256 deposit,
        uint256 crrPpm
    ) external pure returns (uint256) {
        return BondingCurveMath.calculateBuy(supply, reserve, deposit, crrPpm);
    }

    function testCalculateSell(
        uint256 supply,
        uint256 reserve,
        uint256 tokens,
        uint256 crrPpm
    ) external pure returns (uint256) {
        return BondingCurveMath.calculateSell(supply, reserve, tokens, crrPpm);
    }

    function testCalculateSpotPrice(
        uint256 supply,
        uint256 reserve,
        uint256 crrPpm
    ) external pure returns (uint256) {
        return BondingCurveMath.calculateSpotPrice(supply, reserve, crrPpm);
    }

    function testCalculateBuyImpact(
        uint256 supply,
        uint256 reserve,
        uint256 deposit,
        uint256 crrPpm
    ) external pure returns (uint256) {
        return BondingCurveMath.calculateBuyImpact(supply, reserve, deposit, crrPpm);
    }

    function testCalculateSellImpact(
        uint256 supply,
        uint256 reserve,
        uint256 tokens,
        uint256 crrPpm
    ) external pure returns (uint256) {
        return BondingCurveMath.calculateSellImpact(supply, reserve, tokens, crrPpm);
    }
}
