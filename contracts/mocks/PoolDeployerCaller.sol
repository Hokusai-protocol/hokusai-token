// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "../interfaces/IHokusaiAMMPoolDeployer.sol";

contract PoolDeployerCaller {
    function callDeployPool(
        address poolDeployer,
        address reserveToken,
        address tokenAddress,
        address payable tokenManager,
        string memory modelId,
        address treasury,
        uint256 crr,
        uint256 tradeFee,
        uint256 ibrDuration,
        uint256 flatCurveThreshold,
        uint256 flatCurvePrice
    ) external returns (address) {
        IHokusaiAMMPoolDeployer deployer = IHokusaiAMMPoolDeployer(poolDeployer);
        return deployer.deployPool(
            deployer.defaultImplementation(),
            reserveToken,
            tokenAddress,
            tokenManager,
            modelId,
            treasury,
            crr,
            tradeFee,
            ibrDuration,
            flatCurveThreshold,
            flatCurvePrice
        );
    }
}
