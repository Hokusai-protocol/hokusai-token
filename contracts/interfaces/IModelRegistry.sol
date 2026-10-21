// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/**
 * @title IModelRegistry
 * @dev Canonical ModelRegistry API for on-chain consumers. ModelRegistry keeps
 * older alias names (exists, isModelActive, isStringModelRegistered) for
 * off-chain compatibility; they delegate to these functions and are deprecated.
 *
 * "Registered" means the model exists; "active" means registered AND not
 * deactivated. The two are intentionally distinct.
 */
interface IModelRegistry {
    // Numeric model IDs
    function isRegistered(uint256 modelId) external view returns (bool);
    function isActive(uint256 modelId) external view returns (bool);
    function getTokenAddress(uint256 modelId) external view returns (address);
    function weightGenesis(uint256 modelId) external view returns (bytes32);

    // Canonical string model IDs ("1846" etc.)
    function isStringRegistered(string memory modelId) external view returns (bool);
    function isStringActive(string memory modelId) external view returns (bool);
    function getStringToken(string memory modelId) external view returns (address);

    // AMM pools
    function registerPool(string memory modelId, address pool) external;
    function getPool(string memory modelId) external view returns (address);
    function hasPool(string memory modelId) external view returns (bool);
}
