// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "./ModelRegistry.sol";
import "./HokusaiToken.sol";

/**
 * @title TokenManager
 * @dev Manages token operations for multiple models through ModelRegistry integration
 */
contract TokenManager is Ownable, AccessControl {
    ModelRegistry public registry;
    address public deltaVerifier;
    
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");

    event TokensMinted(uint256 indexed modelId, address indexed recipient, uint256 amount);
    event TokensBurned(uint256 indexed modelId, address indexed account, uint256 amount);
    event DeltaVerifierUpdated(address indexed newDeltaVerifier);
    event BatchMinted(uint256 indexed modelId, address[] recipients, uint256[] amounts, uint256 totalAmount);

    modifier validModel(uint256 modelId) {
        require(registry.isRegistered(modelId), "Model not registered");
        _;
    }

    constructor(address registryAddress) Ownable() {
        require(registryAddress != address(0), "Registry address cannot be zero");
        registry = ModelRegistry(registryAddress);
        _setupRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _setupRole(MINTER_ROLE, msg.sender);
    }

    /**
     * @dev Sets the DeltaVerifier contract address
     * @param _deltaVerifier The DeltaVerifier contract address
     */
    function setDeltaVerifier(address _deltaVerifier) external onlyOwner {
        require(_deltaVerifier != address(0), "Invalid delta verifier address");
        deltaVerifier = _deltaVerifier;
        emit DeltaVerifierUpdated(_deltaVerifier);
    }

    /**
     * @dev Mints tokens for a specific model to a recipient
     * @param modelId The model identifier
     * @param recipient The address to receive the tokens
     * @param amount The amount of tokens to mint
     */
    function mintTokens(uint256 modelId, address recipient, uint256 amount) 
        external 
        validModel(modelId) 
    {
        require(
            hasRole(MINTER_ROLE, msg.sender) || msg.sender == owner() || msg.sender == deltaVerifier,
            "Caller is not authorized to mint"
        );
        require(recipient != address(0), "Recipient cannot be zero address");
        require(amount > 0, "Amount must be greater than zero");
        
        address tokenAddress = registry.getToken(modelId);
        HokusaiToken(tokenAddress).mint(recipient, amount);
        
        emit TokensMinted(modelId, recipient, amount);
    }

    /**
     * @dev Mints tokens to multiple recipients in a single transaction
     * @param modelId The model identifier
     * @param recipients Array of addresses to receive tokens
     * @param amounts Array of token amounts corresponding to each recipient
     */
    function batchMintTokens(
        uint256 modelId, 
        address[] calldata recipients, 
        uint256[] calldata amounts
    ) 
        external 
        validModel(modelId) 
    {
        require(
            hasRole(MINTER_ROLE, msg.sender) || msg.sender == owner() || msg.sender == deltaVerifier,
            "Unauthorized"
        );
        require(recipients.length > 0, "Empty recipients array");
        require(recipients.length == amounts.length, "Array length mismatch");
        require(recipients.length <= 100, "Batch size exceeds limit");
        
        address tokenAddress = registry.getToken(modelId);
        HokusaiToken token = HokusaiToken(tokenAddress);
        uint256 totalAmount = 0;
        
        for (uint256 i = 0; i < recipients.length; i++) {
            require(recipients[i] != address(0), "Invalid recipient address");
            require(amounts[i] > 0, "Amount must be greater than zero");
            
            token.mint(recipients[i], amounts[i]);
            totalAmount += amounts[i];
        }
        
        emit BatchMinted(modelId, recipients, amounts, totalAmount);
    }

    /**
     * @dev Burns tokens from a specific account for a model
     * @param modelId The model identifier  
     * @param account The address to burn tokens from
     * @param amount The amount of tokens to burn
     */
    function burnTokens(uint256 modelId, address account, uint256 amount)
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
    function getTokenAddress(uint256 modelId) external view validModel(modelId) returns (address) {
        return registry.getToken(modelId);
    }

    /**
     * @dev Checks if a model is managed by this TokenManager
     * @param modelId The model identifier
     * @return True if the model is registered in the registry
     */
    function isModelManaged(uint256 modelId) external view returns (bool) {
        return registry.isRegistered(modelId);
    }
}
