// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/access/AccessControl.sol";

/**
 * @title AccessControlBase
 * @dev Base contract for standardized role-based access control setup
 *
 * Reduces boilerplate in contracts using AccessControl by providing:
 * - Automatic DEFAULT_ADMIN_ROLE setup in constructor
 * - Batch role granting utilities
 * - Consistent role management patterns
 *
 * Benefits:
 * - DRY: Eliminates duplicate role setup code across contracts
 * - Standardization: All contracts follow same initialization pattern
 * - Maintainability: Updates to role management apply to all derived contracts
 *
 * Usage:
 *   contract MyContract is AccessControlBase {
 *       bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
 *
 *       constructor(address admin) AccessControlBase(admin) {
 *           _grantRole(MINTER_ROLE, admin);
 *       }
 *   }
 */
abstract contract AccessControlBase is AccessControl {
    // ============================================================
    // CONSTRUCTOR
    // ============================================================

    /**
     * @dev Constructor grants DEFAULT_ADMIN_ROLE to specified admin
     * @param admin Address to receive admin role (typically msg.sender or owner)
     *
     * Reverts if admin is zero address to prevent deploying with no admin
     */
    constructor(address admin) {
        require(admin != address(0), "AccessControlBase: admin cannot be zero");
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    // ============================================================
    // BATCH ROLE MANAGEMENT
    // ============================================================

    /**
     * @dev Grant multiple roles to a single account
     * @param roles Array of role identifiers (bytes32)
     * @param account Address to grant all roles
     *
     * Useful for initializing contracts where one address needs multiple roles
     *
     * Example:
     *   bytes32[] memory roles = new bytes32[](2);
     *   roles[0] = MINTER_ROLE;
     *   roles[1] = BURNER_ROLE;
     *   _grantRoles(roles, msg.sender);
     */
    function _grantRoles(bytes32[] memory roles, address account) internal {
        for (uint256 i = 0; i < roles.length; i++) {
            _grantRole(roles[i], account);
        }
    }

    /**
     * @dev Revoke multiple roles from a single account
     * @param roles Array of role identifiers
     * @param account Address to revoke roles from
     *
     * Example:
     *   bytes32[] memory roles = new bytes32[](2);
     *   roles[0] = MINTER_ROLE;
     *   roles[1] = BURNER_ROLE;
     *   _revokeRoles(roles, oldAddress);
     */
    function _revokeRoles(bytes32[] memory roles, address account) internal {
        for (uint256 i = 0; i < roles.length; i++) {
            _revokeRole(roles[i], account);
        }
    }

    /**
     * @dev Grant a role to multiple accounts
     * @param role Role identifier to grant
     * @param accounts Array of addresses to receive the role
     *
     * Example:
     *   address[] memory minters = new address[](3);
     *   minters[0] = address1;
     *   minters[1] = address2;
     *   minters[2] = address3;
     *   _grantRoleToMany(MINTER_ROLE, minters);
     */
    function _grantRoleToMany(bytes32 role, address[] memory accounts) internal {
        for (uint256 i = 0; i < accounts.length; i++) {
            _grantRole(role, accounts[i]);
        }
    }

    /**
     * @dev Revoke a role from multiple accounts
     * @param role Role identifier to revoke
     * @param accounts Array of addresses to revoke from
     *
     * Example:
     *   address[] memory oldMinters = new address[](2);
     *   oldMinters[0] = address1;
     *   oldMinters[1] = address2;
     *   _revokeRoleFromMany(MINTER_ROLE, oldMinters);
     */
    function _revokeRoleFromMany(bytes32 role, address[] memory accounts) internal {
        for (uint256 i = 0; i < accounts.length; i++) {
            _revokeRole(role, accounts[i]);
        }
    }
}
