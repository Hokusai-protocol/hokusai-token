// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "../HokusaiAMM.sol";
import "../HokusaiToken.sol";
import "../ModelRegistry.sol";
import "../TokenManager.sol";
import "../mocks/MockUSDC.sol";
import "../interfaces/IHokusaiParams.sol";

/**
 * @title EchidnaVictim
 * @dev Helper caller that preserves a victim-specific msg.sender at the AMM.
 */
contract EchidnaVictim {
    HokusaiAMM public immutable amm;
    IERC20 public immutable usdc;
    IERC20 public immutable token;

    constructor(HokusaiAMM _amm, IERC20 _usdc, IERC20 _token) {
        amm = _amm;
        usdc = _usdc;
        token = _token;
    }

    function approveAmm() external {
        usdc.approve(address(amm), type(uint256).max);
        token.approve(address(amm), type(uint256).max);
    }

    function victimBuy(uint256 reserveIn) external returns (uint256) {
        return amm.buy(reserveIn, 0, address(this), type(uint256).max);
    }

    function victimSell(uint256 tokensIn) external returns (uint256) {
        return amm.sell(tokensIn, 0, address(this), type(uint256).max);
    }
}

/**
 * @title EchidnaAMMEconomic
 * @dev Economic-attack harness for bounded round trips, repeated cycles, and
 * sandwich-like attacker/victim sequencing against the AMM.
 *
 * Assumptions:
 * - Purchaser whitelist remains disabled, so both attacker and victim can buy.
 * - IBR duration is zero, so sell gating is delegated to the phase harness.
 * - Trade sizes are bounded to keep Echidna exploring profitable-looking paths
 *   rather than extremely large or dust-only inputs.
 * - Rounding tolerance is limited to a small USDC dust budget; fee losses are
 *   expected to dominate that tolerance in any honest round-trip path.
 * - Sandwich profitability is not asserted directly because a victim buy can
 *   legitimately move price in the attacker's favor; the harness instead checks
 *   that sandwich sequencing does not create supply or reserve-accounting drift.
 */
contract EchidnaAMMEconomic {
    string private constant MODEL_ID = "echidna-amm-economic";
    uint256 private constant SUPPLIER_ALLOCATION = 1_000 ether;
    uint256 private constant INVESTOR_ALLOCATION = 1_000_000 ether;
    uint256 private constant MAX_TRADE = 2_500_000e6;
    uint256 private constant MIN_LIQUIDITY = 1_000e6;
    uint256 private constant MAX_CYCLES = 5;
    uint256 private constant ROUND_TOLERANCE_USDC = 100;
    uint256 private constant VICTIM_INITIAL_USDC = 10_000_000e6;
    uint256 private constant FLAT_THRESHOLD = 25_000e6;
    uint256 private constant FLAT_PRICE = 10_000;
    address private constant SUPPLIER = address(0x4001);

    MockUSDC public usdc;
    ModelRegistry public registry;
    TokenManager public manager;
    HokusaiToken public token;
    HokusaiAMM public amm;
    EchidnaVictim public victim;

    bool private profitableRoundtripFound;
    bool private buyPriceViolation;
    bool private sellReserveDirectionViolation;
    bool private sellQuoteImpactViolation;
    bool private sandwichSequenceViolation;

    int256 private attackerUsdcDelta;
    uint256 private attackerCycleCount;

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

        victim = new EchidnaVictim(amm, IERC20(address(usdc)), IERC20(address(token)));

        manager.authorizeAMM(address(amm));
        usdc.mint(address(this), 50_000_000e6);
        usdc.mint(address(victim), VICTIM_INITIAL_USDC);

        usdc.approve(address(amm), type(uint256).max);
        token.approve(address(amm), type(uint256).max);
        victim.approveAmm();
    }

    function buy(uint256 reserveIn) external {
        uint256 bounded = _bound(reserveIn, MAX_TRADE);
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
        uint256 quoteBefore = amm.getSellQuote(bounded);
        try amm.sell(bounded, 0, address(this), type(uint256).max) {
            uint256 reserveAfter = amm.reserveBalance();
            if (reserveAfter > reserveBefore) {
                sellReserveDirectionViolation = true;
            }

            uint256 quoteAfter = amm.getSellQuote(bounded);
            if (quoteAfter > quoteBefore) {
                sellQuoteImpactViolation = true;
            }
        } catch {}
    }

    function depositFees(uint256 amount) external {
        uint256 bounded = _bound(amount, MAX_TRADE);
        if (bounded == 0) {
            return;
        }

        try amm.depositFees(bounded) {} catch {}
    }

    function roundTrip(uint256 reserveIn) external {
        uint256 bounded = _bound(reserveIn, MAX_TRADE);
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
                uint256 usdcAfter = usdc.balanceOf(address(this));
                if (usdcAfter > usdcBefore + ROUND_TOLERANCE_USDC) {
                    profitableRoundtripFound = true;
                }
            } catch {}
        } catch {}
    }

    function cycle(uint256 reserveIn) external {
        if (attackerCycleCount >= MAX_CYCLES) {
            return;
        }

        uint256 bounded = _bound(reserveIn, MAX_TRADE);
        if (bounded < MIN_LIQUIDITY) {
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
                uint256 usdcAfter = usdc.balanceOf(address(this));
                attackerUsdcDelta += int256(usdcAfter) - int256(usdcBefore);
                attackerCycleCount += 1;
            } catch {}
        } catch {}
    }

    function sandwich(uint256 attackerIn, uint256 victimIn) external {
        uint256 attackerBounded = _bound(attackerIn, MAX_TRADE);
        uint256 victimBounded = _boundIncludingZero(victimIn, MAX_TRADE);
        if (attackerBounded < MIN_LIQUIDITY) {
            return;
        }

        uint256 tokenBefore = token.balanceOf(address(this));
        uint256 victimTokenBefore = token.balanceOf(address(victim));
        uint256 totalSupplyBefore = token.totalSupply();

        try amm.buy(attackerBounded, 0, address(this), type(uint256).max) {
            uint256 tokenDelta = token.balanceOf(address(this)) - tokenBefore;
            if (tokenDelta == 0) {
                return;
            }

            if (victimBounded > 0) {
                try victim.victimBuy(victimBounded) {} catch {
                    return;
                }
            }

            try amm.sell(tokenDelta, 0, address(this), type(uint256).max) {
                uint256 attackerTokenAfter = token.balanceOf(address(this));
                uint256 victimTokenAfter = token.balanceOf(address(victim));
                uint256 totalSupplyAfter = token.totalSupply();
                uint256 expectedSupplyAfter = totalSupplyBefore + (victimTokenAfter - victimTokenBefore);

                if (attackerTokenAfter != tokenBefore || totalSupplyAfter != expectedSupplyAfter) {
                    sandwichSequenceViolation = true;
                }
            } catch {}
        } catch {}
    }

    /**
     * @dev Catches quote/accounting bugs that let a bounded attacker end a
     * single buy/sell round trip with more USDC than it started with.
     */
    function echidna_no_profitable_roundtrip() external view returns (bool) {
        return !profitableRoundtripFound;
    }

    /**
     * @dev Catches buy-side quote or reserve updates that let a successful buy
     * lower the reported spot price instead of holding flat or increasing it.
     */
    function echidna_price_monotonic_on_buy() external view returns (bool) {
        return !buyPriceViolation;
    }

    /**
     * @dev Catches sell-side reserve accounting regressions where a successful
     * sell increases tracked reserve instead of reducing or preserving it.
     */
    function echidna_sell_reduces_reserve() external view returns (bool) {
        return !sellReserveDirectionViolation;
    }

    /**
     * @dev Catches sell-side price-impact regressions where completing a sell
     * improves the executable quote for selling the same token amount again.
     */
    function echidna_sell_does_not_improve_exit_quote() external view returns (bool) {
        return !sellQuoteImpactViolation;
    }

    /**
     * @dev Catches cyclic pricing bugs that would let an attacker compound
     * positive USDC balance changes across bounded repeated round trips.
     */
    function echidna_no_profitable_repeated_cycle() external view returns (bool) {
        return attackerUsdcDelta <= int256(ROUND_TOLERANCE_USDC * MAX_CYCLES);
    }

    /**
     * @dev Catches sandwich-sequencing bugs where the attacker fails to round
     * trip back to its starting token balance or total supply drifts away from
     * the victim's retained position after the attacker exits.
     */
    function echidna_sandwich_preserves_position_and_supply() external view returns (bool) {
        return !sandwichSequenceViolation;
    }

    /**
     * @dev Catches accounting divergence where internal reserve tracking is
     * credited more than the AMM's actual USDC balance.
     */
    function echidna_reserve_not_exceeds_usdc_balance() external view returns (bool) {
        return amm.reserveBalance() <= usdc.balanceOf(address(amm));
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

    function _boundIncludingZero(uint256 value, uint256 maxValue) internal pure returns (uint256) {
        if (maxValue == 0) {
            return 0;
        }
        return value % (maxValue + 1);
    }
}
