// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "./libraries/ValidationLib.sol";
import "./interfaces/IRewardVestingVault.sol";

/**
 * @title PendingClaimsEscrow
 * @notice Non-custodial holding contract for DeltaOne reward shares earned by
 * contributors who have not yet registered a verified payout wallet (HOK-2246).
 *
 * The DeltaOne mint is atomic per improvement (all contributors in one mint, which
 * advances the model lineage head), so a wallet-less contributor cannot be deferred
 * without blocking the whole improvement. Instead the mint sends that contributor's
 * share to THIS contract's address, so the reward is minted at earn-time on the same
 * terms (supply/vesting) as peers rather than dropped.
 *
 * Per-account accounting (which account is owed how much, of which model token) lives
 * OFF-CHAIN in auth-service's reward_entitlements ledger. On-chain this contract is a
 * simple per-token holder: once an account verifies a wallet, the auth settlement
 * service (RELEASER_ROLE) calls {release} to deliver the tranche to that wallet. When the
 * model vests rewards, the vested portion is minted to the RewardVestingVault with this
 * escrow as the schedule beneficiary; {claimVested} pulls the unlocked tokens here so they
 * can be released, preserving vesting parity with wallet-having contributors.
 *
 * Trust model: RELEASER_ROLE is the auth settler, which verifies the account<->wallet
 * binding (canonical wallet_verification, HOK-2243) BEFORE releasing. A compromised
 * releaser can at most misroute escrowed reward tokens (bounded by the per-model mint
 * budget) -- it cannot mint. DEFAULT_ADMIN_ROLE (the governance Safe) manages roles,
 * can {pause} releases during an incident, and can {rescue} tokens. This contract's
 * address must be added to the DeltaOne detector's system sinks (HOK-2223) so escrowed
 * mints reconcile clean instead of flagging unauthorized_mint.
 */
contract PendingClaimsEscrow is AccessControl, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    /// @dev Holder of the auth settlement key; the only role that can move funds out via {release}.
    bytes32 public constant RELEASER_ROLE = keccak256("RELEASER_ROLE");
    /// @dev May pause releases for incident response.
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    /// @dev Upper bound on a single {releaseBatch} call.
    uint256 public constant MAX_BATCH = 100;

    /// @notice Cumulative amount released per token, for off-chain reconciliation/audit.
    mapping(address => uint256) public totalReleased;

    event Released(address indexed token, address indexed to, uint256 amount, bytes32 indexed referenceId);
    event Rescued(address indexed token, address indexed to, uint256 amount);
    event VestedClaimed(address indexed vault, uint256 indexed scheduleId, uint256 amount);

    constructor(address admin) {
        ValidationLib.requireNonZeroAddress(admin, "admin");
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(PAUSER_ROLE, admin);
    }

    /**
     * @notice Release a contributor's escrowed reward tranche to their verified wallet.
     * @param token The reward token (per-model HokusaiToken) held in escrow.
     * @param to The contributor's verified payout wallet (binding checked off-chain by the releaser).
     * @param amount Token amount to release (computed off-chain from reward_entitlements).
     * @param referenceId Off-chain correlation id (e.g. reward_entitlement id / idempotency key).
     */
    function release(
        address token,
        address to,
        uint256 amount,
        bytes32 referenceId
    ) external onlyRole(RELEASER_ROLE) nonReentrant whenNotPaused {
        _release(token, to, amount, referenceId);
    }

    /**
     * @notice Release multiple escrowed tranches of a single token in one call.
     * @dev recipients[i] receives amounts[i], tagged with refs[i].
     */
    function releaseBatch(
        address token,
        address[] calldata recipients,
        uint256[] calldata amounts,
        bytes32[] calldata refs
    ) external onlyRole(RELEASER_ROLE) nonReentrant whenNotPaused {
        ValidationLib.requireValidBatch(recipients.length, amounts.length, MAX_BATCH);
        require(refs.length == recipients.length, "references length mismatch");
        for (uint256 i = 0; i < recipients.length; i++) {
            _release(token, recipients[i], amounts[i], refs[i]);
        }
    }

    /**
     * @notice Pull this escrow's vested reward tokens out of a RewardVestingVault.
     * @dev When a wallet-less contributor's reward is minted, the vesting portion lands in
     * the vault with THIS escrow as the schedule beneficiary, and only the beneficiary can
     * claim. This moves the unlocked portion into the escrow so it can then be {release}d to
     * the contributor's verified wallet. It only moves the escrow's own funds inward (no
     * exfiltration), so it is allowed even while paused.
     * @return claimedAmount Tokens transferred from the vault into this escrow.
     */
    function claimVested(address vault, uint256 scheduleId)
        external
        onlyRole(RELEASER_ROLE)
        nonReentrant
        returns (uint256 claimedAmount)
    {
        ValidationLib.requireNonZeroAddress(vault, "vault");
        claimedAmount = IRewardVestingVault(vault).claim(scheduleId);
        emit VestedClaimed(vault, scheduleId, claimedAmount);
    }

    /// @notice Claim multiple of this escrow's vesting schedules from one vault.
    function claimVestedBatch(address vault, uint256[] calldata scheduleIds)
        external
        onlyRole(RELEASER_ROLE)
        nonReentrant
    {
        ValidationLib.requireNonZeroAddress(vault, "vault");
        ValidationLib.requireNonEmptyArray(scheduleIds.length);
        ValidationLib.requireMaxArrayLength(scheduleIds.length, MAX_BATCH);
        for (uint256 i = 0; i < scheduleIds.length; i++) {
            uint256 claimedAmount = IRewardVestingVault(vault).claim(scheduleIds[i]);
            emit VestedClaimed(vault, scheduleIds[i], claimedAmount);
        }
    }

    function _release(address token, address to, uint256 amount, bytes32 referenceId) private {
        ValidationLib.requireNonZeroAddress(token, "token");
        ValidationLib.requireNonZeroAddress(to, "recipient");
        ValidationLib.requirePositiveAmount(amount, "amount");
        totalReleased[token] += amount;
        IERC20(token).safeTransfer(to, amount);
        emit Released(token, to, amount, referenceId);
    }

    /// @notice Current escrow balance of `token` (held for not-yet-released tranches).
    function tokenBalance(address token) external view returns (uint256) {
        return IERC20(token).balanceOf(address(this));
    }

    /// @notice Pause releases (incident response).
    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    /// @notice Resume releases.
    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    /**
     * @notice Governance rescue of tokens (wrong token sent, or migration). Works while paused.
     */
    function rescue(
        address token,
        address to,
        uint256 amount
    ) external onlyRole(DEFAULT_ADMIN_ROLE) nonReentrant {
        ValidationLib.requireNonZeroAddress(token, "token");
        ValidationLib.requireNonZeroAddress(to, "recipient");
        ValidationLib.requirePositiveAmount(amount, "amount");
        IERC20(token).safeTransfer(to, amount);
        emit Rescued(token, to, amount);
    }
}
