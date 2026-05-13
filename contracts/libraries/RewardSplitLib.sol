// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

library RewardSplitLib {
    function split(uint256 amount, uint16 immediateUnlockBps)
        internal
        pure
        returns (uint256 immediateAmount, uint256 vestedAmount)
    {
        require(immediateUnlockBps <= 10000, "invalid bps");

        immediateAmount = (amount * immediateUnlockBps) / 10000;
        vestedAmount = amount - immediateAmount;
    }
}
