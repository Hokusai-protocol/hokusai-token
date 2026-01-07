// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/**
 * @title IDataContributionRegistry
 * @dev Interface for the DataContributionRegistry contract
 * @notice Used by DeltaVerifier to record contributions during token minting
 */
interface IDataContributionRegistry {
    /**
     * @dev Records multiple contributions in a batch
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
    ) external returns (uint256[] memory contributionIds);

    /**
     * @dev Checks if an address has contributed to a model
     * @param modelId The model identifier
     * @param contributor The contributor address
     * @return True if the contributor has contributed to the model
     */
    function hasContributedToModel(string memory modelId, address contributor) external view returns (bool);

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
    );
}
