// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

interface IPurchaserWhitelist {
    function isWhitelisted(address account) external view returns (bool);
}
