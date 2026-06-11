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

contract EchidnaDeltaVerifier {
    struct ModelConfig {
        uint256 modelId;
        string modelIdStr;
        bytes32 genesis;
        uint256 initialBudget;
        bytes32 expectedHead;
        uint256 trackedMinted;
    }

    uint256 private constant MOCK_ATTESTER_KEY = 1;
    address private constant MOCK_ATTESTER = 0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf;
    address private constant USER_A = address(0x4101);
    address private constant USER_B = address(0x4102);
    address private constant USER_C = address(0x4103);
    IHevm private constant HEVM = IHevm(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D);

    ModelRegistry public registry;
    TokenManager public manager;
    DataContributionRegistry public contributionRegistry;
    DeltaVerifier public deltaVerifier;

    ModelConfig[3] private models;
    address[3] private recipients;

    bool private hevmSigningUnavailable;
    bool private forgedMintSucceeded;
    bool private wrongParentAccepted;
    bool private overBudgetAccepted;
    bool private lineageInvariantBroken;

    uint256 private requestNonce;

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

        deltaVerifier.addAttester(MOCK_ATTESTER);
        deltaVerifier.setAttesterThreshold(1);

        recipients[0] = USER_A;
        recipients[1] = USER_B;
        recipients[2] = USER_C;

        _seedModel(0, 101, "echidna-delta-a", 250 ether, keccak256("echidna-delta-genesis-a"));
        _seedModel(1, 202, "echidna-delta-b", 450 ether, keccak256("echidna-delta-genesis-b"));
        _seedModel(2, 303, "echidna-delta-c", 1_000 ether, keccak256("echidna-delta-genesis-c"));
    }

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
    ) private returns (DeltaVerifier.MintRequestPayload memory payload) {
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
            model.trackedMinted += reward;
            if (updateLineage && reward > 0) {
                model.expectedHead = payload.candidateCommitment;
            }
        } catch {}

        _checkLineageByModel(model);
    }

    function _sign(
        uint256 modelId,
        DeltaVerifier.MintRequestPayload memory payload,
        DeltaVerifier.Contributor[] memory contributors
    ) private returns (bytes[] memory signatures) {
        bytes32 digest = deltaVerifier.hashMintRequest(modelId, payload, contributors);
        try HEVM.sign(MOCK_ATTESTER_KEY, digest) returns (uint8 v, bytes32 r, bytes32 s) {
            signatures = new bytes[](1);
            signatures[0] = abi.encodePacked(r, s, v);
        } catch {
            hevmSigningUnavailable = true;
        }
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
