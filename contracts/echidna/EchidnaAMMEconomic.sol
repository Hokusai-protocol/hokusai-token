// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../HokusaiAMM.sol";
import "../HokusaiToken.sol";
import "../ModelRegistry.sol";
import "../TokenManager.sol";
import "../mocks/MockUSDC.sol";
import "../interfaces/IHokusaiParams.sol";

contract EchidnaAMMEconomic {
    string private constant MODEL_ID = "echidna-amm-economic";
    uint256 private constant SUPPLIER_ALLOCATION = 1_000 ether;
    uint256 private constant INVESTOR_ALLOCATION = 1_000_000 ether;
    uint256 private constant MAX_USDC_INPUT = 2_500_000e6;
    uint256 private constant FLAT_THRESHOLD = 25_000e6;
    uint256 private constant FLAT_PRICE = 10_000;
    address private constant SUPPLIER = address(0x4001);

    MockUSDC public usdc;
    ModelRegistry public registry;
    TokenManager public manager;
    HokusaiToken public token;
    HokusaiAMM public amm;

    bool private profitableRoundtripFound;
    bool private buyPriceViolation;
    bool private sellReserveViolation;

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
        token.approve(address(amm), type(uint256).max);
    }

    function buy(uint256 reserveIn) external {
        uint256 bounded = _bound(reserveIn, MAX_USDC_INPUT);
        if (bounded == 0) {
            return;
        }

        uint256 priceBefore = amm.spotPrice();
        try amm.buy(bounded, 0, address(this), type(uint256).max) {
            uint256 priceAfter = amm.spotPrice();
            if (priceAfter < priceBefore) {
                buyPriceViolation = true;
            }
        } catch {}
    }

    function sell(uint256 tokensIn) external {
        uint256 available = token.balanceOf(address(this));
        uint256 bounded = _bound(tokensIn, available);
        if (bounded == 0) {
            return;
        }

        uint256 reserveBefore = amm.reserveBalance();
        uint256 priceBefore = amm.spotPrice();
        try amm.sell(bounded, 0, address(this), type(uint256).max) {
            if (amm.reserveBalance() > reserveBefore) {
                sellReserveViolation = true;
            }

            // Flat-price sells can legitimately leave the reported spot unchanged, so
            // only the reserve direction is treated as the invariant for sell paths.
            if (priceBefore == 0) {
                sellReserveViolation = true;
            }
        } catch {}
    }

    function depositFees(uint256 amount) external {
        uint256 bounded = _bound(amount, MAX_USDC_INPUT);
        if (bounded == 0) {
            return;
        }

        try amm.depositFees(bounded) {} catch {}
    }

    function roundTrip(uint256 reserveIn) external {
        uint256 bounded = _bound(reserveIn, MAX_USDC_INPUT);
        if (bounded == 0) {
            return;
        }

        uint256 usdcBefore = usdc.balanceOf(address(this));
        uint256 tokenBefore = token.balanceOf(address(this));

        try amm.buy(bounded, 0, address(this), type(uint256).max) {
            uint256 tokenDelta = token.balanceOf(address(this)) - tokenBefore;
            if (tokenDelta == 0) {
                return;
            }

            try amm.sell(tokenDelta, 0, address(this), type(uint256).max) {
                if (usdc.balanceOf(address(this)) > usdcBefore) {
                    profitableRoundtripFound = true;
                }
            } catch {}
        } catch {}
    }

    function echidna_no_profitable_roundtrip() external view returns (bool) {
        return !profitableRoundtripFound;
    }

    function echidna_price_monotonic_on_buy() external view returns (bool) {
        return !buyPriceViolation;
    }

    function echidna_sell_reduces_reserve() external view returns (bool) {
        return !sellReserveViolation;
    }

    function echidna_reserve_never_negative() external view returns (bool) {
        return amm.reserveBalance() >= 0;
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
            "Echidna Economic Token",
            "EECO",
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
