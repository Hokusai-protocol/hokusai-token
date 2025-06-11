// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/access/Ownable.sol";
import "./ModelRegistry.sol";
import "./HokusaiToken.sol";

/**
 * @title TokenManager
 * @dev Manages token operations for multiple models through ModelRegistry integration
 */
contract TokenManager is Ownable {
    ModelRegistry public registry;

    event TokensMinted(bytes32 indexed modelId, address indexed recipient, uint256 amount);
    event TokensBurned(bytes32 indexed modelId, address indexed account, uint256 amount);

    modifier validModel(bytes32 modelId) {
        require(registry.isRegistered(modelId), "Model not registered");
        _;
    }

    constructor(address registryAddress) Ownable(msg.sender) {
        require(registryAddress != address(0), "Registry address cannot be zero");
        registry = ModelRegistry(registryAddress);
    }

    /**
     * @dev Mints tokens for a specific model to a recipient
     * @param modelId The model identifier
     * @param recipient The address to receive the tokens
     * @param amount The amount of tokens to mint
     */
    function mintTokens(bytes32 modelId, address recipient, uint256 amount) 
        external 
        onlyOwner 
        validModel(modelId) 
    {
        require(recipient != address(0), "Recipient cannot be zero address");
        require(amount > 0, "Amount must be greater than zero");
        
        address tokenAddress = registry.getToken(modelId);
        HokusaiToken(tokenAddress).mint(recipient, amount);
        
        emit TokensMinted(modelId, recipient, amount);
    }

    /**
     * @dev Burns tokens from a specific account for a model
     * @param modelId The model identifier  
     * @param account The address to burn tokens from
     * @param amount The amount of tokens to burn
     */
    function burnTokens(bytes32 modelId, address account, uint256 amount)
        external
        onlyOwner
        validModel(modelId)
    {
        require(account != address(0), "Account cannot be zero address");
        require(amount > 0, "Amount must be greater than zero");
        
        address tokenAddress = registry.getToken(modelId);
        HokusaiToken(tokenAddress).burnFrom(account, amount);
        
        emit TokensBurned(modelId, account, amount);
    }

    /**
     * @dev Gets the token address for a specific model
     * @param modelId The model identifier
     * @return The token contract address
     */
    function getTokenAddress(bytes32 modelId) external view validModel(modelId) returns (address) {
        return registry.getToken(modelId);
    }

    /**
     * @dev Checks if a model is managed by this TokenManager
     * @param modelId The model identifier
     * @return True if the model is registered in the registry
     */
    function isModelManaged(bytes32 modelId) external view returns (bool) {
        return registry.isRegistered(modelId);
    }
}
