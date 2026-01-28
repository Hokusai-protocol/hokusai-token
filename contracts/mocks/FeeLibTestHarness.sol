// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "../libraries/FeeLib.sol";

/**
 * @title FeeLibTestHarness
 * @dev Test harness contract for FeeLib
 */
contract FeeLibTestHarness {
    function testCalculateFee(uint256 amount, uint256 feeBps) external pure returns (uint256) {
        return FeeLib.calculateFee(amount, feeBps);
    }

    function testApplyFee(uint256 amount, uint256 feeBps)
        external
        pure
        returns (uint256 netAmount, uint256 fee)
    {
        return FeeLib.applyFee(amount, feeBps);
    }

    function testRequireValidFee(uint256 feeBps, uint256 maxBps) external pure {
        FeeLib.requireValidFee(feeBps, maxBps);
    }

    function testPercentage(uint256 amount, uint256 percentageBps) external pure returns (uint256) {
        return FeeLib.percentage(amount, percentageBps);
    }

    function testSplitProtocolFee(uint256 amount, uint256 protocolFeeBps)
        external
        pure
        returns (uint256 protocolFee, uint256 remaining)
    {
        return FeeLib.splitProtocolFee(amount, protocolFeeBps);
    }

    function testApplyMultipleFees(
        uint256 amount,
        uint256 fee1Bps,
        uint256 fee2Bps
    )
        external
        pure
        returns (
            uint256 netAmount,
            uint256 totalFees,
            uint256 fee1,
            uint256 fee2
        )
    {
        fee1 = FeeLib.calculateFee(amount, fee1Bps);
        uint256 afterFee1 = amount - fee1;
        fee2 = FeeLib.calculateFee(afterFee1, fee2Bps);
        (netAmount, totalFees) = FeeLib.applyMultipleFees(amount, fee1Bps, fee2Bps);
    }
}
