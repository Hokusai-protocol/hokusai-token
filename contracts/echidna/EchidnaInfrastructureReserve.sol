// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../InfrastructureReserve.sol";
import "../mocks/MockUSDC.sol";

contract EchidnaFactoryStub {
    mapping(string => bool) private pools;

    function setPool(string memory modelId, bool isPresent) external {
        pools[modelId] = isPresent;
    }

    function hasPool(string memory modelId) external view returns (bool) {
        return pools[modelId];
    }
}

contract EchidnaInfraReserveUnauthorizedCaller {
    function tryDeposit(InfrastructureReserve reserve, string memory modelId, uint256 amount) external returns (bool) {
        try reserve.deposit(modelId, amount) {
            return true;
        } catch {
            return false;
        }
    }

    function tryBatchDeposit(InfrastructureReserve reserve, string[] memory modelIds, uint256[] memory amounts)
        external
        returns (bool)
    {
        try reserve.batchDeposit(modelIds, amounts) {
            return true;
        } catch {
            return false;
        }
    }

    function tryPay(InfrastructureReserve reserve, string memory modelId, address payee, uint256 amount)
        external
        returns (bool)
    {
        try reserve.payInfrastructureCost(modelId, payee, amount, bytes32(0), "unauthorized") {
            return true;
        } catch {
            return false;
        }
    }

    function tryBatchPay(InfrastructureReserve reserve, InfrastructureReserve.Payment[] memory payments)
        external
        returns (bool)
    {
        try reserve.batchPayInfrastructureCosts(payments) {
            return true;
        } catch {
            return false;
        }
    }

    function trySetProvider(InfrastructureReserve reserve, string memory modelId, address provider) external returns (bool) {
        try reserve.setProvider(modelId, provider) {
            return true;
        } catch {
            return false;
        }
    }

    function tryPause(InfrastructureReserve reserve) external returns (bool) {
        try reserve.pause() {
            return true;
        } catch {
            return false;
        }
    }

    function tryUnpause(InfrastructureReserve reserve) external returns (bool) {
        try reserve.unpause() {
            return true;
        } catch {
            return false;
        }
    }

    function tryEmergencyWithdraw(InfrastructureReserve reserve, uint256 amount) external returns (bool) {
        try reserve.emergencyWithdraw(amount) {
            return true;
        } catch {
            return false;
        }
    }

    function trySetTreasury(InfrastructureReserve reserve, address treasury) external returns (bool) {
        try reserve.setTreasury(treasury) {
            return true;
        } catch {
            return false;
        }
    }
}

/**
 * @dev Two-model Echidna harness covering batch operations, provider rotation,
 * access control, and pause semantics. Emergency withdrawals intentionally do
 * not mutate accrued/paid in the production contract, so the balance invariant
 * is expressed as balance plus withdrawn funds. Payments fuzz arbitrary payees
 * because provider[modelId] is informational and not enforced by the reserve.
 */
contract EchidnaInfrastructureReserve {
    string private constant MODEL_A = "echidna-infra-model-a";
    string private constant MODEL_B = "echidna-infra-model-b";
    uint256 private constant MAX_USDC_INPUT = 2_500_000e6;

    address private constant PROVIDER_A_DEFAULT = address(0x5001);
    address private constant PROVIDER_B_DEFAULT = address(0x5002);
    address private constant PROVIDER_ALT_A = address(0x5003);
    address private constant PROVIDER_ALT_B = address(0x5004);

    MockUSDC public usdc;
    EchidnaFactoryStub public factory;
    InfrastructureReserve public reserve;
    EchidnaInfraReserveUnauthorizedCaller private unauthorizedCaller;

    mapping(string => uint256) private ghostCumulativeDeposited;
    mapping(string => uint256) private ghostCumulativePaid;
    mapping(address => uint256) private ghostProviderPayments;
    uint256 private ghostTotalEmergencyWithdrawn;

    bool private pausedDepositSucceeded;
    bool private pausedBatchDepositSucceeded;
    bool private pausedPaymentSucceeded;
    bool private pausedBatchPaymentSucceeded;
    bool private unauthorizedSucceeded;
    bool private providerUpdateCorruptedAccounting;

    constructor() {
        usdc = new MockUSDC();
        factory = new EchidnaFactoryStub();
        factory.setPool(MODEL_A, true);
        factory.setPool(MODEL_B, true);

        reserve = new InfrastructureReserve(address(usdc), address(factory), address(this));
        reserve.grantRole(reserve.DEPOSITOR_ROLE(), address(this));
        reserve.grantRole(reserve.PAYER_ROLE(), address(this));
        reserve.setProvider(MODEL_A, PROVIDER_A_DEFAULT);
        reserve.setProvider(MODEL_B, PROVIDER_B_DEFAULT);

        unauthorizedCaller = new EchidnaInfraReserveUnauthorizedCaller();

        usdc.mint(address(this), 50_000_000e6);
        usdc.approve(address(reserve), type(uint256).max);
    }

    function deposit(uint256 modelSelector, uint256 amount) external {
        string memory modelId = _selectModel(modelSelector);
        uint256 bounded = _bound(amount, MAX_USDC_INPUT);
        if (bounded == 0) {
            return;
        }

        try reserve.deposit(modelId, bounded) {
            ghostCumulativeDeposited[modelId] += bounded;
        } catch {}
    }

    function batchDeposit(uint256 selector, uint256 amount0, uint256 amount1) external {
        (string[] memory modelIds, uint256[] memory amounts) =
            _buildBatchDeposit(selector, amount0, amount1);

        try reserve.batchDeposit(modelIds, amounts) {
            ghostCumulativeDeposited[modelIds[0]] += amounts[0];
            ghostCumulativeDeposited[modelIds[1]] += amounts[1];
        } catch {}
    }

    function payInfrastructureCost(uint256 selector, uint256 amount) external {
        string memory modelId = _selectModel(selector);
        uint256 available = reserve.accrued(modelId);
        uint256 bounded = _bound(amount, available);
        if (bounded == 0) {
            return;
        }

        address payee = _selectPayee(selector >> 8);
        try reserve.payInfrastructureCost(modelId, payee, bounded, bytes32(0), "echidna") {
            ghostCumulativePaid[modelId] += bounded;
            ghostProviderPayments[payee] += bounded;
        } catch {}
    }

    function batchPay(uint256 selector, uint256 amount0, uint256 amount1) external {
        InfrastructureReserve.Payment[] memory payments = _buildBatchPayments(selector, amount0, amount1);
        if (payments.length == 0) {
            return;
        }

        try reserve.batchPayInfrastructureCosts(payments) {
            for (uint256 i = 0; i < payments.length; i++) {
                ghostCumulativePaid[payments[i].modelId] += payments[i].amount;
                ghostProviderPayments[payments[i].payee] += payments[i].amount;
            }
        } catch {}
    }

    function setProvider(uint256 selector) external {
        string memory modelId = _selectModel(selector);
        address nextProvider = _selectProvider(modelId, selector >> 8);
        uint256 accruedBefore = reserve.accrued(modelId);
        uint256 paidBefore = reserve.paid(modelId);

        try reserve.setProvider(modelId, nextProvider) {
            if (reserve.accrued(modelId) != accruedBefore || reserve.paid(modelId) != paidBefore) {
                providerUpdateCorruptedAccounting = true;
            }
        } catch {}
    }

    function emergencyWithdraw(uint256 amount) external {
        uint256 balance = usdc.balanceOf(address(reserve));
        uint256 bounded = _bound(amount, balance);
        if (bounded == 0) {
            return;
        }

        try reserve.emergencyWithdraw(bounded) {
            ghostTotalEmergencyWithdrawn += bounded;
        } catch {}
    }

    function pause() external {
        try reserve.pause() {} catch {}
    }

    function unpause() external {
        try reserve.unpause() {} catch {}
    }

    function attemptPausedDeposit(uint256 selector, uint256 amount) external {
        string memory modelId = _selectModel(selector);
        uint256 bounded = _bound(amount, MAX_USDC_INPUT);
        if (bounded == 0) {
            return;
        }

        try reserve.pause() {} catch {}
        try reserve.deposit(modelId, bounded) {
            pausedDepositSucceeded = true;
        } catch {}
        try reserve.unpause() {} catch {}
    }

    function attemptPausedBatchDeposit(uint256 selector, uint256 amount0, uint256 amount1) external {
        (string[] memory modelIds, uint256[] memory amounts) = _buildBatchDeposit(selector, amount0, amount1);

        try reserve.pause() {} catch {}
        try reserve.batchDeposit(modelIds, amounts) {
            pausedBatchDepositSucceeded = true;
        } catch {}
        try reserve.unpause() {} catch {}
    }

    function attemptPausedPayment(uint256 selector, uint256 amount) external {
        string memory modelId = _selectModel(selector);
        _seedAccrual(modelId, 1);
        uint256 available = reserve.accrued(modelId);
        uint256 upperBound = available == 0 ? 1 : available;
        uint256 bounded = _bound(amount, upperBound);
        if (bounded == 0) {
            return;
        }

        try reserve.pause() {} catch {}
        try reserve.payInfrastructureCost(modelId, _selectPayee(selector >> 8), bounded, bytes32(0), "paused") {
            pausedPaymentSucceeded = true;
        } catch {}
        try reserve.unpause() {} catch {}
    }

    function attemptPausedBatchPayment(uint256 selector, uint256 amount0, uint256 amount1) external {
        _seedBatchPaymentAccrual(selector);
        InfrastructureReserve.Payment[] memory payments = _buildPausedBatchPayments(selector, amount0, amount1);

        try reserve.pause() {} catch {}
        try reserve.batchPayInfrastructureCosts(payments) {
            pausedBatchPaymentSucceeded = true;
        } catch {}
        try reserve.unpause() {} catch {}
    }

    function attemptUnauthorizedDeposit(uint256 selector, uint256 amount) external {
        string memory modelId = _selectModel(selector);
        uint256 bounded = _bound(amount, MAX_USDC_INPUT);
        if (bounded == 0) {
            return;
        }

        if (unauthorizedCaller.tryDeposit(reserve, modelId, bounded)) {
            unauthorizedSucceeded = true;
        }
    }

    function attemptUnauthorizedBatchDeposit(uint256 selector, uint256 amount0, uint256 amount1) external {
        (string[] memory modelIds, uint256[] memory amounts) = _buildBatchDeposit(selector, amount0, amount1);
        if (unauthorizedCaller.tryBatchDeposit(reserve, modelIds, amounts)) {
            unauthorizedSucceeded = true;
        }
    }

    function attemptUnauthorizedPay(uint256 selector, uint256 amount) external {
        string memory modelId = _selectModel(selector);
        _seedAccrual(modelId, 1);
        uint256 available = reserve.accrued(modelId);
        uint256 upperBound = available == 0 ? 1 : available;
        uint256 bounded = _bound(amount, upperBound);
        if (bounded == 0) {
            return;
        }

        if (unauthorizedCaller.tryPay(reserve, modelId, _selectPayee(selector >> 8), bounded)) {
            unauthorizedSucceeded = true;
        }
    }

    function attemptUnauthorizedBatchPay(uint256 selector, uint256 amount0, uint256 amount1) external {
        _seedBatchPaymentAccrual(selector);
        InfrastructureReserve.Payment[] memory payments = _buildPausedBatchPayments(selector, amount0, amount1);
        if (unauthorizedCaller.tryBatchPay(reserve, payments)) {
            unauthorizedSucceeded = true;
        }
    }

    function attemptUnauthorizedSetProvider(uint256 selector) external {
        string memory modelId = _selectModel(selector);
        address providerAddr = _selectProvider(modelId, selector >> 8);
        if (unauthorizedCaller.trySetProvider(reserve, modelId, providerAddr)) {
            unauthorizedSucceeded = true;
        }
    }

    function attemptUnauthorizedPause() external {
        if (unauthorizedCaller.tryPause(reserve)) {
            unauthorizedSucceeded = true;
        }
    }

    function attemptUnauthorizedUnpause() external {
        if (unauthorizedCaller.tryUnpause(reserve)) {
            unauthorizedSucceeded = true;
        }
    }

    function attemptUnauthorizedEmergencyWithdraw(uint256 amount) external {
        _seedReserveBalance();
        uint256 balance = usdc.balanceOf(address(reserve));
        uint256 upperBound = balance == 0 ? 1 : balance;
        uint256 bounded = _bound(amount, upperBound);
        if (bounded == 0) {
            return;
        }

        if (unauthorizedCaller.tryEmergencyWithdraw(reserve, bounded)) {
            unauthorizedSucceeded = true;
        }
    }

    function attemptUnauthorizedSetTreasury(uint256 selector) external {
        address treasury = (selector & 1) == 0 ? PROVIDER_A_DEFAULT : PROVIDER_B_DEFAULT;
        if (unauthorizedCaller.trySetTreasury(reserve, treasury)) {
            unauthorizedSucceeded = true;
        }
    }

    function echidna_accounting_integrity() external view returns (bool) {
        return reserve.totalAccrued() >= reserve.totalPaid();
    }

    function echidna_balance_covers_net_with_withdrawals() external view returns (bool) {
        return usdc.balanceOf(address(reserve)) + ghostTotalEmergencyWithdrawn
            == reserve.totalAccrued() - reserve.totalPaid();
    }

    function echidna_per_model_a_accounting() external view returns (bool) {
        return ghostCumulativeDeposited[MODEL_A] == reserve.accrued(MODEL_A) + reserve.paid(MODEL_A);
    }

    function echidna_per_model_b_accounting() external view returns (bool) {
        return ghostCumulativeDeposited[MODEL_B] == reserve.accrued(MODEL_B) + reserve.paid(MODEL_B);
    }

    function echidna_global_matches_per_model() external view returns (bool) {
        return reserve.totalAccrued()
            == reserve.accrued(MODEL_A) + reserve.paid(MODEL_A) + reserve.accrued(MODEL_B) + reserve.paid(MODEL_B);
    }

    function echidna_paid_matches_global() external view returns (bool) {
        return reserve.totalPaid() == reserve.paid(MODEL_A) + reserve.paid(MODEL_B);
    }

    function echidna_no_overpayment_a() external view returns (bool) {
        return reserve.paid(MODEL_A) <= ghostCumulativeDeposited[MODEL_A];
    }

    function echidna_no_overpayment_b() external view returns (bool) {
        return reserve.paid(MODEL_B) <= ghostCumulativeDeposited[MODEL_B];
    }

    function echidna_provider_balances_match_payments() external view returns (bool) {
        return usdc.balanceOf(PROVIDER_A_DEFAULT) == ghostProviderPayments[PROVIDER_A_DEFAULT]
            && usdc.balanceOf(PROVIDER_B_DEFAULT) == ghostProviderPayments[PROVIDER_B_DEFAULT]
            && usdc.balanceOf(PROVIDER_ALT_A) == ghostProviderPayments[PROVIDER_ALT_A]
            && usdc.balanceOf(PROVIDER_ALT_B) == ghostProviderPayments[PROVIDER_ALT_B];
    }

    function echidna_pause_blocks_deposit() external view returns (bool) {
        return !pausedDepositSucceeded;
    }

    function echidna_pause_blocks_batch_deposit() external view returns (bool) {
        return !pausedBatchDepositSucceeded;
    }

    function echidna_pause_blocks_payment() external view returns (bool) {
        return !pausedPaymentSucceeded;
    }

    function echidna_pause_blocks_batch_payment() external view returns (bool) {
        return !pausedBatchPaymentSucceeded;
    }

    function echidna_no_unauthorized_success() external view returns (bool) {
        return !unauthorizedSucceeded;
    }

    function echidna_provider_update_preserves_accounting() external view returns (bool) {
        return !providerUpdateCorruptedAccounting;
    }

    function _buildBatchDeposit(uint256 selector, uint256 amount0, uint256 amount1)
        internal
        pure
        returns (string[] memory modelIds, uint256[] memory amounts)
    {
        modelIds = new string[](2);
        amounts = new uint256[](2);

        if (selector % 3 == 0) {
            modelIds[0] = MODEL_A;
            modelIds[1] = MODEL_B;
        } else if (selector % 3 == 1) {
            modelIds[0] = MODEL_B;
            modelIds[1] = MODEL_A;
        } else {
            modelIds[0] = MODEL_A;
            modelIds[1] = MODEL_A;
        }

        uint256 maxBatchAmount = MAX_USDC_INPUT / 2;
        amounts[0] = _bound(amount0, maxBatchAmount);
        amounts[1] = _bound(amount1, maxBatchAmount);
    }

    function _buildBatchPayments(uint256 selector, uint256 amount0, uint256 amount1)
        internal
        view
        returns (InfrastructureReserve.Payment[] memory payments)
    {
        payments = new InfrastructureReserve.Payment[](2);
        uint256 remainingA = reserve.accrued(MODEL_A);
        uint256 remainingB = reserve.accrued(MODEL_B);

        for (uint256 i = 0; i < 2; i++) {
            string memory modelId = _batchModelAt(selector, i);
            uint256 bounded = _bound(i == 0 ? amount0 : amount1, _isModelA(modelId) ? remainingA : remainingB);

            payments[i] = _paymentFor(modelId, _selectPayee(selector >> (8 + i)), bounded, "echidna-batch");

            if (_isModelA(modelId)) {
                remainingA -= bounded;
            } else {
                remainingB -= bounded;
            }
        }
    }

    function _buildPausedBatchPayments(uint256 selector, uint256 amount0, uint256 amount1)
        internal
        view
        returns (InfrastructureReserve.Payment[] memory payments)
    {
        payments = new InfrastructureReserve.Payment[](2);
        uint256 remainingA = reserve.accrued(MODEL_A);
        uint256 remainingB = reserve.accrued(MODEL_B);

        for (uint256 i = 0; i < 2; i++) {
            string memory modelId = _batchModelAt(selector, i);
            uint256 available = _isModelA(modelId) ? remainingA : remainingB;
            uint256 bounded = _bound(i == 0 ? amount0 : amount1, available == 0 ? 1 : available);

            payments[i] = _paymentFor(modelId, _selectPayee(selector >> (8 + i)), bounded, "paused-batch");

            if (_isModelA(modelId)) {
                if (available > 0) {
                    remainingA -= bounded;
                }
            } else if (available > 0) {
                remainingB -= bounded;
            }
        }
    }

    function _selectModel(uint256 selector) internal pure returns (string memory) {
        return (selector & 1) == 0 ? MODEL_A : MODEL_B;
    }

    function _selectPayee(uint256 selector) internal view returns (address) {
        uint256 index = selector % 5;
        if (index == 0) {
            return PROVIDER_A_DEFAULT;
        }
        if (index == 1) {
            return PROVIDER_B_DEFAULT;
        }
        if (index == 2) {
            return PROVIDER_ALT_A;
        }
        if (index == 3) {
            return PROVIDER_ALT_B;
        }
        return address(this);
    }

    function _selectProvider(string memory modelId, uint256 selector) internal pure returns (address) {
        bool chooseDefault = (selector & 1) == 0;
        if (_isModelA(modelId)) {
            return chooseDefault ? PROVIDER_A_DEFAULT : PROVIDER_ALT_A;
        }
        return chooseDefault ? PROVIDER_B_DEFAULT : PROVIDER_ALT_B;
    }

    function _batchModelAt(uint256 selector, uint256 index) internal pure returns (string memory) {
        uint256 mode = selector % 3;
        if (mode == 0) {
            return index == 0 ? MODEL_A : MODEL_B;
        }
        if (mode == 1) {
            return index == 0 ? MODEL_B : MODEL_A;
        }
        return MODEL_A;
    }

    function _paymentFor(string memory modelId, address payee, uint256 amount, string memory memo)
        internal
        pure
        returns (InfrastructureReserve.Payment memory)
    {
        return InfrastructureReserve.Payment({
            modelId: modelId,
            payee: payee,
            amount: amount,
            invoiceHash: bytes32(0),
            memo: memo
        });
    }

    function _isModelA(string memory modelId) internal pure returns (bool) {
        return keccak256(bytes(modelId)) == keccak256(bytes(MODEL_A));
    }

    function _bound(uint256 value, uint256 maxValue) internal pure returns (uint256) {
        if (maxValue == 0) {
            return 0;
        }
        return (value % maxValue) + 1;
    }

    function _seedAccrual(string memory modelId, uint256 minimumAccrued) internal {
        try reserve.unpause() {} catch {}

        uint256 currentAccrued = reserve.accrued(modelId);
        if (currentAccrued >= minimumAccrued) {
            return;
        }

        uint256 delta = minimumAccrued - currentAccrued;
        try reserve.deposit(modelId, delta) {
            ghostCumulativeDeposited[modelId] += delta;
        } catch {}
    }

    function _seedBatchPaymentAccrual(uint256 selector) internal {
        uint256 requiredA = 0;
        uint256 requiredB = 0;

        for (uint256 i = 0; i < 2; i++) {
            if (_isModelA(_batchModelAt(selector, i))) {
                requiredA += 1;
            } else {
                requiredB += 1;
            }
        }

        if (requiredA > 0) {
            _seedAccrual(MODEL_A, requiredA);
        }
        if (requiredB > 0) {
            _seedAccrual(MODEL_B, requiredB);
        }
    }

    function _seedReserveBalance() internal {
        if (usdc.balanceOf(address(reserve)) > 0) {
            return;
        }

        _seedAccrual(MODEL_A, 1);
    }
}
