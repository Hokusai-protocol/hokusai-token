// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/**
 * @title IInfrastructureCostOracle
 * @dev Interface for infrastructure cost oracle
 *
 * Provides estimated per-1000-call infrastructure costs for ML models.
 * Used by UsageFeeRouter to implement cost-plus fee splitting.
 */
interface IInfrastructureCostOracle {
    /**
     * @dev Get estimated infrastructure cost per 1000 calls for a model
     * @param modelId String model identifier
     * @return Estimated cost in USDC (6 decimals) per 1000 API calls
     *         Returns 0 if no cost is set for this model
     */
    function getEstimatedCost(string memory modelId) external view returns (uint256);

    /**
     * @dev Check if a model has a cost configured
     * @param modelId String model identifier
     * @return True if cost > 0, false otherwise
     */
    function hasCost(string memory modelId) external view returns (bool);

    /**
     * @dev Event emitted when a model's cost is updated
     * @param modelId Model identifier
     * @param oldCost Previous cost per 1000 calls
     * @param newCost New cost per 1000 calls
     * @param updatedBy Address that made the update
     */
    event CostUpdated(
        string indexed modelId,
        uint256 oldCost,
        uint256 newCost,
        address indexed updatedBy
    );
}
