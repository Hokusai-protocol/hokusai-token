// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/access/Ownable.sol";
import "./interfaces/IPurchaserWhitelist.sol";

contract PurchaserWhitelist is Ownable, IPurchaserWhitelist {
    error ZeroAddress();
    error BatchTooLarge(uint256 length, uint256 max);

    uint256 public constant MAX_BATCH = 200;

    mapping(address => bool) private _whitelisted;

    event AddressWhitelisted(address indexed account);
    event AddressRemoved(address indexed account);

    function isWhitelisted(address account) external view returns (bool) {
        return _whitelisted[account];
    }

    function addToWhitelist(address account) external onlyOwner {
        if (account == address(0)) revert ZeroAddress();
        if (_whitelisted[account]) return;

        _whitelisted[account] = true;
        emit AddressWhitelisted(account);
    }

    function removeFromWhitelist(address account) external onlyOwner {
        if (!_whitelisted[account]) return;

        _whitelisted[account] = false;
        emit AddressRemoved(account);
    }

    function addBatch(address[] calldata accounts) external onlyOwner {
        uint256 length = accounts.length;
        if (length > MAX_BATCH) revert BatchTooLarge(length, MAX_BATCH);

        for (uint256 i = 0; i < length; ++i) {
            address account = accounts[i];
            if (account == address(0)) revert ZeroAddress();
            if (_whitelisted[account]) continue;

            _whitelisted[account] = true;
            emit AddressWhitelisted(account);
        }
    }

    function removeBatch(address[] calldata accounts) external onlyOwner {
        uint256 length = accounts.length;
        if (length > MAX_BATCH) revert BatchTooLarge(length, MAX_BATCH);

        for (uint256 i = 0; i < length; ++i) {
            address account = accounts[i];
            if (!_whitelisted[account]) continue;

            _whitelisted[account] = false;
            emit AddressRemoved(account);
        }
    }
}
