// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";
import "@openzeppelin/contracts/proxy/transparent/ProxyAdmin.sol";
import "./HokusaiAMM.sol";
import "./libraries/ValidationLib.sol";

/**
 * @dev Deploys each pool as a TransparentUpgradeableProxy over one shared
 * HokusaiAMM implementation. All pool proxies are administered by a single
 * ProxyAdmin owned by the factory; the factory exposes no upgrade calls, so
 * upgrade authority stays unreachable until it is wired to governance
 * (HOK-3283 / HOK-3285).
 */
contract HokusaiAMMPoolDeployer {
    address public immutable factory;
    address public immutable implementation;
    ProxyAdmin public immutable proxyAdmin;

    event PoolDeployed(address indexed pool);

    modifier onlyFactory() {
        require(msg.sender == factory, "OnlyFactory");
        _;
    }

    constructor(address _factory) {
        ValidationLib.requireNonZeroAddress(_factory, "factory");
        factory = _factory;
        implementation = address(new HokusaiAMM());
        ProxyAdmin admin = new ProxyAdmin();
        admin.transferOwnership(_factory);
        proxyAdmin = admin;
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
        bytes memory initData = abi.encodeCall(
            HokusaiAMM.initialize,
            (
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
            )
        );
        // initialize runs inside the proxy constructor, so this contract is
        // the initial owner and hands ownership to the factory, as before.
        pool = address(new TransparentUpgradeableProxy(implementation, address(proxyAdmin), initData));
        HokusaiAMM(pool).transferOwnership(factory);
        emit PoolDeployed(pool);
    }
}
