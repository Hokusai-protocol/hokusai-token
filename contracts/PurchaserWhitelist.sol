// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "./interfaces/IPurchaserWhitelist.sol";
import "./libraries/AccessControlBase.sol";

contract PurchaserWhitelist is AccessControlBase, IPurchaserWhitelist {
    error ZeroAddress();
    error BatchTooLarge(uint256 length, uint256 max);

    uint256 public constant MAX_BATCH = 200;
    bytes32 public constant WHITELIST_ADMIN_ROLE = keccak256("WHITELIST_ADMIN_ROLE");

    mapping(address => bool) private _whitelisted;

    event WalletWhitelisted(address indexed wallet);
    event WalletRemovedFromWhitelist(address indexed wallet);

    constructor(address admin) AccessControlBase(admin) {
        _grantRole(WHITELIST_ADMIN_ROLE, admin);
    }

    function isWhitelisted(address account) external view returns (bool) {
        return _whitelisted[account];
    }

    function addToWhitelist(address account) external onlyRole(WHITELIST_ADMIN_ROLE) {
        if (account == address(0)) revert ZeroAddress();
        if (_whitelisted[account]) return;

        _whitelisted[account] = true;
        emit WalletWhitelisted(account);
    }

    function removeFromWhitelist(address account) external onlyRole(WHITELIST_ADMIN_ROLE) {
        if (!_whitelisted[account]) return;

        _whitelisted[account] = false;
        emit WalletRemovedFromWhitelist(account);
    }

    function addBatch(address[] calldata accounts) external onlyRole(WHITELIST_ADMIN_ROLE) {
        uint256 length = accounts.length;
        if (length > MAX_BATCH) revert BatchTooLarge(length, MAX_BATCH);

        for (uint256 i = 0; i < length; ++i) {
            address account = accounts[i];
            if (account == address(0)) revert ZeroAddress();
            if (_whitelisted[account]) continue;

            _whitelisted[account] = true;
            emit WalletWhitelisted(account);
        }
    }

    function removeBatch(address[] calldata accounts) external onlyRole(WHITELIST_ADMIN_ROLE) {
        uint256 length = accounts.length;
        if (length > MAX_BATCH) revert BatchTooLarge(length, MAX_BATCH);

        for (uint256 i = 0; i < length; ++i) {
            address account = accounts[i];
            if (!_whitelisted[account]) continue;

            _whitelisted[account] = false;
            emit WalletRemovedFromWhitelist(account);
        }
    }
}
