// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "./libraries/AccessControlBase.sol";
import "./libraries/ValidationLib.sol";
import "./interfaces/IInfrastructureCostOracle.sol";

/**
 * @title InfrastructureCostOracle
 * @dev Stores and provides infrastructure cost estimates with epoch-based pricing stability
 *
 * Purpose:
 * - Store per-model infrastructure cost per 1000 API calls
 * - Implement epoch-based update constraints for pricing stability
 * - Calculate end-user prices with gross margin markup
 *
 * Architecture:
 * - Uses pending updates pattern similar to HokusaiParams
 * - GOV_ROLE can queue cost updates
 * - ADMIN_ROLE can adjust epoch duration
 * - Updates only apply after epoch boundary (permissionless trigger)
 *
 * Cost Basis:
 * - Costs are denominated in USDC (6 decimals)
 * - Costs represent estimated infrastructure cost per 1000 API calls
 * - End-user price = cost * (1 + grossMarginBps / 10000)
 */
contract InfrastructureCostOracle is AccessControlBase, IInfrastructureCostOracle {
    // ============================================================
    // STATE VARIABLES
    // ============================================================

    bytes32 public constant GOV_ROLE = keccak256("GOV_ROLE");

    /// @dev Default epoch duration (30 days)
    uint256 public constant DEFAULT_EPOCH_DURATION = 30 days;

    /// @dev Minimum epoch duration (1 day)
    uint256 public constant MIN_EPOCH_DURATION = 1 days;

    /// @dev Maximum epoch duration (365 days)
    uint256 public constant MAX_EPOCH_DURATION = 365 days;

    /// @dev Maximum gross margin percentage (100% = 10000 basis points)
    uint16 public constant MAX_GROSS_MARGIN_BPS = 10000;

    /// @dev Current active cost per 1000 calls for each model (USDC, 6 decimals)
    mapping(string => uint256) private _costPerThousandCalls;

    /// @dev Last update timestamp for each model
    mapping(string => uint256) private _lastUpdated;

    /// @dev Pending cost updates for each model
    mapping(string => PendingCostUpdate) private _pendingUpdates;

    /// @dev Epoch duration in seconds
    uint256 private _epochDuration;

    /// @dev Gross margin markup in basis points (e.g., 2000 = 20%)
    uint16 private _grossMarginBps;

    // ============================================================
    // CONSTRUCTOR
    // ============================================================

    /**
     * @dev Initialize oracle with admin and default parameters
     * @param admin Address to receive admin and governance roles
     * @param initialGrossMarginBps Initial gross margin in basis points
     */
    constructor(address admin, uint16 initialGrossMarginBps) AccessControlBase(admin) {
        require(
            initialGrossMarginBps <= MAX_GROSS_MARGIN_BPS,
            "Gross margin cannot exceed 100%"
        );

        _epochDuration = DEFAULT_EPOCH_DURATION;
        _grossMarginBps = initialGrossMarginBps;
        _grantRole(GOV_ROLE, admin);
    }

    // ============================================================
    // GOVERNANCE FUNCTIONS
    // ============================================================

    /**
     * @inheritdoc IInfrastructureCostOracle
     */
    function setEstimatedCost(
        string memory modelId,
        uint256 costPerThousandCalls,
        uint256 effectiveEpoch
    ) external override onlyRole(GOV_ROLE) {
        ValidationLib.requireNonEmptyString(modelId, "model ID");

        uint256 currentCost = _costPerThousandCalls[modelId];
        uint256 lastUpdate = _lastUpdated[modelId];

        // Calculate effective after timestamp
        uint256 effectiveAfter;
        if (lastUpdate == 0) {
            // First update: can be effective immediately or at specified epoch
            effectiveAfter = effectiveEpoch > 0 ? effectiveEpoch : block.timestamp;
        } else {
            // Subsequent updates: must respect epoch boundary
            uint256 nextEpochBoundary = lastUpdate + _epochDuration;
            effectiveAfter = effectiveEpoch > nextEpochBoundary ? effectiveEpoch : nextEpochBoundary;
        }

        // Queue the update
        _pendingUpdates[modelId] = PendingCostUpdate({
            costPerThousandCalls: costPerThousandCalls,
            queuedAt: block.timestamp,
            exists: true
        });

        emit CostUpdateQueued(modelId, currentCost, costPerThousandCalls, effectiveAfter, msg.sender);
    }

    /**
     * @inheritdoc IInfrastructureCostOracle
     */
    function applyPendingUpdate(string memory modelId) external override {
        ValidationLib.requireNonEmptyString(modelId, "model ID");

        PendingCostUpdate storage pending = _pendingUpdates[modelId];
        require(pending.exists, "No pending update for this model");

        uint256 lastUpdate = _lastUpdated[modelId];

        // Check if epoch boundary has passed
        if (lastUpdate > 0) {
            uint256 epochBoundary = lastUpdate + _epochDuration;
            require(block.timestamp >= epochBoundary, "Epoch boundary not reached");
        }

        // Apply the update
        uint256 oldCost = _costPerThousandCalls[modelId];
        uint256 newCost = pending.costPerThousandCalls;

        _costPerThousandCalls[modelId] = newCost;
        _lastUpdated[modelId] = block.timestamp;
        delete _pendingUpdates[modelId];

        emit CostUpdateApplied(modelId, oldCost, newCost, msg.sender);
    }

    /**
     * @inheritdoc IInfrastructureCostOracle
     */
    function setEpochDuration(uint256 newDuration) external override onlyRole(DEFAULT_ADMIN_ROLE) {
        require(
            newDuration >= MIN_EPOCH_DURATION && newDuration <= MAX_EPOCH_DURATION,
            "Epoch duration must be between 1 and 365 days"
        );

        uint256 oldDuration = _epochDuration;
        _epochDuration = newDuration;

        emit EpochDurationSet(oldDuration, newDuration, msg.sender);
    }

    /**
     * @inheritdoc IInfrastructureCostOracle
     */
    function setGrossMarginBps(uint16 newGrossMarginBps) external override onlyRole(GOV_ROLE) {
        require(
            newGrossMarginBps <= MAX_GROSS_MARGIN_BPS,
            "Gross margin cannot exceed 100%"
        );

        uint16 oldMarginBps = _grossMarginBps;
        _grossMarginBps = newGrossMarginBps;

        emit GrossMarginBpsSet(oldMarginBps, newGrossMarginBps, msg.sender);
    }

    // ============================================================
    // VIEW FUNCTIONS
    // ============================================================

    /**
     * @inheritdoc IInfrastructureCostOracle
     */
    function getEstimatedCost(string memory modelId)
        external
        view
        override
        returns (uint256)
    {
        return _costPerThousandCalls[modelId];
    }

    /**
     * @inheritdoc IInfrastructureCostOracle
     */
    function getEndUserPrice(string memory modelId)
        external
        view
        override
        returns (uint256)
    {
        uint256 cost = _costPerThousandCalls[modelId];
        if (cost == 0) {
            return 0;
        }

        // Calculate: cost * (1 + grossMarginBps / 10000)
        // = cost + (cost * grossMarginBps / 10000)
        uint256 markup = (cost * _grossMarginBps) / 10000;
        return cost + markup;
    }

    /**
     * @inheritdoc IInfrastructureCostOracle
     */
    function hasCost(string memory modelId)
        external
        view
        override
        returns (bool)
    {
        return _costPerThousandCalls[modelId] > 0;
    }

    /**
     * @inheritdoc IInfrastructureCostOracle
     */
    function getPendingUpdate(string memory modelId)
        external
        view
        override
        returns (bool exists, uint256 costPerThousandCalls, uint256 queuedAt)
    {
        PendingCostUpdate storage pending = _pendingUpdates[modelId];
        return (pending.exists, pending.costPerThousandCalls, pending.queuedAt);
    }

    /**
     * @inheritdoc IInfrastructureCostOracle
     */
    function getLastUpdated(string memory modelId)
        external
        view
        override
        returns (uint256)
    {
        return _lastUpdated[modelId];
    }

    /**
     * @inheritdoc IInfrastructureCostOracle
     */
    function epochDuration() external view override returns (uint256) {
        return _epochDuration;
    }

    /**
     * @inheritdoc IInfrastructureCostOracle
     */
    function grossMarginBps() external view override returns (uint16) {
        return _grossMarginBps;
    }
}
