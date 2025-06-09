// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

contract HokusaiToken is ERC20, Ownable {
    address public controller;

    event Minted(address indexed to, uint256 amount);
    event Burned(address indexed from, uint256 amount);

    constructor(string memory name, string memory symbol) ERC20(name, symbol) {}

    modifier onlyController() {
        require(msg.sender == controller, "Not controller");
        _;
    }

    function setController(address _controller) external onlyOwner {
        controller = _controller;
    }

    function mint(address to, uint256 amount) external onlyController {
        _mint(to, amount);
        emit Minted(to, amount);
    }

    function burn(uint256 amount) external onlyController {
        _burn(msg.sender, amount);
        emit Burned(msg.sender, amount);
    }
}
