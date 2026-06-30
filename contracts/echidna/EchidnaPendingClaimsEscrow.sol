// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../PendingClaimsEscrow.sol";
import "../mocks/MockUSDC.sol";

/**
 * @dev Helper lacking RELEASER_ROLE / DEFAULT_ADMIN_ROLE, used to prove that releases,
 * rescues, and pause toggles are access-controlled.
 */
contract EchidnaEscrowUnauthorizedCaller {
    function tryRelease(PendingClaimsEscrow escrow, address token, address to, uint256 amount)
        external
        returns (bool)
    {
        try escrow.release(token, to, amount, bytes32(0)) {
            return true;
        } catch {
            return false;
        }
    }

    function tryRescue(PendingClaimsEscrow escrow, address token, address to, uint256 amount)
        external
        returns (bool)
    {
        try escrow.rescue(token, to, amount) {
            return true;
        } catch {
            return false;
        }
    }

    function tryUnpause(PendingClaimsEscrow escrow) external returns (bool) {
        try escrow.unpause() {
            return true;
        } catch {
            return false;
        }
    }
}

/**
 * @dev Echidna harness for PendingClaimsEscrow (security review H-6). The harness holds
 * DEFAULT_ADMIN_ROLE, grants itself RELEASER_ROLE, and is the only authorized mover of
 * funds. A single reward token is escrowed; the harness mints a fixed float into the escrow
 * up front and tracks every outflow with ghosts.
 *
 * Invariants:
 * - balance + Σreleased + Σrescued == initial float (no token leak / phantom mint)
 * - on-chain totalReleased[token] == ghost Σreleased
 * - releases never succeed while paused
 * - no release/rescue/unpause from an unauthorized caller
 */
contract EchidnaPendingClaimsEscrow {
    uint256 private constant INITIAL_FLOAT = 50_000_000e6;

    address private constant RECIPIENT_A = address(0x6001);
    address private constant RECIPIENT_B = address(0x6002);
    address private constant RECIPIENT_C = address(0x6003);

    MockUSDC public token;
    PendingClaimsEscrow public escrow;
    EchidnaEscrowUnauthorizedCaller private unauthorizedCaller;

    uint256 private ghostReleased;
    uint256 private ghostRescued;

    bool private pausedReleaseSucceeded;
    bool private unauthorizedSucceeded;

    constructor() {
        token = new MockUSDC();
        escrow = new PendingClaimsEscrow(address(this));
        escrow.grantRole(escrow.RELEASER_ROLE(), address(this));
        unauthorizedCaller = new EchidnaEscrowUnauthorizedCaller();

        token.mint(address(escrow), INITIAL_FLOAT);
    }

    function release(uint256 selector, uint256 amount) external {
        uint256 bounded = _bound(amount, _escrowBalance());
        if (bounded == 0) {
            return;
        }
        try escrow.release(address(token), _selectRecipient(selector), bounded, bytes32(0)) {
            ghostReleased += bounded;
        } catch {}
    }

    function releaseBatch(uint256 selector, uint256 amount0, uint256 amount1) external {
        address[] memory recipients = new address[](2);
        uint256[] memory amounts = new uint256[](2);
        bytes32[] memory refs = new bytes32[](2);

        recipients[0] = _selectRecipient(selector);
        recipients[1] = _selectRecipient(selector >> 8);

        uint256 balance = _escrowBalance();
        amounts[0] = _bound(amount0, balance);
        if (amounts[0] == 0) {
            return;
        }
        amounts[1] = _bound(amount1, balance - amounts[0]);
        if (amounts[1] == 0) {
            return;
        }

        try escrow.releaseBatch(address(token), recipients, amounts, refs) {
            ghostReleased += amounts[0] + amounts[1];
        } catch {}
    }

    function rescue(uint256 selector, uint256 amount) external {
        uint256 bounded = _bound(amount, _escrowBalance());
        if (bounded == 0) {
            return;
        }
        try escrow.rescue(address(token), _selectRecipient(selector), bounded) {
            ghostRescued += bounded;
        } catch {}
    }

    function pause() external {
        try escrow.pause() {} catch {}
    }

    function unpause() external {
        try escrow.unpause() {} catch {}
    }

    function attemptPausedRelease(uint256 selector, uint256 amount) external {
        uint256 bounded = _bound(amount, _escrowBalance());
        if (bounded == 0) {
            return;
        }
        try escrow.pause() {} catch {}
        try escrow.release(address(token), _selectRecipient(selector), bounded, bytes32(0)) {
            pausedReleaseSucceeded = true;
            ghostReleased += bounded; // keep conservation exact if it ever (wrongly) succeeds
        } catch {}
        try escrow.unpause() {} catch {}
    }

    function attemptUnauthorizedRelease(uint256 selector, uint256 amount) external {
        uint256 bounded = _bound(amount, _escrowBalance());
        if (bounded == 0) {
            return;
        }
        if (unauthorizedCaller.tryRelease(escrow, address(token), _selectRecipient(selector), bounded)) {
            unauthorizedSucceeded = true;
        }
    }

    function attemptUnauthorizedRescue(uint256 selector, uint256 amount) external {
        uint256 bounded = _bound(amount, _escrowBalance());
        if (bounded == 0) {
            return;
        }
        if (unauthorizedCaller.tryRescue(escrow, address(token), _selectRecipient(selector), bounded)) {
            unauthorizedSucceeded = true;
        }
    }

    function attemptUnauthorizedUnpause() external {
        try escrow.pause() {} catch {}
        if (unauthorizedCaller.tryUnpause(escrow)) {
            unauthorizedSucceeded = true;
        }
        try escrow.unpause() {} catch {}
    }

    // ============================================================
    // INVARIANTS
    // ============================================================

    function echidna_conservation() external view returns (bool) {
        return _escrowBalance() + ghostReleased + ghostRescued == INITIAL_FLOAT;
    }

    function echidna_total_released_matches_ghost() external view returns (bool) {
        return escrow.totalReleased(address(token)) == ghostReleased;
    }

    function echidna_pause_blocks_release() external view returns (bool) {
        return !pausedReleaseSucceeded;
    }

    function echidna_no_unauthorized_success() external view returns (bool) {
        return !unauthorizedSucceeded;
    }

    function _escrowBalance() internal view returns (uint256) {
        return token.balanceOf(address(escrow));
    }

    function _selectRecipient(uint256 selector) internal pure returns (address) {
        uint256 index = selector % 3;
        if (index == 0) {
            return RECIPIENT_A;
        }
        if (index == 1) {
            return RECIPIENT_B;
        }
        return RECIPIENT_C;
    }

    function _bound(uint256 value, uint256 maxValue) internal pure returns (uint256) {
        if (maxValue == 0) {
            return 0;
        }
        return (value % maxValue) + 1;
    }
}
