// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "./libraries/AccessControlBase.sol";
import "./libraries/ValidationLib.sol";
import "./interfaces/IInfrastructureCostOracle.sol";

/**
 * @title InfrastructureCostOracle
 * @dev Stores and provides infrastructure cost estimates for ML models
 *
 * Responsibilities:
 * - Store per-model infrastructure cost per 1000 API calls
 * - Allow authorized updaters to modify costs
 * - Provide view functions for cost queries
 *
 * Cost Basis:
 * - Costs are denominated in USDC (6 decimals)
 * - Costs represent estimated infrastructure cost per 1000 API calls
 * - Zero cost means no estimate is configured (triggers fallback in UsageFeeRouter)
 */
contract InfrastructureCostOracle is AccessControlBase, IInfrastructureCostOracle {
    // ============================================================
    // STATE VARIABLES
    // ============================================================

    bytes32 public constant COST_UPDATER_ROLE = keccak256("COST_UPDATER_ROLE");

    // modelId => cost per 1000 calls (USDC, 6 decimals)
    mapping(string => uint256) private modelCosts;

    // ============================================================
    // CONSTRUCTOR
    // ============================================================

    /**
     * @dev Initialize oracle with admin
     * @param admin Address to receive admin and updater roles
     */
    constructor(address admin) AccessControlBase(admin) {
        _grantRole(COST_UPDATER_ROLE, admin);
    }

    // ============================================================
    // ADMIN FUNCTIONS
    // ============================================================

    /**
     * @dev Set infrastructure cost for a model
     * @param modelId String model identifier
     * @param costPer1000Calls Cost in USDC (6 decimals) per 1000 API calls
     */
    function setCost(string memory modelId, uint256 costPer1000Calls)
        external
        onlyRole(COST_UPDATER_ROLE)
    {
        ValidationLib.requireNonEmptyString(modelId, "model ID");

        uint256 oldCost = modelCosts[modelId];
        modelCosts[modelId] = costPer1000Calls;

        emit CostUpdated(modelId, oldCost, costPer1000Calls, msg.sender);
    }

    /**
     * @dev Set costs for multiple models in batch
     * @param modelIds Array of model identifiers
     * @param costs Array of costs per 1000 calls (must match modelIds length)
     */
    function batchSetCosts(
        string[] memory modelIds,
        uint256[] memory costs
    ) external onlyRole(COST_UPDATER_ROLE) {
        ValidationLib.requireMatchingArrayLengths(modelIds.length, costs.length);
        ValidationLib.requireNonEmptyArray(modelIds.length);

        for (uint256 i = 0; i < modelIds.length; i++) {
            ValidationLib.requireNonEmptyString(modelIds[i], "model ID");

            uint256 oldCost = modelCosts[modelIds[i]];
            modelCosts[modelIds[i]] = costs[i];

            emit CostUpdated(modelIds[i], oldCost, costs[i], msg.sender);
        }
    }

    // ============================================================
    // VIEW FUNCTIONS
    // ============================================================

    /**
     * @dev Get estimated infrastructure cost per 1000 calls for a model
     * @param modelId String model identifier
     * @return Estimated cost in USDC (6 decimals) per 1000 API calls
     */
    function getEstimatedCost(string memory modelId)
        external
        view
        override
        returns (uint256)
    {
        return modelCosts[modelId];
    }

    /**
     * @dev Check if a model has a cost configured
     * @param modelId String model identifier
     * @return True if cost > 0, false otherwise
     */
    function hasCost(string memory modelId)
        external
        view
        override
        returns (bool)
    {
        return modelCosts[modelId] > 0;
    }

    /**
     * @dev Check if an address has cost updater role
     * @param account Address to check
     * @return True if account has updater role
     */
    function isUpdater(address account) external view returns (bool) {
        return hasRole(COST_UPDATER_ROLE, account);
    }
}
