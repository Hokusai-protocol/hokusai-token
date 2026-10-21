// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "../HokusaiAMM.sol";

/// @dev Test-only V2 with a layout-compatible appended field, for upgrade tests.
/// The proxy is already initialized, so V2 only adds a reinitializer and must
/// not re-run the parent initializers.
/// @custom:oz-upgrades-from HokusaiAMM
/// @custom:oz-upgrades-unsafe-allow missing-initializer
contract HokusaiAMMV2Mock is HokusaiAMM {
    uint256 public v2Marker;

    function initializeV2(uint256 marker) external reinitializer(2) onlyOwner {
        v2Marker = marker;
    }

    function version() external pure returns (string memory) {
        return "v2";
    }

    function setV2Marker(uint256 value) external onlyOwner {
        v2Marker = value;
    }
}
