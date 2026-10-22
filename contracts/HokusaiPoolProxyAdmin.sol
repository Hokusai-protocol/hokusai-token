// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/proxy/transparent/ProxyAdmin.sol";
import "@openzeppelin/contracts-upgradeable/security/PausableUpgradeable.sol";

/**
 * @dev Reads a pool's pause state on behalf of HokusaiPoolProxyAdmin. A
 * transparent proxy never forwards calls from its admin, so the admin cannot
 * call `paused()` on the pool itself; this separate contract can.
 */
contract PoolPauseReader {
    function isPaused(address pool) external view returns (bool) {
        return PausableUpgradeable(pool).paused();
    }
}

/**
 * @title HokusaiPoolProxyAdmin
 * @dev ProxyAdmin for HokusaiAMM pool proxies, owned by the governance
 * timelock (48h on mainnet). Adds two guarantees on top of OZ ProxyAdmin:
 *
 * - Exit-safe pause: a pool cannot be upgraded while it is paused, so pause
 *   cannot be combined with an upgrade to keep holders from exiting under
 *   the implementation they agreed to. (Governance can still batch an
 *   unpause with an upgrade; see docs/architecture/upgradeable-amm-trust-model.md.)
 * - Per-pool freeze: `freezeUpgrades` permanently disables upgrades for one
 *   pool. It is one-way and, being owner-only, timelocked.
 *
 * Moving a proxy to another admin is disabled, since that would bypass both.
 */
contract HokusaiPoolProxyAdmin is ProxyAdmin {
    PoolPauseReader public immutable pauseReader;

    mapping(address => bool) public upgradesFrozen;

    event UpgradesFrozen(address indexed proxy);

    constructor(address initialOwner) {
        require(initialOwner != address(0), "Owner cannot be zero");
        pauseReader = new PoolPauseReader();
        _transferOwnership(initialOwner);
    }

    /**
     * @dev Permanently disable upgrades for `proxy`. Irreversible.
     */
    function freezeUpgrades(ITransparentUpgradeableProxy proxy) external onlyOwner {
        require(getProxyAdmin(proxy) == address(this), "Not administered here");
        require(!upgradesFrozen[address(proxy)], "Upgrades already frozen");
        upgradesFrozen[address(proxy)] = true;
        emit UpgradesFrozen(address(proxy));
    }

    function upgrade(ITransparentUpgradeableProxy proxy, address implementation) public override onlyOwner {
        _requireUpgradeable(proxy);
        super.upgrade(proxy, implementation);
    }

    function upgradeAndCall(
        ITransparentUpgradeableProxy proxy,
        address implementation,
        bytes memory data
    ) public payable override onlyOwner {
        _requireUpgradeable(proxy);
        super.upgradeAndCall(proxy, implementation, data);
    }

    function changeProxyAdmin(ITransparentUpgradeableProxy, address) public pure override {
        revert("Proxy admin is fixed");
    }

    function _requireUpgradeable(ITransparentUpgradeableProxy proxy) private view {
        require(!upgradesFrozen[address(proxy)], "Upgrades frozen");
        require(!pauseReader.isPaused(address(proxy)), "Pool is paused");
    }
}
