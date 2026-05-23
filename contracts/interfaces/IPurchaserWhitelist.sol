// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

interface IPurchaserWhitelist {
    event WalletWhitelisted(address indexed wallet);
    event WalletRemovedFromWhitelist(address indexed wallet);

    function isWhitelisted(address account) external view returns (bool);
}
