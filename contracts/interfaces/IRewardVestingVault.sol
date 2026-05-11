// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

interface IRewardVestingVault {
    struct VestingSchedule {
        address token;
        address beneficiary;
        string modelId;
        uint256 totalAmount;
        uint256 claimed;
        uint64 start;
        uint64 cliffSeconds;
        uint64 duration;
    }

    function createSchedule(
        string calldata modelId,
        address token,
        address beneficiary,
        uint256 totalAmount,
        uint64 cliffSeconds,
        uint64 duration
    ) external returns (uint256 scheduleId);

    function claim(uint256 scheduleId) external returns (uint256 claimedAmount);

    function claimable(uint256 scheduleId) external view returns (uint256 amount);

    function vestedAmount(uint256 scheduleId) external view returns (uint256 amount);

    function unvestedAmount(uint256 scheduleId) external view returns (uint256 amount);

    function getSchedule(uint256 scheduleId) external view returns (VestingSchedule memory schedule);

    function getSchedulesByBeneficiary(address beneficiary) external view returns (uint256[] memory scheduleIds);
}
