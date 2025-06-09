// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "./ModelRegistry.sol";
import "./HokusaiToken.sol";

contract TokenManager {
    ModelRegistry public registry;

    constructor(address registryAddress) {
        registry = ModelRegistry(registryAddress);
    }

    function mintTokens(bytes32 modelId, address recipient, uint256 amount) external {
        address tokenAddress = registry.getToken(modelId);
        HokusaiToken(tokenAddress).mint(recipient, amount);
    }
}
