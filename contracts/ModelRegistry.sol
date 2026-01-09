// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title ModelRegistry
 * @dev Registry contract to map model IDs to their corresponding token addresses and performance metrics
 */
contract ModelRegistry is Ownable {
    struct ModelInfo {
        address tokenAddress;
        string performanceMetric;
        bool active;
    }

    mapping(uint256 => ModelInfo) public models;
    mapping(uint256 => bool) public isModelRegistered;
    mapping(address => uint256) public tokenToModel;
    uint256 public nextModelId = 1;

    // New: String-based model registry for AMM integration
    mapping(string => ModelInfo) public modelsByString;
    mapping(string => bool) public isStringModelRegistered;
    mapping(address => string) public tokenToStringModel;
    mapping(string => address) public modelPools;

    event ModelRegistered(uint256 indexed modelId, address indexed tokenAddress, string performanceMetric);
    event ModelUpdated(uint256 indexed modelId, address indexed newTokenAddress);
    event MetricUpdated(uint256 indexed modelId, string newMetric);
    event StringModelRegistered(string indexed modelId, address indexed tokenAddress, string performanceMetric);
    event PoolRegistered(string indexed modelId, address indexed poolAddress);

    constructor() Ownable() {}

    /**
     * @dev Registers a new model with its corresponding token address and performance metric
     * @param modelId The unique identifier for the model
     * @param token The address of the token contract for this model
     * @param performanceMetric The performance metric used for this model
     */
    function registerModel(uint256 modelId, address token, string memory performanceMetric) external onlyOwner {
        require(token != address(0), "Token address cannot be zero");
        require(bytes(performanceMetric).length > 0, "Performance metric cannot be empty");
        require(!isModelRegistered[modelId], "Model already registered");
        require(tokenToModel[token] == 0, "Token already registered");
        
        models[modelId] = ModelInfo({
            tokenAddress: token,
            performanceMetric: performanceMetric,
            active: true
        });
        isModelRegistered[modelId] = true;
        tokenToModel[token] = modelId;
        
        emit ModelRegistered(modelId, token, performanceMetric);
    }

    /**
     * @dev Registers a new model with auto-incremented ID
     * @param token The address of the token contract for this model
     * @param performanceMetric The performance metric used for this model
     * @return The assigned model ID
     */
    function registerModelAutoId(address token, string memory performanceMetric) external onlyOwner returns (uint256) {
        uint256 modelId = nextModelId;
        nextModelId++;
        
        require(token != address(0), "Token address cannot be zero");
        require(bytes(performanceMetric).length > 0, "Performance metric cannot be empty");
        require(tokenToModel[token] == 0, "Token already registered");
        
        models[modelId] = ModelInfo({
            tokenAddress: token,
            performanceMetric: performanceMetric,
            active: true
        });
        isModelRegistered[modelId] = true;
        tokenToModel[token] = modelId;
        
        emit ModelRegistered(modelId, token, performanceMetric);
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
        
        address oldToken = models[modelId].tokenAddress;
        models[modelId].tokenAddress = newToken;
        tokenToModel[oldToken] = 0; // Clear old reverse mapping
        tokenToModel[newToken] = modelId; // Set new reverse mapping
        
        emit ModelUpdated(modelId, newToken);
    }

    /**
     * @dev Updates the performance metric for an existing model
     * @param modelId The model identifier to update
     * @param newMetric The new performance metric
     */
    function updateMetric(uint256 modelId, string memory newMetric) external onlyOwner {
        require(isModelRegistered[modelId], "Model not registered");
        require(bytes(newMetric).length > 0, "Performance metric cannot be empty");
        
        models[modelId].performanceMetric = newMetric;
        
        emit MetricUpdated(modelId, newMetric);
    }

    /**
     * @dev Deactivates a model
     * @param modelId The model identifier to deactivate
     */
    function deactivateModel(uint256 modelId) external onlyOwner {
        require(isModelRegistered[modelId], "Model not registered");
        
        models[modelId].active = false;
    }

    /**
     * @dev Gets the token address for a given model ID
     * @param modelId The model identifier
     * @return The token address for the model
     */
    function getToken(uint256 modelId) external view returns (address) {
        require(isModelRegistered[modelId], "Model not registered");
        return models[modelId].tokenAddress;
    }

    /**
     * @dev Gets the token address for a given model ID (alternative name)
     * @param modelId The model identifier
     * @return The token address for the model
     */
    function getTokenAddress(uint256 modelId) external view returns (address) {
        require(isModelRegistered[modelId], "Model not registered");
        return models[modelId].tokenAddress;
    }

    /**
     * @dev Gets the performance metric for a given model ID
     * @param modelId The model identifier
     * @return The performance metric for the model
     */
    function getMetric(uint256 modelId) external view returns (string memory) {
        require(isModelRegistered[modelId], "Model not registered");
        return models[modelId].performanceMetric;
    }

    /**
     * @dev Gets the complete model information
     * @param modelId The model identifier
     * @return The complete ModelInfo struct
     */
    function getModel(uint256 modelId) external view returns (ModelInfo memory) {
        require(isModelRegistered[modelId], "Model not registered");
        return models[modelId];
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

    // ============================================================
    // STRING-BASED MODEL REGISTRY (for TokenManager integration)
    // ============================================================

    /**
     * @dev Registers a new model with string ID
     * @param modelId The unique string identifier for the model
     * @param token The address of the token contract for this model
     * @param performanceMetric The performance metric used for this model
     */
    function registerStringModel(string memory modelId, address token, string memory performanceMetric) external onlyOwner {
        require(token != address(0), "Token address cannot be zero");
        require(bytes(performanceMetric).length > 0, "Performance metric cannot be empty");
        require(bytes(modelId).length > 0, "Model ID cannot be empty");
        require(!isStringModelRegistered[modelId], "Model already registered");
        require(bytes(tokenToStringModel[token]).length == 0, "Token already registered");

        modelsByString[modelId] = ModelInfo({
            tokenAddress: token,
            performanceMetric: performanceMetric,
            active: true
        });
        isStringModelRegistered[modelId] = true;
        tokenToStringModel[token] = modelId;

        emit StringModelRegistered(modelId, token, performanceMetric);
    }

    /**
     * @dev Gets the token address for a given string model ID
     * @param modelId The model identifier
     * @return The token address for the model
     */
    function getStringToken(string memory modelId) external view returns (address) {
        require(isStringModelRegistered[modelId], "Model not registered");
        return modelsByString[modelId].tokenAddress;
    }

    /**
     * @dev Gets the string model ID for a given token address (reverse lookup)
     * @param tokenAddress The token address
     * @return The model ID for the token
     */
    function getStringModelId(address tokenAddress) external view returns (string memory) {
        require(bytes(tokenToStringModel[tokenAddress]).length > 0, "Token not registered");
        return tokenToStringModel[tokenAddress];
    }

    /**
     * @dev Checks if a string model is registered
     * @param modelId The model identifier to check
     * @return True if the model is registered, false otherwise
     */
    function isStringRegistered(string memory modelId) external view returns (bool) {
        return isStringModelRegistered[modelId];
    }

    // ============================================================
    // AMM POOL REGISTRY
    // ============================================================

    /**
     * @dev Registers an AMM pool for a model
     * @param modelId The string model identifier
     * @param pool The AMM pool address
     */
    function registerPool(string memory modelId, address pool) external onlyOwner {
        require(bytes(modelId).length > 0, "Model ID cannot be empty");
        require(pool != address(0), "Pool address cannot be zero");
        require(isStringModelRegistered[modelId], "Model not registered");
        require(modelPools[modelId] == address(0), "Pool already exists");

        modelPools[modelId] = pool;
        emit PoolRegistered(modelId, pool);
    }

    /**
     * @dev Gets the AMM pool address for a model
     * @param modelId The string model identifier
     * @return The pool address, or address(0) if no pool exists
     */
    function getPool(string memory modelId) external view returns (address) {
        return modelPools[modelId];
    }

    /**
     * @dev Checks if a model has an AMM pool
     * @param modelId The string model identifier
     * @return True if the model has a pool, false otherwise
     */
    function hasPool(string memory modelId) external view returns (bool) {
        return modelPools[modelId] != address(0);
    }
}
