// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title HokusaiToken
 * @dev ERC20 token with controller-based minting and burning
 */
contract HokusaiToken is ERC20, Ownable {
    address public controller;

    event ControllerUpdated(address indexed newController);
    event Minted(address indexed to, uint256 amount);
    event Burned(address indexed from, uint256 amount);

    modifier onlyController() {
        require(msg.sender == controller, "Only controller can call this function");
        _;
    }

    constructor() ERC20("Hokusai Token", "HOKU") Ownable(msg.sender) {}

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
     * @dev Burns tokens from a specified address
     * @param from The address to burn tokens from
     * @param amount The amount of tokens to burn
     */
    function burn(address from, uint256 amount) external onlyController {
        _burn(from, amount);
        emit Burned(from, amount);
    }
}