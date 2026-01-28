// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "../libraries/AccessControlBase.sol";

/**
 * @title AccessControlBaseTestHarness
 * @dev Test harness contract for AccessControlBase
 */
contract AccessControlBaseTestHarness is AccessControlBase {
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    bytes32 public constant BURNER_ROLE = keccak256("BURNER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    constructor(address admin) AccessControlBase(admin) {}

    function testGrantRoles(bytes32[] memory roles, address account) external {
        _grantRoles(roles, account);
    }

    function testRevokeRoles(bytes32[] memory roles, address account) external {
        _revokeRoles(roles, account);
    }

    function testGrantRoleToMany(bytes32 role, address[] memory accounts) external {
        _grantRoleToMany(role, accounts);
    }

    function testRevokeRoleFromMany(bytes32 role, address[] memory accounts) external {
        _revokeRoleFromMany(role, accounts);
    }
}
