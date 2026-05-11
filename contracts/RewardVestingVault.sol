// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "./interfaces/IRewardVestingVault.sol";
import "./libraries/ValidationLib.sol";

/**
 * @title RewardVestingVault
 * @dev Manages vesting schedules for token rewards
 */
contract RewardVestingVault is IRewardVestingVault, Ownable, ReentrancyGuard {
    /// @dev The authorized controller (TokenManager) that can create schedules
    address public controller;

    /// @dev Counter for generating unique schedule IDs
    uint256 private _scheduleIdCounter;

    /// @dev Mapping from schedule ID to vesting schedule
    mapping(uint256 => VestingSchedule) private _schedules;

    /// @dev Mapping from beneficiary to array of schedule IDs
    mapping(address => uint256[]) private _beneficiarySchedules;

    /// @dev Mapping from token to total committed (unvested + unclaimed) balance
    mapping(address => uint256) private _tokenCommitted;

    /**
     * @dev Constructor
     */
    constructor() Ownable() {
    }

    /**
     * @dev Sets the controller address
     * @param newController The new controller address
     */
    function setController(address newController) external onlyOwner {
        ValidationLib.requireNonZeroAddress(newController, "controller");
        controller = newController;
        emit RewardVestingVaultControllerUpdated(newController);
    }

    /**
     * @inheritdoc IRewardVestingVault
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
    ) external override returns (uint256 scheduleId) {
        require(msg.sender == controller, "Only controller can create schedules");
        ValidationLib.requireNonZeroAddress(beneficiary, "beneficiary");
        ValidationLib.requireNonZeroAddress(token, "token");
        require(vestedAmount > 0, "Vested amount must be > 0");
        require(duration > 0, "Duration must be > 0");
        require(cliff <= duration, "Cliff must be <= duration");
        require(bytes(modelId).length > 0, "Model ID cannot be empty");

        // Check that the vault has sufficient balance
        uint256 currentBalance = IERC20(token).balanceOf(address(this));
        uint256 newCommitted = _tokenCommitted[token] + vestedAmount;
        require(currentBalance >= newCommitted, "Insufficient token balance in vault");

        // Validate timestamp arithmetic won't overflow
        require(block.timestamp + duration <= type(uint64).max, "Timestamp overflow");

        // Create schedule
        scheduleId = _scheduleIdCounter++;
        uint64 startTimestamp = uint64(block.timestamp);
        uint64 cliffEndTimestamp = startTimestamp + cliff;
        uint64 endTimestamp = startTimestamp + duration;

        _schedules[scheduleId] = VestingSchedule({
            modelId: modelId,
            token: token,
            beneficiary: beneficiary,
            vestedTotal: vestedAmount,
            claimedAmount: 0,
            startTimestamp: startTimestamp,
            cliffEndTimestamp: cliffEndTimestamp,
            endTimestamp: endTimestamp
        });

        _beneficiarySchedules[beneficiary].push(scheduleId);
        _tokenCommitted[token] = newCommitted;

        emit RewardVestingCreated(
            modelId,
            beneficiary,
            totalReward,
            immediateAmount,
            vestedAmount,
            startTimestamp,
            endTimestamp
        );

        return scheduleId;
    }

    /**
     * @inheritdoc IRewardVestingVault
     */
    function claim(uint256 scheduleId) external override nonReentrant returns (uint256 claimed) {
        VestingSchedule storage schedule = _schedules[scheduleId];
        require(schedule.beneficiary != address(0), "Schedule does not exist");

        claimed = claimable(scheduleId);
        require(claimed > 0, "No tokens to claim");

        // Effects
        schedule.claimedAmount += claimed;
        _tokenCommitted[schedule.token] -= claimed;

        // Interactions
        require(
            IERC20(schedule.token).transfer(schedule.beneficiary, claimed),
            "Token transfer failed"
        );

        emit VestedRewardClaimed(schedule.modelId, schedule.beneficiary, claimed);

        return claimed;
    }

    /**
     * @inheritdoc IRewardVestingVault
     */
    function claimable(uint256 scheduleId) public view override returns (uint256) {
        VestingSchedule storage schedule = _schedules[scheduleId];
        if (schedule.beneficiary == address(0)) {
            return 0;
        }

        uint256 vested = vestedAmount(scheduleId);
        return vested - schedule.claimedAmount;
    }

    /**
     * @inheritdoc IRewardVestingVault
     */
    function vestedAmount(uint256 scheduleId) public view override returns (uint256) {
        VestingSchedule storage schedule = _schedules[scheduleId];
        if (schedule.beneficiary == address(0)) {
            return 0;
        }

        // Before cliff
        if (block.timestamp < schedule.cliffEndTimestamp) {
            return 0;
        }

        // After end
        if (block.timestamp >= schedule.endTimestamp) {
            return schedule.vestedTotal;
        }

        // Linear vesting
        uint256 elapsed = block.timestamp - schedule.startTimestamp;
        uint256 duration = schedule.endTimestamp - schedule.startTimestamp;
        return (schedule.vestedTotal * elapsed) / duration;
    }

    /**
     * @inheritdoc IRewardVestingVault
     */
    function unvestedAmount(uint256 scheduleId) external view override returns (uint256) {
        VestingSchedule storage schedule = _schedules[scheduleId];
        if (schedule.beneficiary == address(0)) {
            return 0;
        }

        return schedule.vestedTotal - vestedAmount(scheduleId);
    }

    /**
     * @inheritdoc IRewardVestingVault
     */
    function getSchedule(uint256 scheduleId) external view override returns (VestingSchedule memory) {
        return _schedules[scheduleId];
    }

    /**
     * @inheritdoc IRewardVestingVault
     */
    function getSchedulesForBeneficiary(address beneficiary) external view override returns (uint256[] memory) {
        return _beneficiarySchedules[beneficiary];
    }
}
