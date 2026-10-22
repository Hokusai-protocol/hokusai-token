// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";
import "./HokusaiPoolProxyAdmin.sol";
import "./HokusaiAMM.sol";
import "./libraries/ValidationLib.sol";

/**
 * @dev Deploys each pool as a TransparentUpgradeableProxy whose initializer
 * runs in the proxy constructor, so there is no uninitialized window. The
 * factory chooses the implementation per call (its timelocked
 * `poolImplementation`); `defaultImplementation` is deployed here only because
 * the factory cannot hold HokusaiAMM initcode under the size limit. All pool
 * proxies are administered by one HokusaiPoolProxyAdmin, owned by
 * `proxyAdminOwner` (the deployer at bootstrap, handed to the governance
 * timelock by scripts/governance/transfer-governance.js).
 */
contract HokusaiAMMPoolDeployer {
    address public immutable factory;
    address public immutable defaultImplementation;
    HokusaiPoolProxyAdmin public immutable proxyAdmin;

    event PoolDeployed(address indexed pool);

    modifier onlyFactory() {
        require(msg.sender == factory, "OnlyFactory");
        _;
    }

    constructor(address _factory, address proxyAdminOwner) {
        ValidationLib.requireNonZeroAddress(_factory, "factory");
        ValidationLib.requireNonZeroAddress(proxyAdminOwner, "proxy admin owner");
        factory = _factory;
        defaultImplementation = address(new HokusaiAMM());
        proxyAdmin = new HokusaiPoolProxyAdmin(proxyAdminOwner);
    }

    function deployPool(
        address implementation,
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
