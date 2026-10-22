// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "../HokusaiAMM.sol";

/// @dev Test-only implementation whose pause state cannot be read, for checking
/// that HokusaiPoolProxyAdmin can still replace it.
/// @custom:oz-upgrades-from HokusaiAMM
/// @custom:oz-upgrades-unsafe-allow missing-initializer
contract HokusaiAMMBrokenStateMock is HokusaiAMM {
    function paused() public pure override returns (bool) {
        revert("paused() unavailable");
    }
}
