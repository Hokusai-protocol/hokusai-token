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

    function tryBurnTokens(TokenManager manager, string memory modelId, address account, uint256 amount)
        external
        returns (bool)
    {
        try manager.burnTokens(modelId, account, amount) {
            return true;
        } catch {
            return false;
        }
    }

    function tryBurnInvestorTokens(TokenManager manager, string memory modelId, address account, uint256 amount)
        external
        returns (bool)
    {
        try manager.burnInvestorTokens(modelId, account, amount) {
            return true;
        } catch {
            return false;
        }
    }

    function tryBurnAMMTokens(TokenManager manager, string memory modelId, address account, uint256 amount)
        external
        returns (bool)
    {
        try manager.burnAMMTokens(modelId, account, amount) {
            return true;
        } catch {
            return false;
        }
    }

    function tryBatchMintTokens(
        TokenManager manager,
        string memory modelId,
        address[] memory recipients,
        uint256[] memory amounts
    ) external returns (bool) {
        try manager.batchMintTokens(modelId, recipients, amounts) {
            return true;
        } catch {
            return false;
        }
    }

    function tryBatchMintReward(
        TokenManager manager,
        string memory modelId,
        address[] memory recipients,
        uint256[] memory amounts
    ) external returns (bool) {
        try manager.batchMintReward(modelId, recipients, amounts) {
            return true;
        } catch {
            return false;
        }
    }
}

contract EchidnaAuthorizedManagerCaller {
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

    function tryBatchMintTokens(
        TokenManager manager,
        string memory modelId,
        address[] memory recipients,
        uint256[] memory amounts
    ) external returns (bool) {
        try manager.batchMintTokens(modelId, recipients, amounts) {
            return true;
        } catch {
            return false;
        }
    }

    function tryBurnAMMTokens(TokenManager manager, string memory modelId, address account, uint256 amount)
        external
        returns (bool)
    {
        try manager.burnAMMTokens(modelId, account, amount) {
            return true;
        } catch {
            return false;
        }
    }
}

/**
 * Harness bounds and assumptions:
 * - Models: 3 fixed IDs (A/B/C) to keep mapping-state exploration finite.
 * - Recipients: 5-address pool [this, USER_A, USER_B, USER_C, zero].
 * - Batch size: fixed at 4 entries per fuzz call, below manager max batch size.
 * - Amounts: bounded by remaining investor allocation to reduce cap-dominated reverts.
 * - Role fuzzing: separate helper contract toggles MINTER_ROLE without owner bypass.
 *
 * Acceptance mapping:
 * - mapping consistency -> echidna_model_mapping_consistent
 * - no remap -> echidna_no_model_remap
 * - unauthorized mint/batch/burn -> echidna_no_unauthorized_*
 * - batch sum accounting -> echidna_batch_sum_matches
 * - role boundaries -> echidna_role_boundary
 */
contract EchidnaTokenManager {
    struct Model {
        string modelId;
        address expectedToken;
        bool deployed;
    }

    uint256 private constant SUPPLIER_ALLOCATION = 1_000 ether;
    uint256 private constant INVESTOR_ALLOCATION = 10_000 ether;
    uint256 private constant MAX_MINT = 250 ether;
    uint256 private constant BATCH_SIZE = 4;

    address private constant USER_A = address(0x2001);
    address private constant USER_B = address(0x2002);
    address private constant USER_C = address(0x2003);

    ModelRegistry public registry;
    TokenManager public manager;
    HokusaiToken public tokenA;

    EchidnaUnauthorizedManagerCaller private unauthorizedCaller;
    EchidnaAuthorizedManagerCaller private roleHelper;

    Model[3] private models;
    address[5] private recipientPool;

    uint256 private trackedNetSupplyA;
    bool private remapSucceeded;
    bool private batchSumMismatch;

    bool private unauthorizedMintSucceeded;
    bool private unauthorizedBurnSucceeded;
    bool private unauthorizedBatchMintSucceeded;
    bool private unauthorizedBatchRewardSucceeded;

    bool private helperMinterRole;
    bool private helperUnauthorizedSucceeded;

    constructor() {
        registry = new ModelRegistry();
        manager = new TokenManager(address(registry));
        unauthorizedCaller = new EchidnaUnauthorizedManagerCaller();
        roleHelper = new EchidnaAuthorizedManagerCaller();

        models[0].modelId = "echidna-model-a";
        models[1].modelId = "echidna-model-b";
        models[2].modelId = "echidna-model-c";

        _deployModelSlot(0, USER_A);
        tokenA = HokusaiToken(models[0].expectedToken);

        recipientPool[0] = address(this);
        recipientPool[1] = USER_A;
        recipientPool[2] = USER_B;
        recipientPool[3] = USER_C;
        recipientPool[4] = address(0);
    }

    function deployModelSlot(uint8 slotRaw) external {
        uint256 slot = uint256(slotRaw) % models.length;
        if (models[slot].deployed) {
            return;
        }

        address supplierRecipient = slot == 1 ? USER_B : USER_C;
        _deployModelSlot(slot, supplierRecipient);
    }

    function attemptRedeploy(uint8 slotRaw) external {
        uint256 slot = uint256(slotRaw) % models.length;
        if (!models[slot].deployed) {
            return;
        }

        try this._attemptDeploy(models[slot].modelId, USER_A) {
            remapSucceeded = true;
        } catch {}
    }

    function mintModelA(address recipient, uint256 amount) external {
        address to = recipient == address(0) ? USER_A : recipient;
        uint256 bounded = _boundedMintAmount(amount);
        if (bounded == 0) {
            return;
        }

        try manager.mintTokens(models[0].modelId, to, bounded) {
            trackedNetSupplyA += bounded;
        } catch {}
    }

    function burnModelAUserA(uint256 amount) external {
        _burnModelA(USER_A, amount);
    }

    function burnModelAUserB(uint256 amount) external {
        _burnModelA(USER_B, amount);
    }

    function batchMintTokensModelA(
        uint8 r0,
        uint8 r1,
        uint8 r2,
        uint8 r3,
        uint96 a0,
        uint96 a1,
        uint96 a2,
        uint96 a3
    ) external {
        _batchMintModelA(false, r0, r1, r2, r3, a0, a1, a2, a3);
    }

    function batchMintRewardModelA(
        uint8 r0,
        uint8 r1,
        uint8 r2,
        uint8 r3,
        uint96 a0,
        uint96 a1,
        uint96 a2,
        uint96 a3
    ) external {
        _batchMintModelA(true, r0, r1, r2, r3, a0, a1, a2, a3);
    }

    function attemptUnauthorizedMint(uint256 amount) external {
        uint256 bounded = _bound(amount, MAX_MINT);
        if (bounded == 0) {
            return;
        }

        if (unauthorizedCaller.tryMint(manager, models[0].modelId, USER_A, bounded)) {
            unauthorizedMintSucceeded = true;
        }
    }

    function attemptUnauthorizedBurn(uint8 accountRaw, uint96 amount) external {
        address account = _poolRecipient(accountRaw);
        uint256 bounded = _bound(uint256(amount), tokenA.balanceOf(account));
        if (bounded == 0) {
            return;
        }

        if (unauthorizedCaller.tryBurnTokens(manager, models[0].modelId, account, bounded)) {
            unauthorizedBurnSucceeded = true;
        }
        if (unauthorizedCaller.tryBurnInvestorTokens(manager, models[0].modelId, account, bounded)) {
            unauthorizedBurnSucceeded = true;
        }
        if (unauthorizedCaller.tryBurnAMMTokens(manager, models[0].modelId, account, bounded)) {
            unauthorizedBurnSucceeded = true;
        }
    }

    function attemptUnauthorizedBatchMint(
        uint8 r0,
        uint8 r1,
        uint8 r2,
        uint8 r3,
        uint96 a0,
        uint96 a1,
        uint96 a2,
        uint96 a3
    ) external {
        (address[] memory recipients, uint256[] memory amounts) = _buildBatch(r0, r1, r2, r3, a0, a1, a2, a3);
        if (unauthorizedCaller.tryBatchMintTokens(manager, models[0].modelId, recipients, amounts)) {
            unauthorizedBatchMintSucceeded = true;
        }
        if (unauthorizedCaller.tryBatchMintReward(manager, models[0].modelId, recipients, amounts)) {
            unauthorizedBatchRewardSucceeded = true;
        }
    }

    function grantHelperMinter() external {
        manager.grantRole(manager.MINTER_ROLE(), address(roleHelper));
        helperMinterRole = true;
    }

    function revokeHelperMinter() external {
        manager.revokeRole(manager.MINTER_ROLE(), address(roleHelper));
        helperMinterRole = false;
    }

    function helperMint(uint8 r, uint96 amount) external {
        address recipient = _poolRecipient(r);
        if (recipient == address(0)) {
            recipient = USER_A;
        }
        uint256 bounded = _boundedMintAmount(uint256(amount));
        if (bounded == 0) {
            return;
        }

        bool ok = roleHelper.tryMint(manager, models[0].modelId, recipient, bounded);
        if (ok && !helperMinterRole) {
            helperUnauthorizedSucceeded = true;
        }
        if (ok && helperMinterRole) {
            trackedNetSupplyA += bounded;
        }
    }

    function helperBatchMint(
        uint8 r0,
        uint8 r1,
        uint8 r2,
        uint8 r3,
        uint96 a0,
        uint96 a1,
        uint96 a2,
        uint96 a3
    ) external {
        (address[] memory recipients, uint256[] memory amounts) = _buildBatch(r0, r1, r2, r3, a0, a1, a2, a3);
        uint256 sumExpected = _sumNonZeroNonZeroAddress(recipients, amounts);

        bool ok = roleHelper.tryBatchMintTokens(manager, models[0].modelId, recipients, amounts);
        if (ok && !helperMinterRole) {
            helperUnauthorizedSucceeded = true;
        }
        if (ok && helperMinterRole) {
            trackedNetSupplyA += sumExpected;
        }
    }

    function helperBurnAMM(uint8 r, uint96 amount) external {
        address account = _poolRecipient(r);
        uint256 bounded = _bound(uint256(amount), tokenA.balanceOf(account));
        if (bounded == 0) {
            return;
        }

        bool ok = roleHelper.tryBurnAMMTokens(manager, models[0].modelId, account, bounded);
        if (ok && !helperMinterRole) {
            helperUnauthorizedSucceeded = true;
        }
        if (ok && helperMinterRole) {
            trackedNetSupplyA -= bounded;
        }
    }

    function echidna_model_mapping_consistent() external view returns (bool) {
        for (uint256 i = 0; i < models.length; i++) {
            if (!models[i].deployed) {
                continue;
            }

            if (manager.modelTokens(models[i].modelId) != models[i].expectedToken) {
                return false;
            }

            if (keccak256(bytes(manager.tokenToModel(models[i].expectedToken))) != keccak256(bytes(models[i].modelId))) {
                return false;
            }
        }

        return true;
    }

    function echidna_model_mapping_immutable() external view returns (bool) {
        for (uint256 i = 0; i < models.length; i++) {
            if (!models[i].deployed) {
                continue;
            }
            if (manager.modelTokens(models[i].modelId) != models[i].expectedToken) {
                return false;
            }
        }
        return true;
    }

    function echidna_no_model_remap() external view returns (bool) {
        return !remapSucceeded;
    }

    function echidna_no_unauthorized_mint() external view returns (bool) {
        return !unauthorizedMintSucceeded;
    }

    function echidna_no_unauthorized_burn() external view returns (bool) {
        return !unauthorizedBurnSucceeded;
    }

    function echidna_no_unauthorized_batch_mint() external view returns (bool) {
        return !unauthorizedBatchMintSucceeded;
    }

    function echidna_no_unauthorized_batch_reward() external view returns (bool) {
        return !unauthorizedBatchRewardSucceeded;
    }

    function echidna_batch_sum_matches() external view returns (bool) {
        return !batchSumMismatch;
    }

    function echidna_role_boundary() external view returns (bool) {
        return !helperUnauthorizedSucceeded;
    }

    function echidna_allocation_accounting() external view returns (bool) {
        return tokenA.investorMinted() <= tokenA.investorAllocation();
    }

    function echidna_burn_requires_balance() external view returns (bool) {
        return tokenA.totalSupply() == trackedNetSupplyA;
    }

    function _deployModelSlot(uint256 slot, address supplierRecipient) internal {
        _deployModel(models[slot].modelId, supplierRecipient);
        models[slot].expectedToken = manager.getTokenAddress(models[slot].modelId);
        models[slot].deployed = true;
    }

    function _burnModelA(address account, uint256 amount) internal {
        uint256 available = tokenA.balanceOf(account);
        uint256 bounded = _bound(amount, available);
        if (bounded == 0) {
            return;
        }

        try manager.burnAMMTokens(models[0].modelId, account, bounded) {
            trackedNetSupplyA -= bounded;
        } catch {}
    }

    function _batchMintModelA(
        bool reward,
        uint8 r0,
        uint8 r1,
        uint8 r2,
        uint8 r3,
        uint96 a0,
        uint96 a1,
        uint96 a2,
        uint96 a3
    ) internal {
        (address[] memory recipients, uint256[] memory amounts) = _buildBatch(r0, r1, r2, r3, a0, a1, a2, a3);
        uint256 sumExpected = _sumNonZeroNonZeroAddress(recipients, amounts);

        uint256 beforeSupply = tokenA.totalSupply();
        bool success;
        if (reward) {
            try manager.batchMintReward(models[0].modelId, recipients, amounts) {
                success = true;
            } catch {}
        } else {
            try manager.batchMintTokens(models[0].modelId, recipients, amounts) {
                success = true;
            } catch {}
        }

        if (success) {
            uint256 delta = tokenA.totalSupply() - beforeSupply;
            if (delta != sumExpected) {
                batchSumMismatch = true;
            }
            trackedNetSupplyA += delta;
        }
    }

    function _attemptDeploy(string memory modelId, address supplierRecipient) external {
        require(msg.sender == address(this), "internal only");
        _deployModel(modelId, supplierRecipient);
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

    function _buildBatch(
        uint8 r0,
        uint8 r1,
        uint8 r2,
        uint8 r3,
        uint96 a0,
        uint96 a1,
        uint96 a2,
        uint96 a3
    ) internal view returns (address[] memory recipients, uint256[] memory amounts) {
        recipients = new address[](BATCH_SIZE);
        amounts = new uint256[](BATCH_SIZE);

        recipients[0] = _poolRecipient(r0);
        recipients[1] = _poolRecipient(r1);
        recipients[2] = _poolRecipient(r2);
        recipients[3] = _poolRecipient(r3);

        uint256 remaining = tokenA.investorAllocation() - tokenA.investorMinted();
        uint256 perSlotCap = remaining / BATCH_SIZE;
        amounts[0] = _bound(uint256(a0), perSlotCap);
        amounts[1] = _bound(uint256(a1), perSlotCap);
        amounts[2] = _bound(uint256(a2), perSlotCap);
        amounts[3] = _bound(uint256(a3), perSlotCap);
    }

    function _sumNonZeroNonZeroAddress(address[] memory recipients, uint256[] memory amounts)
        internal
        pure
        returns (uint256 sumExpected)
    {
        for (uint256 i = 0; i < recipients.length; i++) {
            if (recipients[i] != address(0) && amounts[i] > 0) {
                sumExpected += amounts[i];
            }
        }
    }

    function _poolRecipient(uint8 raw) internal view returns (address) {
        return recipientPool[uint256(raw) % recipientPool.length];
    }

    function _boundedMintAmount(uint256 amount) internal view returns (uint256) {
        uint256 remaining = tokenA.investorAllocation() - tokenA.investorMinted();
        uint256 cap = remaining < MAX_MINT ? remaining : MAX_MINT;
        return _bound(amount, cap);
    }

    function _bound(uint256 value, uint256 maxValue) internal pure returns (uint256) {
        if (maxValue == 0) {
            return 0;
        }
        return (value % maxValue) + 1;
    }
}
