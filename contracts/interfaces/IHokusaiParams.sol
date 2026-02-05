// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/**
 * @title IHokusaiParams
 * @dev Interface for Hokusai token parameter management
 * Provides a standardized way to manage dynamic parameters for token operations
 * without requiring contract upgrades.
 */
interface IHokusaiParams {
    /**
     * @dev Returns the number of tokens to mint per unit of deltaOne improvement
     * @return The tokens per deltaOne value (replaces hardcoded baseRewardRate)
     */
    function tokensPerDeltaOne() external view returns (uint256);

    /**
     * @dev Returns the infrastructure cost accrual percentage in basis points
     * @return The accrual percentage (5000-10000 basis points, where 5000 = 50%, 10000 = 100%)
     */
    function infrastructureAccrualBps() external view returns (uint16);

    /**
     * @dev Returns the profit share percentage in basis points (residual after infrastructure)
     * @return The profit share percentage (calculated as 10000 - infrastructureAccrualBps)
     */
    function getProfitShareBps() external view returns (uint16);

    /**
     * @dev Returns the license reference hash
     * @return The bytes32 hash of the license reference
     */
    function licenseHash() external view returns (bytes32);

    /**
     * @dev Returns the license reference URI
     * @return The string URI for the license reference
     */
    function licenseURI() external view returns (string memory);

    /**
     * @dev Returns both license hash and URI in a single call for gas efficiency
     * @return hash The bytes32 hash of the license reference
     * @return uri The string URI for the license reference
     */
    function licenseRef() external view returns (bytes32 hash, string memory uri);

    /**
     * @dev Sets the tokens per deltaOne parameter
     * @param newValue The new tokens per deltaOne value (must be between 100-100000)
     * Requirements:
     * - Only addresses with GOV_ROLE can call this function
     * - newValue must be within valid bounds (100-100000)
     */
    function setTokensPerDeltaOne(uint256 newValue) external;

    /**
     * @dev Sets the infrastructure cost accrual percentage
     * @param newBps The new accrual in basis points (must be 5000-10000, i.e., 50-100%)
     * Requirements:
     * - Only addresses with GOV_ROLE can call this function
     * - newBps must be between 5000 and 10000 (50-100%)
     */
    function setInfrastructureAccrualBps(uint16 newBps) external;

    /**
     * @dev Sets the license reference
     * @param hash The bytes32 hash of the license reference
     * @param uri The string URI for the license reference
     * Requirements:
     * - Only addresses with GOV_ROLE can call this function
     */
    function setLicenseRef(bytes32 hash, string memory uri) external;

    /**
     * @dev Emitted when tokensPerDeltaOne is updated
     * @param oldValue The previous tokens per deltaOne value
     * @param newValue The new tokens per deltaOne value
     * @param updatedBy The address that made the update
     */
    event TokensPerDeltaOneSet(uint256 indexed oldValue, uint256 indexed newValue, address indexed updatedBy);

    /**
     * @dev Emitted when infrastructureAccrualBps is updated
     * @param oldBps The previous accrual in basis points
     * @param newBps The new accrual in basis points
     * @param updatedBy The address that made the update
     */
    event InfrastructureAccrualBpsSet(uint16 indexed oldBps, uint16 indexed newBps, address indexed updatedBy);

    /**
     * @dev Emitted when license reference is updated
     * @param oldHash The previous license hash
     * @param newHash The new license hash
     * @param newUri The new license URI
     * @param updatedBy The address that made the update
     */
    event LicenseRefSet(bytes32 indexed oldHash, bytes32 indexed newHash, string newUri, address indexed updatedBy);
}
