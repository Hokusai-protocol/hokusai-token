// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./interfaces/IRewardVestingVault.sol";

/**
 * @title RewardVestingVault
 * @dev Holds vested contributor rewards until they become claimable.
 */
contract RewardVestingVault is IRewardVestingVault, ReentrancyGuard {
    using SafeERC20 for IERC20;

    mapping(uint256 => VestingSchedule) public schedules;
    mapping(address => uint256[]) private _schedulesByBeneficiary;

    uint256 public nextScheduleId;
    address public immutable tokenManager;

    event VestingScheduleCreated(
        uint256 indexed scheduleId,
        string indexed modelId,
        address indexed beneficiary,
        address token,
        uint256 vestedAmount,
        uint64 start,
        uint64 cliffSeconds,
        uint64 duration
    );

    event VestedRewardClaimed(
        uint256 indexed scheduleId,
        string indexed modelId,
        address indexed beneficiary,
        uint256 amount
    );

    modifier onlyTokenManager() {
        require(msg.sender == tokenManager, "Only TokenManager can create schedules");
        _;
    }

    constructor(address tokenManagerAddress) {
        require(tokenManagerAddress != address(0), "TokenManager cannot be zero address");
        tokenManager = tokenManagerAddress;
    }

    function createSchedule(
        string calldata modelId,
        address token,
        address beneficiary,
        uint256 totalAmount,
        uint64 cliffSeconds,
        uint64 duration
    ) external override onlyTokenManager returns (uint256 scheduleId) {
        require(token != address(0), "Token cannot be zero address");
        require(beneficiary != address(0), "Beneficiary cannot be zero address");
        require(bytes(modelId).length > 0, "Model ID cannot be empty");
        require(totalAmount > 0, "Vested amount must be > 0");
        require(duration > 0, "Vesting duration must be > 0");
        require(cliffSeconds <= duration, "Cliff exceeds vesting duration");

        scheduleId = nextScheduleId++;

        VestingSchedule memory schedule = VestingSchedule({
            token: token,
            beneficiary: beneficiary,
            modelId: modelId,
            totalAmount: totalAmount,
            claimed: 0,
            start: uint64(block.timestamp),
            cliffSeconds: cliffSeconds,
            duration: duration
        });

        schedules[scheduleId] = schedule;
        _schedulesByBeneficiary[beneficiary].push(scheduleId);

        emit VestingScheduleCreated(
            scheduleId,
            modelId,
            beneficiary,
            token,
            totalAmount,
            schedule.start,
            cliffSeconds,
            duration
        );
    }

    function claim(uint256 scheduleId) external override nonReentrant returns (uint256 claimedAmount) {
        VestingSchedule storage schedule = schedules[scheduleId];
        require(schedule.beneficiary != address(0), "Schedule does not exist");
        require(msg.sender == schedule.beneficiary, "Only beneficiary can claim");

        claimedAmount = _claimable(schedule);
        require(claimedAmount > 0, "No vested rewards available");

        schedule.claimed += claimedAmount;
        IERC20(schedule.token).safeTransfer(schedule.beneficiary, claimedAmount);

        emit VestedRewardClaimed(scheduleId, schedule.modelId, schedule.beneficiary, claimedAmount);
    }

    function claimable(uint256 scheduleId) external view override returns (uint256 amount) {
        VestingSchedule storage schedule = schedules[scheduleId];
        require(schedule.beneficiary != address(0), "Schedule does not exist");
        return _claimable(schedule);
    }

    function vestedAmount(uint256 scheduleId) external view override returns (uint256 amount) {
        VestingSchedule storage schedule = schedules[scheduleId];
        require(schedule.beneficiary != address(0), "Schedule does not exist");
        return _vestedAmount(schedule);
    }

    function unvestedAmount(uint256 scheduleId) external view override returns (uint256 amount) {
        VestingSchedule storage schedule = schedules[scheduleId];
        require(schedule.beneficiary != address(0), "Schedule does not exist");
        return schedule.totalAmount - _vestedAmount(schedule);
    }

    function getSchedule(uint256 scheduleId) external view override returns (VestingSchedule memory schedule) {
        schedule = schedules[scheduleId];
        require(schedule.beneficiary != address(0), "Schedule does not exist");
    }

    function getSchedulesByBeneficiary(
        address beneficiary
    ) external view override returns (uint256[] memory scheduleIds) {
        return _schedulesByBeneficiary[beneficiary];
    }

    function _claimable(VestingSchedule storage schedule) private view returns (uint256) {
        return _vestedAmount(schedule) - schedule.claimed;
    }

    function _vestedAmount(VestingSchedule storage schedule) private view returns (uint256) {
        uint256 cliffEnd = uint256(schedule.start) + uint256(schedule.cliffSeconds);
        if (block.timestamp < cliffEnd) {
            return 0;
        }

        uint256 vestingEnd = uint256(schedule.start) + uint256(schedule.duration);
        if (block.timestamp >= vestingEnd) {
            return schedule.totalAmount;
        }

        uint256 elapsed = block.timestamp - uint256(schedule.start);
        return (schedule.totalAmount * elapsed) / uint256(schedule.duration);
    }
}
