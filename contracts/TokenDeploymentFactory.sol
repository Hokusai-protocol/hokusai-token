// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "./HokusaiParams.sol";
import "./HokusaiToken.sol";
import "./interfaces/ITokenDeploymentFactory.sol";
import "./libraries/ValidationLib.sol";

contract TokenDeploymentFactory is ITokenDeploymentFactory {
    event TokenAndParamsDeployed(
        address indexed tokenAddress,
        address indexed paramsAddress,
        address indexed controller
    );

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
    ) external returns (address tokenAddress, address paramsAddress) {
        ValidationLib.requireNonZeroAddress(controller, "controller");

        HokusaiParams newParams = new HokusaiParams(
            initialParams.tokensPerDeltaOne,
            initialParams.infrastructureAccrualBps,
            initialParams.initialOraclePricePerThousandUsd,
            initialParams.licenseHash,
            initialParams.licenseURI,
            initialParams.governor,
            initialParams.vestingConfig
        );
        paramsAddress = address(newParams);

        HokusaiToken newToken = new HokusaiToken(
            name,
            symbol,
            controller,
            paramsAddress,
            initialSupply,
            maxSupply,
            modelSupplierAllocation,
            investorAllocation,
            modelSupplierRecipient
        );
        tokenAddress = address(newToken);

        emit TokenAndParamsDeployed(tokenAddress, paramsAddress, controller);
    }
}
