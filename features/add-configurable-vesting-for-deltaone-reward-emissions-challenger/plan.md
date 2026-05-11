# Plan: Configurable vesting for DeltaOne reward emissions (HOK-1651)

## Problem & goal

Early Hokusai tokens may launch with shallow AMM reserves. If a DeltaVerifier
reward mints a large balance directly to a contributor, the contributor can
immediately dump into the CRR pool and drain reserves. We want contributor
rewards from verified model improvements to be **partially liquid and partially
vested**, while leaving everything else (AMM mints, model-supplier allocations,
infrastructure mechanics, DeltaOne math) untouched.

Default policy (model-agnostic, protocol-level):

- `vestingEnabled = true`
- `immediateUnlockBps = 1000` (10% immediately liquid)
- `vestingDurationSeconds = 365 days` (linear)
- `cliffSeconds = 0`

Per the `feedback_protocol_vs_instance` memory, this is a generic protocol
primitive. Per-model knobs live in config; the contract just enforces what
the params contract says.

## Approach summary

Split reward minting from AMM minting at the `TokenManager` API surface:

- **New** `mintReward` / `batchMintReward` on `TokenManager` apply vesting.
- **Existing** `mintTokens` / `batchMintTokens` stay as-is (used by AMM/owner).
- **DeltaVerifier** is updated to call the reward variants.
- **New** `RewardVestingVault` contract holds vested portions and issues
  per-recipient schedules. Beneficiary cannot transfer/sell unvested tokens
  because they live in the vault, not in the beneficiary's balance.
- **`HokusaiParams`** gains vesting config state, getters, setters, events,
  and an `applyPendingUpdates` extension. A `defaultVestingConfig()` constant
  view exposes the protocol-wide default so SDK/scripts can fill it in
  without hard-coding magic numbers.

This shape preserves every acceptance criterion and avoids touching AMM mint
flow, DeltaOne math, infrastructure cost mechanics, or model-supplier
distribution.

## Alternatives considered

1. **Single `mintTokens` with conditional routing on `msg.sender`** (route
   via vesting only if caller is `deltaVerifier`). Rejected — implicit
   coupling, hard to extend later when DeltaVerifier-equivalents are added,
   and risks silent vesting for callers we did not intend.
2. **Add a `bool applyVesting` parameter to existing functions.** Rejected —
   breaks the API for every existing caller (AMM, tests, scripts).
3. **Per-model vault instances.** Rejected — adds deploy complexity and
   storage cost. Single global vault keyed by `scheduleId` (with token +
   beneficiary stored on the schedule) is simpler and gas-cheaper. The vault
   already has `(modelId, token, beneficiary)` per schedule, so it works for
   any number of tokens.
4. **Mint vested portion lazily on claim** (no vault custody). Rejected —
   the spec requires unvested tokens be unable to be sold/transferred. The
   simplest enforcement is to actually mint them into a contract the
   beneficiary doesn't control. Lazy-mint also makes it hard to expose
   `unvestedAmount` against current supply.
5. **Bake defaults into a sentinel "zero means default" pattern in the
   constructor.** Rejected because `enabled=false` is a legitimate setting
   that would collide with the sentinel. Instead, defaults are exposed via
   a `defaultVestingConfig()` view and applied by the SDK/test helpers
   when the caller omits vesting.

## Detailed design

### 1. `IRewardVestingVault.sol` (new interface)

```solidity
interface IRewardVestingVault {
    struct VestingSchedule {
        string  modelId;
        address token;
        address beneficiary;
        uint256 vestedTotal;          // total amount placed under vesting
        uint256 claimedAmount;        // cumulative claimed
        uint64  startTimestamp;
        uint64  cliffEndTimestamp;
        uint64  endTimestamp;         // start + duration
    }

    event RewardVestingCreated(
        string  indexed modelId,
        address indexed contributor,
        uint256 totalReward,
        uint256 immediateAmount,
        uint256 vestedAmount,
        uint256 vestingStart,
        uint256 vestingEnd
    );
    event VestedRewardClaimed(
        string  indexed modelId,
        address indexed contributor,
        uint256 amount
    );
    event RewardVestingVaultControllerUpdated(address indexed newController);

    function createSchedule(
        string  calldata modelId,
        address token,
        address beneficiary,
        uint256 totalReward,
        uint256 immediateAmount,
        uint256 vestedAmount,
        uint64  duration,
        uint64  cliff
    ) external returns (uint256 scheduleId);

    function claim(uint256 scheduleId) external returns (uint256 claimed);

    function claimable(uint256 scheduleId) external view returns (uint256);
    function vestedAmount(uint256 scheduleId) external view returns (uint256);
    function unvestedAmount(uint256 scheduleId) external view returns (uint256);
    function getSchedule(uint256 scheduleId) external view returns (VestingSchedule memory);
    function getSchedulesForBeneficiary(address beneficiary) external view returns (uint256[] memory);
}
```

### 2. `RewardVestingVault.sol` (new contract)

- Inherits `Ownable` and `ReentrancyGuard`.
- Stores `address public controller` (the authorized `TokenManager`). Owner
  sets via `setController`. `createSchedule` requires `msg.sender == controller`.
- Linear vesting math (returns 0 before `cliffEndTimestamp`):
  ```
  if (block.timestamp < cliffEndTimestamp) return 0;
  if (block.timestamp >= endTimestamp)      return vestedTotal;
  elapsed = block.timestamp - startTimestamp;
  duration = endTimestamp - startTimestamp;
  return (vestedTotal * elapsed) / duration;
  ```
- `claimable(scheduleId) = vestedAmount(scheduleId) - claimedAmount`.
- `claim(scheduleId)` is `nonReentrant`, transfers ERC20 to beneficiary,
  updates `claimedAmount` (effects-before-interactions), emits
  `VestedRewardClaimed`. Anyone may call (transfer always lands on the
  beneficiary), simplifying delegated keepers.
- `createSchedule` validates:
  - `beneficiary != address(0)`
  - `token != address(0)`
  - `vestedAmount > 0` (zero-vesting schedules are no-ops and should not be
    created — caller should mint full liquid instead)
  - `duration > 0`
  - `cliff <= duration`
  - `block.timestamp + duration` fits in `uint64`
  - **`token.balanceOf(address(this)) >= sum of un-distributed vestedTotal across schedules of that token`** — implemented via a per-token committed-balance accounting so the vault refuses to over-issue schedules without backing tokens.
- Custom errors via `ValidationLib` style where appropriate.
- Emits `RewardVestingCreated` from inside `createSchedule` so each schedule
  yields exactly one creation event (TokenManager does not double-emit).

### 3. `HokusaiParams.sol` updates

Add private state:

```solidity
bool   private _vestingEnabled;
uint16 private _immediateUnlockBps;
uint64 private _vestingDurationSeconds;
uint64 private _cliffSeconds;
```

Add constants (protocol-level defaults, model-agnostic):

```solidity
bool    public constant DEFAULT_VESTING_ENABLED            = true;
uint16  public constant DEFAULT_IMMEDIATE_UNLOCK_BPS       = 1000;     // 10%
uint64  public constant DEFAULT_VESTING_DURATION_SECONDS   = 365 days;
uint64  public constant DEFAULT_CLIFF_SECONDS              = 0;
uint16  public constant MAX_IMMEDIATE_UNLOCK_BPS           = 10000;
uint64  public constant MAX_VESTING_DURATION_SECONDS       = 10 * 365 days;
```

Extend constructor with a `VestingConfig` argument; on input:
- Validate `immediateUnlockBps <= 10000`.
- If `enabled`, require `vestingDurationSeconds > 0` and
  `cliffSeconds <= vestingDurationSeconds` and
  `vestingDurationSeconds <= MAX_VESTING_DURATION_SECONDS`.
- Store as-is.

Add view functions (per `IHokusaiParams` extension):
- `vestingEnabled() external view returns (bool)`
- `immediateUnlockBps() external view returns (uint16)`
- `vestingDurationSeconds() external view returns (uint64)`
- `cliffSeconds() external view returns (uint64)`
- `vestingConfig() external view returns (VestingConfig memory)`
- `defaultVestingConfig() external pure returns (VestingConfig memory)`

Add GOV setter:
- `setVestingConfig(VestingConfig calldata cfg)` with the same validation
  and a `VestingConfigSet(...)` event.

Hook into the `applyPendingUpdates` epoch flow? **No** for this task. Vesting
config is operationally distinct from per-epoch pricing parameters; making it
a direct GOV-mutable knob keeps the scope contained and matches the pattern
used for `licenseRef`. We can fold it into the epoch flow later if needed.

### 4. `TokenManager.sol` updates

- Extend `InitialParams` with `IHokusaiParams.VestingConfig vestingConfig`.
  Forward it to the `HokusaiParams` constructor in both
  `deployTokenWithParams` and `deployTokenWithAllocations`.
- Update `ParamsDeployed` event to also expose vesting fields **or** add a
  new `ParamsVestingConfigured` event — pick the additive option to avoid
  breaking subscribers: emit a separate `ParamsVestingConfigured(modelId,
  enabled, immediateUnlockBps, vestingDurationSeconds, cliffSeconds)` from
  inside both deploy paths.
- Add `address public rewardVestingVault` and an owner-only
  `setRewardVestingVault(address)` with `RewardVestingVaultUpdated` event.
- Add `mintReward(string modelId, address recipient, uint256 amount)`:
  - Same auth gate as `mintTokens` (`MINTER_ROLE || owner || deltaVerifier`).
  - Same registry/model-active checks.
  - If `params.vestingEnabled() == false`, behaves exactly like `mintTokens`
    (mint full amount, emit `TokensMinted`).
  - Else compute `immediate = amount * bps / 10000`, `vested = amount - immediate`.
    Mint `immediate` to recipient, mint `vested` to vault, then call
    `vault.createSchedule(modelId, token, recipient, amount, immediate,
    vested, duration, cliff)`. Emits `TokensMinted(modelId, recipient,
    immediate)` and lets the vault emit `RewardVestingCreated`.
  - If `vested == 0` (e.g. bps == 10000 → 100% immediate), skip vault call
    and mint full amount liquid.
  - If `vault == address(0)` and vesting is enabled, revert with
    `"Reward vesting vault not set"`.
- Add `batchMintReward(string modelId, address[] recipients, uint256[] amounts)`:
  - Mirrors `batchMintTokens`. For each non-zero amount, performs the same
    split logic via the vault. Zero-amount entries emit
    `ContributorSkipped` exactly as today.
  - Emits a `BatchRewardsMinted(modelId, recipients, amounts, totalAmount)`
    event (parallel to `BatchMinted`).

Existing `mintTokens` and `batchMintTokens` remain unchanged so the AMM keeps
working without changes.

### 5. `DeltaVerifier.sol` updates

- In `_processEvaluation`: replace
  `tokenManager.mintTokens(modelIdStr, data.contributor, rewardAmount)`
  with `tokenManager.mintReward(modelIdStr, data.contributor, rewardAmount)`.
- In `submitEvaluationWithMultipleContributors`: replace
  `tokenManager.batchMintTokens(modelIdStr, contributorAddresses, rewardAmounts)`
  with `tokenManager.batchMintReward(...)`.
- No change to math (`calculateRewardDynamic`, `calculateDeltaOne`,
  budget checks, contribution registry recording).

### 6. Helpers / scripts

- Extend `test/helpers/tokenDeployment.js`:
  - Export `defaultVestingConfig()` returning `{ enabled: true,
    immediateUnlockBps: 1000, vestingDurationSeconds: 365 * 24 * 60 * 60,
    cliffSeconds: 0 }`.
  - `buildInitialParams` includes `vestingConfig: defaultVestingConfig()`
    by default and accepts overrides.
- `scripts/deploy.js` (if present) wiring: after deploying TokenManager,
  deploy `RewardVestingVault`, then call
  `tokenManager.setRewardVestingVault(...)`. Check existing deploy scripts
  and update minimally — only the production deploy script and any
  smoke test scripts that already wire DeltaVerifier.

## File-level plan

| Action  | Path |
| ------- | ---- |
| ADD     | `contracts/interfaces/IRewardVestingVault.sol` |
| ADD     | `contracts/RewardVestingVault.sol` |
| EDIT    | `contracts/interfaces/IHokusaiParams.sol` (struct, view fns, events, setter) |
| EDIT    | `contracts/HokusaiParams.sol` (state, constructor, views, setter, validation) |
| EDIT    | `contracts/TokenManager.sol` (vault wiring, `mintReward`, `batchMintReward`, InitialParams extension) |
| EDIT    | `contracts/DeltaVerifier.sol` (switch to `mintReward`/`batchMintReward`) |
| EDIT    | `test/helpers/tokenDeployment.js` (default vesting + override) |
| ADD     | `test/RewardVestingVault.test.js` |
| ADD     | `test/TokenManager.vesting.test.js` |
| ADD     | `test/DeltaVerifier.vesting.integration.test.js` |
| EDIT    | `test/HokusaiParams.test.js` (add vesting suite for params) |
| EDIT    | existing TokenManager/DeltaVerifier tests that build InitialParams (they go through `buildInitialParams`, so changes are transparent) |
| EDIT    | `scripts/deploy.js` (if it wires DeltaVerifier today, also wire vault) |

## Implementation phases (for the coding agent)

### Phase 1 — Params layer (vesting fields)
1. Extend `IHokusaiParams` with `VestingConfig` struct, view fns, setter, events.
2. Implement in `HokusaiParams`: constants, state, constructor arg, getters,
   setter, validation, `VestingConfigSet` event. `defaultVestingConfig()`
   returns the protocol default. Add params-level vesting tests covering:
   default values from constants, custom values stored & retrievable,
   validation (bps > 10000, duration == 0 while enabled, cliff > duration,
   non-GOV setter call reverts).

### Phase 2 — Vault contract
1. Add `IRewardVestingVault`.
2. Add `RewardVestingVault` with controller-gated `createSchedule`, linear
   math, `claim`, view functions, committed-balance accounting, events,
   `nonReentrant` claim.
3. Add `RewardVestingVault.test.js` covering:
   - construction (controller required)
   - controller-only `createSchedule`
   - schedule storage round-trip
   - `claimable`/`vestedAmount`/`unvestedAmount` curve at t=0, cliff-end,
     50%, 100%, beyond-end
   - cliff > 0 prevents claim before cliff
   - over-claim rejected
   - second claim after partial works
   - reentrancy attempt (mock malicious token) doesn't drain
   - committed-balance refuses oversubscription (mint less than promised)
   - `getSchedulesForBeneficiary` returns ids

### Phase 3 — TokenManager wiring
1. Extend `InitialParams` with `vestingConfig`.
2. Forward vesting config in both deploy paths and emit
   `ParamsVestingConfigured`.
3. Add `rewardVestingVault` storage + setter + event.
4. Add `mintReward` and `batchMintReward` (auth identical to today; falls
   back to plain mint when `!vestingEnabled` or `immediateUnlockBps == 10000`;
   reverts when vault unset and vesting enabled).
5. Add `TokenManager.vesting.test.js`:
   - vesting disabled → mintReward mints full to recipient (no schedule)
   - vesting enabled default 10/90 → recipient gets 10%, vault gets 90%,
     schedule created with correct timing, RewardVestingCreated event
   - custom immediate unlock (e.g. 2500 bps → 25%)
   - custom duration (e.g. 30 days)
   - immediateUnlockBps == 10000 → fully liquid even with vesting "enabled"
   - vault unset + vesting enabled → revert
   - non-MINTER caller → revert
   - batchMintReward distributes per-recipient (mixed amounts incl. zero;
     zero entries emit ContributorSkipped and don't create schedules)
   - reward minted post-deactivation reverts (registry inactive)

### Phase 4 — DeltaVerifier integration
1. Switch `mintTokens`/`batchMintTokens` calls to the reward variants.
2. Add `DeltaVerifier.vesting.integration.test.js`:
   - end-to-end: deploy params with default vesting, deploy token, register
     model, set DeltaVerifier, submitEvaluation with a 100% delta and verify
     contributor receives 10% immediately + 90% in vault schedule with
     duration 365 days
   - half-year fast-forward: claim returns ≈ 50% of vested portion (±1 sec)
   - full-year fast-forward: claim returns 100% of vested portion
   - batch path (`submitEvaluationWithMultipleContributors`): three
     contributors with weights 5000/3000/2000 each get their own schedule
     with the right split
   - **AMM cannot drain unvested rewards**: in the integration scenario,
     have the contributor try to sell their full reward into the AMM and
     verify only the liquid 10% can be sold (transferFrom reverts on the
     remainder because the contributor doesn't hold it)
   - vesting disabled path: contributor gets full liquid amount (parity
     with old behavior)

### Phase 5 — Helpers, scripts, cleanup
1. Update `test/helpers/tokenDeployment.js` to default vesting via the new
   helper.
2. Update `scripts/deploy.js` (and any sepolia/testnet deploy script that
   already wires DeltaVerifier) to also deploy the vault and call
   `setRewardVestingVault`.
3. Run `npx hardhat compile` and the full `npm test` suite. Triage any
   incidental breakage from the `InitialParams` struct extension (most
   tests should be unaffected because they go through `buildInitialParams`).

## Edge cases & risks

- **Rounding dust**: `immediate = amount * bps / 10000` rounds down. The
  vested portion gets the remainder, which is correct (the contributor still
  receives the exact `amount` over the schedule's lifetime).
- **`amount = 0`**: `mintReward` should early-return (or skip) the same way
  `batchMintTokens` skips zero amounts today. Keep behavior consistent.
- **`immediateUnlockBps = 0`**: 100% vests. Valid, no special case.
- **`immediateUnlockBps = 10000`**: 100% immediate. Skip vault entirely.
- **Cliff == duration**: legal but means a single cliff-edge unlock. Math
  must still emit `RewardVestingCreated` and `claim` returns 0 until cliff.
- **Reentrancy**: `claim` is `nonReentrant` and follows
  checks-effects-interactions. ERC20 transfer last.
- **Per-token accounting**: vault tracks `totalCommitted[token]` (sum of
  un-claimed vested portions). `createSchedule` requires
  `token.balanceOf(vault) >= totalCommitted + newVestedAmount`. Token must
  already be minted into the vault before `createSchedule` is called —
  TokenManager mints first, then calls the vault.
- **String `modelId` indexing**: Solidity hashes the string for the indexed
  topic. Off-chain consumers must compare against the hash; this is the
  same pattern as existing `TokensMinted`.
- **Multiple schedules per contributor**: each reward creates a new
  scheduleId. `getSchedulesForBeneficiary` lets consumers enumerate.
- **Token decimals**: untouched. We never scale amounts.
- **Pause / model deactivation**: `mintReward` enforces
  `isStringActive(modelId)` exactly like `mintTokens`. `claim` is independent
  of model state — pre-existing vested rewards should always be claimable.
  Document explicitly in vault NatSpec.
- **Existing `InitialParams` callers**: the struct extension is breaking at
  the Solidity ABI level. All known callers in this repo go through
  `buildInitialParams` (tests, scripts), which we extend transparently.
  The contract-deployer service may need a corresponding TS update —
  flag this in the PR description but it is out of scope for this PR.

## Release readiness

- **`database_change_risk`**: `none` (smart contract change, no DB schema).
- **`env_changes`**: `none`.
- **`config_changes`**: `none` in this repo. Downstream `contract-deployer`
  service must add the vesting fields to its deployment params builder; not
  in scope for this PR but called out for the PR description.
- **`manual_steps`**:
  - `deploy RewardVestingVault and call setRewardVestingVault on TokenManager during testnet/mainnet deploy`
  - `if migrating existing TokenManager: deploy vault, wire it via setter before next reward mint`

## Test scenarios (mapped to spec)

| Spec scenario | Covered in |
| -- | -- |
| default 10% immediate / 90% vested | `TokenManager.vesting.test.js` + integration |
| custom immediate unlock percentage | `TokenManager.vesting.test.js` |
| custom vesting duration | `TokenManager.vesting.test.js` |
| zero cliff linear vesting | `RewardVestingVault.test.js` |
| batch rewards | `TokenManager.vesting.test.js` + integration |
| claim before vesting | `RewardVestingVault.test.js` (returns 0) |
| partial claim after 6 months | `RewardVestingVault.test.js` + integration |
| full claim after 12 months | `RewardVestingVault.test.js` + integration |
| vesting disabled | `TokenManager.vesting.test.js` + integration |
| attempted over-claim | `RewardVestingVault.test.js` |
| AMM cannot drain unvested rewards | `DeltaVerifier.vesting.integration.test.js` |

## Out of scope

- Cliff schedules with non-linear curves (exponential, milestone-based).
- Re-vesting on revocation (no revocation in v1).
- Front-end UI work.
- Off-chain SDK/service updates beyond the test helpers in this repo.
- Linking vesting params into the epoch-based pending-update flow.
