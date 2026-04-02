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

    /// @dev Maximum supply cap (modelSupplierAllocation + investorAllocation)
    uint256 public immutable maxSupply;

    /// @dev Model supplier allocation amount (not minted until distributeModelSupplierAllocation is called)
    uint256 public immutable modelSupplierAllocation;

    /// @dev Address to receive model supplier allocation
    address public immutable modelSupplierRecipient;

    /// @dev Flag indicating if model supplier allocation has been distributed
    bool public modelSupplierDistributed;

    event ControllerUpdated(address indexed newController);
    event Minted(address indexed to, uint256 amount);
    event Burned(address indexed from, uint256 amount);
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
        address _modelSupplierRecipient
    ) ERC20(_name, _symbol) Ownable() {
        require(bytes(_name).length > 0, "Token name cannot be empty");
        require(bytes(_symbol).length > 0, "Token symbol cannot be empty");
        require(_controller != address(0), "Controller cannot be zero address");
        require(_params != address(0), "Params cannot be zero address");

        // Determine mode: cap-based if maxSupply > 0, legacy otherwise
        bool isCapBased = _maxSupply > 0;

        if (isCapBased) {
            require(_modelSupplierAllocation <= _maxSupply, "Model supplier allocation exceeds max supply");
            require(_modelSupplierRecipient != address(0), "Model supplier recipient cannot be zero address");
        } else {
            require(_initialSupply > 0, "Initial supply must be greater than zero");
        }

        controller = _controller;
        params = IHokusaiParams(_params);

        // Initialize immutables (must be assigned unconditionally)
        maxSupply = isCapBased ? _maxSupply : type(uint256).max;
        modelSupplierAllocation = isCapBased ? _modelSupplierAllocation : 0;
        modelSupplierRecipient = isCapBased ? _modelSupplierRecipient : address(0);
        modelSupplierDistributed = !isCapBased; // True for legacy, false for cap-based

        // Mint initial supply for legacy mode
        if (!isCapBased) {
            _mint(_controller, _initialSupply);
            emit Minted(_controller, _initialSupply);
        }

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
        // Enforce max supply cap (only for cap-based tokens)
        if (maxSupply < type(uint256).max) {
            require(totalSupply() + amount <= maxSupply, "Minting would exceed max supply");
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

    /**
     * @dev Returns the remaining mintable supply (for cap-based tokens)
     * @return The amount of tokens that can still be minted
     */
    function getRemainingSupply() external view returns (uint256) {
        if (maxSupply >= type(uint256).max) {
            return type(uint256).max; // Legacy tokens have unlimited supply
        }

        uint256 currentSupply = totalSupply();
        if (currentSupply >= maxSupply) {
            return 0;
        }

        return maxSupply - currentSupply;
    }
}