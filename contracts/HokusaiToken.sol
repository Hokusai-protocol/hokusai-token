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

    event ControllerUpdated(address indexed newController);
    event Minted(address indexed to, uint256 amount);
    event Burned(address indexed from, uint256 amount);

    modifier onlyController() {
        require(msg.sender == controller, "Only controller can call this function");
        _;
    }

    /**
     * @dev Constructor to initialize the token with custom name, symbol, controller, params, and initial supply
     * @param _name The name of the token (e.g., "Hokusai Model Token")
     * @param _symbol The symbol of the token (e.g., "HMT")
     * @param _controller The address that will have mint/burn privileges
     * @param _params The address of the parameter contract for this token
     * @param _initialSupply The initial supply to mint to the controller
     */
    constructor(
        string memory _name,
        string memory _symbol,
        address _controller,
        address _params,
        uint256 _initialSupply
    ) ERC20(_name, _symbol) Ownable() {
        require(bytes(_name).length > 0, "Token name cannot be empty");
        require(bytes(_symbol).length > 0, "Token symbol cannot be empty");
        require(_controller != address(0), "Controller cannot be zero address");
        require(_params != address(0), "Params cannot be zero address");
        require(_initialSupply > 0, "Initial supply must be greater than zero");

        controller = _controller;
        params = IHokusaiParams(_params);

        // Mint initial supply to the controller
        _mint(_controller, _initialSupply);

        emit ControllerUpdated(_controller);
        emit Minted(_controller, _initialSupply);
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
        _mint(to, amount);
        emit Minted(to, amount);
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
}