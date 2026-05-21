// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/**
 * @dev Mock attacker contract for testing reentrancy protection in
 * TokenManager and DeployableTokenManager.
 *
 * Attack pattern:
 *   1. attack() calls the target function with excess ETH
 *   2. The target refunds the excess via _refundExcess() → triggers receive()
 *   3. receive() forwards the received ETH and attempts to re-enter the target
 *   4. nonReentrant fires before any state change and reverts the re-entry
 *   5. receive() propagates the revert; _refundExcess() sees the failed send
 *   6. The entire outer call reverts — the attack fails
 *
 * Tests that use this contract verify the revert, proving the guard works.
 * EXCESS must be >= DEPLOYMENT_FEE so the re-entry passes fee validation
 * and reaches the nonReentrant check (rather than failing on the fee check).
 */
contract MaliciousReentrant {
    address public target;
    bytes public reentryCalldata;
    bool public reentryAttempted;

    constructor(address _target) {
        target = _target;
    }

    function setReentryData(bytes calldata data) external {
        reentryCalldata = data;
    }

    receive() external payable {
        if (reentryCalldata.length > 0 && !reentryAttempted) {
            reentryAttempted = true;
            // Forward the received ETH so the re-entry passes fee validation;
            // nonReentrant fires before any state change and reverts.
            (bool ok, bytes memory err) = target.call{value: msg.value}(reentryCalldata);
            if (!ok) {
                // Propagate the revert so _refundExcess() fails and the outer call reverts
                assembly {
                    revert(add(err, 32), mload(err))
                }
            }
        }
    }

    function attack(bytes calldata callData) external payable {
        (bool ok, bytes memory err) = target.call{value: msg.value}(callData);
        if (!ok) {
            assembly {
                revert(add(err, 32), mload(err))
            }
        }
    }
}
