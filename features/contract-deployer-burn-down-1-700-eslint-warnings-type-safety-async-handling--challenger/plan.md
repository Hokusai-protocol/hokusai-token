# HOK-2118_c — Contract-deployer eslint warning burn-down: Implementation Plan

## 1. Context & Baseline

`services/contract-deployer` currently exits 0 from `npm run lint` because the high-volume, behavior-sensitive `@typescript-eslint/recommended-requiring-type-checking` rules are set to **`warn`** (HOK-2102 / PR #146). CI gates on errors, so progress is only "locked in" once a rule graduates back to `error`.

**Measured baseline in this worktree (npm ci + `npm run lint`):**

| count | rule | category |
| --: | -- | -- |
| 410 | `@typescript-eslint/no-unsafe-member-access` | type-safety |
| 286 | `@typescript-eslint/no-unsafe-assignment` | type-safety |
| 260 | `@typescript-eslint/strict-boolean-expressions` | behavior |
| 154 | `@typescript-eslint/no-explicit-any` | type-safety |
| 148 | `@typescript-eslint/no-unsafe-argument` | type-safety |
| 139 | `no-console` | style |
| 125 | `@typescript-eslint/prefer-nullish-coalescing` | behavior |
| 117 | `@typescript-eslint/no-unsafe-call` | type-safety |
|  59 | `@typescript-eslint/explicit-function-return-type` | style |
|  46 | `@typescript-eslint/require-await` | async |
|  41 | `@typescript-eslint/no-misused-promises` | async |
|  28 | `@typescript-eslint/no-floating-promises` | async |
|  25 | `@typescript-eslint/explicit-module-boundary-types` | style |
|  21 | `@typescript-eslint/no-unsafe-return` | type-safety |
|   4 | `@typescript-eslint/restrict-template-expressions` | style |
| **1863** | **total warnings** (1047 src / 886 tests) | |

(Baseline is ~150 higher than the original issue snapshot — drift from intervening merges.)

Top warning sources (file → count):
1. `tests/api/deployments.test.ts` — 185
2. `src/config/monitoring-config.ts` — 113
3. `tests/unit/blockchain/delta-verifier-client.test.ts` — 93
4. `tests/integration/mint-request-flow.test.ts` — 82
5. `tests/unit/monitoring/health-check.test.ts` — 74
6. `src/monitoring/state-tracker.ts` — 65
7. `tests/deployment/containerization.test.ts` — 61
8. `src/monitoring/amm-monitor.ts` — 59
9. `src/monitoring/pool-discovery.ts` — 51
10. `src/blockchain/model-registry.ts` — 46

A clear pattern emerges: **the monitoring/ subtree, the test mocks, and the deployments API tests are the dominant sources**. The mint path itself is comparatively cleaner.

## 2. Scope Decision (Recommendation)

The Linear issue's acceptance criteria covers all five rule families. A single PR that resolves all 1,863 warnings and promotes every rule to `error` is technically possible but:

- The diff would be on the order of thousands of touched lines across 69 files.
- Behavior-sensitive conversions (`strict-boolean-expressions`, `prefer-nullish-coalescing`, async semantics) require careful per-site review.
- The original issue explicitly says "**Each phase can be its own PR**" and labels mass-autofix as unsafe.

**Recommendation:** produce ONE focused PR that delivers the two phases with the highest real-bug value and the highest leverage cascade, and explicitly defer the remaining phases to follow-up issues under the same parent epic. Concretely:

- **In scope for this PR:** Phase 1 (async safety) + Phase 2 (type the sources). This eliminates the ~99 async warnings (real-bug value) and is expected to cascade-eliminate a large fraction of the ~903 `no-unsafe-*` warnings by typing `JSON.parse` results, ethers contract wrappers, and jest mock helpers.
- **Deferred to follow-up Linear issues** (HOK-2118_d, _e, _f — open via Linear after merge): Phase 3 (no-explicit-any residue), Phase 4 (strict-boolean / nullish-coalescing), Phase 5 (style rules).
- **Rule promotion in `.eslintrc.json`:** promote any rule whose final count is **0** in this PR. Expected: the three async rules unconditionally; some `no-unsafe-*` rules conditionally on cleanup outcome.

This decision is captured in section 12 (Open Questions) so the user can override before approval.

## 3. Architectural Decisions

### 3.1 Async route-handler wrapper for Express

Express 4 does not auto-catch async handler rejections, which is the primary driver of `no-misused-promises` warnings on `app.get('/x', async (req, res) => …)`. Two viable approaches:

- **Adopt `express-async-handler` (npm package).** Pros: tiny, battle-tested, zero in-house surface. Cons: new dep.
- **Author an in-repo `asyncHandler<T>(fn): RequestHandler` wrapper** in `src/middleware/`. Pros: no new dep, types we control. Cons: ~10 lines we own.

**Decision:** author it in-repo. The implementation is trivial (`(fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)`), and we already own `src/middleware/error-handler.ts` which it must integrate with. This avoids a new dependency and keeps the failure surface inside the existing error-handler pipeline.

### 3.2 Typing `JSON.parse` call sites

There are 36 `JSON.parse` sites across `src/` and `tests/`. A few already cast `as MintRequestMessage` etc., which silences `no-unsafe-*` but is also unsafe. The right tool for each site:

- **Trusted-source parses** (e.g. own-written redis state, deployment artifact JSON we control): type the result via a small typed wrapper `parseTrusted<T>(s: string): T` and a one-line type assertion. Document the trust assumption in a one-line comment at the wrapper definition only.
- **Untrusted-source parses** (queue messages, external responses): run them through a **Joi schema** (already a project dep) or a hand-written type guard. The mint-request schema in `src/schemas/mint-request-schema.ts` is the existing pattern — reuse it as the model.
- For tests reading fixtures from disk: typed cast with a one-line comment is acceptable.

**Decision:** introduce `src/utils/json.ts` with `parseTrusted<T>(s: string): T` and `parseValidated<T>(s: string, schema: Joi.Schema): T` helpers. Migrate the 36 sites to use one or the other.

### 3.3 Typing ethers contract wrappers

Many `no-unsafe-*` warnings come from `new ethers.Contract(addr, abi, signer)` returning a `Contract` whose method signatures are `any`. Ethers v6 supports typed contract factories via codegen (`typechain`) but we don't currently run it. Two options:

- **Bring in `typechain`** + ethers v6 target. Pros: durable. Cons: build-step change, new dev dep, separate effort.
- **Hand-write minimal interfaces per contract** (e.g. `type DeltaVerifierContract = ethers.Contract & { submitMintRequest(...): Promise<ethers.TransactionResponse>; SUBMITTER_ROLE(): Promise<string>; … }`). Pros: zero build change. Cons: hand-maintained.

**Decision:** hand-written minimal interfaces in `src/blockchain/contract-types.ts`, scoped to the contracts we actually use (`DeltaVerifier`, `ModelRegistry`, `BurnAuction`, `HokusaiToken`). Typechain is a worthy follow-up but out of scope here — the issue is about ESLint warnings, not build-system changes.

### 3.4 Typing jest mocks

`tests/mocks/ethers-mock.ts` and `redis-mock.ts` return loosely-typed objects that cascade `any` through every test that uses them. Solution: give each mock factory an explicit return type matching the relevant interface, using `jest.MockedFunction<…>` or `jest.Mocked<…>` where appropriate. Several mocks already use `jest.Mocked<ethers.Provider>` partially — extend that pattern.

### 3.5 Phase 1 fix patterns

For `no-floating-promises`: prefer `await` when in an async context; otherwise `void promise` for deliberate fire-and-forget, or `promise.catch(logAndSwallow)` when we want the error logged. **No `// eslint-disable` lines.**

For `no-misused-promises`: most occurrences are passing async functions to APIs that expect `(…) => void` (e.g. `setInterval`, Express handlers, `redis.on('message', async …)`). Fixes:
- Express handlers → wrap with `asyncHandler` (3.1).
- `setInterval`/`setTimeout` callbacks → wrap with `void (async () => { … })()`.
- Event emitters (`redis.on`) → wrap the listener identically.

For `require-await`: either add the missing `await` (often a forgotten await on a returned promise), or remove the `async` keyword when the function genuinely doesn't need it.

### 3.6 Rule promotion gate

For each rule whose count reaches **0**, flip the corresponding entry in `.eslintrc.json` from `"warn"` to `"error"`. This is the durable lock-in — CI now rejects any regression. For rules whose count is non-zero at the end of this PR, leave at `"warn"`.

## 4. Out-of-Scope (this PR)

- `no-explicit-any` residue after Phase 2 cascade (Phase 3, deferred).
- `strict-boolean-expressions` and `prefer-nullish-coalescing` per-site fixes (Phase 4, deferred).
- `no-console` / `explicit-*-types` / `restrict-template-expressions` (Phase 5, deferred).
- Introducing `typechain` (build-system change).
- Any non-lint refactor or behavior change.
- Any mint-path correctness changes — those would require MintRequest seam coordination per [[project_mintrequest_seam_authority]].

## 5. Implementation Phases (in execution order)

### Phase A: Foundations (no warnings fixed yet)

A.1. Create `src/middleware/async-handler.ts` exporting `asyncHandler<P, ResBody, ReqBody, ReqQuery>(fn): RequestHandler`. Plumb its error path into the existing `errorHandler` middleware.

A.2. Create `src/utils/json.ts` exporting `parseTrusted<T>(s: string): T` and `parseValidated<T>(s, schema: Joi.Schema): T`. The `parseTrusted` wrapper carries a top-of-function comment recording the "trusted-source" invariant.

A.3. Create `src/blockchain/contract-types.ts` exporting minimal typed wrappers for `DeltaVerifierContract`, `ModelRegistryContract`, `BurnAuctionContract`, `HokusaiTokenContract` — each as `ethers.Contract & { …signatures we call… }`. Include a small `typedContract<T>(addr, abi, runner): T` factory.

A.4. Strengthen `tests/mocks/ethers-mock.ts` and `tests/mocks/redis-mock.ts` to return `Partial<jest.Mocked<…>>` where the assertion narrows correctly. Where partial-mocks are intentional, expose a typed factory that returns the explicit subset (avoiding `as any`).

A.5. Add a tiny `npm run lint:report` script (`eslint src tests --ext .ts -f json | jq …`) for re-measuring per-rule counts without scrolling output. Optional but useful for grading.

### Phase B: Async safety burn-down (target: `no-floating-promises`, `no-misused-promises`, `require-await` → 0)

B.1. **`src/routes/*.ts`** — convert async route handlers to `asyncHandler(...)` wrapping. Files: `routes/health.ts`, `routes/deployments.ts`, `routes/monitoring.ts`, `routes/reconciliation.ts`.

B.2. **`src/server.ts`** — fix any direct async lambda passed to express. Wrap top-level `start()` await chain; fire-and-forget startup tasks marked `void`.

B.3. **`src/monitoring/*.ts`** — `setInterval(async () => …)` patterns get wrapped via `void (async () => …)()`. Same for redis `on('message', …)` handlers.

B.4. **`src/queue/*.ts`** — consumer loops: validate every `await` is intentional; fire-and-forget metric updates use `void`.

B.5. **`src/services/*.ts`** — `require-await` fixes: remove `async` where genuinely sync, or add the missing await.

B.6. **`tests/**`** — fix floating promises in test setup/teardown (typically missing `await` on `redis.quit()` etc.). `require-await` in mock factories: drop `async` keyword.

B.7. Re-measure: confirm 0 of each async rule. Promote in `.eslintrc.json` to `"error"`.

### Phase C: Source-typing cascade (target: `no-unsafe-member-access`, `no-unsafe-assignment`, `no-unsafe-argument`, `no-unsafe-call`, `no-unsafe-return` → as low as possible)

C.1. Migrate all 36 `JSON.parse` call sites to `parseTrusted<T>` or `parseValidated<T>`. The mint path (`mint-request-consumer.ts`, `event-publisher.ts`) uses `parseValidated` with the existing mint-request Joi schema (avoid changing the canonical schema — see [[project_mintrequest_seam_authority]]).

C.2. Replace `new ethers.Contract(...)` call sites with `typedContract<…>(...)` from `contract-types.ts`. Apply across:
   - `src/blockchain/delta-verifier-client.ts`
   - `src/blockchain/model-registry.ts`
   - `src/blockchain/contract-deployer.ts`
   - `src/services/blockchain.service.ts`
   - `src/monitoring/amm-monitor.ts`, `pool-discovery.ts`, `event-listener.ts`, `state-tracker.ts` (where they instantiate contracts)
   - `src/routes/health.ts` (where it instantiates `DeltaVerifier` for the readiness check)

C.3. In `tests/`, replace the `as DeltaVerifierClient` shim casts (visible in `tests/api/deployments.test.ts:182`, `:204`) with typed mock factories from the strengthened `tests/mocks`.

C.4. Where residual `no-unsafe-*` is rooted in third-party APIs we can't type (e.g. AWS SDK responses), introduce **narrow typed wrappers** in the file that owns the call — not call-site casts. This concentrates the unsafety to one auditable line per source.

C.5. Re-measure. For each `no-unsafe-*` rule whose count is 0, promote to `"error"`.

### Phase D: Promotion & cleanup

D.1. Update `.eslintrc.json` to set promoted rules to `"error"`. Leave anything still > 0 at `"warn"`.

D.2. Run `npm run lint` — must exit 0 with the reduced warning total. Capture before/after counts in the PR description.

D.3. Run `npm test`. Specifically verify:
   - `tests/unit/queue/mint-request-consumer.test.ts` (JSON.parse migration touched mint path)
   - `tests/unit/blockchain/golden-fixture-parity.test.ts` (digest/wire parity unchanged — fixture parse path)
   - `tests/api/deployments.test.ts` (mock typing changes)
   - `tests/integration/*` (async handler wrapping)

D.4. Run `npx hardhat compile` and `npm run typecheck` to confirm no TS regressions.

### Phase E: Follow-up issues (Linear, not code)

After PR merges, file follow-ups under HOK-2053:
- `HOK-2118_d`: remaining `no-explicit-any` (Phase 3).
- `HOK-2118_e`: `strict-boolean-expressions` + `prefer-nullish-coalescing` (Phase 4).
- `HOK-2118_f`: style rules (Phase 5).

(Filing these is a manual user action — out of scope for the coding agent.)

## 6. Files Expected to Change

**New:**
- `services/contract-deployer/src/middleware/async-handler.ts`
- `services/contract-deployer/src/utils/json.ts`
- `services/contract-deployer/src/blockchain/contract-types.ts`

**Modified — config:**
- `services/contract-deployer/.eslintrc.json` (rule promotions)
- `services/contract-deployer/package.json` (only if `lint:report` script added — optional)

**Modified — src (async safety + cascade):** all four files in `src/routes/`, `src/server.ts`, `src/mint-request-listener.ts`, `src/contract-deploy-listener.ts`, the four files in `src/blockchain/`, the five files in `src/services/`, the six files in `src/queue/`, the six files in `src/monitoring/`, plus a handful in `src/config/`.

**Modified — tests:** mock helpers (`tests/mocks/*.ts`), the top-warning test files (`tests/api/deployments.test.ts`, the unit and integration tests under `tests/unit/blockchain/`, `tests/integration/`, `tests/deployment/`).

Conservative estimate: ~50 files touched. Realistic upper bound: ~65.

## 7. Test Scenarios

Lint is the primary signal — the test suite is the regression guard.

| scenario | command | passes if |
| -- | -- | -- |
| no new lint errors | `npm run lint` | exits 0, total warnings reduced from 1863, async family = 0 |
| no TS regressions | `npm run typecheck` | exits 0 |
| existing test suite green | `npm test` | exits 0 |
| mint path digest unchanged | `npm test -- golden-fixture-parity` | exits 0 (this is the gate from [[project_mintrequest_seam_authority]]) |
| Express async error path still funnels to `errorHandler` | `npm test -- routes` | exits 0, error response shape unchanged |
| contracts compile | `npx hardhat compile` (repo root) | exits 0 |

No new tests are required for this PR — we are not adding behavior. We **must not weaken or skip** any existing test to silence a warning.

## 8. Risks & Mitigations

| risk | mitigation |
| -- | -- |
| `||` → `??` change masks an existing bug | OUT OF SCOPE this PR; deferred to Phase 4. |
| Async wrapper changes alter error response shape | `asyncHandler` forwards to existing `errorHandler` via `next(err)` — unchanged. Covered by routes tests. |
| `void promise` masks an error that was previously surfaced | Pick `void` only where we genuinely want fire-and-forget; otherwise `.catch(logger.error)`. Per-site judgment, not blanket. |
| Typing change to `JSON.parse` of redis mint-request payload diverges from token-repo schema | Use the existing canonical Joi schema unchanged ([[project_mintrequest_seam_authority]]). Gate: `golden-fixture-parity` test. |
| Ethers v6 contract type changes break runtime calls | Hand-typed `Contract & { … }` only narrows the type — runtime behavior is unchanged. |
| Test mocks become too strict and fail elsewhere | Use `Partial<jest.Mocked<…>>` for partial mocks; only the methods actually mocked are required. |
| Promoting a rule to `error` while a sibling file still has 1 occurrence | Re-measure after each cluster; only promote rules whose final count is 0. |

## 9. Step-by-Step Execution Checklist (for coder agent)

1. `npm ci` in `services/contract-deployer/` (already done in planning; coder confirms).
2. Capture pre-state: `npm run lint 2>&1 | grep -oE '@typescript-eslint/[a-z-]+|no-console' | sort | uniq -c | sort -rn > /tmp/lint-pre.txt`.
3. Implement Phase A (foundations) — no warning-count change expected; verify file compiles via `npm run typecheck`.
4. Implement Phase B (async). Re-measure after each subphase (B.1, B.2, …). Target: all three async rules = 0.
5. Promote `no-floating-promises`, `no-misused-promises`, `require-await` to `error` in `.eslintrc.json`.
6. Re-run `npm run lint` — confirm exit 0.
7. Implement Phase C (source typing). Re-measure after each subphase.
8. Promote any `no-unsafe-*` rule whose count is 0.
9. Re-run `npm run lint` — confirm exit 0 with reduced warnings.
10. Run `npm test`, `npm run typecheck`, `npx hardhat compile` (repo root) — all green.
11. Capture post-state: `npm run lint 2>&1 | grep -oE '@typescript-eslint/[a-z-]+|no-console' | sort | uniq -c | sort -rn > /tmp/lint-post.txt`.
12. Diff the two for the PR description.

## 10. Release Readiness

- `database_change_risk`: **none** — no migrations, no schema, no DB changes.
- `env_changes`: **none** — no new or modified environment variables.
- `config_changes`: `services/contract-deployer/.eslintrc.json` (rule promotions, no behavior change at runtime).
- `manual_steps`: **none** — pure code/typing cleanup, no deployment ritual.

## 11. PR Description Template (for reviewer phase)

```
HOK-2118_c: Contract-deployer eslint burn-down — Phases 1 & 2

Pre:  1863 warnings  (async 115, no-unsafe-* 1082, …)
Post: <N> warnings   (async 0, no-unsafe-* <M>, …)

Promoted to error in .eslintrc.json: <list>

What changed:
- New: src/middleware/async-handler.ts, src/utils/json.ts, src/blockchain/contract-types.ts
- Async handlers wrapped via asyncHandler (no behavior change — same errorHandler)
- JSON.parse call sites typed via parseTrusted / parseValidated
- Ethers contract instances typed via typedContract<...>
- Test mocks return Partial<jest.Mocked<...>>

Not in this PR (deferred to HOK-2118_d/e/f):
- no-explicit-any cleanup
- strict-boolean-expressions / prefer-nullish-coalescing (behavior-sensitive)
- style rules (no-console etc.)

Risk: low. No behavior change. Mint-path golden-fixture-parity test gates the JSON.parse migration.
```

## 12. Open Questions for the User

1. **Scope confirmation.** Is the recommended "Phase 1 + Phase 2" scope acceptable for this single PR, deferring Phases 3–5 to follow-up Linear issues? (Alternative: attempt all phases in one PR — higher risk, longer review.)
2. **Async wrapper choice.** OK to author `asyncHandler` in-repo rather than adopting `express-async-handler`? (Saves a dep.)
3. **Typechain.** Confirm typechain codegen is out of scope here? (Hand-written contract types are the chosen alternative.)
4. **Rule promotion threshold.** Promote a rule to `error` only when its count is exactly 0, or also when it drops below a threshold (e.g. ≤2) with `// eslint-disable-next-line` annotations on the residue? (Recommendation: only at 0 — no disable comments.)
