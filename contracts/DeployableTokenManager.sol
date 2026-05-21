// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "./libraries/AccessControlBase.sol";
import "./libraries/ValidationLib.sol";
import "./ModelRegistry.sol";
import "./interfaces/IHokusaiParams.sol";
import "./interfaces/IManagedHokusaiToken.sol";
import "./interfaces/IRewardVestingVault.sol";
import "./interfaces/ITokenDeploymentFactory.sol";
import "./libraries/RewardSplitLib.sol";

/**
 * @dev Size-safe TokenManager variant for live deployments.
 * Token and params creation is delegated to TokenDeploymentFactory so this
 * contract stays below the EIP-170 runtime bytecode limit.
 */
contract DeployableTokenManager is Ownable, AccessControlBase, ReentrancyGuard {
    ModelRegistry public registry;
    ITokenDeploymentFactory public tokenDeploymentFactory;
    address public deltaVerifier;
    IRewardVestingVault public vestingVault;

    struct InitialParams {
        uint256 tokensPerDeltaOne;
        uint16 infrastructureAccrualBps;
        uint256 initialOraclePricePerThousandUsd;
        bytes32 licenseHash;
        string licenseURI;
        address governor;
        IHokusaiParams.VestingConfig vestingConfig;
    }

    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    bytes32 public constant DEPLOYER_ROLE = keccak256("DEPLOYER_ROLE");

    mapping(string => address) public modelTokens;
    mapping(address => string) public tokenToModel;
    mapping(string => address) public modelParams;

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
    event ParamsDeployed(
        string indexed modelId,
        address indexed paramsAddress,
        address indexed deployer,
        uint256 tokensPerDeltaOne,
        uint16 infrastructureAccrualBps,
        uint256 initialOraclePricePerThousandUsd
    );
    event TokensMinted(string indexed modelId, address indexed recipient, uint256 amount);
    event TokensBurned(string indexed modelId, address indexed account, uint256 amount);
    event DeltaVerifierUpdated(address indexed newDeltaVerifier);
    event VestingVaultUpdated(address indexed vestingVault);
    event BatchMinted(string indexed modelId, address[] recipients, uint256[] amounts, uint256 totalAmount);
    event ContributorSkipped(address indexed contributor, uint256 index);
    event DeploymentFeeUpdated(uint256 newFee);
    event AllocationDistributed(
        string indexed modelId,
        address indexed modelSupplierRecipient,
        uint256 modelSupplierAllocation,
        address indexed investorRecipient,
        uint256 investorAllocation
    );
    event ModelSupplierAllocationDistributed(
        string indexed modelId,
        address indexed recipient,
        uint256 amount
    );
    event RewardVestingCreated(
        string indexed modelId,
        address indexed contributor,
        uint256 totalReward,
        uint256 immediateAmount,
        uint256 vestedAmount,
        uint256 vestingStart,
        uint256 vestingEnd
    );
    event DeploymentFeesWithdrawn(address indexed recipient, uint256 amount);

    constructor(address registryAddress, address tokenDeploymentFactoryAddress)
        Ownable()
        AccessControlBase(msg.sender)
    {
        ValidationLib.requireNonZeroAddress(registryAddress, "registry address");
        ValidationLib.requireNonZeroAddress(tokenDeploymentFactoryAddress, "token deployment factory");

        registry = ModelRegistry(registryAddress);
        tokenDeploymentFactory = ITokenDeploymentFactory(tokenDeploymentFactoryAddress);
        feeRecipient = msg.sender;

        bytes32[] memory roles = new bytes32[](2);
        roles[0] = MINTER_ROLE;
        roles[1] = DEPLOYER_ROLE;
        _grantRoles(roles, msg.sender);
    }

    function deployTokenWithParams(
        string memory modelId,
        string memory name,
        string memory symbol,
        uint256 totalSupply,
        InitialParams memory initialParams
    ) public payable nonReentrant returns (address tokenAddress) {
        ValidationLib.requireNonEmptyString(modelId, "model ID");
        ValidationLib.requireNonEmptyString(name, "token name");
        ValidationLib.requireNonEmptyString(symbol, "token symbol");
        ValidationLib.requirePositiveAmount(totalSupply, "total supply");
        ValidationLib.requireNonZeroAddress(initialParams.governor, "governor");
        require(modelTokens[modelId] == address(0), "Token already deployed for this model");

        _collectDeploymentFee();

        address paramsAddress;
        (tokenAddress, paramsAddress) = tokenDeploymentFactory.deployTokenAndParams(
            name,
            symbol,
            address(this),
            totalSupply,
            0,
            0,
            0,
            address(0),
            _toFactoryParams(initialParams)
        );

        _storeDeployment(modelId, tokenAddress, paramsAddress);
        _emitParamsDeployed(modelId, paramsAddress, initialParams);
        emit TokenDeployed(modelId, tokenAddress, msg.sender, name, symbol, totalSupply);

        // Refund excess payment (CEI: last step, after all state changes and events)
        _refundExcess();
    }

    function deployTokenWithAllocations(
        string memory modelId,
        string memory name,
        string memory symbol,
        uint256 modelSupplierAllocation,
        address modelSupplierRecipient,
        uint256 investorAllocation,
        InitialParams memory initialParams
    ) public payable nonReentrant returns (address tokenAddress) {
        ValidationLib.requireNonEmptyString(modelId, "model ID");
        ValidationLib.requireNonEmptyString(name, "token name");
        ValidationLib.requireNonEmptyString(symbol, "token symbol");
        ValidationLib.requirePositiveAmount(modelSupplierAllocation, "model supplier allocation");
        ValidationLib.requireNonZeroAddress(modelSupplierRecipient, "model supplier recipient");
        ValidationLib.requirePositiveAmount(investorAllocation, "investor allocation");
        ValidationLib.requireNonZeroAddress(initialParams.governor, "governor");
        require(modelTokens[modelId] == address(0), "Token already deployed for this model");

        _collectDeploymentFee();

        uint256 maxSupply = modelSupplierAllocation + investorAllocation;
        address paramsAddress;
        (tokenAddress, paramsAddress) = tokenDeploymentFactory.deployTokenAndParams(
            name,
            symbol,
            address(this),
            0,
            maxSupply,
            modelSupplierAllocation,
            investorAllocation,
            modelSupplierRecipient,
            _toFactoryParams(initialParams)
        );

        _storeDeployment(modelId, tokenAddress, paramsAddress);
        _emitParamsDeployed(modelId, paramsAddress, initialParams);
        emit TokenDeployed(modelId, tokenAddress, msg.sender, name, symbol, maxSupply);
        emit AllocationDistributed(
            modelId,
            modelSupplierRecipient,
            modelSupplierAllocation,
            address(0),
            investorAllocation
        );

        // Refund excess payment (CEI: last step, after all state changes and events)
        _refundExcess();
    }

    function distributeModelSupplierAllocation(string memory modelId) external onlyOwner {
        ValidationLib.requireNonEmptyString(modelId, "model ID");
        address tokenAddress = modelTokens[modelId];
        require(tokenAddress != address(0), "Token not deployed for this model");

        IManagedHokusaiToken token = IManagedHokusaiToken(tokenAddress);
        token.distributeModelSupplierAllocation();

        emit ModelSupplierAllocationDistributed(
            modelId,
            token.modelSupplierRecipient(),
            token.modelSupplierAllocation()
        );
    }

    function setDeploymentFee(uint256 _fee) external onlyOwner {
        deploymentFee = _fee;
        emit DeploymentFeeUpdated(_fee);
    }

    function setFeeRecipient(address _recipient) external onlyOwner {
        ValidationLib.requireNonZeroAddress(_recipient, "fee recipient");
        feeRecipient = _recipient;
    }

    function setDeltaVerifier(address _deltaVerifier) external onlyOwner {
        ValidationLib.requireNonZeroAddress(_deltaVerifier, "delta verifier");
        deltaVerifier = _deltaVerifier;
        emit DeltaVerifierUpdated(_deltaVerifier);
    }

    function setVestingVault(address vaultAddress) external onlyOwner {
        ValidationLib.requireNonZeroAddress(vaultAddress, "vesting vault");
        require(address(vestingVault) == address(0), "Vesting vault already set");
        vestingVault = IRewardVestingVault(vaultAddress);
        emit VestingVaultUpdated(vaultAddress);
    }

    function authorizeAMM(address amm) external onlyOwner {
        ValidationLib.requireNonZeroAddress(amm, "AMM address");
        grantRole(MINTER_ROLE, amm);
    }

    function revokeAMM(address amm) external onlyOwner {
        revokeRole(MINTER_ROLE, amm);
    }

    /**
     * @dev Returns the redeemable circulating supply used by AMM pricing.
     * Excludes balances held in the vesting vault until contributors claim them.
     */
    function getRedeemableSupply(string memory modelId) external view returns (uint256) {
        ValidationLib.requireNonEmptyString(modelId, "model ID");

        address tokenAddress = modelTokens[modelId];
        require(tokenAddress != address(0), "Token not deployed for this model");

        uint256 totalSupply = IERC20(tokenAddress).totalSupply();
        address vault = address(vestingVault);
        if (vault == address(0)) {
            return totalSupply;
        }

        uint256 lockedSupply = IERC20(tokenAddress).balanceOf(vault);
        return totalSupply > lockedSupply ? totalSupply - lockedSupply : 0;
    }

    function mintTokens(string memory modelId, address recipient, uint256 amount) external {
        require(
            hasRole(MINTER_ROLE, msg.sender) || msg.sender == owner() || msg.sender == deltaVerifier,
            "Caller is not authorized to mint"
        );
        ValidationLib.requireNonEmptyString(modelId, "model ID");
        ValidationLib.requireNonZeroAddress(recipient, "recipient");
        ValidationLib.requirePositiveAmount(amount, "amount");

        address tokenAddress = modelTokens[modelId];
        require(tokenAddress != address(0), "Token not deployed for this model");
        require(
            !registry.isStringModelRegistered(modelId) || registry.isStringActive(modelId),
            "Model is deactivated"
        );

        _mintInvestorToken(tokenAddress, recipient, amount);
        emit TokensMinted(modelId, recipient, amount);
    }

    function batchMintTokens(
        string memory modelId,
        address[] calldata recipients,
        uint256[] calldata amounts
    ) external {
        require(
            hasRole(MINTER_ROLE, msg.sender) || msg.sender == owner() || msg.sender == deltaVerifier,
            "Unauthorized"
        );
        ValidationLib.requireNonEmptyString(modelId, "model ID");
        ValidationLib.requireValidBatch(recipients.length, amounts.length, 100);

        address tokenAddress = modelTokens[modelId];
        require(tokenAddress != address(0), "Token not deployed for this model");
        require(
            !registry.isStringModelRegistered(modelId) || registry.isStringActive(modelId),
            "Model is deactivated"
        );

        uint256 totalAmount = 0;

        for (uint256 i = 0; i < recipients.length; i++) {
            ValidationLib.requireNonZeroAddress(recipients[i], "recipient");

            if (amounts[i] == 0) {
                emit ContributorSkipped(recipients[i], i);
                continue;
            }

            _mintInvestorToken(tokenAddress, recipients[i], amounts[i]);
            totalAmount += amounts[i];
        }

        emit BatchMinted(modelId, recipients, amounts, totalAmount);
    }

    function mintReward(string memory modelId, address recipient, uint256 amount) external {
        require(
            hasRole(MINTER_ROLE, msg.sender) || msg.sender == owner() || msg.sender == deltaVerifier,
            "Caller is not authorized to mint"
        );
        ValidationLib.requireNonEmptyString(modelId, "model ID");
        ValidationLib.requireNonZeroAddress(recipient, "recipient");
        ValidationLib.requirePositiveAmount(amount, "amount");

        address tokenAddress = modelTokens[modelId];
        require(tokenAddress != address(0), "Token not deployed for this model");
        require(
            !registry.isStringModelRegistered(modelId) || registry.isStringActive(modelId),
            "Model is deactivated"
        );

        _mintRewardWithVesting(modelId, tokenAddress, recipient, amount);
        emit TokensMinted(modelId, recipient, amount);
    }

    function batchMintReward(
        string memory modelId,
        address[] calldata recipients,
        uint256[] calldata amounts
    ) external {
        require(
            hasRole(MINTER_ROLE, msg.sender) || msg.sender == owner() || msg.sender == deltaVerifier,
            "Unauthorized"
        );
        ValidationLib.requireNonEmptyString(modelId, "model ID");
        ValidationLib.requireValidBatch(recipients.length, amounts.length, 100);

        address tokenAddress = modelTokens[modelId];
        require(tokenAddress != address(0), "Token not deployed for this model");
        require(
            !registry.isStringModelRegistered(modelId) || registry.isStringActive(modelId),
            "Model is deactivated"
        );

        uint256 totalAmount = 0;

        for (uint256 i = 0; i < recipients.length; i++) {
            ValidationLib.requireNonZeroAddress(recipients[i], "recipient");

            if (amounts[i] == 0) {
                emit ContributorSkipped(recipients[i], i);
                continue;
            }

            _mintRewardWithVesting(modelId, tokenAddress, recipients[i], amounts[i]);
            totalAmount += amounts[i];
        }

        emit BatchMinted(modelId, recipients, amounts, totalAmount);
    }

    function burnTokens(string memory modelId, address account, uint256 amount) external {
        require(
            hasRole(MINTER_ROLE, msg.sender) || msg.sender == owner() || msg.sender == deltaVerifier,
            "Caller is not authorized to burn"
        );
        ValidationLib.requireNonEmptyString(modelId, "model ID");
        ValidationLib.requireNonZeroAddress(account, "account");
        ValidationLib.requirePositiveAmount(amount, "amount");

        address tokenAddress = modelTokens[modelId];
        require(tokenAddress != address(0), "Token not deployed for this model");
        IManagedHokusaiToken(tokenAddress).burnFrom(account, amount);
        emit TokensBurned(modelId, account, amount);
    }

    function burnInvestorTokens(string memory modelId, address account, uint256 amount) external {
        require(
            hasRole(MINTER_ROLE, msg.sender) || msg.sender == owner() || msg.sender == deltaVerifier,
            "Caller is not authorized to burn"
        );
        ValidationLib.requireNonEmptyString(modelId, "model ID");
        ValidationLib.requireNonZeroAddress(account, "account");
        ValidationLib.requirePositiveAmount(amount, "amount");

        address tokenAddress = modelTokens[modelId];
        require(tokenAddress != address(0), "Token not deployed for this model");
        _burnInvestorToken(tokenAddress, account, amount);
        emit TokensBurned(modelId, account, amount);
    }

    function getTokenAddress(string memory modelId) external view returns (address) {
        return modelTokens[modelId];
    }

    function hasToken(string memory modelId) external view returns (bool) {
        return modelTokens[modelId] != address(0);
    }

    function getModelId(address tokenAddress) external view returns (string memory) {
        ValidationLib.requireNonZeroAddress(tokenAddress, "token address");
        ValidationLib.requireNonEmptyString(tokenToModel[tokenAddress], "token");
        return tokenToModel[tokenAddress];
    }

    function getParamsAddress(string memory modelId) external view returns (address) {
        return modelParams[modelId];
    }

    function hasParams(string memory modelId) external view returns (bool) {
        return modelParams[modelId] != address(0);
    }

    /**
     * @dev Validates and retains deployment fee (pull-payment model)
     * Fee remains in contract until withdrawn via withdrawDeploymentFees()
     */
    function _collectDeploymentFee() private {
        if (deploymentFee > 0) {
            require(msg.value >= deploymentFee, "Insufficient deployment fee");
        }
    }

    /**
     * @dev Refunds excess payment to msg.sender (CEI-compliant: call last)
     * Only called after all state changes and event emissions
     */
    function _refundExcess() private {
        if (msg.value > deploymentFee) {
            uint256 excess = msg.value - deploymentFee;
            (bool refunded, ) = msg.sender.call{value: excess}("");
            require(refunded, "Failed to refund excess payment");
        }
    }

    /**
     * @dev Withdraws accrued deployment fees to feeRecipient (owner only, pull-payment)
     * Because this function is onlyOwner, Slither's arbitrary-send-eth does not flag it
     */
    function withdrawDeploymentFees() external onlyOwner nonReentrant {
        uint256 balance = address(this).balance;
        require(balance > 0, "No fees to withdraw");

        (bool sent, ) = feeRecipient.call{value: balance}("");
        require(sent, "Failed to send deployment fees");

        emit DeploymentFeesWithdrawn(feeRecipient, balance);
    }

    function _storeDeployment(
        string memory modelId,
        address tokenAddress,
        address paramsAddress
    ) private {
        modelTokens[modelId] = tokenAddress;
        tokenToModel[tokenAddress] = modelId;
        modelParams[modelId] = paramsAddress;
    }

    function _emitParamsDeployed(
        string memory modelId,
        address paramsAddress,
        InitialParams memory initialParams
    ) private {
        emit ParamsDeployed(
            modelId,
            paramsAddress,
            msg.sender,
            initialParams.tokensPerDeltaOne,
            initialParams.infrastructureAccrualBps,
            initialParams.initialOraclePricePerThousandUsd
        );
    }

    function _toFactoryParams(InitialParams memory initialParams)
        private
        pure
        returns (ITokenDeploymentFactory.InitialParams memory)
    {
        return ITokenDeploymentFactory.InitialParams({
            tokensPerDeltaOne: initialParams.tokensPerDeltaOne,
            infrastructureAccrualBps: initialParams.infrastructureAccrualBps,
            initialOraclePricePerThousandUsd: initialParams.initialOraclePricePerThousandUsd,
            licenseHash: initialParams.licenseHash,
            licenseURI: initialParams.licenseURI,
            governor: initialParams.governor,
            vestingConfig: initialParams.vestingConfig
        });
    }

    function _mintRewardWithVesting(
        string memory modelId,
        address tokenAddress,
        address recipient,
        uint256 amount
    ) private {
        IManagedHokusaiToken token = IManagedHokusaiToken(tokenAddress);
        IHokusaiParams params = token.params();

        if (!params.vestingEnabled()) {
            _mintRewardToken(tokenAddress, recipient, amount);
            return;
        }

        (uint256 immediateAmount, uint256 vestedAmount) = RewardSplitLib.split(
            amount,
            params.immediateUnlockBps()
        );

        if (immediateAmount > 0) {
            _mintRewardToken(tokenAddress, recipient, immediateAmount);
        }

        if (vestedAmount == 0) {
            return;
        }

        require(address(vestingVault) != address(0), "Vesting vault not configured");

        uint64 duration = params.vestingDurationSeconds();
        _mintRewardToken(tokenAddress, address(vestingVault), vestedAmount);
        vestingVault.createSchedule(
            modelId,
            tokenAddress,
            recipient,
            vestedAmount,
            params.cliffSeconds(),
            duration
        );

        emit RewardVestingCreated(
            modelId,
            recipient,
            amount,
            immediateAmount,
            vestedAmount,
            block.timestamp,
            block.timestamp + uint256(duration)
        );
    }

    function _mintInvestorToken(address tokenAddress, address recipient, uint256 amount) private {
        IManagedHokusaiToken token = IManagedHokusaiToken(tokenAddress);
        if (token.maxSupply() == type(uint256).max) {
            token.mint(recipient, amount);
            return;
        }

        token.mintInvestor(recipient, amount);
    }

    function _mintRewardToken(address tokenAddress, address recipient, uint256 amount) private {
        IManagedHokusaiToken token = IManagedHokusaiToken(tokenAddress);
        if (token.maxSupply() == type(uint256).max) {
            token.mint(recipient, amount);
            return;
        }

        token.mintReward(recipient, amount);
    }

    function _burnInvestorToken(address tokenAddress, address account, uint256 amount) private {
        IManagedHokusaiToken token = IManagedHokusaiToken(tokenAddress);
        if (token.maxSupply() == type(uint256).max) {
            token.burnFrom(account, amount);
            return;
        }

        token.burnInvestor(account, amount);
    }
}
