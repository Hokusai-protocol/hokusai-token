// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract ModelRegistry {
    mapping(bytes32 => address) public modelToToken;

    function registerModel(bytes32 modelId, address token) external {
        modelToToken[modelId] = token;
    }

    function getToken(bytes32 modelId) external view returns (address) {
        return modelToToken[modelId];
    }
}
