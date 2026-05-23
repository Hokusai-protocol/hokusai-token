// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "./HokusaiAMM.sol";
import "./libraries/ValidationLib.sol";

contract HokusaiAMMPoolDeployer {
    address public immutable factory;

    event PoolDeployed(address indexed pool);

    modifier onlyFactory() {
        require(msg.sender == factory, "OnlyFactory");
        _;
    }

    constructor(address _factory) {
        ValidationLib.requireNonZeroAddress(_factory, "factory");
        factory = _factory;
    }

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
    ) external onlyFactory returns (address pool) {
        HokusaiAMM newPool = new HokusaiAMM(
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
        pool = address(newPool);
        newPool.transferOwnership(factory);
        emit PoolDeployed(pool);
    }
}
