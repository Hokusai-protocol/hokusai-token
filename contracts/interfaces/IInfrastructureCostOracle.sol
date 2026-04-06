// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/**
 * @title IInfrastructureCostOracle
 * @dev Interface for infrastructure cost oracle with epoch-based pricing stability
 *
 * Provides estimated per-1000-call infrastructure costs for ML models with
 * time-gated updates to ensure pricing stability across epochs.
 */
interface IInfrastructureCostOracle {
    /**
     * @dev Structure for pending cost updates
     */
    struct PendingCostUpdate {
        uint256 costPerThousandCalls;
        uint256 queuedAt;
        uint256 effectiveAfter;
        bool exists;
    }

    /**
     * @dev Get estimated infrastructure cost per 1000 calls for a model
     * @param modelId String model identifier
     * @return Estimated cost in USDC (6 decimals) per 1000 API calls
     */
    function getEstimatedCost(string memory modelId) external view returns (uint256);

    /**
     * @dev Get end-user price (cost + gross margin) per 1000 calls
     * @param modelId String model identifier
     * @return End-user price in USDC (6 decimals) per 1000 API calls
     */
    function getEndUserPrice(string memory modelId) external view returns (uint256);

    /**
     * @dev Check if a model has a cost configured
     * @param modelId String model identifier
     * @return True if cost > 0, false otherwise
     */
    function hasCost(string memory modelId) external view returns (bool);

    /**
     * @dev Queue a cost update for a model (GOV_ROLE required)
     * @param modelId String model identifier
     * @param costPerThousandCalls Cost in USDC (6 decimals) per 1000 API calls
     * @param effectiveEpoch Timestamp when update should become effective
     */
    function setEstimatedCost(
        string memory modelId,
        uint256 costPerThousandCalls,
        uint256 effectiveEpoch
    ) external;

    /**
     * @dev Apply pending cost update if epoch boundary has passed (permissionless)
     * @param modelId String model identifier
     */
    function applyPendingUpdate(string memory modelId) external;

    /**
     * @dev Set the epoch duration (ADMIN_ROLE required)
     * @param newDuration New epoch duration in seconds
     */
    function setEpochDuration(uint256 newDuration) external;

    /**
     * @dev Set the gross margin markup percentage (GOV_ROLE required)
     * @param newGrossMarginBps New gross margin in basis points (e.g., 2000 = 20%)
     */
    function setGrossMarginBps(uint16 newGrossMarginBps) external;

    /**
     * @dev Get the current epoch duration
     * @return Epoch duration in seconds
     */
    function epochDuration() external view returns (uint256);

    /**
     * @dev Get the gross margin markup percentage
     * @return Gross margin in basis points
     */
    function grossMarginBps() external view returns (uint16);

    /**
     * @dev Get information about a pending cost update
     * @param modelId String model identifier
     * @return exists Whether a pending update exists
     * @return costPerThousandCalls The pending cost value
     * @return queuedAt When the update was queued
     * @return effectiveAfter When the update becomes eligible for application
     */
    function getPendingUpdate(string memory modelId) external view returns (
        bool exists,
        uint256 costPerThousandCalls,
        uint256 queuedAt,
        uint256 effectiveAfter
    );

    /**
     * @dev Get the last update timestamp for a model
     * @param modelId String model identifier
     * @return Timestamp of last cost update (0 if never updated)
     */
    function getLastUpdated(string memory modelId) external view returns (uint256);

    /**
     * @dev Event emitted when a cost update is queued
     * @param modelId Model identifier
     * @param currentCost Current active cost
     * @param newCost Queued cost that will become active
     * @param effectiveAfter Timestamp when update can be applied
     * @param queuedBy Address that queued the update
     */
    event CostUpdateQueued(
        string indexed modelId,
        uint256 currentCost,
        uint256 newCost,
        uint256 effectiveAfter,
        address indexed queuedBy
    );

    /**
     * @dev Event emitted when a pending cost update is applied
     * @param modelId Model identifier
     * @param oldCost Previous cost
     * @param newCost New active cost
     * @param appliedBy Address that triggered the update
     */
    event CostUpdateApplied(
        string indexed modelId,
        uint256 oldCost,
        uint256 newCost,
        address indexed appliedBy
    );

    /**
     * @dev Event emitted when epoch duration changes
     * @param oldDuration Previous epoch duration
     * @param newDuration New epoch duration
     * @param updatedBy Address that made the change
     */
    event EpochDurationSet(
        uint256 oldDuration,
        uint256 newDuration,
        address indexed updatedBy
    );

    /**
     * @dev Event emitted when gross margin changes
     * @param oldMarginBps Previous gross margin in basis points
     * @param newMarginBps New gross margin in basis points
     * @param updatedBy Address that made the change
     */
    event GrossMarginBpsSet(
        uint16 oldMarginBps,
        uint16 newMarginBps,
        address indexed updatedBy
    );
}
