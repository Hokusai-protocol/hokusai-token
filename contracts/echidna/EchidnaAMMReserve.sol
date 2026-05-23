// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../HokusaiAMM.sol";
import "../HokusaiToken.sol";
import "../ModelRegistry.sol";
import "../TokenManager.sol";
import "../mocks/MockUSDC.sol";
import "../interfaces/IHokusaiParams.sol";

contract EchidnaAMMReserve {
    string private constant MODEL_ID = "echidna-amm-reserve";
    uint256 private constant SUPPLIER_ALLOCATION = 1_000 ether;
    uint256 private constant INVESTOR_ALLOCATION = 1_000_000 ether;
    uint256 private constant MAX_USDC_INPUT = 5_000_000e6;
    uint256 private constant FLAT_THRESHOLD = 50_000e6;
    uint256 private constant FLAT_PRICE = 10_000;
    address private constant SUPPLIER = address(0x3001);

    MockUSDC public usdc;
    ModelRegistry public registry;
    TokenManager public manager;
    HokusaiToken public token;
    HokusaiAMM public amm;

    bool private graduatedSeen;
    bool private pausedBuySucceeded;
    bool private tradeSizeViolation;

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
            0,
            FLAT_THRESHOLD,
            FLAT_PRICE
        );

        manager.authorizeAMM(address(amm));
        usdc.mint(address(this), 50_000_000e6);
        usdc.approve(address(amm), type(uint256).max);
    }

    function buy(uint256 reserveIn) external {
        uint256 bounded = _bound(reserveIn, MAX_USDC_INPUT);
        if (bounded == 0) {
            return;
        }

        uint256 reserveBefore = amm.reserveBalance();
        try amm.buy(bounded, 0, address(this), type(uint256).max) {
            uint256 reserveAfter = amm.reserveBalance();
            if (reserveAfter < reserveBefore || reserveAfter - reserveBefore > bounded) {
                tradeSizeViolation = true;
            }
            if (amm.hasGraduated()) {
                graduatedSeen = true;
            }
        } catch {}
    }

    function sell(uint256 tokensIn) external {
        uint256 available = token.balanceOf(address(this));
        uint256 bounded = _bound(tokensIn, available);
        if (bounded == 0) {
            return;
        }

        token.approve(address(amm), type(uint256).max);
        try amm.sell(bounded, 0, address(this), type(uint256).max) {
            if (amm.hasGraduated()) {
                graduatedSeen = true;
            }
        } catch {}
    }

    function depositFees(uint256 amount) external {
        uint256 bounded = _bound(amount, MAX_USDC_INPUT);
        if (bounded == 0) {
            return;
        }

        try amm.depositFees(bounded) {
            if (amm.hasGraduated()) {
                graduatedSeen = true;
            }
        } catch {}
    }

    function pause() external {
        try amm.pause() {} catch {}
    }

    function unpause() external {
        try amm.unpause() {} catch {}
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
    }

    function echidna_reserve_accounting() external view returns (bool) {
        return amm.reserveBalance() <= usdc.balanceOf(address(amm));
    }

    function echidna_graduated_monotonic() external view returns (bool) {
        return !graduatedSeen || amm.hasGraduated();
    }

    function echidna_spot_price_positive() external view returns (bool) {
        uint256 supply = manager.getRedeemableSupply(MODEL_ID);
        if (amm.paused() || supply == 0) {
            return true;
        }
        return amm.spotPrice() > 0;
    }

    function echidna_pause_blocks_buy() external view returns (bool) {
        return !pausedBuySucceeded;
    }

    function echidna_trade_size_respected() external view returns (bool) {
        return !tradeSizeViolation;
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
            "Echidna AMM Token",
            "EAMM",
            SUPPLIER_ALLOCATION,
            SUPPLIER,
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
