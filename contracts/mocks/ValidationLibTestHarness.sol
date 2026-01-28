// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "../libraries/ValidationLib.sol";

/**
 * @title ValidationLibTestHarness
 * @dev Test harness contract for ValidationLib since library functions can't be called directly
 */
contract ValidationLibTestHarness {
    function testRequireNonZeroAddress(address addr, string memory context) external pure {
        ValidationLib.requireNonZeroAddress(addr, context);
    }

    function testRequirePositiveAmount(uint256 amount, string memory context) external pure {
        ValidationLib.requirePositiveAmount(amount, context);
    }

    function testRequireNonEmptyString(string memory str, string memory context) external pure {
        ValidationLib.requireNonEmptyString(str, context);
    }

    function testRequireMatchingArrayLengths(uint256 length1, uint256 length2) external pure {
        ValidationLib.requireMatchingArrayLengths(length1, length2);
    }

    function testRequireNonEmptyArray(uint256 length) external pure {
        ValidationLib.requireNonEmptyArray(length);
    }

    function testRequireInBounds(uint256 value, uint256 min, uint256 max) external pure {
        ValidationLib.requireInBounds(value, min, max);
    }

    function testRequireMaxArrayLength(uint256 length, uint256 maxLength) external pure {
        ValidationLib.requireMaxArrayLength(length, maxLength);
    }

    function testRequireValidBatch(
        uint256 length1,
        uint256 length2,
        uint256 maxLength
    ) external pure {
        ValidationLib.requireValidBatch(length1, length2, maxLength);
    }
}
