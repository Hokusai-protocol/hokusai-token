// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../RewardVestingVault.sol";
import "../mocks/MockUSDC.sol";

/**
 * @dev Helper that is NOT the vault's tokenManager, used to prove createSchedule is
 * access-controlled (only the configured tokenManager may create schedules).
 */
contract EchidnaVestingUnauthorizedCaller {
    function tryCreateSchedule(
        RewardVestingVault vault,
        string memory modelId,
        address token,
        address beneficiary,
        uint256 totalAmount,
        uint64 cliffSeconds,
        uint64 duration
    ) external returns (bool) {
        try vault.createSchedule(modelId, token, beneficiary, totalAmount, cliffSeconds, duration) {
            return true;
        } catch {
            return false;
        }
    }

    function tryClaim(RewardVestingVault vault, uint256 scheduleId) external returns (bool) {
        try vault.claim(scheduleId) {
            return true;
        } catch {
            return false;
        }
    }
}

/**
 * @dev Echidna harness for RewardVestingVault — the deepest time-state fund-holding
 * contract (security review H-6, "vesting first"). The harness is itself the vault's
 * tokenManager (so it can mint schedules) AND the beneficiary of every schedule (so its
 * own `claim` action is authorized). Echidna varies block.timestamp between calls, which
 * exercises pre-cliff / mid-vest / fully-vested transitions.
 *
 * Funding model mirrors production: createSchedule does NOT pull tokens; the TokenManager
 * separately mints the vested portion to the vault. The harness reproduces that by minting
 * exactly `totalAmount` to the vault each time it creates a schedule, so the vault balance
 * tracks (created − claimed) exactly and the conservation property is precise.
 *
 * Invariants:
 * - balance == Σcreated − Σclaimed (no token leak / no shortfall)
 * - per schedule: claimed ≤ totalAmount; vested ≤ totalAmount; claimable + claimed == vested
 * - no claim ever credited tokens before the schedule's cliff
 * - on-chain Σclaimed == ghost Σclaimed (== tokens transferred out)
 * - only the tokenManager can create schedules; only the beneficiary can claim
 */
contract EchidnaRewardVestingVault {
    string private constant MODEL_ID = "echidna-vesting-model";
    uint256 private constant MAX_SCHEDULE_AMOUNT = 2_500_000e6;
    uint64 private constant MAX_DURATION = 4 * 365 days;
    uint256 private constant MAX_SCHEDULES = 12;

    MockUSDC public token;
    RewardVestingVault public vault;
    EchidnaVestingUnauthorizedCaller private unauthorizedCaller;

    uint256[] private scheduleIds;
    mapping(uint256 => uint256) private ghostTotalAmount;
    uint256 private ghostTotalCreated;
    uint256 private ghostTotalClaimed;

    bool private prematureClaimCredited;
    bool private unauthorizedSucceeded;

    constructor() {
        token = new MockUSDC();
        vault = new RewardVestingVault(address(this));
        unauthorizedCaller = new EchidnaVestingUnauthorizedCaller();
    }

    function createSchedule(uint256 amount, uint256 cliff, uint256 duration) external {
        if (scheduleIds.length >= MAX_SCHEDULES) {
            return;
        }

        uint256 boundedAmount = _bound(amount, MAX_SCHEDULE_AMOUNT);
        uint64 boundedDuration = uint64(_bound(duration, MAX_DURATION));
        uint64 boundedCliff = uint64(cliff % (uint256(boundedDuration) + 1)); // cliff <= duration

        try vault.createSchedule(
            MODEL_ID,
            address(token),
            address(this), // beneficiary == harness, so claim() is authorized
            boundedAmount,
            boundedCliff,
            boundedDuration
        ) returns (uint256 scheduleId) {
            // Fund the vault exactly as the TokenManager would post-creation.
            token.mint(address(vault), boundedAmount);
            scheduleIds.push(scheduleId);
            ghostTotalAmount[scheduleId] = boundedAmount;
            ghostTotalCreated += boundedAmount;
        } catch {}
    }

    function claim(uint256 selector) external {
        uint256 count = scheduleIds.length;
        if (count == 0) {
            return;
        }
        uint256 scheduleId = scheduleIds[selector % count];

        RewardVestingVault.VestingSchedule memory s = vault.getSchedule(scheduleId);
        uint256 cliffEnd = uint256(s.start) + uint256(s.cliffSeconds);

        try vault.claim(scheduleId) returns (uint256 claimedAmount) {
            if (claimedAmount > 0 && block.timestamp < cliffEnd) {
                prematureClaimCredited = true;
            }
            ghostTotalClaimed += claimedAmount;
        } catch {}
    }

    function attemptUnauthorizedCreate(uint256 amount, uint256 duration) external {
        uint256 boundedAmount = _bound(amount, MAX_SCHEDULE_AMOUNT);
        uint64 boundedDuration = uint64(_bound(duration, MAX_DURATION));
        if (
            unauthorizedCaller.tryCreateSchedule(
                vault, MODEL_ID, address(token), address(this), boundedAmount, 0, boundedDuration
            )
        ) {
            unauthorizedSucceeded = true;
        }
    }

    function attemptUnauthorizedClaim(uint256 selector) external {
        uint256 count = scheduleIds.length;
        if (count == 0) {
            return;
        }
        // Beneficiary is the harness; a different msg.sender must never claim.
        if (unauthorizedCaller.tryClaim(vault, scheduleIds[selector % count])) {
            unauthorizedSucceeded = true;
        }
    }

    // ============================================================
    // INVARIANTS
    // ============================================================

    function echidna_balance_equals_created_minus_claimed() external view returns (bool) {
        return token.balanceOf(address(vault)) == ghostTotalCreated - ghostTotalClaimed;
    }

    function echidna_onchain_claimed_matches_ghost() external view returns (bool) {
        uint256 sumClaimed = 0;
        for (uint256 i = 0; i < scheduleIds.length; i++) {
            sumClaimed += vault.getSchedule(scheduleIds[i]).claimed;
        }
        return sumClaimed == ghostTotalClaimed;
    }

    function echidna_claimed_le_total() external view returns (bool) {
        for (uint256 i = 0; i < scheduleIds.length; i++) {
            uint256 id = scheduleIds[i];
            if (vault.getSchedule(id).claimed > ghostTotalAmount[id]) {
                return false;
            }
        }
        return true;
    }

    function echidna_vested_le_total() external view returns (bool) {
        for (uint256 i = 0; i < scheduleIds.length; i++) {
            uint256 id = scheduleIds[i];
            if (vault.vestedAmount(id) > ghostTotalAmount[id]) {
                return false;
            }
        }
        return true;
    }

    function echidna_claimable_plus_claimed_eq_vested() external view returns (bool) {
        for (uint256 i = 0; i < scheduleIds.length; i++) {
            uint256 id = scheduleIds[i];
            RewardVestingVault.VestingSchedule memory s = vault.getSchedule(id);
            if (vault.claimable(id) + s.claimed != vault.vestedAmount(id)) {
                return false;
            }
        }
        return true;
    }

    function echidna_no_premature_claim() external view returns (bool) {
        return !prematureClaimCredited;
    }

    function echidna_no_unauthorized_success() external view returns (bool) {
        return !unauthorizedSucceeded;
    }

    function _bound(uint256 value, uint256 maxValue) internal pure returns (uint256) {
        if (maxValue == 0) {
            return 0;
        }
        return (value % maxValue) + 1;
    }
}
