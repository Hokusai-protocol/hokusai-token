// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "./interfaces/IHokusaiParams.sol";

/**
 * @title HokusaiParams
 * @dev Implementation of dynamic parameter management for Hokusai tokens
 * Allows governance to adjust key operational parameters without contract upgrades
 */
contract HokusaiParams is IHokusaiParams, AccessControl {
    /// @dev Role identifier for governance operations
    bytes32 public constant GOV_ROLE = keccak256("GOV_ROLE");

    /// @dev Minimum allowed value for tokensPerDeltaOne
    uint256 public constant MIN_TOKENS_PER_DELTA_ONE = 100;

    /// @dev Maximum allowed value for tokensPerDeltaOne
    uint256 public constant MAX_TOKENS_PER_DELTA_ONE = 1000000;

    /// @dev Minimum allowed value for infrastructureAccrualBps (10% in basis points)
    uint16 public constant MIN_INFRASTRUCTURE_ACCRUAL_BPS = 1000;

    /// @dev Maximum allowed value for infrastructureAccrualBps (100% in basis points)
    uint16 public constant MAX_INFRASTRUCTURE_ACCRUAL_BPS = 10000;

    /// @dev Default price epoch duration (30 days in seconds)
    uint256 public constant DEFAULT_PRICE_EPOCH_DURATION = 30 days;

    /// @dev Number of tokens to mint per unit of deltaOne improvement (global default)
    uint256 private _tokensPerDeltaOne;

    /// @dev Metric evaluation mode for this model's token
    IHokusaiParams.MetricType private _metricType;

    /// @dev Infrastructure cost accrual percentage in basis points (global default)
    uint16 private _infrastructureAccrualBps;

    /// @dev Hash of the license reference
    bytes32 private _licenseHash;

    /// @dev URI string for the license reference
    string private _licenseURI;

    /// @dev Price epoch duration in seconds
    uint256 private _priceEpochDuration;

    /// @dev Struct to track pending parameter updates
    struct PendingUpdate {
        uint256 value;
        uint256 queuedAt;
        bool exists;
    }

    /// @dev Mapping of model ID to epoch start timestamp
    mapping(string => uint256) private _priceEpochStart;

    /// @dev Mapping of model ID to parameter name to pending update
    mapping(string => mapping(string => PendingUpdate)) private _pendingParamUpdates;

    /// @dev Mapping of model ID to model-specific tokensPerDeltaOne
    mapping(string => uint256) private _modelTokensPerDeltaOne;

    /// @dev Mapping of model ID to model-specific infrastructureAccrualBps
    mapping(string => uint16) private _modelInfrastructureAccrualBps;

    /// @dev Mapping to track if a model has been initialized
    mapping(string => bool) private _modelInitialized;

    /**
     * @dev Constructor to initialize the parameter contract
     * @param initialTokensPerDeltaOne Initial tokens per deltaOne value (100-1000000)
     * @param initialInfrastructureAccrualBps Initial infrastructure accrual in basis points (1000-10000)
     * @param initialLicenseHash Initial license reference hash
     * @param initialLicenseURI Initial license reference URI
     * @param governor Address to grant GOV_ROLE to
     */
    constructor(
        uint256 initialTokensPerDeltaOne,
        uint16 initialInfrastructureAccrualBps,
        bytes32 initialLicenseHash,
        string memory initialLicenseURI,
        address governor
    ) {
        require(governor != address(0), "Governor cannot be zero address");
        require(
            initialTokensPerDeltaOne >= MIN_TOKENS_PER_DELTA_ONE &&
            initialTokensPerDeltaOne <= MAX_TOKENS_PER_DELTA_ONE,
            "tokensPerDeltaOne must be between 100 and 1000000"
        );
        require(
            initialInfrastructureAccrualBps >= MIN_INFRASTRUCTURE_ACCRUAL_BPS &&
            initialInfrastructureAccrualBps <= MAX_INFRASTRUCTURE_ACCRUAL_BPS,
            "infrastructureAccrualBps must be between 1000 and 10000"
        );

        // Set initial values
        _tokensPerDeltaOne = initialTokensPerDeltaOne;
        _metricType = IHokusaiParams.MetricType.MultiMetric;
        _infrastructureAccrualBps = initialInfrastructureAccrualBps;
        _licenseHash = initialLicenseHash;
        _licenseURI = initialLicenseURI;
        _priceEpochDuration = DEFAULT_PRICE_EPOCH_DURATION;

        // Setup access control
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(GOV_ROLE, governor);
    }

    /**
     * @inheritdoc IHokusaiParams
     */
    function tokensPerDeltaOne() external view override returns (uint256) {
        return _tokensPerDeltaOne;
    }

    /**
     * @inheritdoc IHokusaiParams
     */
    function metricType() external view override returns (uint8) {
        return uint8(_metricType);
    }

    /**
     * @inheritdoc IHokusaiParams
     */
    function infrastructureAccrualBps() external view override returns (uint16) {
        return _infrastructureAccrualBps;
    }

    /**
     * @inheritdoc IHokusaiParams
     */
    function getProfitShareBps() external view override returns (uint16) {
        return 10000 - _infrastructureAccrualBps;
    }

    /**
     * @inheritdoc IHokusaiParams
     */
    function licenseHash() external view override returns (bytes32) {
        return _licenseHash;
    }

    /**
     * @inheritdoc IHokusaiParams
     */
    function licenseURI() external view override returns (string memory) {
        return _licenseURI;
    }

    /**
     * @inheritdoc IHokusaiParams
     */
    function licenseRef() external view override returns (bytes32 hash, string memory uri) {
        return (_licenseHash, _licenseURI);
    }

    /**
     * @inheritdoc IHokusaiParams
     */
    function setTokensPerDeltaOne(uint256 newValue) external override onlyRole(GOV_ROLE) {
        require(
            newValue >= MIN_TOKENS_PER_DELTA_ONE && newValue <= MAX_TOKENS_PER_DELTA_ONE,
            "tokensPerDeltaOne must be between 100 and 1000000"
        );

        uint256 oldValue = _tokensPerDeltaOne;
        _tokensPerDeltaOne = newValue;

        emit TokensPerDeltaOneSet(oldValue, newValue, msg.sender);
    }

    /**
     * @inheritdoc IHokusaiParams
     */
    function setMetricType(uint8 newMetricType) external override onlyRole(GOV_ROLE) {
        require(newMetricType <= uint8(IHokusaiParams.MetricType.SingleMetric), "Invalid metric type");

        uint8 oldMetricType = uint8(_metricType);
        _metricType = IHokusaiParams.MetricType(newMetricType);

        emit MetricTypeSet(oldMetricType, newMetricType, msg.sender);
    }

    /**
     * @inheritdoc IHokusaiParams
     */
    function setInfrastructureAccrualBps(uint16 newBps) external override onlyRole(GOV_ROLE) {
        require(
            newBps >= MIN_INFRASTRUCTURE_ACCRUAL_BPS && newBps <= MAX_INFRASTRUCTURE_ACCRUAL_BPS,
            "infrastructureAccrualBps must be between 1000 and 10000"
        );

        uint16 oldBps = _infrastructureAccrualBps;
        _infrastructureAccrualBps = newBps;

        emit InfrastructureAccrualBpsSet(oldBps, newBps, msg.sender);
    }

    /**
     * @inheritdoc IHokusaiParams
     */
    function setLicenseRef(bytes32 hash, string memory uri) external override onlyRole(GOV_ROLE) {
        bytes32 oldHash = _licenseHash;
        _licenseHash = hash;
        _licenseURI = uri;

        emit LicenseRefSet(oldHash, hash, uri, msg.sender);
    }

    // ============================================================
    // EPOCH-BASED PRICE LOCKING FUNCTIONS
    // ============================================================

    /**
     * @dev Initializes a model with current global defaults if not already initialized
     * @param modelId The model identifier
     */
    function _initializeModelIfNeeded(string memory modelId) private {
        if (!_modelInitialized[modelId]) {
            _modelTokensPerDeltaOne[modelId] = _tokensPerDeltaOne;
            _modelInfrastructureAccrualBps[modelId] = _infrastructureAccrualBps;
            _priceEpochStart[modelId] = block.timestamp;
            _modelInitialized[modelId] = true;
        }
    }

    /**
     * @dev Validates parameter name and value
     * @param paramName The parameter name
     * @param newValue The new value to validate
     */
    function _validateParam(string memory paramName, uint256 newValue) private pure {
        bytes32 paramHash = keccak256(bytes(paramName));

        if (paramHash == keccak256(bytes("tokensPerDeltaOne"))) {
            require(
                newValue >= MIN_TOKENS_PER_DELTA_ONE && newValue <= MAX_TOKENS_PER_DELTA_ONE,
                "tokensPerDeltaOne must be between 100 and 1000000"
            );
        } else if (paramHash == keccak256(bytes("infrastructureAccrualBps"))) {
            require(
                newValue >= MIN_INFRASTRUCTURE_ACCRUAL_BPS && newValue <= MAX_INFRASTRUCTURE_ACCRUAL_BPS,
                "infrastructureAccrualBps must be between 1000 and 10000"
            );
        } else {
            revert("Invalid parameter name");
        }
    }

    /**
     * @dev Gets the current value of a parameter for a model
     * @param modelId The model identifier
     * @param paramName The parameter name
     * @return The current parameter value
     */
    function _getCurrentParamValue(string memory modelId, string memory paramName) private view returns (uint256) {
        bytes32 paramHash = keccak256(bytes(paramName));

        if (paramHash == keccak256(bytes("tokensPerDeltaOne"))) {
            return _modelInitialized[modelId] ? _modelTokensPerDeltaOne[modelId] : _tokensPerDeltaOne;
        } else if (paramHash == keccak256(bytes("infrastructureAccrualBps"))) {
            return _modelInitialized[modelId] ? _modelInfrastructureAccrualBps[modelId] : _infrastructureAccrualBps;
        }
        revert("Invalid parameter name");
    }

    /**
     * @dev Sets a parameter value for a model
     * @param modelId The model identifier
     * @param paramName The parameter name
     * @param newValue The new value
     */
    function _setParamValue(string memory modelId, string memory paramName, uint256 newValue) private {
        bytes32 paramHash = keccak256(bytes(paramName));

        if (paramHash == keccak256(bytes("tokensPerDeltaOne"))) {
            _modelTokensPerDeltaOne[modelId] = newValue;
        } else if (paramHash == keccak256(bytes("infrastructureAccrualBps"))) {
            _modelInfrastructureAccrualBps[modelId] = uint16(newValue);
        }
    }

    /**
     * @inheritdoc IHokusaiParams
     */
    function queueParamUpdate(
        string memory modelId,
        string memory paramName,
        uint256 newValue
    ) external override onlyRole(GOV_ROLE) {
        require(bytes(modelId).length > 0, "Model ID cannot be empty");

        _initializeModelIfNeeded(modelId);
        _validateParam(paramName, newValue);

        uint256 currentValue = _getCurrentParamValue(modelId, paramName);
        uint256 effectiveAfter = _priceEpochStart[modelId] + _priceEpochDuration;

        _pendingParamUpdates[modelId][paramName] = PendingUpdate({
            value: newValue,
            queuedAt: block.timestamp,
            exists: true
        });

        emit ParamUpdateQueued(modelId, paramName, currentValue, newValue, effectiveAfter);
    }

    /**
     * @inheritdoc IHokusaiParams
     */
    function applyPendingUpdates(string memory modelId) external override {
        require(bytes(modelId).length > 0, "Model ID cannot be empty");
        require(_modelInitialized[modelId], "Model not initialized");

        uint256 epochEnd = _priceEpochStart[modelId] + _priceEpochDuration;
        require(block.timestamp >= epochEnd, "Epoch has not ended yet");

        // Apply tokensPerDeltaOne if pending
        string memory tokensParam = "tokensPerDeltaOne";
        if (_pendingParamUpdates[modelId][tokensParam].exists) {
            uint256 oldValue = _modelTokensPerDeltaOne[modelId];
            uint256 newValue = _pendingParamUpdates[modelId][tokensParam].value;
            _modelTokensPerDeltaOne[modelId] = newValue;
            delete _pendingParamUpdates[modelId][tokensParam];
            emit ParamUpdateApplied(modelId, tokensParam, oldValue, newValue);
        }

        // Apply infrastructureAccrualBps if pending
        string memory infraParam = "infrastructureAccrualBps";
        if (_pendingParamUpdates[modelId][infraParam].exists) {
            uint256 oldValue = _modelInfrastructureAccrualBps[modelId];
            uint256 newValue = _pendingParamUpdates[modelId][infraParam].value;
            _modelInfrastructureAccrualBps[modelId] = uint16(newValue);
            delete _pendingParamUpdates[modelId][infraParam];
            emit ParamUpdateApplied(modelId, infraParam, oldValue, newValue);
        }

        // Start new epoch
        _priceEpochStart[modelId] = block.timestamp;
    }

    /**
     * @inheritdoc IHokusaiParams
     */
    function getPriceEpochInfo(string memory modelId) external view override returns (
        uint256 epochStart,
        uint256 epochEnd,
        bool hasPendingUpdates
    ) {
        if (!_modelInitialized[modelId]) {
            return (0, 0, false);
        }

        epochStart = _priceEpochStart[modelId];
        epochEnd = epochStart + _priceEpochDuration;

        hasPendingUpdates =
            _pendingParamUpdates[modelId]["tokensPerDeltaOne"].exists ||
            _pendingParamUpdates[modelId]["infrastructureAccrualBps"].exists;

        return (epochStart, epochEnd, hasPendingUpdates);
    }

    /**
     * @inheritdoc IHokusaiParams
     */
    function cancelPendingUpdate(
        string memory modelId,
        string memory paramName
    ) external override onlyRole(GOV_ROLE) {
        require(bytes(modelId).length > 0, "Model ID cannot be empty");
        require(_pendingParamUpdates[modelId][paramName].exists, "No pending update for this parameter");

        delete _pendingParamUpdates[modelId][paramName];
    }

    /**
     * @inheritdoc IHokusaiParams
     */
    function emergencySetParam(
        string memory modelId,
        string memory paramName,
        uint256 newValue,
        string memory reason
    ) external override onlyRole(DEFAULT_ADMIN_ROLE) {
        require(bytes(modelId).length > 0, "Model ID cannot be empty");
        require(bytes(reason).length > 0, "Reason cannot be empty");

        _initializeModelIfNeeded(modelId);
        _validateParam(paramName, newValue);
        _setParamValue(modelId, paramName, newValue);

        // Clear any pending update for this parameter
        if (_pendingParamUpdates[modelId][paramName].exists) {
            delete _pendingParamUpdates[modelId][paramName];
        }

        emit EmergencyParamOverride(modelId, paramName, newValue, reason);
    }

    /**
     * @inheritdoc IHokusaiParams
     */
    function priceEpochDuration() external view override returns (uint256) {
        return _priceEpochDuration;
    }

    /**
     * @inheritdoc IHokusaiParams
     */
    function getEpochStart(string memory modelId) external view override returns (uint256) {
        return _priceEpochStart[modelId];
    }

    /**
     * @inheritdoc IHokusaiParams
     */
    function getModelTokensPerDeltaOne(string memory modelId) external view override returns (uint256) {
        if (!_modelInitialized[modelId]) {
            return _tokensPerDeltaOne;
        }
        return _modelTokensPerDeltaOne[modelId];
    }

    /**
     * @inheritdoc IHokusaiParams
     */
    function getModelInfrastructureAccrualBps(string memory modelId) external view override returns (uint16) {
        if (!_modelInitialized[modelId]) {
            return _infrastructureAccrualBps;
        }
        return _modelInfrastructureAccrualBps[modelId];
    }
}
