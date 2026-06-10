// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "./libraries/ValidationLib.sol";
import "./ModelRegistry.sol";
import "./TokenManager.sol";
import "./HokusaiToken.sol";
import "./interfaces/IHokusaiParams.sol";
import "./interfaces/IDataContributionRegistry.sol";

contract DeltaVerifier is AccessControl, ReentrancyGuard, Pausable, EIP712 {
    using ECDSA for bytes32;

    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    bytes32 public constant SUBMITTER_ROLE = keccak256("SUBMITTER_ROLE");

    error ModelTokenMismatch(uint256 modelId, address registryToken, address tokenManagerToken);

    // --- Attester registry errors (HOK-2126) ---
    error ZeroAttester();
    error AttesterAlreadyRegistered(address attester);
    error AttesterNotRegistered(address attester);
    error InvalidAttesterThreshold(uint256 threshold, uint256 attesterCount);
    error AttesterThresholdWouldBeUnmet(uint256 newAttesterCount, uint256 threshold);

    // --- Attester signature verification errors (HOK-2132) ---
    /// @notice No threshold is set, so no attester can have authorized a mint. Fail-closed: every mint
    /// reverts until the admin Safe configures at least a 1-of-1 attester set (addAttester + threshold).
    error AttestationThresholdNotConfigured();
    error InsufficientAttesterSignatures(uint256 provided, uint256 required);
    error SignerNotAttester(address signer);
    /// @notice Signatures must be ordered by strictly ascending recovered signer address; this both
    /// enforces uniqueness (no double-counting one attester toward the threshold) and makes the call
    /// deterministic for m-of-n.
    error UnorderedOrDuplicateAttesters(address signer);

    /// @notice Thrown by the legacy submitEvaluation* mint entrypoints once legacy mints are disabled.
    error LegacyMintEntrypointDisabled();

    /// @notice One-way switch. Once true, the legacy submitEvaluation* mint entrypoints revert,
    /// leaving submitMintRequest (the canonical path) as the only way to mint. Set on mainnet so a
    /// SUBMITTER_ROLE holder cannot bypass the canonical mint path. Cannot be re-enabled. (HOK-2125)
    bool public legacyMintsDisabled;

    event LegacyMintsDisabled(address indexed by);

    struct Metrics {
        uint256 accuracy;
        uint256 precision;
        uint256 recall;
        uint256 f1;
        uint256 auroc;
    }

    struct EvaluationData {
        string pipelineRunId;
        Metrics baselineMetrics;
        Metrics newMetrics;
        address contributor;
        uint256 contributorWeight; // in basis points (10000 = 100%)
        uint256 contributedSamples;
        uint256 totalSamples;
        uint256 maxCostUsd;
        uint256 actualCostUsd;
    }

    struct ContributorInfo {
        address walletAddress;
        uint256 contributorWeight; // in basis points (10000 = 100%)
        uint256 contributedSamples;
        uint256 totalSamples;
    }

    struct Contributor {
        address walletAddress;
        uint256 weight; // in basis points (10000 = 100%)
    }

    struct EvaluationDataWithInfo {
        string pipelineRunId;
        Metrics baselineMetrics;
        Metrics newMetrics;
        ContributorInfo contributorInfo;
        uint256 maxCostUsd;
        uint256 actualCostUsd;
    }

    struct EvaluationDataBase {
        string pipelineRunId;
        Metrics baselineMetrics;
        Metrics newMetrics;
        uint256 maxCostUsd;
        uint256 actualCostUsd;
        uint256 totalSamples;
    }

    struct BenchmarkAnchors {
        bytes32 benchmarkSpecHash;
        bytes32 datasetHash;
        bytes32 attestationHash;
        bytes32 idempotencyKey;
        string metricName;
        string metricFamily;
    }

    struct MintRequestPayload {
        string pipelineRunId;
        uint256 baselineScoreBps;
        uint256 candidateScoreBps;
        uint256 maxCostUsdMicro;
        uint256 actualCostUsdMicro;
        uint256 totalSamples;
        BenchmarkAnchors anchors;
    }

    ModelRegistry public immutable modelRegistry;
    TokenManager public immutable tokenManager;
    IDataContributionRegistry public immutable contributionRegistry;

    uint256 public baseRewardRate; // tokens per 1% improvement
    uint256 public minImprovementBps; // minimum improvement in basis points
    uint256 public maxReward; // maximum reward cap
    
    uint256 private constant RATE_LIMIT_DURATION = 1 hours;
    mapping(address => uint256) private lastSubmissionTime;
    mapping(bytes32 => bool) public processedIdempotencyKeys;

    // --- Attester registry (HOK-2126) ---
    // The set of addresses authorized to attest mints, and how many distinct attester signatures a
    // mint must carry (m-of-n). The signature verification that *consumes* these is added in HOK-2132;
    // this issue provides only the Safe-governed registry + invariants. Runs 1-of-1 at launch, but the
    // set/threshold shape supports m-of-n later with no storage change. Governed by DEFAULT_ADMIN_ROLE
    // (the admin Safe / timelock); pause() is the separate fast emergency brake.
    mapping(address => bool) public isAttester;
    uint256 public attesterCount;
    uint256 public attesterThreshold;

    // --- EIP-712 typed-data definitions for the attested mint payload (HOK-2132) ---
    // The signature binds the FULL economic payload (modelId + every anchor + scores/costs + samples +
    // contributors), domain-separated by chainId + this contract's address (via the EIP712 base). The
    // typehashes embed the exact schema; adding/removing a field changes the typehash and silently
    // invalidates old signatures (cross-schema replay protection). Referenced struct types are listed in
    // alphabetical order per EIP-712. Launch is hardware-wallet EOA (ECDSA.recover); the address-keyed
    // attester registry is already EIP-1271-ready for a later Safe/threshold signer.
    bytes32 private constant BENCHMARK_ANCHORS_TYPEHASH =
        keccak256(
            "BenchmarkAnchors(bytes32 benchmarkSpecHash,bytes32 datasetHash,bytes32 attestationHash,bytes32 idempotencyKey,string metricName,string metricFamily)"
        );
    bytes32 private constant CONTRIBUTOR_TYPEHASH = keccak256("Contributor(address walletAddress,uint256 weight)");
    bytes32 private constant MINT_REQUEST_PAYLOAD_TYPEHASH =
        keccak256(
            "MintRequestPayload(string pipelineRunId,uint256 baselineScoreBps,uint256 candidateScoreBps,uint256 maxCostUsdMicro,uint256 actualCostUsdMicro,uint256 totalSamples,BenchmarkAnchors anchors)BenchmarkAnchors(bytes32 benchmarkSpecHash,bytes32 datasetHash,bytes32 attestationHash,bytes32 idempotencyKey,string metricName,string metricFamily)"
        );
    bytes32 private constant MINT_REQUEST_TYPEHASH =
        keccak256(
            "MintRequest(uint256 modelId,MintRequestPayload payload,Contributor[] contributors)BenchmarkAnchors(bytes32 benchmarkSpecHash,bytes32 datasetHash,bytes32 attestationHash,bytes32 idempotencyKey,string metricName,string metricFamily)Contributor(address walletAddress,uint256 weight)MintRequestPayload(string pipelineRunId,uint256 baselineScoreBps,uint256 candidateScoreBps,uint256 maxCostUsdMicro,uint256 actualCostUsdMicro,uint256 totalSamples,BenchmarkAnchors anchors)"
        );

    event EvaluationSubmitted(
        string indexed pipelineRunId,
        uint256 indexed modelId
    );
    
    event RewardCalculated(
        address indexed contributor,
        uint256 deltaInBps,
        uint256 rewardAmount
    );
    
    event RewardParametersUpdated(
        uint256 baseRewardRate,
        uint256 minImprovementBps,
        uint256 maxReward
    );

    event BatchRewardsDistributed(
        uint256 indexed modelId,
        address[] contributors,
        uint256[] amounts,
        uint256 totalAmount
    );

    event BudgetConstraintViolated(
        string indexed pipelineRunId,
        uint256 indexed modelId,
        uint256 maxCostUsd,
        uint256 actualCostUsd
    );

    event DeltaOneAccepted(
        uint256 indexed modelId,
        bytes32 indexed idempotencyKey,
        bytes32 indexed benchmarkSpecHash,
        bytes32 attestationHash,
        bytes32 datasetHash,
        string metricName,
        string metricFamily,
        uint256 baselineScoreBps,
        uint256 candidateScoreBps,
        uint256 rewardAmount,
        string pipelineRunId
    );

    event AttesterAdded(address indexed attester, uint256 attesterCount);
    event AttesterRemoved(address indexed attester, uint256 attesterCount);
    event AttesterThresholdUpdated(uint256 threshold);

    constructor(
        address _modelRegistry,
        address payable _tokenManager,
        address _contributionRegistry,
        uint256 _baseRewardRate,
        uint256 _minImprovementBps,
        uint256 _maxReward
    ) EIP712("HokusaiDeltaVerifier", "1") {
        ValidationLib.requireNonZeroAddress(_modelRegistry, "model registry");
        ValidationLib.requireNonZeroAddress(_tokenManager, "token manager");
        ValidationLib.requireNonZeroAddress(_contributionRegistry, "contribution registry");
        ValidationLib.requirePositiveAmount(_baseRewardRate, "reward rate");
        ValidationLib.requirePositiveAmount(_minImprovementBps, "min improvement");

        modelRegistry = ModelRegistry(_modelRegistry);
        tokenManager = TokenManager(_tokenManager);
        contributionRegistry = IDataContributionRegistry(_contributionRegistry);
        baseRewardRate = _baseRewardRate;
        minImprovementBps = _minImprovementBps;
        maxReward = _maxReward;

        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(PAUSER_ROLE, msg.sender);
        _grantRole(SUBMITTER_ROLE, msg.sender);
    }

    function submitEvaluation(
        uint256 modelId,
        EvaluationData calldata data
    ) external nonReentrant whenNotPaused onlyRole(SUBMITTER_ROLE) returns (uint256) {
        if (legacyMintsDisabled) revert LegacyMintEntrypointDisabled();
        // Validate model exists
        require(modelRegistry.isRegistered(modelId), "Model not registered");
        require(modelRegistry.isModelActive(modelId), "Model is deactivated");
        _assertCanonicalTokenMatch(modelId);
        
        return _processEvaluation(modelId, data);
    }

    function submitEvaluationWithContributorInfo(
        uint256 modelId,
        EvaluationDataWithInfo calldata data
    ) external nonReentrant whenNotPaused onlyRole(SUBMITTER_ROLE) returns (uint256) {
        if (legacyMintsDisabled) revert LegacyMintEntrypointDisabled();
        // Validate model exists
        require(modelRegistry.isRegistered(modelId), "Model not registered");
        require(modelRegistry.isModelActive(modelId), "Model is deactivated");
        _assertCanonicalTokenMatch(modelId);
        
        // Validate wallet address
        ValidationLib.requireNonZeroAddress(data.contributorInfo.walletAddress, "wallet address");
        
        // Create evaluation data from contributor info
        EvaluationData memory evalData = EvaluationData({
            pipelineRunId: data.pipelineRunId,
            baselineMetrics: data.baselineMetrics,
            newMetrics: data.newMetrics,
            contributor: data.contributorInfo.walletAddress,
            contributorWeight: data.contributorInfo.contributorWeight,
            contributedSamples: data.contributorInfo.contributedSamples,
            totalSamples: data.contributorInfo.totalSamples,
            maxCostUsd: data.maxCostUsd,
            actualCostUsd: data.actualCostUsd
        });
        
        // Process using existing logic
        return _processEvaluation(modelId, evalData);
    }

    function submitEvaluationWithMultipleContributors(
        uint256 modelId,
        EvaluationDataBase calldata data,
        Contributor[] calldata contributors
    ) external nonReentrant whenNotPaused onlyRole(SUBMITTER_ROLE) returns (uint256) {
        if (legacyMintsDisabled) revert LegacyMintEntrypointDisabled();
        // Validate model exists
        require(modelRegistry.isRegistered(modelId), "Model not registered");
        require(modelRegistry.isModelActive(modelId), "Model is deactivated");
        _assertCanonicalTokenMatch(modelId);
        (address[] memory contributorAddresses, uint256[] memory rewardAmounts) = _validateContributors(contributors);
        require(data.totalSamples > 0, "Total samples must be positive");

        if (_isBudgetConstraintViolated(data.maxCostUsd, data.actualCostUsd)) {
            emit BudgetConstraintViolated(
                data.pipelineRunId,
                modelId,
                data.maxCostUsd,
                data.actualCostUsd
            );
            return 0;
        }

        // Calculate delta one score
        uint256 deltaInBps = _calculateSingleMetricDelta(data.baselineMetrics.accuracy, data.newMetrics.accuracy);

        // Calculate total reward based on full improvement using dynamic parameters
        string memory modelIdStr = _uintToString(modelId);
        uint256 totalReward = calculateRewardDynamic(modelIdStr, deltaInBps, 10000, 0);

        if (totalReward > 0) {
            // Distribute rewards proportionally and mint tokens
            {
                uint256 totalDistributed = 0;

                for (uint256 i = 0; i < contributors.length; i++) {
                    uint256 contributorReward = (totalReward * contributors[i].weight) / 10000;
                    rewardAmounts[i] = contributorReward;
                    totalDistributed += contributorReward;

                    emit RewardCalculated(contributors[i].walletAddress, deltaInBps, contributorReward);
                }

                // Assign rounding dust to the first contributor to prevent token loss
                uint256 dust = totalReward - totalDistributed;
                if (dust > 0) {
                    rewardAmounts[0] += dust;
                    totalDistributed += dust;
                }

                // Mint tokens in batch (zero-amount contributors are skipped by TokenManager)
                tokenManager.batchMintReward(modelIdStr, contributorAddresses, rewardAmounts);

                emit BatchRewardsDistributed(modelId, contributorAddresses, rewardAmounts, totalDistributed);
            }

            // Record contributions in registry (in separate scope to reduce stack depth)
            _recordContributions(
                modelIdStr,
                contributorAddresses,
                contributors,
                data.totalSamples,
                rewardAmounts,
                data.pipelineRunId
            );
        }

        emit EvaluationSubmitted(data.pipelineRunId, modelId);

        return totalReward;
    }

    /**
     * @dev Callers must normalize any non-proportion metric to a 0-10000 bps scale before submission.
     * @param attesterSignatures EIP-712 signatures over the full (modelId, payload, contributors) tuple,
     *        ordered by strictly ascending recovered signer address. At least `attesterThreshold` distinct
     *        registered attesters must sign (1-of-1 at launch). The SUBMITTER relays; the attester authorizes.
     */
    function submitMintRequest(
        uint256 modelId,
        MintRequestPayload calldata payload,
        Contributor[] calldata contributors,
        bytes[] calldata attesterSignatures
    ) external nonReentrant whenNotPaused onlyRole(SUBMITTER_ROLE) returns (uint256) {
        require(modelRegistry.isRegistered(modelId), "Model not registered");
        require(modelRegistry.isModelActive(modelId), "Model is deactivated");
        _assertCanonicalTokenMatch(modelId);
        require(payload.anchors.idempotencyKey != bytes32(0), "Idempotency key cannot be empty");
        require(!processedIdempotencyKeys[payload.anchors.idempotencyKey], "Idempotency key already processed");
        require(bytes(payload.pipelineRunId).length > 0, "Pipeline run ID cannot be empty");
        require(bytes(payload.anchors.metricName).length > 0, "Metric name cannot be empty");
        require(payload.baselineScoreBps <= 10000, "Baseline score exceeds 10000 bps");
        require(payload.candidateScoreBps <= 10000, "Candidate score exceeds 10000 bps");

        // Authorization gate (HOK-2132): the mint must be signed by registered attester(s) over this exact
        // payload. Fail-closed if no threshold is configured. Verified before any state change or mint.
        _verifyAttestation(modelId, payload, contributors, attesterSignatures);

        (address[] memory contributorAddresses, uint256[] memory rewardAmounts) = _validateContributors(contributors);

        processedIdempotencyKeys[payload.anchors.idempotencyKey] = true;

        if (_isBudgetConstraintViolated(payload.maxCostUsdMicro, payload.actualCostUsdMicro)) {
            emit BudgetConstraintViolated(
                payload.pipelineRunId,
                modelId,
                payload.maxCostUsdMicro,
                payload.actualCostUsdMicro
            );
            return 0;
        }

        uint256 deltaInBps = _calculateSingleMetricDelta(payload.baselineScoreBps, payload.candidateScoreBps);
        string memory modelIdStr = _uintToString(modelId);
        uint256 totalReward = calculateRewardDynamic(modelIdStr, deltaInBps, 10000, 0);

        if (totalReward > 0) {
            uint256 totalDistributed = 0;

            for (uint256 i = 0; i < contributors.length; i++) {
                uint256 contributorReward = (totalReward * contributors[i].weight) / 10000;
                rewardAmounts[i] = contributorReward;
                totalDistributed += contributorReward;

                emit RewardCalculated(contributors[i].walletAddress, deltaInBps, contributorReward);
            }

            uint256 dust = totalReward - totalDistributed;
            if (dust > 0) {
                rewardAmounts[0] += dust;
                totalDistributed += dust;
            }

            tokenManager.batchMintReward(modelIdStr, contributorAddresses, rewardAmounts);

            emit BatchRewardsDistributed(modelId, contributorAddresses, rewardAmounts, totalDistributed);

            _recordContributions(
                modelIdStr,
                contributorAddresses,
                contributors,
                payload.totalSamples,
                rewardAmounts,
                payload.pipelineRunId
            );
        }

        emit DeltaOneAccepted(
            modelId,
            payload.anchors.idempotencyKey,
            payload.anchors.benchmarkSpecHash,
            payload.anchors.attestationHash,
            payload.anchors.datasetHash,
            payload.anchors.metricName,
            payload.anchors.metricFamily,
            payload.baselineScoreBps,
            payload.candidateScoreBps,
            totalReward,
            payload.pipelineRunId
        );
        emit EvaluationSubmitted(payload.pipelineRunId, modelId);

        return totalReward;
    }

    /**
     * @notice The EIP-712 digest an attester must sign to authorize a `submitMintRequest`. Off-chain
     * signers and tests should sign this exact value (domain = chainId + this contract). Exposed so the
     * human-in-the-loop / HSM attester signs precisely the bytes the contract verifies.
     */
    function hashMintRequest(
        uint256 modelId,
        MintRequestPayload calldata payload,
        Contributor[] calldata contributors
    ) external view returns (bytes32) {
        return _hashTypedDataV4(_hashMintRequest(modelId, payload, contributors));
    }

    function _processEvaluation(
        uint256 modelId,
        EvaluationData memory data
    ) private returns (uint256) {
        // Validate evaluation data
        _validateEvaluationDataMemory(data);
        
        // Check rate limit
        require(
            block.timestamp >= lastSubmissionTime[data.contributor] + RATE_LIMIT_DURATION,
            "Rate limit exceeded"
        );

        if (_isBudgetConstraintViolated(data.maxCostUsd, data.actualCostUsd)) {
            emit BudgetConstraintViolated(
                data.pipelineRunId,
                modelId,
                data.maxCostUsd,
                data.actualCostUsd
            );
            return 0;
        }
        lastSubmissionTime[data.contributor] = block.timestamp;
        
        // Calculate delta one score
        uint256 deltaInBps = _calculateSingleMetricDelta(data.baselineMetrics.accuracy, data.newMetrics.accuracy);

        // Calculate reward using dynamic parameters
        string memory modelIdStr = _uintToString(modelId);
        uint256 rewardAmount = calculateRewardDynamic(
            modelIdStr,
            deltaInBps,
            data.contributorWeight,
            data.contributedSamples
        );
        
        // Emit events
        emit EvaluationSubmitted(data.pipelineRunId, modelId);
        emit RewardCalculated(data.contributor, deltaInBps, rewardAmount);
        
        // Trigger minting through TokenManager if reward > 0
        if (rewardAmount > 0) {
            tokenManager.mintReward(modelIdStr, data.contributor, rewardAmount);

            // Record contribution in registry
            _recordSingleContribution(
                modelIdStr,
                data.contributor,
                data.contributorWeight,
                data.contributedSamples,
                data.totalSamples,
                rewardAmount,
                data.pipelineRunId
            );
        }

        return rewardAmount;
    }
    
    function calculateDeltaOneForModel(
        uint256 /* modelId */,
        Metrics memory baseline,
        Metrics memory newMetrics
    ) public pure returns (uint256) {
        return _calculateSingleMetricDelta(baseline.accuracy, newMetrics.accuracy);
    }
    
    function calculateReward(
        uint256 deltaInBps,
        uint256 contributorWeight,
        uint256 /* contributedSamples */
    ) public view returns (uint256) {
        // Check minimum improvement threshold
        if (deltaInBps < minImprovementBps) {
            return 0;
        }

        // Calculate base reward: (improvement % * base rate * contributor weight)
        // Note: baseRewardRate is already in wei, so no additional scaling needed
        uint256 reward = (deltaInBps * baseRewardRate * contributorWeight) / (100 * 10000);

        // Cap at maximum reward
        if (reward > maxReward) {
            reward = maxReward;
        }

        return reward;
    }

    /**
     * @dev Calculate reward using dynamic parameters from the token's params contract
     * @param modelId The model identifier to get token and parameters for
     * @param deltaInBps The improvement delta in basis points
     * @param contributorWeight The contributor's weight in basis points
     * @return The calculated reward amount
     */
    function calculateRewardDynamic(
        string memory modelId,
        uint256 deltaInBps,
        uint256 contributorWeight,
        uint256 /* contributedSamples */
    ) public view returns (uint256) {
        address tokenAddress = modelRegistry.getStringToken(modelId);
        address tokenManagerAddress = tokenManager.getTokenAddress(modelId);
        if (tokenManagerAddress != address(0) && tokenManagerAddress != tokenAddress) {
            revert ModelTokenMismatch(_stringToUint(modelId), tokenAddress, tokenManagerAddress);
        }

        // Get the token's params contract
        HokusaiToken token = HokusaiToken(tokenAddress);
        IHokusaiParams params = token.params();

        // Get dynamic parameters
        uint256 tokensPerDeltaOne = params.tokensPerDeltaOne();

        // Check minimum improvement threshold
        if (deltaInBps < minImprovementBps) {
            return 0;
        }

        // tokensPerDeltaOne is stored in wei-scaled whole tokens, so the reward is already in base units.
        // Formula: (improvement % * tokensPerDeltaOne * contributor weight) / (100 * 10000)
        uint256 reward = (deltaInBps * tokensPerDeltaOne * contributorWeight) / (100 * 10000);

        // Cap at maximum reward
        if (reward > maxReward) {
            reward = maxReward;
        }

        return reward;
    }
    
    function _calculateSingleMetricDelta(
        uint256 baseline,
        uint256 newValue
    ) private pure returns (uint256) {
        if (newValue <= baseline) {
            return 0;
        }

        return newValue - baseline;
    }

    function _validateEvaluationData(EvaluationData calldata data) private pure {
        // Validate contributor address
        ValidationLib.requireNonZeroAddress(data.contributor, "contributor address");

        // Validate contributor weight
        ValidationLib.requireMaxValue(data.contributorWeight, 10000);

        // Validate metrics are within valid range (0-100%)
        _validateMetrics(data.baselineMetrics);
        _validateMetrics(data.newMetrics);

        // Validate sample counts
        ValidationLib.requirePositiveAmount(data.contributedSamples, "contributed samples");
        require(data.totalSamples >= data.contributedSamples, "Invalid total samples");
        _validateBudgetData(data.maxCostUsd, data.actualCostUsd);
    }
    
    function _validateMetrics(Metrics memory metrics) private pure {
        ValidationLib.requireMaxValue(metrics.accuracy, 10000);
        ValidationLib.requireMaxValue(metrics.precision, 10000);
        ValidationLib.requireMaxValue(metrics.recall, 10000);
        ValidationLib.requireMaxValue(metrics.f1, 10000);
        ValidationLib.requireMaxValue(metrics.auroc, 10000);
    }

    function _validateEvaluationDataMemory(EvaluationData memory data) private pure {
        // Validate contributor address
        ValidationLib.requireNonZeroAddress(data.contributor, "contributor address");

        // Validate contributor weight
        ValidationLib.requireMaxValue(data.contributorWeight, 10000);

        // Validate metrics are within valid range (0-100%)
        _validateMetrics(data.baselineMetrics);
        _validateMetrics(data.newMetrics);

        // Validate sample counts
        ValidationLib.requirePositiveAmount(data.contributedSamples, "contributed samples");
        require(data.totalSamples >= data.contributedSamples, "Invalid total samples");
        _validateBudgetData(data.maxCostUsd, data.actualCostUsd);
    }

    function _validateBudgetData(uint256 maxCostUsd, uint256 actualCostUsd) private pure {
        if (maxCostUsd == 0 || actualCostUsd == 0) {
            return;
        }

        ValidationLib.requirePositiveAmount(maxCostUsd, "max cost usd");
        ValidationLib.requirePositiveAmount(actualCostUsd, "actual cost usd");
    }

    function _isBudgetConstraintViolated(uint256 maxCostUsd, uint256 actualCostUsd) private pure returns (bool) {
        if (maxCostUsd == 0 || actualCostUsd == 0) {
            return false;
        }

        return actualCostUsd > maxCostUsd;
    }

    function _validateContributors(
        Contributor[] calldata contributors
    ) private pure returns (address[] memory contributorAddresses, uint256[] memory rewardAmounts) {
        ValidationLib.requireNonEmptyArray(contributors.length);
        ValidationLib.requireMaxArrayLength(contributors.length, 100);

        uint256 totalWeight = 0;
        contributorAddresses = new address[](contributors.length);
        rewardAmounts = new uint256[](contributors.length);

        for (uint256 i = 0; i < contributors.length; i++) {
            ValidationLib.requireNonZeroAddress(contributors[i].walletAddress, "wallet address");

            for (uint256 j = 0; j < i; j++) {
                require(contributors[i].walletAddress != contributorAddresses[j], "Duplicate contributor address");
            }

            contributorAddresses[i] = contributors[i].walletAddress;
            totalWeight += contributors[i].weight;
        }

        require(totalWeight == 10000, "Weights must sum to 100%");
    }
    
    // Admin functions
    function setBaseRewardRate(uint256 _baseRewardRate) external onlyRole(DEFAULT_ADMIN_ROLE) {
        ValidationLib.requirePositiveAmount(_baseRewardRate, "reward rate");
        baseRewardRate = _baseRewardRate;
        emit RewardParametersUpdated(baseRewardRate, minImprovementBps, maxReward);
    }

    function setMinImprovementBps(uint256 _minImprovementBps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        ValidationLib.requirePositiveAmount(_minImprovementBps, "min improvement");
        minImprovementBps = _minImprovementBps;
        emit RewardParametersUpdated(baseRewardRate, minImprovementBps, maxReward);
    }
    
    function setMaxReward(uint256 _maxReward) external onlyRole(DEFAULT_ADMIN_ROLE) {
        maxReward = _maxReward;
        emit RewardParametersUpdated(baseRewardRate, minImprovementBps, maxReward);
    }
    
    // --- Attester registry governance (HOK-2126) ---
    // Controlled by DEFAULT_ADMIN_ROLE (the admin Safe; non-emergency changes are expected to route
    // through the governance timelock). Launch sequence: addAttester(launchAttester) then
    // setAttesterThreshold(1). Emergency: pause() halts mints immediately; rotate add-then-remove,
    // then unpause(). The signature verification that reads this registry lands in HOK-2132.

    /// @notice Register an attester. 1-of-1 at launch; the set/threshold supports m-of-n later.
    function addAttester(address attester) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (attester == address(0)) revert ZeroAttester();
        if (isAttester[attester]) revert AttesterAlreadyRegistered(attester);
        isAttester[attester] = true;
        attesterCount += 1;
        emit AttesterAdded(attester, attesterCount);
    }

    /// @notice Remove an attester. Rotation is add-new-then-remove-old (zero-downtime). A removal that
    /// would drop the attester count below the current threshold reverts — use pause() for an immediate
    /// halt, then rotate.
    function removeAttester(address attester) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (!isAttester[attester]) revert AttesterNotRegistered(attester);
        uint256 newCount = attesterCount - 1;
        if (newCount < attesterThreshold) revert AttesterThresholdWouldBeUnmet(newCount, attesterThreshold);
        isAttester[attester] = false;
        attesterCount = newCount;
        emit AttesterRemoved(attester, attesterCount);
    }

    /// @notice Set the number of distinct attester signatures a mint must carry (1 <= m <= attesterCount).
    function setAttesterThreshold(uint256 threshold) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (threshold == 0 || threshold > attesterCount) {
            revert InvalidAttesterThreshold(threshold, attesterCount);
        }
        attesterThreshold = threshold;
        emit AttesterThresholdUpdated(threshold);
    }

    /// @notice Permanently disable the legacy submitEvaluation* mint entrypoints (one-way; cannot be
    /// re-enabled). After this, submitMintRequest is the only mint path. Call on mainnet so a
    /// SUBMITTER_ROLE holder cannot bypass the canonical mint path. (HOK-2125)
    function disableLegacyMints() external onlyRole(DEFAULT_ADMIN_ROLE) {
        legacyMintsDisabled = true;
        emit LegacyMintsDisabled(msg.sender);
    }

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }
    
    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    /**
     * @dev Records a single contribution in the DataContributionRegistry
     */
    function _recordSingleContribution(
        string memory modelId,
        address contributor,
        uint256 weightBps,
        uint256 contributedSamples,
        uint256 totalSamples,
        uint256 tokensEarned,
        string memory pipelineRunId
    ) private {
        address[] memory contributorAddresses = new address[](1);
        contributorAddresses[0] = contributor;

        bytes32[] memory contributionHashes = new bytes32[](1);
        contributionHashes[0] = keccak256(abi.encodePacked(
            modelId,
            contributor,
            pipelineRunId
        ));

        uint256[] memory weightsBps = new uint256[](1);
        weightsBps[0] = weightBps;

        uint256[] memory samples = new uint256[](1);
        samples[0] = contributedSamples;

        uint256[] memory rewardAmounts = new uint256[](1);
        rewardAmounts[0] = tokensEarned;

        contributionRegistry.recordContributionBatch(
            modelId,
            contributorAddresses,
            contributionHashes,
            weightsBps,
            samples,
            totalSamples,
            rewardAmounts,
            pipelineRunId
        );
    }

    /**
     * @dev Records contributions in the DataContributionRegistry
     * @param modelId The model identifier (string)
     * @param contributorAddresses Array of contributor addresses
     * @param contributors Array of Contributor structs with attribution weights
     * @param totalSamples Total sample count for the evaluated dataset
     * @param rewardAmounts Array of token amounts earned
     * @param pipelineRunId ML pipeline execution reference
     */
    function _recordContributions(
        string memory modelId,
        address[] memory contributorAddresses,
        Contributor[] calldata contributors,
        uint256 totalSamples,
        uint256[] memory rewardAmounts,
        string memory pipelineRunId
    ) private {
        // Generate contribution hashes (deterministic based on contribution data)
        bytes32[] memory contributionHashes = new bytes32[](contributorAddresses.length);
        uint256[] memory contributedSamples = new uint256[](contributorAddresses.length);
        uint256[] memory weightsBps = new uint256[](contributorAddresses.length);

        for (uint256 i = 0; i < contributorAddresses.length; i++) {
            // Generate deterministic hash for this contribution
            contributionHashes[i] = keccak256(abi.encodePacked(
                modelId,
                contributorAddresses[i],
                pipelineRunId,
                i // Include index to ensure uniqueness within batch
            ));

            // Extract weights (already in basis points)
            weightsBps[i] = contributors[i].weight;

            // Attribute integer samples proportionally; truncation dust stays unassigned.
            contributedSamples[i] = (totalSamples * contributors[i].weight) / 10000;
        }

        // Record contributions in the registry
        contributionRegistry.recordContributionBatch(
            modelId,
            contributorAddresses,
            contributionHashes,
            weightsBps,
            contributedSamples,
            totalSamples,
            rewardAmounts,
            pipelineRunId
        );
    }

    function _assertCanonicalTokenMatch(uint256 modelId) private view {
        address registryToken = modelRegistry.getTokenAddress(modelId);
        string memory modelIdStr = _uintToString(modelId);
        address tokenManagerToken = tokenManager.getTokenAddress(modelIdStr);

        if (tokenManagerToken != address(0) && tokenManagerToken != registryToken) {
            revert ModelTokenMismatch(modelId, registryToken, tokenManagerToken);
        }
    }

    // --- Attester signature verification (HOK-2132) ---

    /**
     * @dev Reverts unless at least `attesterThreshold` distinct registered attesters have signed the
     * EIP-712 digest of (modelId, payload, contributors). Signatures must be ordered by strictly
     * ascending recovered signer address — this rejects duplicate signers (so one attester cannot be
     * counted twice toward the threshold) and makes m-of-n deterministic. Fail-closed when unconfigured.
     */
    function _verifyAttestation(
        uint256 modelId,
        MintRequestPayload calldata payload,
        Contributor[] calldata contributors,
        bytes[] calldata attesterSignatures
    ) private view {
        uint256 threshold = attesterThreshold;
        if (threshold == 0) revert AttestationThresholdNotConfigured();
        if (attesterSignatures.length < threshold) {
            revert InsufficientAttesterSignatures(attesterSignatures.length, threshold);
        }

        bytes32 digest = _hashTypedDataV4(_hashMintRequest(modelId, payload, contributors));

        address last = address(0);
        for (uint256 i = 0; i < attesterSignatures.length; i++) {
            address signer = digest.recover(attesterSignatures[i]);
            if (signer <= last) revert UnorderedOrDuplicateAttesters(signer);
            if (!isAttester[signer]) revert SignerNotAttester(signer);
            last = signer;
        }
    }

    function _hashMintRequest(
        uint256 modelId,
        MintRequestPayload calldata payload,
        Contributor[] calldata contributors
    ) private pure returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    MINT_REQUEST_TYPEHASH,
                    modelId,
                    _hashPayload(payload),
                    _hashContributors(contributors)
                )
            );
    }

    function _hashPayload(MintRequestPayload calldata payload) private pure returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    MINT_REQUEST_PAYLOAD_TYPEHASH,
                    keccak256(bytes(payload.pipelineRunId)),
                    payload.baselineScoreBps,
                    payload.candidateScoreBps,
                    payload.maxCostUsdMicro,
                    payload.actualCostUsdMicro,
                    payload.totalSamples,
                    _hashAnchors(payload.anchors)
                )
            );
    }

    function _hashAnchors(BenchmarkAnchors calldata anchors) private pure returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    BENCHMARK_ANCHORS_TYPEHASH,
                    anchors.benchmarkSpecHash,
                    anchors.datasetHash,
                    anchors.attestationHash,
                    anchors.idempotencyKey,
                    keccak256(bytes(anchors.metricName)),
                    keccak256(bytes(anchors.metricFamily))
                )
            );
    }

    function _hashContributors(Contributor[] calldata contributors) private pure returns (bytes32) {
        bytes32[] memory hashes = new bytes32[](contributors.length);
        for (uint256 i = 0; i < contributors.length; i++) {
            hashes[i] = keccak256(
                abi.encode(CONTRIBUTOR_TYPEHASH, contributors[i].walletAddress, contributors[i].weight)
            );
        }
        return keccak256(abi.encodePacked(hashes));
    }

    function _stringToUint(string memory value) private pure returns (uint256 parsed) {
        bytes memory buffer = bytes(value);
        require(buffer.length > 0, "Model not registered");

        for (uint256 i = 0; i < buffer.length; i++) {
            uint8 charCode = uint8(buffer[i]);
            require(charCode >= 48 && charCode <= 57, "Model not registered");
            parsed = (parsed * 10) + (charCode - 48);
        }
    }

    /**
     * @dev Converts a uint256 to its ASCII string decimal representation.
     */
    function _uintToString(uint256 value) private pure returns (string memory) {
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
