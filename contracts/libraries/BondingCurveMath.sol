// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import {ud} from "@prb/math/src/UD60x18.sol";
import {sd} from "@prb/math/src/SD59x18.sol";

/**
 * @title BondingCurveMath
 * @dev Fixed-point arithmetic library for bonding curve calculations
 *
 * pow, ln and exp delegate to PRBMath (UD60x18 / SD59x18), replacing the
 * original Taylor-series versions whose ln diverged outside |y| <= 1 and added
 * k instead of k × ln(3) when rescaling (HOK-3289 AMM-L1).
 *
 * All functions use 18-decimal fixed-point arithmetic (PRECISION = 1e18)
 * This means 1.0 is represented as 1e18, 0.5 as 5e17, etc.
 *
 * BONDING CURVE FORMULAS:
 * - Buy:  T = S × ((1 + E/R)^w - 1)
 * - Sell: F = R × (1 - (1 - T/S)^(1/w))
 * - Spot: P = R / (w × S)
 *
 * Where:
 *   T = tokens to mint/burn
 *   S = current supply
 *   R = reserve balance
 *   E = reserve deposited
 *   F = reserve returned
 *   w = CRR (reserve ratio)
 *
 * Security: Tested extensively for the specific use case of CRR ∈ [5%, 100%]
 * with typical trading volumes. Should not be used for arbitrary inputs without
 * additional validation and testing.
 */
library BondingCurveMath {
    // ============================================================
    // CONSTANTS
    // ============================================================

    /**
     * @dev Fixed-point precision: 1.0 = 1e18
     * All calculations use 18 decimal places
     */
    uint256 internal constant PRECISION = 1e18;

    /**
     * @dev Parts per million (for CRR conversion)
     * CRR is stored as PPM (e.g., 100000 = 10%)
     */
    uint256 internal constant PPM = 1000000;

    // ============================================================
    // ERRORS
    // ============================================================

    error LnUndefined();

    // ============================================================
    // CORE MATHEMATICAL FUNCTIONS
    // ============================================================

    /**
     * @dev Fixed-point exponentiation: base^exponent (PRBMath UD60x18)
     * @param base Base value (18 decimals, e.g., 1.5e18 = 1.5)
     * @param exponent Exponent value (18 decimals)
     * @return result base^exponent (18 decimals)
     *
     * Examples:
     *   pow(2e18, 1e18) = 2e18           // 2^1 = 2
     *   pow(15e17, 5e17) ≈ 1.2247e18    // 1.5^0.5 ≈ 1.2247
     */
    function pow(uint256 base, uint256 exponent) internal pure returns (uint256 result) {
        // Edge cases
        if (exponent == 0) return PRECISION; // x^0 = 1
        if (base == 0) return 0;             // 0^x = 0 (for x > 0)
        if (base == PRECISION) return PRECISION; // 1^x = 1

        return ud(base).pow(ud(exponent)).unwrap();
    }

    /**
     * @dev Natural logarithm (PRBMath SD59x18)
     * @param x Input value (18 decimals, must be > 0)
     * @return Natural logarithm of x (18 decimals, can be negative)
     *
     * Examples:
     *   ln(1e18) = 0                     // ln(1) = 0
     *   ln(2718281828459045235) ≈ 1e18  // ln(e) ≈ 1
     */
    function ln(uint256 x) internal pure returns (int256) {
        if (x == 0) revert LnUndefined();
        return sd(int256(x)).ln().unwrap();
    }

    /**
     * @dev Exponential function (PRBMath SD59x18)
     * @param x Input value (18 decimals, can be negative; reverts above ~133e18)
     * @return exp(x) (18 decimals; 0 below ~-41.4e18)
     *
     * Examples:
     *   exp(0) = 1e18                    // e^0 = 1
     *   exp(1e18) ≈ 2.718e18            // e^1 ≈ 2.718
     *   exp(-1e18) ≈ 0.368e18           // e^-1 ≈ 0.368
     */
    function exp(int256 x) internal pure returns (uint256) {
        return uint256(sd(x).exp().unwrap());
    }

    // ============================================================
    // BONDING CURVE CALCULATIONS
    // ============================================================

    /**
     * @dev Calculate tokens to mint for a buy on bonding curve
     * @param supply Current token supply (18 decimals)
     * @param reserve Current reserve balance (can be 6 or 18 decimals)
     * @param deposit Reserve deposited (same decimals as reserve)
     * @param crrPpm Reserve ratio in parts per million (e.g., 100000 = 10%)
     * @return tokensOut Tokens to mint (18 decimals)
     *
     * Formula: T = S × ((1 + E/R)^w - 1)
     * Where w = crrPpm / 1000000
     *
     * Example (10% CRR):
     *   supply = 1000e18
     *   reserve = 100e6 (100 USDC)
     *   deposit = 10e6 (10 USDC)
     *   crrPpm = 100000 (10%)
     *   Result: ~95.4e18 tokens (approximate)
     */
    function calculateBuy(
        uint256 supply,
        uint256 reserve,
        uint256 deposit,
        uint256 crrPpm
    ) internal pure returns (uint256 tokensOut) {
        if (reserve == 0 || supply == 0) return 0;

        // Calculate ratio = (1 + deposit/reserve) in PRECISION
        // ratio = 1e18 + (deposit × 1e18) / reserve
        uint256 ratio = PRECISION + ((deposit * PRECISION) / reserve);

        // Calculate exponent = crrPpm / 1000000 in PRECISION
        // For 10% CRR (100000 ppm): exponent = 0.1e18
        uint256 exponent = (crrPpm * PRECISION) / PPM;

        // Calculate ratio^exponent
        uint256 power = pow(ratio, exponent);

        // Handle edge case where power <= 1 (no tokens to mint)
        if (power <= PRECISION) return 0;

        // Calculate tokens = supply × (power - 1)
        tokensOut = (supply * (power - PRECISION)) / PRECISION;
    }

    /**
     * @dev Calculate reserve to return for a sell on bonding curve
     * @param supply Current token supply (18 decimals)
     * @param reserve Current reserve balance (can be 6 or 18 decimals)
     * @param tokens Tokens to burn (18 decimals)
     * @param crrPpm Reserve ratio in parts per million
     * @return reserveOut Reserve to return (same decimals as reserve)
     *
     * Formula: F = R × (1 - (1 - T/S)^(1/w))
     * Where 1/w = 1000000 / crrPpm
     *
     * Example (10% CRR):
     *   supply = 1000e18
     *   reserve = 100e6
     *   tokens = 95.4e18
     *   crrPpm = 100000 (10%)
     *   Result: ~10e6 (10 USDC returned)
     */
    function calculateSell(
        uint256 supply,
        uint256 reserve,
        uint256 tokens,
        uint256 crrPpm
    ) internal pure returns (uint256 reserveOut) {
        if (supply == 0 || tokens > supply || reserve == 0) return 0;

        // Calculate tokenRatio = T/S in PRECISION
        uint256 tokenRatio = (tokens * PRECISION) / supply;

        // Calculate base = 1 - T/S
        uint256 base = PRECISION - tokenRatio;

        // Calculate exponent = 1/w = 1000000/crrPpm in PRECISION
        // For 10% CRR (100000 ppm): exponent = 10e18
        uint256 exponent = (PPM * PRECISION) / crrPpm;

        // Calculate base^exponent
        uint256 power = pow(base, exponent);

        // Handle edge case where power >= 1 (no reserve to return)
        if (power >= PRECISION) return 0;

        // Calculate reserveOut = reserve × (1 - power)
        reserveOut = (reserve * (PRECISION - power)) / PRECISION;
    }

    /**
     * @dev Calculate spot price on bonding curve
     * @param supply Current token supply (18 decimals)
     * @param reserve Current reserve balance (6 or 18 decimals)
     * @param crrPpm Reserve ratio in parts per million
     * @return price Price in reserve per token (reserve decimals per 1e18 tokens)
     *
     * Formula: P = R / (w × S)
     *
     * Example (10% CRR):
     *   supply = 1000e18
     *   reserve = 100e6 (USDC)
     *   crrPpm = 100000 (10%)
     *   Result: 1000 (0.001 USDC per token = $0.001)
     */
    function calculateSpotPrice(
        uint256 supply,
        uint256 reserve,
        uint256 crrPpm
    ) internal pure returns (uint256 price) {
        if (supply == 0 || crrPpm == 0) return 0;

        // P = R / (w × S)
        // w = crrPpm / PPM
        // P = (R × PPM) / (crrPpm × S)
        // Need to handle potential overflow/underflow in division
        uint256 denominator = (crrPpm * supply) / PRECISION;
        if (denominator == 0) return 0;

        price = (reserve * PPM) / denominator;
    }

    // ============================================================
    // PRICE IMPACT CALCULATIONS
    // ============================================================

    /**
     * @dev Calculate price impact for a buy in basis points
     * @param supply Current supply
     * @param reserve Current reserve
     * @param deposit Deposit amount
     * @param crrPpm Reserve ratio in PPM
     * @return impactBps Price impact in basis points (100 = 1%, 10000 = 100%)
     *
     * Price impact = (newPrice - oldPrice) / oldPrice × 10000
     */
    function calculateBuyImpact(
        uint256 supply,
        uint256 reserve,
        uint256 deposit,
        uint256 crrPpm
    ) internal pure returns (uint256 impactBps) {
        if (supply == 0 || reserve == 0) return 0;

        uint256 oldPrice = calculateSpotPrice(supply, reserve, crrPpm);
        uint256 tokensOut = calculateBuy(supply, reserve, deposit, crrPpm);
        uint256 newSupply = supply + tokensOut;
        uint256 newReserve = reserve + deposit;
        uint256 newPrice = calculateSpotPrice(newSupply, newReserve, crrPpm);

        if (newPrice <= oldPrice) return 0;
        impactBps = ((newPrice - oldPrice) * 10000) / oldPrice;
    }

    /**
     * @dev Calculate price impact for a sell in basis points
     * @param supply Current supply
     * @param reserve Current reserve
     * @param tokens Tokens to sell
     * @param crrPpm Reserve ratio in PPM
     * @return impactBps Price impact in basis points (negative, represented as positive number)
     */
    function calculateSellImpact(
        uint256 supply,
        uint256 reserve,
        uint256 tokens,
        uint256 crrPpm
    ) internal pure returns (uint256 impactBps) {
        if (supply == 0 || reserve == 0 || tokens > supply) return 0;

        uint256 oldPrice = calculateSpotPrice(supply, reserve, crrPpm);
        uint256 reserveOut = calculateSell(supply, reserve, tokens, crrPpm);
        uint256 newSupply = supply - tokens;
        uint256 newReserve = reserve - reserveOut;

        if (newSupply == 0) return 10000; // 100% impact

        uint256 newPrice = calculateSpotPrice(newSupply, newReserve, crrPpm);

        if (oldPrice <= newPrice) return 0;
        impactBps = ((oldPrice - newPrice) * 10000) / oldPrice;
    }
}
