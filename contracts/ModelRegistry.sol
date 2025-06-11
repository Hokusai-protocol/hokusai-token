// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title ModelRegistry
 * @dev Registry contract to map model IDs to their corresponding token addresses
 */
contract ModelRegistry is Ownable {
    mapping(uint256 => address) public modelToToken;
    mapping(uint256 => bool) public isModelRegistered;
    mapping(address => uint256) public tokenToModel;
    uint256 public nextModelId = 1;

    event ModelRegistered(uint256 indexed modelId, address indexed tokenAddress);
    event ModelUpdated(uint256 indexed modelId, address indexed newTokenAddress);

    constructor() Ownable(msg.sender) {}

    /**
     * @dev Registers a new model with its corresponding token address
     * @param modelId The unique identifier for the model
     * @param token The address of the token contract for this model
     */
    function registerModel(uint256 modelId, address token) external onlyOwner {
        require(token != address(0), "Token address cannot be zero");
        require(!isModelRegistered[modelId], "Model already registered");
        require(tokenToModel[token] == 0, "Token already registered");
        
        modelToToken[modelId] = token;
        isModelRegistered[modelId] = true;
        tokenToModel[token] = modelId;
        
        emit ModelRegistered(modelId, token);
    }

    /**
     * @dev Registers a new model with auto-incremented ID
     * @param token The address of the token contract for this model
     * @return The assigned model ID
     */
    function registerModelAutoId(address token) external onlyOwner returns (uint256) {
        uint256 modelId = nextModelId;
        nextModelId++;
        
        require(token != address(0), "Token address cannot be zero");
        require(tokenToModel[token] == 0, "Token already registered");
        
        modelToToken[modelId] = token;
        isModelRegistered[modelId] = true;
        tokenToModel[token] = modelId;
        
        emit ModelRegistered(modelId, token);
        return modelId;
    }

    /**
     * @dev Updates the token address for an existing model
     * @param modelId The model identifier to update
     * @param newToken The new token address
     */
    function updateModel(uint256 modelId, address newToken) external onlyOwner {
        require(newToken != address(0), "Token address cannot be zero");
        require(isModelRegistered[modelId], "Model not registered");
        require(tokenToModel[newToken] == 0, "Token already registered");
        
        address oldToken = modelToToken[modelId];
        modelToToken[modelId] = newToken;
        tokenToModel[oldToken] = 0; // Clear old reverse mapping
        tokenToModel[newToken] = modelId; // Set new reverse mapping
        
        emit ModelUpdated(modelId, newToken);
    }

    /**
     * @dev Gets the token address for a given model ID
     * @param modelId The model identifier
     * @return The token address for the model
     */
    function getToken(uint256 modelId) external view returns (address) {
        require(isModelRegistered[modelId], "Model not registered");
        return modelToToken[modelId];
    }

    /**
     * @dev Gets the token address for a given model ID (alternative name)
     * @param modelId The model identifier
     * @return The token address for the model
     */
    function getTokenAddress(uint256 modelId) external view returns (address) {
        require(isModelRegistered[modelId], "Model not registered");
        return modelToToken[modelId];
    }

    /**
     * @dev Gets the model ID for a given token address (reverse lookup)
     * @param tokenAddress The token address
     * @return The model ID for the token
     */
    function getModelId(address tokenAddress) external view returns (uint256) {
        require(tokenToModel[tokenAddress] != 0, "Token not registered");
        return tokenToModel[tokenAddress];
    }

    /**
     * @dev Checks if a model is registered
     * @param modelId The model identifier to check
     * @return True if the model is registered, false otherwise
     */
    function isRegistered(uint256 modelId) external view returns (bool) {
        return isModelRegistered[modelId];
    }

    /**
     * @dev Checks if a model exists (alias for isRegistered)
     * @param modelId The model identifier to check
     * @return True if the model exists, false otherwise
     */
    function exists(uint256 modelId) external view returns (bool) {
        return isModelRegistered[modelId];
    }
}
