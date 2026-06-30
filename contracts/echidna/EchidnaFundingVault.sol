// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../FundingVault.sol";
import "../mocks/MockUSDC.sol";

// --- ABI-compatible stubs for the pre-graduation lifecycle --------------------------------
// FundingVault casts _modelRegistry/_tokenManager/_ammFactory to concrete types but, for the
// deposit/withdraw/announce/cancel paths, only calls isStringRegistered / isStringActive /
// getTokenAddress. The AMM factory is never touched off the graduate() path, so a non-zero
// dummy address satisfies the constructor without deploying the full AMM graph.

contract StubModelRegistry {
    bool public active = true;
    function setActive(bool a) external { active = a; }
    function isStringRegistered(string memory) external pure returns (bool) { return true; }
    function isStringActive(string memory) external view returns (bool) { return active; }
}

contract StubFundingTokenManager {
    address public token;
    constructor(address token_) { token = token_; }
    function getTokenAddress(string memory) external view returns (address) { return token; }
}

/**
 * @dev Stand-in depositor so commitments are per-account (Echidna otherwise drives every call
 * from the harness). Holds USDC, approves the vault, and acts on its own behalf.
 */
contract EchidnaFundingUser {
    function approve(MockUSDC usdc, address vault) external {
        usdc.approve(vault, type(uint256).max);
    }

    function deposit(FundingVault vault, string memory modelId, uint256 amount) external returns (bool) {
        try vault.deposit(modelId, amount) {
            return true;
        } catch {
            return false;
        }
    }

    function withdraw(FundingVault vault, string memory modelId) external returns (bool) {
        try vault.withdraw(modelId) {
            return true;
        } catch {
            return false;
        }
    }
}

/**
 * @dev Echidna harness for FundingVault's pre-graduation accounting and the H-5 escape hatch
 * (security review H-6 coverage). Three stand-in users deposit/withdraw; the harness
 * (GRADUATOR/admin) announces and cancels. graduate() is out of scope (needs the live AMM),
 * so `graduated` stays false and every reachable state is pre-graduation.
 *
 * Invariants:
 * - vault USDC balance == proposal.totalCommitted (no leak / no shortfall)
 * - totalCommitted == Σ per-user commitments (accounting integrity)
 * - H-5: announce → (model deactivated, bricking graduate) → cancel → withdraw always
 *   succeeds for a committed user, so funds are never permanently trapped
 */
contract EchidnaFundingVault {
    string private constant MODEL_ID = "echidna-funding-model";
    uint256 private constant MAX_DEPOSIT = 1_000_000e6;
    uint256 private constant USER_FLOAT = 100_000_000e6;
    uint256 private constant NUM_USERS = 3;

    MockUSDC public usdc;
    StubModelRegistry public registry;
    FundingVault public vault;
    EchidnaFundingUser[3] public users;

    bool private withdrawAfterCancelFailed;

    constructor() {
        usdc = new MockUSDC();
        MockUSDC modelToken = new MockUSDC(); // proposal token placeholder (never traded here)
        registry = new StubModelRegistry();
        StubFundingTokenManager tm = new StubFundingTokenManager(address(modelToken));

        vault = new FundingVault(
            address(usdc),
            address(0xA11CE), // ammFactory dummy — only used on the graduate() path
            payable(address(tm)),
            address(registry),
            address(this)
        );

        // Register the single proposal under test.
        vault.registerProposal(MODEL_ID, address(modelToken), type(uint256).max);

        users[0] = _makeUser();
        users[1] = _makeUser();
        users[2] = _makeUser();
    }

    function _makeUser() internal returns (EchidnaFundingUser user) {
        user = new EchidnaFundingUser();
        usdc.mint(address(user), USER_FLOAT);
        user.approve(usdc, address(vault));
    }

    function deposit(uint256 userSel, uint256 amount) external {
        registry.setActive(true);
        EchidnaFundingUser user = users[userSel % NUM_USERS];
        uint256 bal = usdc.balanceOf(address(user));
        uint256 cap = bal < MAX_DEPOSIT ? bal : MAX_DEPOSIT;
        uint256 bounded = _bound(amount, cap);
        if (bounded == 0) {
            return;
        }
        user.deposit(vault, MODEL_ID, bounded);
    }

    function withdraw(uint256 userSel) external {
        users[userSel % NUM_USERS].withdraw(vault, MODEL_ID);
    }

    function announce() external {
        try vault.announceGraduation(MODEL_ID) {} catch {}
    }

    function cancel() external {
        try vault.cancelGraduation(MODEL_ID) {} catch {}
    }

    /**
     * @dev End-to-end H-5 escape hatch: a committed user is announced, the model is then
     * deactivated (making graduate() revert forever), and the user must still recover funds
     * via cancel → withdraw.
     */
    function escapeHatch(uint256 userSel) external {
        EchidnaFundingUser user = users[userSel % NUM_USERS];

        // Ensure this user holds a live commitment.
        registry.setActive(true);
        if (vault.getCommitment(MODEL_ID, address(user)) == 0) {
            uint256 bal = usdc.balanceOf(address(user));
            uint256 cap = bal < MAX_DEPOSIT ? bal : MAX_DEPOSIT;
            uint256 seed = _bound(uint256(keccak256(abi.encodePacked(userSel))), cap);
            if (seed == 0) {
                return;
            }
            user.deposit(vault, MODEL_ID, seed);
        }

        // Announce (requires active), then deactivate to brick graduate().
        try vault.announceGraduation(MODEL_ID) {} catch { return; }
        registry.setActive(false);

        // Escape: cancel re-opens withdrawals even with the model deactivated.
        try vault.cancelGraduation(MODEL_ID) {} catch {
            // A committed, announced, not-graduated proposal must always be cancellable.
            withdrawAfterCancelFailed = true;
            return;
        }

        if (vault.getCommitment(MODEL_ID, address(user)) > 0) {
            if (!user.withdraw(vault, MODEL_ID)) {
                withdrawAfterCancelFailed = true;
            }
        }
        registry.setActive(true);
    }

    // ============================================================
    // INVARIANTS
    // ============================================================

    function echidna_balance_equals_total_committed() external view returns (bool) {
        return usdc.balanceOf(address(vault)) == _totalCommitted();
    }

    function echidna_total_committed_equals_sum_commitments() external view returns (bool) {
        uint256 sum = 0;
        for (uint256 i = 0; i < NUM_USERS; i++) {
            sum += vault.getCommitment(MODEL_ID, address(users[i]));
        }
        return sum == _totalCommitted();
    }

    /// @dev Isolated tuple read — keeps the 8-field destructure in a shallow stack frame.
    function _totalCommitted() internal view returns (uint256 totalCommitted) {
        (, , totalCommitted, , , , , ) = vault.getProposal(MODEL_ID);
    }

    function echidna_funds_never_trapped() external view returns (bool) {
        return !withdrawAfterCancelFailed;
    }

    function _bound(uint256 value, uint256 maxValue) internal pure returns (uint256) {
        if (maxValue == 0) {
            return 0;
        }
        return (value % maxValue) + 1;
    }
}
