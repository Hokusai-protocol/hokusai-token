// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title ModelRegistry
 * @dev Registry contract to map model IDs to their corresponding token addresses
 */
contract ModelRegistry is Ownable {
    mapping(bytes32 => address) public modelToToken;
    mapping(bytes32 => bool) public isModelRegistered;

    event ModelRegistered(bytes32 indexed modelId, address indexed tokenAddress);
    event ModelUpdated(bytes32 indexed modelId, address indexed newTokenAddress);

    constructor() Ownable(msg.sender) {}

    /**
     * @dev Registers a new model with its corresponding token address
     * @param modelId The unique identifier for the model
     * @param token The address of the token contract for this model
     */
    function registerModel(bytes32 modelId, address token) external onlyOwner {
        require(token != address(0), "Token address cannot be zero");
        require(!isModelRegistered[modelId], "Model already registered");
        
        modelToToken[modelId] = token;
        isModelRegistered[modelId] = true;
        
        emit ModelRegistered(modelId, token);
    }

    /**
     * @dev Updates the token address for an existing model
     * @param modelId The model identifier to update
     * @param newToken The new token address
     */
    function updateModel(bytes32 modelId, address newToken) external onlyOwner {
        require(newToken != address(0), "Token address cannot be zero");
        require(isModelRegistered[modelId], "Model not registered");
        
        modelToToken[modelId] = newToken;
        
        emit ModelUpdated(modelId, newToken);
    }

    /**
     * @dev Gets the token address for a given model ID
     * @param modelId The model identifier
     * @return The token address for the model
     */
    function getToken(bytes32 modelId) external view returns (address) {
        require(isModelRegistered[modelId], "Model not registered");
        return modelToToken[modelId];
    }

    /**
     * @dev Checks if a model is registered
     * @param modelId The model identifier to check
     * @return True if the model is registered, false otherwise
     */
    function isRegistered(bytes32 modelId) external view returns (bool) {
        return isModelRegistered[modelId];
    }
}
