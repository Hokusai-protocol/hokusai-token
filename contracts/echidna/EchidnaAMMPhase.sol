// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../HokusaiAMM.sol";
import "../HokusaiToken.sol";
import "../ModelRegistry.sol";
import "../TokenManager.sol";
import "../mocks/MockUSDC.sol";
import "../interfaces/IHokusaiParams.sol";

/**
 * @title EchidnaAMMPhase
 * @notice IBR/phase/graduation harness for HokusaiAMM.
 * @dev
 * - Uses `_ibrDuration = 1 days`; Echidna timestamp advancement should naturally
 *   exercise both pre- and post-IBR states.
 * - Constructor pre-buys to seed sellable token balance so sell attempts can be
 *   exercised during IBR without requiring prior fuzz actions.
 * - Post-IBR sell-path quote/reserve/fee accounting is covered in
 *   `EchidnaAMMReserve`; this harness focuses on phase gating and monotonicity.
 */
contract EchidnaAMMPhase {
    string private constant MODEL_ID = "echidna-amm-phase";
    uint256 private constant SUPPLIER_ALLOCATION = 1_000 ether;
    uint256 private constant INVESTOR_ALLOCATION = 1_000_000 ether;
    uint256 private constant MAX_USDC_INPUT = 500_000e6;
    uint256 private constant FLAT_THRESHOLD = 10_000e6;
    uint256 private constant FLAT_PRICE = 10_000;
    uint256 private constant IBR_DURATION = 1 days;
    uint256 private constant PREBUY_SEED = 5_000e6;
    address private constant SUPPLIER = address(0x3002);

    MockUSDC public usdc;
    ModelRegistry public registry;
    TokenManager public manager;
    HokusaiToken public token;
    HokusaiAMM public amm;

    bool private pausedBuySucceeded;
    bool private pausedSellSucceeded;
    bool private sellDuringIbrSucceeded;
    bool private sellEnabledMonotonicBroken;
    bool private graduationReverted;
    bool private observedSellEnabled;
    bool private observedGraduated;

    constructor() {
        usdc = new MockUSDC();
        registry = new ModelRegistry();
        manager = new TokenManager(address(registry));

        _deployModel();
        token = HokusaiToken(manager.getTokenAddress(MODEL_ID));
        amm = new HokusaiAMM(
            address(usdc),
            address(token),
            payable(address(manager)),
            MODEL_ID,
            address(this),
            200_000,
            30,
            IBR_DURATION,
            FLAT_THRESHOLD,
            FLAT_PRICE
        );

        manager.authorizeAMM(address(amm));
        usdc.mint(address(this), 50_000_000e6);
        usdc.approve(address(amm), type(uint256).max);

        // Seed sellable token balance while keeping pool below graduation threshold.
        try amm.buy(PREBUY_SEED, 0, address(this), type(uint256).max) {
            _refreshPhaseFlags();
        } catch {}
    }

    function buy(uint256 reserveIn) external {
        uint256 bounded = _bound(reserveIn, MAX_USDC_INPUT);
        if (bounded == 0) {
            return;
        }

        try amm.buy(bounded, 0, address(this), type(uint256).max) {
            _refreshPhaseFlags();
        } catch {}
    }

    function sell(uint256 tokensIn) external {
        uint256 available = token.balanceOf(address(this));
        uint256 bounded = _bound(tokensIn, available);
        if (bounded == 0) {
            return;
        }

        token.approve(address(amm), type(uint256).max);
        bool inIbr = block.timestamp < amm.buyOnlyUntil();

        try amm.sell(bounded, 0, address(this), type(uint256).max) {
            if (inIbr) {
                sellDuringIbrSucceeded = true;
            }
            _refreshPhaseFlags();
        } catch {}
    }

    function depositFees(uint256 amount) external {
        uint256 bounded = _bound(amount, MAX_USDC_INPUT);
        if (bounded == 0) {
            return;
        }

        try amm.depositFees(bounded) {
            _refreshPhaseFlags();
        } catch {}
    }

    function setParameters(uint256 newCrr, uint256 newFee) external {
        uint256 boundedCrr = (newCrr % (amm.MAX_CRR() - amm.MIN_CRR() + 1)) + amm.MIN_CRR();
        uint256 boundedFee = newFee % (amm.MAX_TRADE_FEE() + 1);
        try amm.setParameters(boundedCrr, boundedFee) {
            _refreshPhaseFlags();
        } catch {}
    }

    function setMaxTradeBps(uint256 newBps) external {
        uint256 bounded = (newBps % amm.MAX_TRADE_BPS_LIMIT()) + 1;
        try amm.setMaxTradeBps(bounded) {
            _refreshPhaseFlags();
        } catch {}
    }

    function withdrawTreasury(uint256 amount) external {
        uint256 balance = usdc.balanceOf(address(amm));
        uint256 reserve = amm.reserveBalance();
        if (balance <= reserve) {
            return;
        }

        uint256 surplus = balance - reserve;
        uint256 bounded = _bound(amount, surplus);
        if (bounded == 0) {
            return;
        }

        try amm.withdrawTreasury(bounded) {
            _refreshPhaseFlags();
        } catch {}
    }

    function pause() external {
        try amm.pause() {
            _refreshPhaseFlags();
        } catch {}
    }

    function unpause() external {
        try amm.unpause() {
            _refreshPhaseFlags();
        } catch {}
    }

    function buyWhilePaused(uint256 reserveIn) external {
        uint256 bounded = _bound(reserveIn, MAX_USDC_INPUT);
        if (bounded == 0) {
            return;
        }

        try amm.pause() {} catch {}
        try amm.buy(bounded, 0, address(this), type(uint256).max) {
            pausedBuySucceeded = true;
        } catch {}
        try amm.unpause() {} catch {}

        _refreshPhaseFlags();
    }

    function sellWhilePaused(uint256 tokensIn) external {
        uint256 available = token.balanceOf(address(this));
        uint256 bounded = _bound(tokensIn, available);
        if (bounded == 0) {
            return;
        }

        try amm.pause() {} catch {}
        token.approve(address(amm), type(uint256).max);
        try amm.sell(bounded, 0, address(this), type(uint256).max) {
            pausedSellSucceeded = true;
        } catch {}
        try amm.unpause() {} catch {}

        _refreshPhaseFlags();
    }

    function echidna_no_sell_during_ibr() external view returns (bool) {
        return !sellDuringIbrSucceeded;
    }

    function echidna_sell_enabled_monotonic() external view returns (bool) {
        return !sellEnabledMonotonicBroken;
    }

    function echidna_graduation_one_way() external view returns (bool) {
        return !graduationReverted;
    }

    function echidna_reserve_accounting() external view returns (bool) {
        return amm.reserveBalance() <= usdc.balanceOf(address(amm));
    }

    function echidna_pause_blocks_buy() external view returns (bool) {
        return !pausedBuySucceeded;
    }

    function echidna_pause_blocks_sell() external view returns (bool) {
        return !pausedSellSucceeded;
    }

    function _deployModel() internal {
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
            MODEL_ID,
            "Echidna AMM Phase Token",
            "EAMP",
            SUPPLIER_ALLOCATION,
            SUPPLIER,
            INVESTOR_ALLOCATION,
            initialParams
        );
    }

    function _refreshPhaseFlags() internal {
        bool nowSellEnabled = amm.isSellEnabled();
        bool nowGraduated = amm.hasGraduated();

        if (observedSellEnabled && !nowSellEnabled) {
            sellEnabledMonotonicBroken = true;
        }
        if (observedGraduated && !nowGraduated) {
            graduationReverted = true;
        }

        observedSellEnabled = observedSellEnabled || nowSellEnabled;
        observedGraduated = observedGraduated || nowGraduated;
    }

    function _bound(uint256 value, uint256 maxValue) internal pure returns (uint256) {
        if (maxValue == 0) {
            return 0;
        }
        return (value % maxValue) + 1;
    }
}
