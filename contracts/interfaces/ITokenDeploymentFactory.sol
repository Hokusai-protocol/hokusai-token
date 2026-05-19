// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "./IHokusaiParams.sol";

interface ITokenDeploymentFactory {
    struct InitialParams {
        uint256 tokensPerDeltaOne;
        uint16 infrastructureAccrualBps;
        uint256 initialOraclePricePerThousandUsd;
        bytes32 licenseHash;
        string licenseURI;
        address governor;
        IHokusaiParams.VestingConfig vestingConfig;
    }

    function deployTokenAndParams(
        string memory name,
        string memory symbol,
        address controller,
        uint256 initialSupply,
        uint256 maxSupply,
        uint256 modelSupplierAllocation,
        uint256 investorAllocation,
        address modelSupplierRecipient,
        InitialParams memory initialParams
    ) external returns (address tokenAddress, address paramsAddress);
}
