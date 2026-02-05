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
    uint256 public constant MAX_TOKENS_PER_DELTA_ONE = 100000;

    /// @dev Minimum allowed value for infrastructureAccrualBps (50% in basis points)
    uint16 public constant MIN_INFRASTRUCTURE_ACCRUAL_BPS = 5000;

    /// @dev Maximum allowed value for infrastructureAccrualBps (100% in basis points)
    uint16 public constant MAX_INFRASTRUCTURE_ACCRUAL_BPS = 10000;

    /// @dev Number of tokens to mint per unit of deltaOne improvement
    uint256 private _tokensPerDeltaOne;

    /// @dev Infrastructure cost accrual percentage in basis points (5000-10000 = 50-100%)
    uint16 private _infrastructureAccrualBps;

    /// @dev Hash of the license reference
    bytes32 private _licenseHash;

    /// @dev URI string for the license reference
    string private _licenseURI;

    /**
     * @dev Constructor to initialize the parameter contract
     * @param initialTokensPerDeltaOne Initial tokens per deltaOne value (100-100000)
     * @param initialInfrastructureAccrualBps Initial infrastructure accrual in basis points (5000-10000)
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
            "tokensPerDeltaOne must be between 100 and 100000"
        );
        require(
            initialInfrastructureAccrualBps >= MIN_INFRASTRUCTURE_ACCRUAL_BPS &&
            initialInfrastructureAccrualBps <= MAX_INFRASTRUCTURE_ACCRUAL_BPS,
            "infrastructureAccrualBps must be between 5000 and 10000"
        );

        // Set initial values
        _tokensPerDeltaOne = initialTokensPerDeltaOne;
        _infrastructureAccrualBps = initialInfrastructureAccrualBps;
        _licenseHash = initialLicenseHash;
        _licenseURI = initialLicenseURI;

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
            "tokensPerDeltaOne must be between 100 and 100000"
        );

        uint256 oldValue = _tokensPerDeltaOne;
        _tokensPerDeltaOne = newValue;

        emit TokensPerDeltaOneSet(oldValue, newValue, msg.sender);
    }

    /**
     * @inheritdoc IHokusaiParams
     */
    function setInfrastructureAccrualBps(uint16 newBps) external override onlyRole(GOV_ROLE) {
        require(
            newBps >= MIN_INFRASTRUCTURE_ACCRUAL_BPS && newBps <= MAX_INFRASTRUCTURE_ACCRUAL_BPS,
            "infrastructureAccrualBps must be between 5000 and 10000"
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
}
