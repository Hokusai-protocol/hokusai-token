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
    uint256 public constant REWARD_CAP_MULTIPLIER = 100;

    address public controller;

    /// @dev Immutable reference to the parameter contract for this token
    IHokusaiParams public immutable params;

    /// @dev Maximum supply cap (modelSupplierAllocation + investorAllocation)
    uint256 public immutable maxSupply;

    /// @dev Model supplier allocation amount (not minted until distributeModelSupplierAllocation is called)
    uint256 public immutable modelSupplierAllocation;

    /// @dev Investor allocation reserved for AMM-driven mints
    uint256 public immutable investorAllocation;

    /// @dev Address to receive model supplier allocation
    address public immutable modelSupplierRecipient;

    /// @dev Flag indicating if model supplier allocation has been distributed
    bool public modelSupplierDistributed;

    /// @dev Net investor mints after investor-side burns
    uint256 public investorMinted;

    /// @dev Total rewards minted across immediate and vested flows
    uint256 public rewardMinted;

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

    modifier onlyController() {
        require(msg.sender == controller, "Only controller can call this function");
        _;
    }

    /**
     * @dev Constructor to initialize the token
     * @param _name The name of the token (e.g., "Hokusai Model Token")
     * @param _symbol The symbol of the token (e.g., "HMT")
     * @param _controller The address that will have mint/burn privileges
     * @param _params The address of the parameter contract for this token
     * @param _initialSupply Initial supply to mint to controller (for legacy deployment), or 0 for cap-based deployment
     * @param _maxSupply Maximum supply cap (0 for legacy mode = unlimited)
     * @param _modelSupplierAllocation Amount allocated for model supplier (0 for legacy mode)
     * @param _investorAllocation Amount allocated for investor purchases (0 for legacy mode)
     * @param _modelSupplierRecipient Address to receive model supplier allocation (address(0) for legacy mode)
     */
    constructor(
        string memory _name,
        string memory _symbol,
        address _controller,
        address _params,
        uint256 _initialSupply,
        uint256 _maxSupply,
        uint256 _modelSupplierAllocation,
        uint256 _investorAllocation,
        address _modelSupplierRecipient
    ) ERC20(_name, _symbol) Ownable() {
        require(bytes(_name).length > 0, "Token name cannot be empty");
        require(bytes(_symbol).length > 0, "Token symbol cannot be empty");
        require(_controller != address(0), "Controller cannot be zero address");
        require(_params != address(0), "Params cannot be zero address");

        // Determine mode: cap-based if maxSupply > 0, legacy otherwise
        bool isCapBased = _maxSupply > 0;

        if (isCapBased) {
            require(
                _modelSupplierAllocation + _investorAllocation == _maxSupply,
                "Max supply must equal supplier + investor allocations"
            );
            require(_modelSupplierRecipient != address(0), "Model supplier recipient cannot be zero address");
        } else {
            require(_initialSupply > 0, "Initial supply must be greater than zero");
            require(_investorAllocation == 0, "Investor allocation only valid for cap-based tokens");
        }

        controller = _controller;
        params = IHokusaiParams(_params);

        // Initialize immutables (must be assigned unconditionally)
        maxSupply = isCapBased ? _maxSupply : type(uint256).max;
        modelSupplierAllocation = isCapBased ? _modelSupplierAllocation : 0;
        investorAllocation = isCapBased ? _investorAllocation : 0;
        modelSupplierRecipient = isCapBased ? _modelSupplierRecipient : address(0);
        modelSupplierDistributed = !isCapBased; // True for legacy, false for cap-based

        // Mint initial supply for legacy mode
        if (!isCapBased) {
            _mint(_controller, _initialSupply);
            emit Minted(_controller, _initialSupply);
        }

        emit TokenSupplyConfigured(_initialSupply, maxSupply, modelSupplierAllocation, modelSupplierRecipient);
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

    /**
     * @dev Mints tokens to a specified address
     * @param to The address to mint tokens to
     * @param amount The amount of tokens to mint
     */
    function mint(address to, uint256 amount) external onlyController {
        require(maxSupply == type(uint256).max, "Use mintInvestor or mintReward on cap-based tokens");
        _mint(to, amount);
        emit Minted(to, amount);
    }

    function mintInvestor(address to, uint256 amount) external onlyController {
        if (maxSupply < type(uint256).max) {
            require(investorMinted + amount <= investorAllocation, "Exceeds investor allocation");
            investorMinted += amount;
        }

        _mint(to, amount);
        emit Minted(to, amount);
    }

    function mintReward(address to, uint256 amount) external onlyController {
        if (maxSupply < type(uint256).max) {
            uint256 rewardCap = getRewardMintingCap();
            require(rewardMinted + amount <= rewardCap, "Exceeds reward mint cap");
            rewardMinted += amount;
        }

        _mint(to, amount);
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

    function burnInvestor(address from, uint256 amount) external onlyController {
        if (maxSupply < type(uint256).max) {
            require(amount <= investorMinted, "Burn exceeds investor minted");
            investorMinted -= amount;
        }

        _burn(from, amount);
        emit Burned(from, amount);
    }

    /**
     * @dev Returns the remaining investor allocation for cap-based tokens.
     */
    function getRemainingSupply() external view returns (uint256) {
        if (maxSupply >= type(uint256).max) {
            return type(uint256).max; // Legacy tokens have unlimited supply
        }

        if (investorMinted >= investorAllocation) {
            return 0;
        }

        return investorAllocation - investorMinted;
    }

    function getRemainingInvestorAllocation() external view returns (uint256) {
        if (maxSupply >= type(uint256).max) {
            return type(uint256).max;
        }

        if (investorMinted >= investorAllocation) {
            return 0;
        }

        return investorAllocation - investorMinted;
    }

    function getRewardMintingCap() public view returns (uint256) {
        if (maxSupply >= type(uint256).max) {
            return type(uint256).max;
        }

        return REWARD_CAP_MULTIPLIER * params.tokensPerDeltaOne();
    }

    function getRemainingRewardAllocation() external view returns (uint256) {
        uint256 rewardCap = getRewardMintingCap();
        if (rewardCap == type(uint256).max) {
            return type(uint256).max;
        }

        if (rewardMinted >= rewardCap) {
            return 0;
        }

        return rewardCap - rewardMinted;
    }
}
