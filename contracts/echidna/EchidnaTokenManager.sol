// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../HokusaiToken.sol";
import "../HokusaiParams.sol";
import "../ModelRegistry.sol";
import "../TokenManager.sol";
import "../interfaces/IHokusaiParams.sol";

contract EchidnaUnauthorizedManagerCaller {
    function tryMint(TokenManager manager, string memory modelId, address recipient, uint256 amount)
        external
        returns (bool)
    {
        try manager.mintTokens(modelId, recipient, amount) {
            return true;
        } catch {
            return false;
        }
    }
}

contract EchidnaTokenManager {
    string private constant MODEL_A = "echidna-model-a";
    string private constant MODEL_B = "echidna-model-b";
    uint256 private constant SUPPLIER_ALLOCATION = 1_000 ether;
    uint256 private constant INVESTOR_ALLOCATION = 10_000 ether;
    uint256 private constant MAX_MINT = 250 ether;
    address private constant USER_A = address(0x2001);
    address private constant USER_B = address(0x2002);

    ModelRegistry public registry;
    TokenManager public manager;
    HokusaiToken public tokenA;
    HokusaiToken public tokenB;
    EchidnaUnauthorizedManagerCaller private unauthorizedCaller;

    address private expectedTokenA;
    address private expectedTokenB;
    uint256 private trackedNetSupplyA;
    bool private unauthorizedMintSucceeded;

    constructor() {
        registry = new ModelRegistry();
        manager = new TokenManager(address(registry));
        unauthorizedCaller = new EchidnaUnauthorizedManagerCaller();

        _deployModel(MODEL_A, USER_A);
        tokenA = HokusaiToken(manager.getTokenAddress(MODEL_A));
        expectedTokenA = address(tokenA);
    }

    function deployModelB() external {
        if (expectedTokenB != address(0)) {
            return;
        }

        _deployModel(MODEL_B, USER_B);
        tokenB = HokusaiToken(manager.getTokenAddress(MODEL_B));
        expectedTokenB = address(tokenB);
    }

    function mintModelA(address recipient, uint256 amount) external {
        address to = recipient == address(0) ? USER_A : recipient;
        uint256 remaining = tokenA.investorAllocation() - tokenA.investorMinted();
        uint256 bounded = _bound(amount, remaining < MAX_MINT ? remaining : MAX_MINT);
        if (bounded == 0) {
            return;
        }

        try manager.mintTokens(MODEL_A, to, bounded) {
            trackedNetSupplyA += bounded;
        } catch {}
    }

    function burnModelAUserA(uint256 amount) external {
        uint256 available = tokenA.balanceOf(USER_A);
        uint256 bounded = _bound(amount, available);
        if (bounded == 0) {
            return;
        }

        try manager.burnAMMTokens(MODEL_A, USER_A, bounded) {
            trackedNetSupplyA -= bounded;
        } catch {}
    }

    function burnModelAUserB(uint256 amount) external {
        uint256 available = tokenA.balanceOf(USER_B);
        uint256 bounded = _bound(amount, available);
        if (bounded == 0) {
            return;
        }

        try manager.burnAMMTokens(MODEL_A, USER_B, bounded) {
            trackedNetSupplyA -= bounded;
        } catch {}
    }

    function attemptUnauthorizedMint(uint256 amount) external {
        uint256 bounded = _bound(amount, MAX_MINT);
        if (bounded == 0) {
            return;
        }

        if (unauthorizedCaller.tryMint(manager, MODEL_A, USER_A, bounded)) {
            unauthorizedMintSucceeded = true;
        }
    }

    function echidna_model_mapping_immutable() external view returns (bool) {
        bool okA = expectedTokenA == address(0) || manager.modelTokens(MODEL_A) == expectedTokenA;
        bool okB = expectedTokenB == address(0) || manager.modelTokens(MODEL_B) == expectedTokenB;
        return okA && okB;
    }

    function echidna_no_unauthorized_mint() external view returns (bool) {
        return !unauthorizedMintSucceeded;
    }

    function echidna_allocation_accounting() external view returns (bool) {
        return tokenA.investorMinted() <= tokenA.investorAllocation();
    }

    function echidna_burn_requires_balance() external view returns (bool) {
        return tokenA.totalSupply() == trackedNetSupplyA;
    }

    function _deployModel(string memory modelId, address supplierRecipient) internal {
        IHokusaiParams.VestingConfig memory vestingConfig = IHokusaiParams.VestingConfig({
            enabled: false,
            immediateUnlockBps: 10_000,
            vestingDurationSeconds: 0,
            cliffSeconds: 0
        });
        TokenManager.InitialParams memory initialParams = TokenManager.InitialParams({
            tokensPerDeltaOne: 100 ether,
            infrastructureAccrualBps: 1_000,
            initialOraclePricePerThousandUsd: 0,
            licenseHash: bytes32(0),
            licenseURI: "",
            governor: address(this),
            vestingConfig: vestingConfig
        });

        manager.deployTokenWithAllocations(
            modelId,
            "Echidna Managed Token",
            "EMT",
            SUPPLIER_ALLOCATION,
            supplierRecipient,
            INVESTOR_ALLOCATION,
            initialParams
        );
    }

    function _bound(uint256 value, uint256 maxValue) internal pure returns (uint256) {
        if (maxValue == 0) {
            return 0;
        }
        return (value % maxValue) + 1;
    }
}
