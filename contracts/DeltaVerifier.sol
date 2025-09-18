// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "./ModelRegistry.sol";
import "./TokenManager.sol";

contract DeltaVerifier is Ownable, ReentrancyGuard, Pausable {
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
    }

    struct EvaluationDataBase {
        string pipelineRunId;
        Metrics baselineMetrics;
        Metrics newMetrics;
    }

    ModelRegistry public immutable modelRegistry;
    TokenManager public immutable tokenManager;
    
    uint256 public baseRewardRate; // tokens per 1% improvement
    uint256 public minImprovementBps; // minimum improvement in basis points
    uint256 public maxReward; // maximum reward cap
    
    uint256 private constant RATE_LIMIT_DURATION = 1 hours;
    mapping(address => uint256) private lastSubmissionTime;
    
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

    constructor(
        address _modelRegistry,
        address _tokenManager,
        uint256 _baseRewardRate,
        uint256 _minImprovementBps,
        uint256 _maxReward
    ) {
        require(_modelRegistry != address(0), "Invalid model registry");
        require(_tokenManager != address(0), "Invalid token manager");
        require(_baseRewardRate > 0, "Invalid reward rate");
        require(_minImprovementBps > 0, "Invalid min improvement");
        
        modelRegistry = ModelRegistry(_modelRegistry);
        tokenManager = TokenManager(_tokenManager);
        baseRewardRate = _baseRewardRate;
        minImprovementBps = _minImprovementBps;
        maxReward = _maxReward;
    }

    function submitEvaluation(
        uint256 modelId,
        EvaluationData calldata data
    ) external nonReentrant whenNotPaused returns (uint256) {
        // Validate model exists
        require(modelRegistry.isRegistered(modelId), "Model not registered");
        
        return _processEvaluation(modelId, data);
    }

    function submitEvaluationWithContributorInfo(
        uint256 modelId,
        EvaluationDataWithInfo calldata data
    ) external nonReentrant whenNotPaused returns (uint256) {
        // Validate model exists
        require(modelRegistry.isRegistered(modelId), "Model not registered");
        
        // Validate wallet address
        require(data.contributorInfo.walletAddress != address(0), "Invalid wallet address");
        require(_isValidAddress(data.contributorInfo.walletAddress), "Invalid wallet address format");
        
        // Create evaluation data from contributor info
        EvaluationData memory evalData = EvaluationData({
            pipelineRunId: data.pipelineRunId,
            baselineMetrics: data.baselineMetrics,
            newMetrics: data.newMetrics,
            contributor: data.contributorInfo.walletAddress,
            contributorWeight: data.contributorInfo.contributorWeight,
            contributedSamples: data.contributorInfo.contributedSamples,
            totalSamples: data.contributorInfo.totalSamples
        });
        
        // Process using existing logic
        return _processEvaluation(modelId, evalData);
    }

    function submitEvaluationWithMultipleContributors(
        uint256 modelId,
        EvaluationDataBase calldata data,
        Contributor[] calldata contributors
    ) external nonReentrant whenNotPaused returns (uint256) {
        // Validate model exists
        require(modelRegistry.isRegistered(modelId), "Model not registered");
        require(contributors.length > 0, "No contributors provided");
        require(contributors.length <= 100, "Batch size exceeds limit");
        
        // Validate contributors and weights
        uint256 totalWeight = 0;
        address[] memory contributorAddresses = new address[](contributors.length);
        uint256[] memory rewardAmounts = new uint256[](contributors.length);
        
        for (uint256 i = 0; i < contributors.length; i++) {
            require(contributors[i].walletAddress != address(0), "Invalid wallet address");
            require(_isValidAddress(contributors[i].walletAddress), "Invalid wallet address format");
            
            // Check for duplicates
            for (uint256 j = 0; j < i; j++) {
                require(contributors[i].walletAddress != contributorAddresses[j], "Duplicate contributor address");
            }
            
            contributorAddresses[i] = contributors[i].walletAddress;
            totalWeight += contributors[i].weight;
        }
        
        require(totalWeight == 10000, "Weights must sum to 100%");
        
        // Calculate delta one score
        uint256 deltaInBps = calculateDeltaOne(data.baselineMetrics, data.newMetrics);
        
        // Calculate total reward based on full improvement
        uint256 totalReward = calculateReward(deltaInBps, 10000, 0);
        
        if (totalReward > 0) {
            // Distribute rewards proportionally
            uint256 totalDistributed = 0;
            
            for (uint256 i = 0; i < contributors.length; i++) {
                uint256 contributorReward = (totalReward * contributors[i].weight) / 10000;
                rewardAmounts[i] = contributorReward;
                totalDistributed += contributorReward;
                
                emit RewardCalculated(contributors[i].walletAddress, deltaInBps, contributorReward);
            }
            
            // Mint tokens in batch
            tokenManager.batchMintTokens(_uintToString(modelId), contributorAddresses, rewardAmounts);
            
            emit BatchRewardsDistributed(modelId, contributorAddresses, rewardAmounts, totalDistributed);
        }
        
        emit EvaluationSubmitted(data.pipelineRunId, modelId);
        
        return totalReward;
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
        lastSubmissionTime[data.contributor] = block.timestamp;
        
        // Calculate delta one score
        uint256 deltaInBps = calculateDeltaOne(data.baselineMetrics, data.newMetrics);
        
        // Calculate reward
        uint256 rewardAmount = calculateReward(
            deltaInBps,
            data.contributorWeight,
            data.contributedSamples
        );
        
        // Emit events
        emit EvaluationSubmitted(data.pipelineRunId, modelId);
        emit RewardCalculated(data.contributor, deltaInBps, rewardAmount);
        
        // Trigger minting through TokenManager if reward > 0
        if (rewardAmount > 0) {
            tokenManager.mintTokens(_uintToString(modelId), data.contributor, rewardAmount);
        }
        
        return rewardAmount;
    }
    
    function calculateDeltaOne(
        Metrics memory baseline,
        Metrics memory newMetrics
    ) public pure returns (uint256) {
        uint256 totalDelta = 0;
        uint256 metricCount = 0;
        
        // Calculate individual metric deltas
        totalDelta += _calculateMetricDelta(baseline.accuracy, newMetrics.accuracy);
        totalDelta += _calculateMetricDelta(baseline.precision, newMetrics.precision);
        totalDelta += _calculateMetricDelta(baseline.recall, newMetrics.recall);
        totalDelta += _calculateMetricDelta(baseline.f1, newMetrics.f1);
        totalDelta += _calculateMetricDelta(baseline.auroc, newMetrics.auroc);
        metricCount = 5;
        
        // Return average delta in basis points
        if (metricCount == 0) return 0;
        return totalDelta / metricCount;
    }
    
    function calculateReward(
        uint256 deltaInBps,
        uint256 contributorWeight,
        uint256 contributedSamples
    ) public view returns (uint256) {
        // Check minimum improvement threshold
        if (deltaInBps < minImprovementBps) {
            return 0;
        }
        
        // Calculate base reward: (improvement % * base rate * contributor weight)
        uint256 reward = (deltaInBps * baseRewardRate * contributorWeight) / (100 * 10000);
        
        // Cap at maximum reward
        if (reward > maxReward) {
            reward = maxReward;
        }
        
        return reward;
    }
    
    function _calculateMetricDelta(
        uint256 baseline,
        uint256 newValue
    ) private pure returns (uint256) {
        if (baseline == 0) {
            // Handle zero baseline case
            return newValue > 0 ? 10000 : 0; // 100% improvement if from 0 to any positive
        }
        
        if (newValue <= baseline) {
            return 0; // No improvement
        }
        
        // Calculate percentage improvement in basis points
        uint256 delta = ((newValue - baseline) * 10000) / baseline;
        return delta;
    }
    
    function _validateEvaluationData(EvaluationData calldata data) private pure {
        // Validate contributor address
        require(data.contributor != address(0), "Invalid contributor address");
        
        // Validate contributor weight
        require(data.contributorWeight <= 10000, "Invalid contributor weight");
        
        // Validate metrics are within valid range (0-100%)
        _validateMetrics(data.baselineMetrics);
        _validateMetrics(data.newMetrics);
        
        // Validate sample counts
        require(data.contributedSamples > 0, "Invalid contributed samples");
        require(data.totalSamples >= data.contributedSamples, "Invalid total samples");
    }
    
    function _validateMetrics(Metrics memory metrics) private pure {
        require(metrics.accuracy <= 10000, "Invalid metric value");
        require(metrics.precision <= 10000, "Invalid metric value");
        require(metrics.recall <= 10000, "Invalid metric value");
        require(metrics.f1 <= 10000, "Invalid metric value");
        require(metrics.auroc <= 10000, "Invalid metric value");
    }

    function _validateEvaluationDataMemory(EvaluationData memory data) private pure {
        // Validate contributor address
        require(data.contributor != address(0), "Invalid contributor address");
        
        // Validate contributor weight
        require(data.contributorWeight <= 10000, "Invalid contributor weight");
        
        // Validate metrics are within valid range (0-100%)
        _validateMetrics(data.baselineMetrics);
        _validateMetrics(data.newMetrics);
        
        // Validate sample counts
        require(data.contributedSamples > 0, "Invalid contributed samples");
        require(data.totalSamples >= data.contributedSamples, "Invalid total samples");
    }
    
    // Admin functions
    function setBaseRewardRate(uint256 _baseRewardRate) external onlyOwner {
        require(_baseRewardRate > 0, "Invalid reward rate");
        baseRewardRate = _baseRewardRate;
        emit RewardParametersUpdated(baseRewardRate, minImprovementBps, maxReward);
    }
    
    function setMinImprovementBps(uint256 _minImprovementBps) external onlyOwner {
        require(_minImprovementBps > 0, "Invalid min improvement");
        minImprovementBps = _minImprovementBps;
        emit RewardParametersUpdated(baseRewardRate, minImprovementBps, maxReward);
    }
    
    function setMaxReward(uint256 _maxReward) external onlyOwner {
        maxReward = _maxReward;
        emit RewardParametersUpdated(baseRewardRate, minImprovementBps, maxReward);
    }
    
    function pause() external onlyOwner {
        _pause();
    }
    
    function unpause() external onlyOwner {
        _unpause();
    }

    function _isValidAddress(address addr) private pure returns (bool) {
        return addr != address(0);
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