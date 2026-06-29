// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../DataContributionRegistry.sol";
import "../DeltaVerifier.sol";
import "../ModelRegistry.sol";
import "../TokenManager.sol";
import "../interfaces/IHokusaiParams.sol";

interface IHevm {
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8 v, bytes32 r, bytes32 s);
}

/**
 * @dev Echidna harness for DeltaVerifier (HOK-2137 base + HOK-2171 governance/lifecycle extensions).
 *
 * The base contract registers a single attester (MOCK_ATTESTER, key=1) at threshold 1 and fuzzes the
 * canonical submitMintRequest path interleaved with the governance/lifecycle surfaces: attester churn,
 * lineage-head resets, the one-way legacy-mint disable latch, idempotency replay, pause/unpause, and
 * an on-chain (harness-independent) budget cross-check.
 *
 * Two virtuals — `_attesterKeys()` and `_currentThreshold()` — let the m-of-n subclass
 * (EchidnaDeltaVerifierMultiAttester) reuse the entire body with a 2-of-3 signer set.
 *
 * Harness-modeling note: every payload sets `deadline = type(uint256).max`. The contract's HOK-2170
 * expiry check (`block.timestamp > payload.deadline`) would otherwise revert every mint (default
 * deadline 0), making the mint properties vacuous. This is a harness fix, not a contract change.
 */
contract EchidnaDeltaVerifier {
    struct ModelConfig {
        uint256 modelId;
        string modelIdStr;
        bytes32 genesis;
        uint256 initialBudget;
        bytes32 expectedHead;
        uint256 trackedMinted;
    }

    // Known HEVM signer keys (cheatcode key -> recovered address). Ascending by address:
    //   key2 0x2B5AD5...  <  key3 0x6813Eb...  <  key1 0x7E5F45...
    uint256 internal constant ATTESTER_KEY_1 = 1; // 0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf
    uint256 internal constant ATTESTER_KEY_2 = 2; // 0x2B5AD5c4795c026514f8317c7a215E218DcCD6cF
    uint256 internal constant ATTESTER_KEY_3 = 3; // 0x6813Eb9362372EEF6200f3b1dbC3f819671cBA69
    address internal constant ATTESTER_ADDR_1 = 0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf;
    address internal constant ATTESTER_ADDR_2 = 0x2B5AD5c4795c026514f8317c7a215E218DcCD6cF;
    address internal constant ATTESTER_ADDR_3 = 0x6813Eb9362372EEF6200f3b1dbC3f819671cBA69;

    address private constant USER_A = address(0x4101);
    address private constant USER_B = address(0x4102);
    address private constant USER_C = address(0x4103);
    IHevm internal constant HEVM = IHevm(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D);

    ModelRegistry public registry;
    TokenManager public manager;
    DataContributionRegistry public contributionRegistry;
    DeltaVerifier public deltaVerifier;

    ModelConfig[3] internal models;
    address[3] internal recipients;

    bool internal hevmSigningUnavailable;
    bool private forgedMintSucceeded;
    bool private wrongParentAccepted;
    bool private overBudgetAccepted;
    bool internal lineageInvariantBroken;

    // --- HOK-2171 invariant flags ---
    // (1) attester churn: a mint with fewer than threshold valid signatures must never mint.
    bool private subThresholdMintSucceeded;
    // (2)/(3) legacy disable latch + post-disable legacy success.
    bool private legacyDisabledLatched;
    bool private legacyMintSucceededAfterDisable;
    // (4) idempotency replay: a second mint for an already-seen key must never succeed.
    bool private idempotencyDoubleMint;
    mapping(bytes32 => bool) private harnessSeenKey;
    // (6) pause interleaving: no state transition may occur while paused.
    bool private mutationWhilePaused;

    uint256 internal requestNonce;

    constructor() {
        registry = new ModelRegistry();
        manager = new TokenManager(address(registry));
        contributionRegistry = new DataContributionRegistry();
        deltaVerifier = new DeltaVerifier(
            address(registry),
            payable(address(manager)),
            address(contributionRegistry),
            100 ether,
            100,
            1_000_000 ether
        );

        manager.setDeltaVerifier(address(deltaVerifier));
        contributionRegistry.grantRole(contributionRegistry.RECORDER_ROLE(), address(deltaVerifier));
        deltaVerifier.grantRole(deltaVerifier.SUBMITTER_ROLE(), address(this));

        _configureAttesters();

        recipients[0] = USER_A;
        recipients[1] = USER_B;
        recipients[2] = USER_C;

        _seedModel(0, 101, "echidna-delta-a", 250 ether, keccak256("echidna-delta-genesis-a"));
        _seedModel(1, 202, "echidna-delta-b", 450 ether, keccak256("echidna-delta-genesis-b"));
        _seedModel(2, 303, "echidna-delta-c", 1_000 ether, keccak256("echidna-delta-genesis-c"));
    }

    // --- Attester-set configuration (overridable for m-of-n) ---

    /// @dev Base: register the single launch attester (key 1) at threshold 1.
    function _configureAttesters() internal virtual {
        deltaVerifier.addAttester(ATTESTER_ADDR_1);
        deltaVerifier.setAttesterThreshold(1);
    }

    /// @dev The full pool of attester keys this harness signs with (subset used for the threshold).
    function _attesterKeys() internal pure virtual returns (uint256[] memory keys) {
        keys = new uint256[](1);
        keys[0] = ATTESTER_KEY_1;
    }

    /// @dev How many signatures a valid request carries (== the configured on-chain threshold).
    function _currentThreshold() internal pure virtual returns (uint256) {
        return 1;
    }

    // =========================================================================
    // Original mint-path fuzzers (HOK-2137)
    // =========================================================================

    function submitValidRequest(
        uint8 modelSlotRaw,
        uint96 ignoredAmount,
        uint16 baselineBpsRaw,
        uint16 candidateBpsRaw
    ) external {
        if (hevmSigningUnavailable) {
            return;
        }

        uint256 slot = uint256(modelSlotRaw) % models.length;
        ModelConfig storage model = models[slot];

        uint16 baselineBps = uint16(uint256(baselineBpsRaw) % 9_500);
        uint16 candidateBps = baselineBps + uint16(uint256(candidateBpsRaw) % (10_001 - baselineBps));
        uint256 totalSamples = 1 + (uint256(ignoredAmount) % 1_000_000);

        DeltaVerifier.MintRequestPayload memory payload = _payloadForModel(model, baselineBps, candidateBps, totalSamples);
        DeltaVerifier.Contributor[] memory contributors = _singleContributor(recipients[slot]);

        _submitAndTrack(model, payload, contributors, true);
    }

    function submitForgedSignature(uint8 modelSlotRaw, bytes memory fakeSig) external {
        uint256 slot = uint256(modelSlotRaw) % models.length;
        ModelConfig storage model = models[slot];
        DeltaVerifier.MintRequestPayload memory payload = _payloadForModel(model, 5_000, 5_200, 10_000);
        DeltaVerifier.Contributor[] memory contributors = _singleContributor(recipients[slot]);
        bytes[] memory signatures = new bytes[](1);
        signatures[0] = fakeSig;

        try deltaVerifier.submitMintRequest(model.modelId, payload, contributors, signatures) returns (uint256 reward) {
            if (reward > 0) {
                forgedMintSucceeded = true;
            }
        } catch {}

        _checkLineage(slot);
    }

    function submitWrongLineageParent(uint8 modelSlotRaw, bytes32 fakeParent) external {
        if (hevmSigningUnavailable || fakeParent == bytes32(0)) {
            return;
        }

        uint256 slot = uint256(modelSlotRaw) % models.length;
        ModelConfig storage model = models[slot];
        DeltaVerifier.MintRequestPayload memory payload = _payloadForModel(model, 5_000, 5_200, 10_000);
        payload.baselineCommitment = fakeParent;
        if (payload.baselineCommitment == model.expectedHead) {
            payload.baselineCommitment = bytes32(uint256(fakeParent) ^ uint256(1));
        }

        DeltaVerifier.Contributor[] memory contributors = _singleContributor(recipients[slot]);
        bytes[] memory signatures = _sign(model.modelId, payload, contributors);
        if (signatures.length == 0) {
            return;
        }

        try deltaVerifier.submitMintRequest(model.modelId, payload, contributors, signatures) returns (uint256) {
            wrongParentAccepted = true;
        } catch {}

        _checkLineage(slot);
    }

    function submitOverBudget(uint8 modelSlotRaw) external {
        if (hevmSigningUnavailable) {
            return;
        }

        uint256 slot = uint256(modelSlotRaw) % models.length;
        ModelConfig storage model = models[slot];

        while (model.trackedMinted + 100 ether <= model.initialBudget) {
            DeltaVerifier.MintRequestPayload memory topUpAttempt = _payloadForModel(model, 5_000, 5_100, 10_000);
            DeltaVerifier.Contributor[] memory contributors = _singleContributor(recipients[slot]);
            uint256 beforeMinted = model.trackedMinted;
            _submitAndTrack(model, topUpAttempt, contributors, true);
            if (model.trackedMinted == beforeMinted) {
                break;
            }
        }

        DeltaVerifier.MintRequestPayload memory payload = _payloadForModel(model, 5_000, 5_200, 10_000);
        DeltaVerifier.Contributor[] memory finalContributors = _singleContributor(recipients[slot]);
        bytes[] memory signatures = _sign(model.modelId, payload, finalContributors);
        if (signatures.length == 0) {
            return;
        }

        try deltaVerifier.submitMintRequest(model.modelId, payload, finalContributors, signatures) returns (uint256 reward) {
            if (reward > 0 && model.trackedMinted + reward > model.initialBudget) {
                overBudgetAccepted = true;
            }
        } catch {}

        _checkLineage(slot);
    }

    // =========================================================================
    // HOK-2171 (1): attester churn
    // =========================================================================

    /// @dev Fuzz addAttester/removeAttester from the known-key pool. Both add and remove are governed and
    /// may revert (already-registered, not-registered, threshold-would-be-unmet); we swallow reverts and
    /// rely on the live-getter invariants below to catch any bad state.
    function churnAttesters(uint8 choiceRaw) external {
        uint256 choice = uint256(choiceRaw) % 6;
        address target = _attesterAddrForChoice(choice);
        if (choice < 3) {
            try deltaVerifier.addAttester(target) {} catch {}
        } else {
            try deltaVerifier.removeAttester(target) {} catch {}
        }
    }

    /// @dev Fuzz setAttesterThreshold across [0, attesterCount+1]; reverts for 0 / > count are expected.
    function churnThreshold(uint8 thresholdRaw) external {
        uint256 t = uint256(thresholdRaw) % (deltaVerifier.attesterCount() + 2);
        try deltaVerifier.setAttesterThreshold(t) {} catch {}
    }

    /// @dev Submit a request carrying STRICTLY FEWER than the current threshold valid signatures.
    /// The contract must reject it (InsufficientAttesterSignatures); flag if a positive mint slips through.
    function submitBelowThreshold(uint8 modelSlotRaw) external {
        if (hevmSigningUnavailable) {
            return;
        }
        uint256 threshold = deltaVerifier.attesterThreshold();
        if (threshold == 0) {
            return; // 0 means unconfigured; "fewer than 0" is not expressible.
        }

        uint256 slot = uint256(modelSlotRaw) % models.length;
        ModelConfig storage model = models[slot];
        DeltaVerifier.MintRequestPayload memory payload = _payloadForModel(model, 5_000, 5_200, 10_000);
        DeltaVerifier.Contributor[] memory contributors = _singleContributor(recipients[slot]);

        bytes[] memory full = _sign(model.modelId, payload, contributors);
        if (full.length == 0) {
            return;
        }
        // Drop the last signature so we carry (threshold - 1) at most.
        uint256 keep = full.length > threshold ? threshold - 1 : full.length - 1;
        bytes[] memory short = new bytes[](keep);
        for (uint256 i = 0; i < keep; i++) {
            short[i] = full[i];
        }

        try deltaVerifier.submitMintRequest(model.modelId, payload, contributors, short) returns (uint256 reward) {
            if (reward > 0) {
                subThresholdMintSucceeded = true;
            }
        } catch {}

        _checkLineage(slot);
    }

    // =========================================================================
    // HOK-2171 (2): resetModelHead interleaving
    // =========================================================================

    /// @dev Reset a model's lineage head between mints; on success mirror the new head into the harness's
    /// tracked expectedHead so echidna_lineage_monotonic stays a tight equality (head only moves via a
    /// tracked mint or a tracked admin reset).
    function resetHead(uint8 modelSlotRaw, bytes32 newHeadRaw) external {
        uint256 slot = uint256(modelSlotRaw) % models.length;
        ModelConfig storage model = models[slot];
        bytes32 newHead = newHeadRaw == bytes32(0) ? keccak256(abi.encodePacked("reset", requestNonce, slot)) : newHeadRaw;

        try deltaVerifier.resetModelHead(model.modelId, newHead) {
            model.expectedHead = newHead;
        } catch {}

        _checkLineageByModel(model);
    }

    // =========================================================================
    // HOK-2171 (3): disableLegacyMints one-way
    // =========================================================================

    function disableLegacy() external {
        try deltaVerifier.disableLegacyMints() {} catch {}
        if (deltaVerifier.legacyMintsDisabled()) {
            legacyDisabledLatched = true;
        }
    }

    /// @dev After disable, a legacy entrypoint must revert (LegacyMintEntrypointDisabled is its first line).
    /// A minimal/empty EvaluationData is fine: the disabled-check reverts before any field is read.
    function probeLegacyAfterDisable(uint8 modelSlotRaw) external {
        uint256 slot = uint256(modelSlotRaw) % models.length;
        ModelConfig storage model = models[slot];

        DeltaVerifier.EvaluationData memory data;
        try deltaVerifier.submitEvaluation(model.modelId, data) returns (uint256) {
            if (deltaVerifier.legacyMintsDisabled()) {
                legacyMintSucceededAfterDisable = true;
            }
        } catch {}
    }

    // =========================================================================
    // HOK-2171 (4): idempotency replay
    // =========================================================================

    /// @dev Submit a fresh request, then resubmit the IDENTICAL idempotencyKey/payload and assert the replay
    /// reverts. `costViolated` true exercises the zero-reward-but-key-burned path (key consumed, no payout),
    /// proving reuse is blocked even without a mint.
    function submitThenReplay(uint8 modelSlotRaw, bool costViolated) external {
        if (hevmSigningUnavailable) {
            return;
        }
        uint256 slot = uint256(modelSlotRaw) % models.length;
        ModelConfig storage model = models[slot];

        DeltaVerifier.MintRequestPayload memory payload = _payloadForModel(model, 5_000, 5_200, 10_000);
        if (costViolated) {
            // actualCost > maxCost > 0 => cost rejection: returns 0 but still burns the idempotency key.
            payload.maxCostUsdMicro = 1;
            payload.actualCostUsdMicro = 2;
        }
        DeltaVerifier.Contributor[] memory contributors = _singleContributor(recipients[slot]);
        bytes32 key = payload.anchors.idempotencyKey;

        bytes[] memory signatures = _sign(model.modelId, payload, contributors);
        if (signatures.length == 0) {
            return;
        }

        bool firstAccepted;
        try deltaVerifier.submitMintRequest(model.modelId, payload, contributors, signatures) returns (uint256 reward) {
            firstAccepted = true;
            harnessSeenKey[key] = true;
            if (reward > 0) {
                model.trackedMinted += reward;
                model.expectedHead = payload.candidateCommitment;
            }
        } catch {}
        _checkLineageByModel(model);

        if (!firstAccepted) {
            return; // nothing was consumed; replay carries no guarantee.
        }

        // Replay: identical key (re-sign the identical digest). Must revert.
        bytes[] memory replaySig = _sign(model.modelId, payload, contributors);
        try deltaVerifier.submitMintRequest(model.modelId, payload, contributors, replaySig) returns (uint256 replayReward) {
            // Any acceptance of an already-seen key is a double-spend of the idempotency guard.
            if (harnessSeenKey[key]) {
                idempotencyDoubleMint = true;
            }
            if (replayReward > 0) {
                model.trackedMinted += replayReward;
                model.expectedHead = payload.candidateCommitment;
            }
        } catch {}
        _checkLineageByModel(model);
    }

    // =========================================================================
    // HOK-2171 (6): pause interleaving
    // =========================================================================

    function pauseVerifier() external {
        try deltaVerifier.pause() {} catch {}
    }

    function unpauseVerifier() external {
        try deltaVerifier.unpause() {} catch {}
    }

    /// @dev Submit a real mint while the contract is paused; whenNotPaused must reject it. Flag if any
    /// observable state transition (mint, head advance, budget decrement, key burn) happens while paused.
    function submitWhilePaused(uint8 modelSlotRaw) external {
        if (hevmSigningUnavailable || !deltaVerifier.paused()) {
            return;
        }
        uint256 slot = uint256(modelSlotRaw) % models.length;
        ModelConfig storage model = models[slot];

        DeltaVerifier.MintRequestPayload memory payload = _payloadForModel(model, 5_000, 5_200, 10_000);
        DeltaVerifier.Contributor[] memory contributors = _singleContributor(recipients[slot]);
        bytes32 key = payload.anchors.idempotencyKey;
        bytes[] memory signatures = _sign(model.modelId, payload, contributors);
        if (signatures.length == 0) {
            return;
        }

        bytes32 headBefore = deltaVerifier.currentModelHead(model.modelId);
        uint256 budgetBefore = deltaVerifier.mintBudgetRemaining(model.modelId);

        try deltaVerifier.submitMintRequest(model.modelId, payload, contributors, signatures) returns (uint256) {
            // A successful return while paused is itself a violation.
            mutationWhilePaused = true;
        } catch {}

        if (
            deltaVerifier.currentModelHead(model.modelId) != headBefore ||
            deltaVerifier.mintBudgetRemaining(model.modelId) != budgetBefore ||
            deltaVerifier.processedIdempotencyKeys(key)
        ) {
            mutationWhilePaused = true;
        }
    }

    // =========================================================================
    // Properties
    // =========================================================================

    function echidna_minted_never_exceeds_budget() external view returns (bool) {
        for (uint256 i = 0; i < models.length; i++) {
            if (models[i].trackedMinted > models[i].initialBudget) {
                return false;
            }
        }
        return !overBudgetAccepted;
    }

    function echidna_no_mint_without_valid_signature() external view returns (bool) {
        return !forgedMintSucceeded;
    }

    function echidna_lineage_monotonic() external view returns (bool) {
        return !wrongParentAccepted && !lineageInvariantBroken;
    }

    // --- HOK-2171 properties ---

    /// (1) The contract self-enforces threshold <= count and threshold >= 1 (>=1 holds once configured; an
    /// unconfigured 0 is the fail-closed pre-launch state). Read live getters and assert the invariant.
    function echidna_attester_threshold_within_count() external view returns (bool) {
        uint256 threshold = deltaVerifier.attesterThreshold();
        uint256 count = deltaVerifier.attesterCount();
        if (threshold > count) {
            return false;
        }
        // Once any attester is configured, the launch invariant is threshold >= 1.
        if (count > 0 && threshold == 0) {
            return false;
        }
        return true;
    }

    /// (1) A request with fewer than threshold valid signatures must never mint.
    function echidna_no_mint_below_threshold() external view returns (bool) {
        return !subThresholdMintSucceeded;
    }

    /// (3) Once legacyMintsDisabled latches true it can never read false again.
    function echidna_legacy_disable_is_one_way() external view returns (bool) {
        if (legacyDisabledLatched && !deltaVerifier.legacyMintsDisabled()) {
            return false;
        }
        return true;
    }

    /// (3) No legacy entrypoint succeeds after the disable latch.
    function echidna_no_legacy_mint_after_disable() external view returns (bool) {
        return !legacyMintSucceededAfterDisable;
    }

    /// (4) A second mint for an already-seen idempotency key never succeeds.
    function echidna_no_idempotency_double_mint() external view returns (bool) {
        return !idempotencyDoubleMint;
    }

    /// (5) Independent (chain-state) accounting: budget consumed on-chain equals the harness's tracked
    /// total, and never exceeds the initial budget — verified from mintBudgetRemaining, not bookkeeping
    /// sums. Reward may be split by infrastructureAccrualBps, so mintBudgetRemaining (decremented by the
    /// full reward) is the correct ground truth, not token.totalSupply.
    function echidna_budget_accounting_matches_chain() external view returns (bool) {
        for (uint256 i = 0; i < models.length; i++) {
            uint256 remaining = deltaVerifier.mintBudgetRemaining(models[i].modelId);
            if (remaining > models[i].initialBudget) {
                return false;
            }
            if (models[i].initialBudget - remaining != models[i].trackedMinted) {
                return false;
            }
        }
        return true;
    }

    /// (6) No state transition occurs while paused.
    function echidna_no_mutation_while_paused() external view returns (bool) {
        return !mutationWhilePaused;
    }

    // =========================================================================
    // Internals
    // =========================================================================

    function _attesterAddrForChoice(uint256 choice) private pure returns (address) {
        uint256 idx = choice % 3;
        if (idx == 0) return ATTESTER_ADDR_1;
        if (idx == 1) return ATTESTER_ADDR_2;
        return ATTESTER_ADDR_3;
    }

    function _seedModel(
        uint256 slot,
        uint256 modelId,
        string memory modelIdStr,
        uint256 budget,
        bytes32 genesis
    ) private {
        IHokusaiParams.VestingConfig memory vestingConfig = IHokusaiParams.VestingConfig({
            enabled: false,
            immediateUnlockBps: 10_000,
            vestingDurationSeconds: 0,
            cliffSeconds: 0
        });

        TokenManager.InitialParams memory params = TokenManager.InitialParams({
            tokensPerDeltaOne: 100 ether,
            infrastructureAccrualBps: 8_000,
            initialOraclePricePerThousandUsd: 0,
            licenseHash: keccak256(bytes(modelIdStr)),
            licenseURI: "https://example.invalid/license",
            governor: address(this),
            vestingConfig: vestingConfig
        });

        manager.deployTokenWithParams(modelIdStr, modelIdStr, "EDV", 1_000_000 ether, params);
        address token = manager.getTokenAddress(modelIdStr);
        registry.registerModel(modelId, token, "accuracy");
        registry.setWeightGenesis(modelId, genesis);
        deltaVerifier.setMintBudget(modelId, budget);

        models[slot] = ModelConfig({
            modelId: modelId,
            modelIdStr: modelIdStr,
            genesis: genesis,
            initialBudget: budget,
            expectedHead: genesis,
            trackedMinted: 0
        });
    }

    function _payloadForModel(
        ModelConfig storage model,
        uint16 baselineBps,
        uint16 candidateBps,
        uint256 totalSamples
    ) internal returns (DeltaVerifier.MintRequestPayload memory payload) {
        requestNonce += 1;
        payload.pipelineRunId = _join("eval-", requestNonce);
        payload.baselineScoreBps = baselineBps;
        payload.candidateScoreBps = candidateBps;
        payload.maxCostUsdMicro = 0;
        payload.actualCostUsdMicro = 0;
        payload.totalSamples = totalSamples;
        payload.anchors = DeltaVerifier.BenchmarkAnchors({
            benchmarkSpecHash: keccak256(abi.encodePacked("bench", requestNonce, model.modelId)),
            datasetHash: keccak256(abi.encodePacked("dataset", requestNonce, model.modelId)),
            attestationHash: keccak256(abi.encodePacked("attestation", requestNonce, model.modelId)),
            idempotencyKey: keccak256(abi.encodePacked("idem", requestNonce, model.modelId)),
            metricName: "accuracy",
            metricFamily: "proportion"
        });
        payload.baselineCommitment = model.expectedHead;
        payload.candidateCommitment = keccak256(abi.encodePacked("candidate", requestNonce, model.modelId));
        // HOK-2170 deadline: never-expiring so the canonical mint path is actually exercised (a 0 default
        // would revert every request with SignatureExpired). Harness-modeling only.
        payload.deadline = type(uint256).max;
    }

    function _singleContributor(address recipient)
        private
        pure
        returns (DeltaVerifier.Contributor[] memory contributors)
    {
        contributors = new DeltaVerifier.Contributor[](1);
        contributors[0] = DeltaVerifier.Contributor({walletAddress: recipient, weight: 10_000});
    }

    function _submitAndTrack(
        ModelConfig storage model,
        DeltaVerifier.MintRequestPayload memory payload,
        DeltaVerifier.Contributor[] memory contributors,
        bool updateLineage
    ) private {
        bytes[] memory signatures = _sign(model.modelId, payload, contributors);
        if (signatures.length == 0) {
            return;
        }

        try deltaVerifier.submitMintRequest(model.modelId, payload, contributors, signatures) returns (uint256 reward) {
            harnessSeenKey[payload.anchors.idempotencyKey] = true;
            model.trackedMinted += reward;
            if (updateLineage && reward > 0) {
                model.expectedHead = payload.candidateCommitment;
            }
        } catch {}

        _checkLineageByModel(model);
    }

    /// @dev Sign the EIP-712 digest with the configured attester key set, ordered by STRICTLY ASCENDING
    /// recovered signer address. Base set is {key1}; m-of-n subclasses override _attesterKeys/_currentThreshold.
    function _sign(
        uint256 modelId,
        DeltaVerifier.MintRequestPayload memory payload,
        DeltaVerifier.Contributor[] memory contributors
    ) internal returns (bytes[] memory signatures) {
        bytes32 digest = deltaVerifier.hashMintRequest(modelId, payload, contributors);

        uint256[] memory keys = _attesterKeys();
        uint256 threshold = _currentThreshold();
        // The pool is pre-sorted by signer address in _attesterKeys(); take the lowest `threshold`.
        bytes[] memory sigs = new bytes[](threshold);
        for (uint256 i = 0; i < threshold; i++) {
            try HEVM.sign(keys[i], digest) returns (uint8 v, bytes32 r, bytes32 s) {
                sigs[i] = abi.encodePacked(r, s, v);
            } catch {
                hevmSigningUnavailable = true;
                return new bytes[](0);
            }
        }
        signatures = sigs;
    }

    function _checkLineage(uint256 slot) private {
        _checkLineageByModel(models[slot]);
    }

    function _checkLineageByModel(ModelConfig storage model) private {
        try deltaVerifier.currentModelHead(model.modelId) returns (bytes32 actualHead) {
            if (actualHead != model.expectedHead) {
                lineageInvariantBroken = true;
            }
        } catch {
            lineageInvariantBroken = true;
        }
    }

    function _join(string memory prefix, uint256 value) private pure returns (string memory) {
        return string(abi.encodePacked(prefix, _toString(value)));
    }

    function _toString(uint256 value) private pure returns (string memory) {
        if (value == 0) {
            return "0";
        }

        uint256 temp = value;
        uint256 digits;
        while (temp != 0) {
            digits++;
            temp /= 10;
        }

        bytes memory buffer = new bytes(digits);
        while (value != 0) {
            digits -= 1;
            buffer[digits] = bytes1(uint8(48 + uint256(value % 10)));
            value /= 10;
        }
        return string(buffer);
    }
}
