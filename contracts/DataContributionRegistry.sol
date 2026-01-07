// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/access/AccessControl.sol";

/**
 * @title DataContributionRegistry
 * @dev Registry contract to track data contributions to ML models and their attribution weights
 * @notice This contract records contributions when DeltaVerifier mints tokens for model improvements
 */
contract DataContributionRegistry is AccessControl {
    enum ContributionStatus {
        Pending,
        Verified,
        Claimed,
        Rejected
    }

    struct ContributionRecord {
        string modelId;                    // Model identifier (string, matches DeltaVerifier)
        address contributor;               // Ethereum address of contributor
        bytes32 contributionHash;          // SHA-256 hash of contribution data
        uint256 contributorWeightBps;      // Attribution weight in basis points (0-10000)
        uint256 contributedSamples;        // Number of data samples contributed
        uint256 totalSamples;              // Total samples in training set
        uint256 tokensEarned;              // Tokens minted for this contribution
        uint256 timestamp;                 // Block timestamp of registration
        string pipelineRunId;              // ML pipeline execution reference
        ContributionStatus status;         // pending, verified, claimed, rejected
    }

    // Role definitions
    bytes32 public constant RECORDER_ROLE = keccak256("RECORDER_ROLE");
    bytes32 public constant VERIFIER_ROLE = keccak256("VERIFIER_ROLE");

    // Primary storage
    mapping(uint256 => ContributionRecord) public contributions;
    mapping(uint256 => bool) public isContributionRegistered;
    uint256 public nextContributionId = 1;

    // Lookup indices
    mapping(string => uint256[]) private _modelContributions;      // modelId => contributionIds
    mapping(address => uint256[]) private _contributorRecords;     // contributor => contributionIds
    mapping(bytes32 => uint256) public hashToContribution;         // hash => contributionId

    // Aggregate tracking
    mapping(string => mapping(address => uint256)) public contributorTotalTokens;  // modelId => contributor => total tokens
    mapping(address => uint256) public contributorGlobalTokens;                    // contributor => all-time tokens

    // Events
    event ContributionRecorded(
        uint256 indexed contributionId,
        string modelId,
        address indexed contributor,
        bytes32 contributionHash,
        uint256 weightBps,
        uint256 tokensEarned,
        string pipelineRunId
    );

    event ContributionVerified(
        uint256 indexed contributionId,
        address verifier
    );

    event ContributionRejected(
        uint256 indexed contributionId,
        string reason
    );

    event RecorderAuthorized(address indexed recorder);
    event RecorderRevoked(address indexed recorder);

    constructor() {
        // Grant DEFAULT_ADMIN_ROLE to deployer
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);

        // Deployer can also record initially (can be revoked later)
        _grantRole(RECORDER_ROLE, msg.sender);
        _grantRole(VERIFIER_ROLE, msg.sender);
    }

    /**
     * @dev Internal function to record a single contribution
     * @param modelId The model identifier
     * @param contributor The contributor's address
     * @param contributionHash Hash of the contribution data
     * @param weightBps Attribution weight in basis points
     * @param contributedSamples Number of samples contributed
     * @param totalSamples Total samples in training set
     * @param tokensEarned Tokens minted for this contribution
     * @param pipelineRunId ML pipeline execution reference
     * @return contributionId The ID of the recorded contribution
     */
    function _recordContributionInternal(
        string memory modelId,
        address contributor,
        bytes32 contributionHash,
        uint256 weightBps,
        uint256 contributedSamples,
        uint256 totalSamples,
        uint256 tokensEarned,
        string memory pipelineRunId
    ) internal returns (uint256) {
        require(contributor != address(0), "Invalid contributor address");
        require(bytes(modelId).length > 0, "Model ID cannot be empty");
        require(contributionHash != bytes32(0), "Invalid contribution hash");
        require(weightBps <= 10000, "Weight cannot exceed 100%");
        require(contributedSamples <= totalSamples, "Contributed samples cannot exceed total");
        require(bytes(pipelineRunId).length > 0, "Pipeline run ID cannot be empty");

        uint256 contributionId = nextContributionId;
        nextContributionId++;

        contributions[contributionId] = ContributionRecord({
            modelId: modelId,
            contributor: contributor,
            contributionHash: contributionHash,
            contributorWeightBps: weightBps,
            contributedSamples: contributedSamples,
            totalSamples: totalSamples,
            tokensEarned: tokensEarned,
            timestamp: block.timestamp,
            pipelineRunId: pipelineRunId,
            status: ContributionStatus.Pending
        });

        isContributionRegistered[contributionId] = true;

        // Update indices
        _modelContributions[modelId].push(contributionId);
        _contributorRecords[contributor].push(contributionId);
        hashToContribution[contributionHash] = contributionId;

        // Update aggregate tracking
        contributorTotalTokens[modelId][contributor] += tokensEarned;
        contributorGlobalTokens[contributor] += tokensEarned;

        emit ContributionRecorded(
            contributionId,
            modelId,
            contributor,
            contributionHash,
            weightBps,
            tokensEarned,
            pipelineRunId
        );

        return contributionId;
    }

    /**
     * @dev Records a single contribution (public interface)
     * @param modelId The model identifier
     * @param contributor The contributor's address
     * @param contributionHash Hash of the contribution data
     * @param weightBps Attribution weight in basis points
     * @param contributedSamples Number of samples contributed
     * @param totalSamples Total samples in training set
     * @param tokensEarned Tokens minted for this contribution
     * @param pipelineRunId ML pipeline execution reference
     * @return contributionId The ID of the recorded contribution
     */
    function recordContribution(
        string memory modelId,
        address contributor,
        bytes32 contributionHash,
        uint256 weightBps,
        uint256 contributedSamples,
        uint256 totalSamples,
        uint256 tokensEarned,
        string memory pipelineRunId
    ) external onlyRole(RECORDER_ROLE) returns (uint256) {
        return _recordContributionInternal(
            modelId,
            contributor,
            contributionHash,
            weightBps,
            contributedSamples,
            totalSamples,
            tokensEarned,
            pipelineRunId
        );
    }

    /**
     * @dev Records multiple contributions in a batch (gas efficient)
     * @param modelId The model identifier
     * @param contributors Array of contributor addresses
     * @param contributionHashes Array of contribution hashes
     * @param weightsBps Array of attribution weights in basis points
     * @param contributedSamples Array of contributed samples per contributor
     * @param totalSamples Total samples in training set
     * @param tokensEarned Array of tokens earned per contributor
     * @param pipelineRunId ML pipeline execution reference
     * @return contributionIds Array of recorded contribution IDs
     */
    function recordContributionBatch(
        string memory modelId,
        address[] memory contributors,
        bytes32[] memory contributionHashes,
        uint256[] memory weightsBps,
        uint256[] memory contributedSamples,
        uint256 totalSamples,
        uint256[] memory tokensEarned,
        string memory pipelineRunId
    ) external onlyRole(RECORDER_ROLE) returns (uint256[] memory) {
        require(bytes(modelId).length > 0, "Model ID cannot be empty");
        require(contributors.length > 0, "Empty contributors array");
        require(contributors.length <= 100, "Batch size exceeds limit");
        require(
            contributors.length == contributionHashes.length &&
            contributors.length == weightsBps.length &&
            contributors.length == contributedSamples.length &&
            contributors.length == tokensEarned.length,
            "Array length mismatch"
        );
        require(bytes(pipelineRunId).length > 0, "Pipeline run ID cannot be empty");

        uint256[] memory contributionIds = new uint256[](contributors.length);

        for (uint256 i = 0; i < contributors.length; i++) {
            contributionIds[i] = _recordContributionInternal(
                modelId,
                contributors[i],
                contributionHashes[i],
                weightsBps[i],
                contributedSamples[i],
                totalSamples,
                tokensEarned[i],
                pipelineRunId
            );
        }

        return contributionIds;
    }

    /**
     * @dev Verifies a contribution (marks as verified)
     * @param contributionId The contribution ID to verify
     */
    function verifyContribution(uint256 contributionId) external onlyRole(VERIFIER_ROLE) {
        require(isContributionRegistered[contributionId], "Contribution not registered");
        require(
            contributions[contributionId].status == ContributionStatus.Pending,
            "Contribution not pending"
        );

        contributions[contributionId].status = ContributionStatus.Verified;

        emit ContributionVerified(contributionId, msg.sender);
    }

    /**
     * @dev Rejects a contribution with a reason
     * @param contributionId The contribution ID to reject
     * @param reason The reason for rejection
     */
    function rejectContribution(uint256 contributionId, string memory reason) external onlyRole(VERIFIER_ROLE) {
        require(isContributionRegistered[contributionId], "Contribution not registered");
        require(
            contributions[contributionId].status == ContributionStatus.Pending,
            "Contribution not pending"
        );
        require(bytes(reason).length > 0, "Reason cannot be empty");

        contributions[contributionId].status = ContributionStatus.Rejected;

        emit ContributionRejected(contributionId, reason);
    }

    /**
     * @dev Gets a contribution record by ID
     * @param contributionId The contribution ID
     * @return The contribution record
     */
    function getContribution(uint256 contributionId) external view returns (ContributionRecord memory) {
        require(isContributionRegistered[contributionId], "Contribution not registered");
        return contributions[contributionId];
    }

    /**
     * @dev Gets contribution IDs for a model (paginated)
     * @param modelId The model identifier
     * @param offset Starting index
     * @param limit Maximum number of results
     * @return Array of contribution IDs
     */
    function getContributionIdsByModel(
        string memory modelId,
        uint256 offset,
        uint256 limit
    ) external view returns (uint256[] memory) {
        uint256[] storage allIds = _modelContributions[modelId];

        if (offset >= allIds.length) {
            return new uint256[](0);
        }

        uint256 end = offset + limit;
        if (end > allIds.length) {
            end = allIds.length;
        }

        uint256 resultSize = end - offset;
        uint256[] memory result = new uint256[](resultSize);

        for (uint256 i = 0; i < resultSize; i++) {
            result[i] = allIds[offset + i];
        }

        return result;
    }

    /**
     * @dev Gets contribution IDs for a contributor (paginated)
     * @param contributor The contributor address
     * @param offset Starting index
     * @param limit Maximum number of results
     * @return Array of contribution IDs
     */
    function getContributionIdsByContributor(
        address contributor,
        uint256 offset,
        uint256 limit
    ) external view returns (uint256[] memory) {
        uint256[] storage allIds = _contributorRecords[contributor];

        if (offset >= allIds.length) {
            return new uint256[](0);
        }

        uint256 end = offset + limit;
        if (end > allIds.length) {
            end = allIds.length;
        }

        uint256 resultSize = end - offset;
        uint256[] memory result = new uint256[](resultSize);

        for (uint256 i = 0; i < resultSize; i++) {
            result[i] = allIds[offset + i];
        }

        return result;
    }

    /**
     * @dev Gets the total number of contributions for a model
     * @param modelId The model identifier
     * @return Total number of contributions
     */
    function getModelContributionCount(string memory modelId) external view returns (uint256) {
        return _modelContributions[modelId].length;
    }

    /**
     * @dev Gets the total number of contributions by a contributor
     * @param contributor The contributor address
     * @return Total number of contributions
     */
    function getContributorContributionCount(address contributor) external view returns (uint256) {
        return _contributorRecords[contributor].length;
    }

    /**
     * @dev Checks if a contribution hash exists
     * @param contributionHash The contribution hash
     * @return exists True if the hash exists
     * @return contributionId The contribution ID (0 if not exists)
     */
    function verifyContributionHash(bytes32 contributionHash) external view returns (bool exists, uint256 contributionId) {
        contributionId = hashToContribution[contributionHash];
        exists = contributionId != 0;
    }

    /**
     * @dev Checks if an address has contributed to a model
     * @param modelId The model identifier
     * @param contributor The contributor address
     * @return True if the contributor has contributed to the model
     */
    function hasContributedToModel(string memory modelId, address contributor) external view returns (bool) {
        return contributorTotalTokens[modelId][contributor] > 0;
    }

    /**
     * @dev Gets contributor statistics for a specific model
     * @param modelId The model identifier
     * @param contributor The contributor address
     * @return totalContributions Number of contributions
     * @return totalTokens Total tokens earned
     * @return totalSamples Total samples contributed
     */
    function getContributorStatsForModel(
        string memory modelId,
        address contributor
    ) external view returns (
        uint256 totalContributions,
        uint256 totalTokens,
        uint256 totalSamples
    ) {
        uint256[] storage contributionIds = _modelContributions[modelId];
        totalTokens = contributorTotalTokens[modelId][contributor];

        for (uint256 i = 0; i < contributionIds.length; i++) {
            ContributionRecord storage record = contributions[contributionIds[i]];
            if (record.contributor == contributor) {
                totalContributions++;
                totalSamples += record.contributedSamples;
            }
        }
    }

    /**
     * @dev Gets global contributor statistics
     * @param contributor The contributor address
     * @return totalContributions Total number of contributions across all models
     * @return totalTokens Total tokens earned across all models
     * @return modelsContributedTo Number of unique models contributed to
     */
    function getContributorGlobalStats(
        address contributor
    ) external view returns (
        uint256 totalContributions,
        uint256 totalTokens,
        uint256 modelsContributedTo
    ) {
        totalContributions = _contributorRecords[contributor].length;
        totalTokens = contributorGlobalTokens[contributor];

        // Count unique models
        uint256[] storage contributionIds = _contributorRecords[contributor];
        string[] memory seenModels = new string[](contributionIds.length);

        for (uint256 i = 0; i < contributionIds.length; i++) {
            string memory modelId = contributions[contributionIds[i]].modelId;
            bool seen = false;

            for (uint256 j = 0; j < modelsContributedTo; j++) {
                if (keccak256(bytes(seenModels[j])) == keccak256(bytes(modelId))) {
                    seen = true;
                    break;
                }
            }

            if (!seen) {
                seenModels[modelsContributedTo] = modelId;
                modelsContributedTo++;
            }
        }
    }
}
