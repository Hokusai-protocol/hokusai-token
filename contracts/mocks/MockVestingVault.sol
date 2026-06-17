// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @dev Minimal stand-in for RewardVestingVault used to test PendingClaimsEscrow.claimVested.
 * Transfers a preconfigured claimable amount for a scheduleId to msg.sender (the beneficiary),
 * matching the real vault's `claim(uint256) returns (uint256)` selector.
 */
contract MockVestingVault {
    IERC20 public immutable token;
    mapping(uint256 => uint256) public claimableOf;

    constructor(address _token) {
        token = IERC20(_token);
    }

    function setClaimable(uint256 scheduleId, uint256 amount) external {
        claimableOf[scheduleId] = amount;
    }

    function claim(uint256 scheduleId) external returns (uint256 claimedAmount) {
        claimedAmount = claimableOf[scheduleId];
        claimableOf[scheduleId] = 0;
        if (claimedAmount > 0) {
            require(token.transfer(msg.sender, claimedAmount), "transfer failed");
        }
        return claimedAmount;
    }
}
