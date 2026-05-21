// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract ReentrantFeeRecipient {
    address public target;
    bytes public reentryData;
    bool public reentryBlocked;
    bool private attempted;

    function configure(address _target, bytes calldata _reentryData) external {
        target = _target;
        reentryData = _reentryData;
        reentryBlocked = false;
        attempted = false;
    }

    receive() external payable {
        if (attempted || target == address(0) || reentryData.length == 0) {
            return;
        }

        attempted = true;

        (bool ok, bytes memory returndata) = target.call{value: msg.value}(reentryData);
        require(!ok, "Reentry unexpectedly succeeded");

        reentryBlocked = _isExpectedRevert(returndata);
        require(reentryBlocked, "Unexpected reentry failure");
    }

    function _isExpectedRevert(bytes memory returndata) private pure returns (bool) {
        if (returndata.length < 68) {
            return false;
        }

        bytes4 selector;
        assembly {
            selector := mload(add(returndata, 0x20))
        }

        if (selector != 0x08c379a0) {
            return false;
        }

        assembly {
            returndata := add(returndata, 0x04)
        }

        string memory reason = abi.decode(returndata, (string));
        return keccak256(bytes(reason)) == keccak256(bytes("ReentrancyGuard: reentrant call"));
    }
}
