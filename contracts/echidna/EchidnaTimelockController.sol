// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../governance/HokusaiTimelockController.sol";

/**
 * @dev Trivial target for timelocked calls. Records the last value written and asserts the
 * caller was the timelock, so a successful execution proves the timelock is the executor.
 */
contract EchidnaTimelockTarget {
    address public immutable timelock;
    uint256 public value;
    uint256 public callCount;

    constructor(address timelock_) {
        timelock = timelock_;
    }

    function setValue(uint256 v) external {
        require(msg.sender == timelock, "only timelock");
        value = v;
        callCount += 1;
    }
}

/**
 * @dev Helper with neither PROPOSER_ROLE nor EXECUTOR_ROLE, used to prove scheduling and
 * execution are role-gated.
 */
contract EchidnaTimelockUnauthorizedCaller {
    function trySchedule(
        HokusaiTimelockController timelock,
        address target,
        bytes memory data,
        bytes32 salt,
        uint256 delay
    ) external returns (bool) {
        try timelock.schedule(target, 0, data, bytes32(0), salt, delay) {
            return true;
        } catch {
            return false;
        }
    }

    function tryExecute(
        HokusaiTimelockController timelock,
        address target,
        bytes memory data,
        bytes32 salt
    ) external returns (bool) {
        try timelock.execute(target, 0, data, bytes32(0), salt) {
            return true;
        } catch {
            return false;
        }
    }
}

/**
 * @dev Echidna harness for HokusaiTimelockController (security review H-6 — the timelock
 * guards every privileged op, yet had no delay/role invariants fuzzed). The harness is
 * proposer + executor + canceller; Echidna varies block.timestamp so scheduled operations
 * cross their ready time non-deterministically.
 *
 * Invariants:
 * - no operation executes before block.timestamp reaches its scheduled ready time (delay enforced)
 * - every executed operation was previously scheduled through the timelock
 * - the timelock never accepts a schedule with delay < minDelay
 * - scheduling and execution are role-gated (an unauthorized caller can do neither)
 */
contract EchidnaTimelockController {
    uint256 private constant MIN_DELAY = 1000;
    uint256 private constant MAX_EXTRA_DELAY = 100000;
    uint256 private constant MAX_OPS = 16;

    HokusaiTimelockController public timelock;
    EchidnaTimelockTarget public target;
    EchidnaTimelockUnauthorizedCaller private unauthorizedCaller;

    struct Op {
        bytes data;
        bytes32 salt;
        uint256 readyTimestamp;
        bool scheduled;
    }

    Op[] private ops;

    bool private prematureExecution;
    bool private executedUnscheduled;
    bool private acceptedShortDelay;
    bool private unauthorizedSucceeded;

    constructor() {
        address[] memory proposers = new address[](1);
        address[] memory executors = new address[](1);
        proposers[0] = address(this);
        executors[0] = address(this);

        // admin == address(0): no standing timelock admin, roles are fixed at construction
        // (mirrors the mainnet posture).
        timelock = new HokusaiTimelockController(MIN_DELAY, proposers, executors, address(0));
        target = new EchidnaTimelockTarget(address(timelock));
        unauthorizedCaller = new EchidnaTimelockUnauthorizedCaller();
    }

    function schedule(uint256 value, uint256 extraDelay, uint256 saltSeed) external {
        if (ops.length >= MAX_OPS) {
            return;
        }
        uint256 delay = MIN_DELAY + (extraDelay % (MAX_EXTRA_DELAY + 1));
        bytes memory data = abi.encodeWithSelector(EchidnaTimelockTarget.setValue.selector, value);
        bytes32 salt = keccak256(abi.encodePacked(saltSeed, ops.length, value));

        try timelock.schedule(address(target), 0, data, bytes32(0), salt, delay) {
            ops.push(Op({
                data: data,
                salt: salt,
                readyTimestamp: block.timestamp + delay,
                scheduled: true
            }));
        } catch {}
    }

    function execute(uint256 selector) external {
        uint256 count = ops.length;
        if (count == 0) {
            return;
        }
        Op storage op = ops[selector % count];

        try timelock.execute(address(target), 0, op.data, bytes32(0), op.salt) {
            if (block.timestamp < op.readyTimestamp) {
                prematureExecution = true;
            }
            if (!op.scheduled) {
                executedUnscheduled = true;
            }
        } catch {}
    }

    function attemptShortDelaySchedule(uint256 value, uint256 shortDelay, uint256 saltSeed) external {
        uint256 delay = shortDelay % MIN_DELAY; // strictly < minDelay
        bytes memory data = abi.encodeWithSelector(EchidnaTimelockTarget.setValue.selector, value);
        bytes32 salt = keccak256(abi.encodePacked("short", saltSeed, value));

        try timelock.schedule(address(target), 0, data, bytes32(0), salt, delay) {
            acceptedShortDelay = true;
        } catch {}
    }

    function attemptExecuteUnscheduled(uint256 value, uint256 saltSeed) external {
        // Never scheduled through the timelock — execution must always revert.
        bytes memory data = abi.encodeWithSelector(EchidnaTimelockTarget.setValue.selector, value);
        bytes32 salt = keccak256(abi.encodePacked("never", saltSeed, value));

        try timelock.execute(address(target), 0, data, bytes32(0), salt) {
            executedUnscheduled = true;
        } catch {}
    }

    function attemptUnauthorizedSchedule(uint256 value, uint256 saltSeed) external {
        bytes memory data = abi.encodeWithSelector(EchidnaTimelockTarget.setValue.selector, value);
        bytes32 salt = keccak256(abi.encodePacked("unauth-sched", saltSeed, value));
        if (unauthorizedCaller.trySchedule(timelock, address(target), data, salt, MIN_DELAY)) {
            unauthorizedSucceeded = true;
        }
    }

    function attemptUnauthorizedExecute(uint256 selector) external {
        uint256 count = ops.length;
        if (count == 0) {
            return;
        }
        Op storage op = ops[selector % count];
        if (unauthorizedCaller.tryExecute(timelock, address(target), op.data, op.salt)) {
            unauthorizedSucceeded = true;
        }
    }

    // ============================================================
    // INVARIANTS
    // ============================================================

    function echidna_no_premature_execution() external view returns (bool) {
        return !prematureExecution;
    }

    function echidna_no_unscheduled_execution() external view returns (bool) {
        return !executedUnscheduled;
    }

    function echidna_min_delay_enforced() external view returns (bool) {
        return !acceptedShortDelay && timelock.getMinDelay() == MIN_DELAY;
    }

    function echidna_no_unauthorized_success() external view returns (bool) {
        return !unauthorizedSucceeded;
    }
}
