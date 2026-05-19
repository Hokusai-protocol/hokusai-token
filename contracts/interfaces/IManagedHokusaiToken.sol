// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "./IHokusaiParams.sol";

interface IManagedHokusaiToken {
    function mint(address to, uint256 amount) external;

    function mintInvestor(address to, uint256 amount) external;

    function mintReward(address to, uint256 amount) external;

    function burnFrom(address from, uint256 amount) external;

    function burnInvestor(address from, uint256 amount) external;

    function distributeModelSupplierAllocation() external;

    function modelSupplierRecipient() external view returns (address);

    function modelSupplierAllocation() external view returns (uint256);

    function investorAllocation() external view returns (uint256);

    function investorMinted() external view returns (uint256);

    function rewardMinted() external view returns (uint256);

    function maxSupply() external view returns (uint256);

    function getRewardMintingCap() external view returns (uint256);

    function params() external view returns (IHokusaiParams);
}
