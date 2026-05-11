// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/**
 * @title IRewardVestingVault
 * @dev Interface for managing vested token rewards
 */
interface IRewardVestingVault {
    struct VestingSchedule {
        string modelId;
        address token;
        address beneficiary;
        uint256 vestedTotal;        // total amount placed under vesting
        uint256 claimedAmount;      // cumulative claimed
        uint64 startTimestamp;
        uint64 cliffEndTimestamp;
        uint64 endTimestamp;        // start + duration
    }

    /**
     * @dev Emitted when a new vesting schedule is created
     * @param modelId The model identifier
     * @param contributor The contributor receiving the vested reward
     * @param totalReward The total reward amount (immediate + vested)
     * @param immediateAmount The amount immediately available
     * @param vestedAmount The amount subject to vesting
     * @param vestingStart The vesting start timestamp
     * @param vestingEnd The vesting end timestamp
     */
    event RewardVestingCreated(
        string indexed modelId,
        address indexed contributor,
        uint256 totalReward,
        uint256 immediateAmount,
        uint256 vestedAmount,
        uint256 vestingStart,
        uint256 vestingEnd
    );

    /**
     * @dev Emitted when vested rewards are claimed
     * @param modelId The model identifier
     * @param contributor The contributor claiming rewards
     * @param amount The amount claimed
     */
    event VestedRewardClaimed(
        string indexed modelId,
        address indexed contributor,
        uint256 amount
    );

    /**
     * @dev Emitted when the controller is updated
     * @param newController The new controller address
     */
    event RewardVestingVaultControllerUpdated(address indexed newController);

    /**
     * @dev Creates a new vesting schedule
     * @param modelId The model identifier
     * @param token The token address
     * @param beneficiary The beneficiary address
     * @param totalReward The total reward amount
     * @param immediateAmount The immediate amount (for event only)
     * @param vestedAmount The vested amount
     * @param duration The vesting duration in seconds
     * @param cliff The cliff duration in seconds
     * @return scheduleId The ID of the created schedule
     */
    function createSchedule(
        string calldata modelId,
        address token,
        address beneficiary,
        uint256 totalReward,
        uint256 immediateAmount,
        uint256 vestedAmount,
        uint64 duration,
        uint64 cliff
    ) external returns (uint256 scheduleId);

    /**
     * @dev Claims vested tokens for a schedule
     * @param scheduleId The schedule ID
     * @return claimed The amount claimed
     */
    function claim(uint256 scheduleId) external returns (uint256 claimed);

    /**
     * @dev Returns the claimable amount for a schedule
     * @param scheduleId The schedule ID
     * @return The claimable amount
     */
    function claimable(uint256 scheduleId) external view returns (uint256);

    /**
     * @dev Returns the vested amount for a schedule
     * @param scheduleId The schedule ID
     * @return The vested amount
     */
    function vestedAmount(uint256 scheduleId) external view returns (uint256);

    /**
     * @dev Returns the unvested amount for a schedule
     * @param scheduleId The schedule ID
     * @return The unvested amount
     */
    function unvestedAmount(uint256 scheduleId) external view returns (uint256);

    /**
     * @dev Returns the complete vesting schedule
     * @param scheduleId The schedule ID
     * @return The VestingSchedule struct
     */
    function getSchedule(uint256 scheduleId) external view returns (VestingSchedule memory);

    /**
     * @dev Returns all schedule IDs for a beneficiary
     * @param beneficiary The beneficiary address
     * @return Array of schedule IDs
     */
    function getSchedulesForBeneficiary(address beneficiary) external view returns (uint256[] memory);
}
