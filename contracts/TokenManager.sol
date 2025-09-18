// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "./ModelRegistry.sol";
import "./HokusaiToken.sol";

/**
 * @title TokenManager
 * @dev Manages token deployment and operations for models
 * Users can deploy tokens directly and pay gas fees themselves
 */
contract TokenManager is Ownable, AccessControl {
    ModelRegistry public registry;
    address public deltaVerifier;
    
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    bytes32 public constant DEPLOYER_ROLE = keccak256("DEPLOYER_ROLE");

    // Track deployed tokens
    mapping(string => address) public modelTokens;
    mapping(address => string) public tokenToModel;

    // Optional platform fee for deployment
    uint256 public deploymentFee = 0;
    address public feeRecipient;

    event TokenDeployed(
        string indexed modelId,
        address indexed tokenAddress,
        address indexed deployer,
        string name,
        string symbol,
        uint256 totalSupply
    );
    event TokensMinted(string indexed modelId, address indexed recipient, uint256 amount);
    event TokensBurned(string indexed modelId, address indexed account, uint256 amount);
    event DeltaVerifierUpdated(address indexed newDeltaVerifier);
    event BatchMinted(string indexed modelId, address[] recipients, uint256[] amounts, uint256 totalAmount);
    event DeploymentFeeUpdated(uint256 newFee);


    constructor(address registryAddress) Ownable() {
        require(registryAddress != address(0), "Registry address cannot be zero");
        registry = ModelRegistry(registryAddress);
        feeRecipient = msg.sender;
        _setupRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _setupRole(MINTER_ROLE, msg.sender);
        _setupRole(DEPLOYER_ROLE, msg.sender);
    }

    /**
     * @dev Deploy a new token for a model - USER PAYS GAS
     * @param modelId The model identifier (string)
     * @param name Token name
     * @param symbol Token symbol
     * @param totalSupply The total supply to mint initially
     * @return tokenAddress The deployed token address
     */
    function deployToken(
        string memory modelId,
        string memory name,
        string memory symbol,
        uint256 totalSupply
    ) external payable returns (address tokenAddress) {
        // Validate inputs
        require(bytes(modelId).length > 0, "Model ID cannot be empty");
        require(bytes(name).length > 0, "Token name cannot be empty");
        require(bytes(symbol).length > 0, "Token symbol cannot be empty");
        require(totalSupply > 0, "Total supply must be greater than zero");

        // Check if model already has a token
        require(modelTokens[modelId] == address(0), "Token already deployed for this model");

        // Check deployment fee if configured
        if (deploymentFee > 0) {
            require(msg.value >= deploymentFee, "Insufficient deployment fee");
            // Transfer fee to recipient
            (bool sent, ) = feeRecipient.call{value: deploymentFee}("");
            require(sent, "Failed to send deployment fee");

            // Refund excess payment
            if (msg.value > deploymentFee) {
                (bool refunded, ) = msg.sender.call{value: msg.value - deploymentFee}("");
                require(refunded, "Failed to refund excess payment");
            }
        }

        // Deploy new HokusaiToken with this contract as controller and initial supply
        HokusaiToken newToken = new HokusaiToken(name, symbol, address(this), totalSupply);
        tokenAddress = address(newToken);

        // Store token mapping
        modelTokens[modelId] = tokenAddress;
        tokenToModel[tokenAddress] = modelId;

        // Note: Registry registration is not attempted as it uses uint256 modelId
        // The ModelRegistry can be updated separately to support string modelIds if needed

        emit TokenDeployed(modelId, tokenAddress, msg.sender, name, symbol, totalSupply);

        return tokenAddress;
    }

    /**
     * @dev Set deployment fee (owner only)
     */
    function setDeploymentFee(uint256 _fee) external onlyOwner {
        deploymentFee = _fee;
        emit DeploymentFeeUpdated(_fee);
    }

    /**
     * @dev Set fee recipient (owner only)
     */
    function setFeeRecipient(address _recipient) external onlyOwner {
        require(_recipient != address(0), "Invalid recipient");
        feeRecipient = _recipient;
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
    function mintTokens(string memory modelId, address recipient, uint256 amount)
        external
    {
        require(
            hasRole(MINTER_ROLE, msg.sender) || msg.sender == owner() || msg.sender == deltaVerifier,
            "Caller is not authorized to mint"
        );
        require(bytes(modelId).length > 0, "Model ID cannot be empty");
        require(recipient != address(0), "Recipient cannot be zero address");
        require(amount > 0, "Amount must be greater than zero");

        address tokenAddress = modelTokens[modelId];
        require(tokenAddress != address(0), "Token not deployed for this model");

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
        string memory modelId,
        address[] calldata recipients,
        uint256[] calldata amounts
    )
        external
    {
        require(
            hasRole(MINTER_ROLE, msg.sender) || msg.sender == owner() || msg.sender == deltaVerifier,
            "Unauthorized"
        );
        require(bytes(modelId).length > 0, "Model ID cannot be empty");
        require(recipients.length > 0, "Empty recipients array");
        require(recipients.length == amounts.length, "Array length mismatch");
        require(recipients.length <= 100, "Batch size exceeds limit");

        address tokenAddress = modelTokens[modelId];
        require(tokenAddress != address(0), "Token not deployed for this model");

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
    function burnTokens(string memory modelId, address account, uint256 amount)
        external
        onlyOwner
    {
        require(bytes(modelId).length > 0, "Model ID cannot be empty");
        require(account != address(0), "Account cannot be zero address");
        require(amount > 0, "Amount must be greater than zero");

        address tokenAddress = modelTokens[modelId];
        require(tokenAddress != address(0), "Token not deployed for this model");

        HokusaiToken(tokenAddress).burnFrom(account, amount);

        emit TokensBurned(modelId, account, amount);
    }

    /**
     * @dev Gets the token address for a specific model
     * @param modelId The model identifier
     * @return The token contract address
     */
    function getTokenAddress(string memory modelId) external view returns (address) {
        return modelTokens[modelId];
    }

    /**
     * @dev Checks if a model has a deployed token
     * @param modelId The model identifier
     * @return True if the model has a token deployed
     */
    function hasToken(string memory modelId) external view returns (bool) {
        return modelTokens[modelId] != address(0);
    }

    /**
     * @dev Gets the model ID for a specific token address
     * @param tokenAddress The token address
     * @return The model identifier
     */
    function getModelId(address tokenAddress) external view returns (string memory) {
        require(tokenAddress != address(0), "Token address cannot be zero");
        require(bytes(tokenToModel[tokenAddress]).length > 0, "Token not found");
        return tokenToModel[tokenAddress];
    }
}
