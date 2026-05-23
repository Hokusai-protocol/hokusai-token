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

contract EchidnaInfrastructureReserve {
    string private constant MODEL_ID = "echidna-infra-model";
    uint256 private constant MAX_USDC_INPUT = 2_500_000e6;
    address private constant PROVIDER = address(0x5001);

    MockUSDC public usdc;
    EchidnaFactoryStub public factory;
    InfrastructureReserve public reserve;

    uint256 private cumulativeDeposited;

    constructor() {
        usdc = new MockUSDC();
        factory = new EchidnaFactoryStub();
        factory.setPool(MODEL_ID, true);

        reserve = new InfrastructureReserve(address(usdc), address(factory), address(this));
        reserve.grantRole(reserve.DEPOSITOR_ROLE(), address(this));
        reserve.grantRole(reserve.PAYER_ROLE(), address(this));
        reserve.setProvider(MODEL_ID, PROVIDER);

        usdc.mint(address(this), 50_000_000e6);
        usdc.approve(address(reserve), type(uint256).max);
    }

    function deposit(uint256 amount) external {
        uint256 bounded = _bound(amount, MAX_USDC_INPUT);
        if (bounded == 0) {
            return;
        }

        try reserve.deposit(MODEL_ID, bounded) {
            cumulativeDeposited += bounded;
        } catch {}
    }

    function payInfrastructureCost(uint256 amount) external {
        uint256 available = reserve.accrued(MODEL_ID);
        uint256 bounded = _bound(amount, available);
        if (bounded == 0) {
            return;
        }

        try reserve.payInfrastructureCost(MODEL_ID, PROVIDER, bounded, bytes32(0), "echidna") {} catch {}
    }

    function emergencyWithdraw(uint256 amount) external {
        uint256 balance = usdc.balanceOf(address(reserve));
        uint256 requiredBacking = reserve.totalAccrued() - reserve.totalPaid();
        if (balance <= requiredBacking) {
            return;
        }

        uint256 surplus = balance - requiredBacking;
        uint256 bounded = _bound(amount, surplus);
        if (bounded == 0) {
            return;
        }

        try reserve.emergencyWithdraw(bounded) {} catch {}
    }

    function pause() external {
        try reserve.pause() {} catch {}
    }

    function unpause() external {
        try reserve.unpause() {} catch {}
    }

    function echidna_accounting_integrity() external view returns (bool) {
        return reserve.totalAccrued() >= reserve.totalPaid();
    }

    function echidna_balance_covers_net() external view returns (bool) {
        return usdc.balanceOf(address(reserve)) >= reserve.totalAccrued() - reserve.totalPaid();
    }

    function echidna_no_overpayment() external view returns (bool) {
        return cumulativeDeposited == reserve.accrued(MODEL_ID) + reserve.paid(MODEL_ID);
    }

    function _bound(uint256 value, uint256 maxValue) internal pure returns (uint256) {
        if (maxValue == 0) {
            return 0;
        }
        return (value % maxValue) + 1;
    }
}
