// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

interface IHokusaiAMMPoolDeployer {
    function deployPool(
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
    ) external returns (address);
}
