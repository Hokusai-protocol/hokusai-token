// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/access/Ownable.sol";
import "./HokusaiToken.sol";

/**
 * @title AuctionBurner
 * @dev Contract for burning tokens to simulate model access consumption
 * This contract provides a clean interface for users to burn their tokens
 * in exchange for API/model access rights
 */
contract AuctionBurner is Ownable {
    HokusaiToken public token;

    event TokensBurned(address indexed user, uint256 amount);
    event TokenContractUpdated(address indexed newToken);

    /**
     * @dev Constructor sets the token contract reference
     * @param _token Address of the HokusaiToken contract
     */
    constructor(address _token) Ownable() {
        require(_token != address(0), "Token address cannot be zero");
        token = HokusaiToken(_token);
    }

    /**
     * @dev Updates the token contract reference (admin only)
     * @param _token New token contract address
     */
    function setToken(address _token) external onlyOwner {
        require(_token != address(0), "Token address cannot be zero");
        token = HokusaiToken(_token);
        emit TokenContractUpdated(_token);
    }

    /**
     * @dev Burns tokens from the caller's balance
     * @param amount Amount of tokens to burn
     * 
     * Requirements:
     * - amount must be greater than zero
     * - caller must have sufficient token balance
     * - caller must have approved this contract to spend their tokens
     */
    function burn(uint256 amount) external {
        require(amount > 0, "Amount must be greater than zero");
        
        // Use transferFrom to get allowance, then let user burn directly
        // This ensures the Burned event shows the correct user address
        token.transferFrom(msg.sender, address(this), amount);
        
        // Transfer back to user and let them burn (preserves user in event)
        // Actually, let's transfer to ourselves and use the internal burn
        // But emit our own event to track who initiated the burn
        token.burn(amount);
        
        emit TokensBurned(msg.sender, amount);
    }
}