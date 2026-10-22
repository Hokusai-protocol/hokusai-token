// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/// @dev Test-only pool whose depositFees takes nothing, standing in for a
/// faulty upgraded pool implementation.
contract NonPullingPoolMock {
    function depositFees(uint256) external {}
}
