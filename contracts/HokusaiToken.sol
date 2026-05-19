// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "./interfaces/IHokusaiParams.sol";

/**
 * @title HokusaiToken
 * @dev ERC20 token with controller-based minting and burning
 * Each token has an immutable reference to its parameter contract for dynamic configuration
 */
contract HokusaiToken is ERC20, Ownable {
    address public controller;

    /// @dev Immutable reference to the parameter contract for this token
    IHokusaiParams public immutable params;

    /// @dev Historical sum of modelSupplierAllocation + investorAllocation; no longer a hard enforcement boundary.
    uint256 public immutable maxSupply;

    /// @dev Model supplier allocation amount (not minted until distributeModelSupplierAllocation is called)
    uint256 public immutable modelSupplierAllocation;

    /// @dev Address to receive model supplier allocation
    address public immutable modelSupplierRecipient;

    /// @dev Maximum tokens mintable through the investor (AMM) bucket
    uint256 public immutable investorAllocation;

    /// @dev Defense-in-depth cap on reward minting: 100 * tokensPerDeltaOne sampled at construction
    uint256 public immutable rewardAllocation;

    /// @dev Running sum of tokens minted through mintInvestor
    uint256 public investorMinted;

    /// @dev Running sum of tokens minted through mintReward
    uint256 public rewardMinted;

    /// @dev Flag indicating if model supplier allocation has been distributed
    bool public modelSupplierDistributed;

    event ControllerUpdated(address indexed newController);
    event Minted(address indexed to, uint256 amount);
    event Burned(address indexed from, uint256 amount);
    event TokenSupplyConfigured(
        uint256 initialSupply,
        uint256 maxSupply,
        uint256 modelSupplierAllocation,
        address indexed modelSupplierRecipient
    );
    event ModelSupplierAllocationDistributed(address indexed recipient, uint256 amount);
    event InvestorMinted(address indexed to, uint256 amount, uint256 newInvestorMinted);
    event RewardMinted(address indexed to, uint256 amount, uint256 newRewardMinted);
    event TokenAllocationsConfigured(uint256 maxSupply, uint256 modelSupplierAllocation, uint256 investorAllocation, uint256 rewardAllocation);

    modifier onlyController() {
        require(msg.sender == controller, "Only controller can call this function");
        _;
    }

    constructor(
        string memory _name,
        string memory _symbol,
        address _controller,
        address _params,
        uint256 _initialSupply,
        uint256 _maxSupply,
        uint256 _modelSupplierAllocation,
        address _modelSupplierRecipient
    ) ERC20(_name, _symbol) Ownable() {
        require(bytes(_name).length > 0, "Token name cannot be empty");
        require(bytes(_symbol).length > 0, "Token symbol cannot be empty");
        require(_controller != address(0), "Controller cannot be zero address");
        require(_params != address(0), "Params cannot be zero address");

        bool isCapBased = _maxSupply > 0;

        if (isCapBased) {
            require(_modelSupplierAllocation <= _maxSupply, "Model supplier allocation exceeds max supply");
            require(_modelSupplierRecipient != address(0), "Model supplier recipient cannot be zero address");
        } else {
            require(_initialSupply > 0, "Initial supply must be greater than zero");
        }

        controller = _controller;
        params = IHokusaiParams(_params);

        maxSupply = isCapBased ? _maxSupply : type(uint256).max;
        modelSupplierAllocation = isCapBased ? _modelSupplierAllocation : 0;
        modelSupplierRecipient = isCapBased ? _modelSupplierRecipient : address(0);
        modelSupplierDistributed = !isCapBased;
        investorAllocation = isCapBased ? _maxSupply - _modelSupplierAllocation : 0;
        rewardAllocation = isCapBased ? 100 * IHokusaiParams(_params).tokensPerDeltaOne() : type(uint256).max;

        if (!isCapBased) {
            _mint(_controller, _initialSupply);
            emit Minted(_controller, _initialSupply);
        }

        emit TokenSupplyConfigured(_initialSupply, maxSupply, modelSupplierAllocation, modelSupplierRecipient);
        emit TokenAllocationsConfigured(maxSupply, modelSupplierAllocation, investorAllocation, rewardAllocation);
        emit ControllerUpdated(_controller);
    }

    /**
     * @dev Sets the controller address that can mint and burn tokens
     * @param _controller The address to set as controller
     */
    function setController(address _controller) external onlyOwner {
        require(_controller != address(0), "Controller cannot be zero address");
        controller = _controller;
        emit ControllerUpdated(_controller);
    }

    /// @dev Legacy mint — works only for legacy (unlimited) tokens. Cap-based tokens must use mintInvestor/mintReward.
    function mint(address to, uint256 amount) external onlyController {
        require(maxSupply == type(uint256).max, "Use mintInvestor or mintReward for cap-based tokens");
        _mint(to, amount);
        emit Minted(to, amount);
    }

    /// @dev Mints tokens charged against the investor allocation bucket (AMM purchases).
    function mintInvestor(address to, uint256 amount) external onlyController {
        if (maxSupply < type(uint256).max) {
            require(investorMinted + amount <= investorAllocation, "Investor allocation exhausted");
            investorMinted += amount;
        }
        _mint(to, amount);
        emit InvestorMinted(to, amount, investorMinted);
        emit Minted(to, amount);
    }

    /// @dev Mints tokens charged against the reward allocation bucket (DeltaOne rewards).
    function mintReward(address to, uint256 amount) external onlyController {
        if (maxSupply < type(uint256).max) {
            require(rewardMinted + amount <= rewardAllocation, "Reward allocation exhausted");
            rewardMinted += amount;
        }
        _mint(to, amount);
        emit RewardMinted(to, amount, rewardMinted);
        emit Minted(to, amount);
    }

    /**
     * @dev Distributes model supplier allocation (only callable once by controller)
     * This should be called when the model has been registered and verified
     */
    function distributeModelSupplierAllocation() external onlyController {
        require(!modelSupplierDistributed, "Model supplier allocation already distributed");
        require(modelSupplierAllocation > 0, "No model supplier allocation set");

        modelSupplierDistributed = true;

        _mint(modelSupplierRecipient, modelSupplierAllocation);
        emit ModelSupplierAllocationDistributed(modelSupplierRecipient, modelSupplierAllocation);
        emit Minted(modelSupplierRecipient, modelSupplierAllocation);
    }

    /**
     * @dev Burns tokens from caller's balance
     * @param amount The amount of tokens to burn
     */
    function burn(uint256 amount) external {
        _burn(msg.sender, amount);
        emit Burned(msg.sender, amount);
    }

    /**
     * @dev Burns tokens from a specified address using allowance
     * @param from The address to burn tokens from
     * @param amount The amount of tokens to burn
     */
    function burnFrom(address from, uint256 amount) external onlyController {
        _burn(from, amount);
        emit Burned(from, amount);
    }

    function investorRemaining() public view returns (uint256) {
        if (maxSupply == type(uint256).max) return type(uint256).max;
        return investorAllocation - investorMinted;
    }

    function rewardRemaining() public view returns (uint256) {
        if (maxSupply == type(uint256).max) return type(uint256).max;
        return rewardAllocation - rewardMinted;
    }

    function getRemainingSupply() external view returns (uint256) {
        if (maxSupply == type(uint256).max) return type(uint256).max;
        uint256 supplierRemaining = modelSupplierDistributed ? 0 : modelSupplierAllocation;
        return investorRemaining() + rewardRemaining() + supplierRemaining;
    }
}
