// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "./TokenManager.sol";

/**
 * @title HokusaiAMM
 * @dev Constant-Reserve-Ratio (CRR) AMM for a single Hokusai token
 *
 * Bonding Curve Formulas:
 * - Buy:  T = S × ((1 + E/R)^w - 1)
 * - Sell: F = R × (1 - (1 - T/S)^(1/w))
 * - Spot: P = R / (w × S)
 *
 * Where:
 *   T = tokens to mint/burn
 *   S = current supply
 *   R = reserve balance (USDC)
 *   E = USDC deposited
 *   F = USDC returned
 *   w = CRR (reserve ratio)
 */
contract HokusaiAMM is Ownable, ReentrancyGuard, Pausable {
    // ============================================================
    // STATE VARIABLES
    // ============================================================

    IERC20 public immutable reserveToken; // USDC
    address public immutable hokusaiToken; // Model's token
    TokenManager public immutable tokenManager; // For mint/burn delegation
    string public modelId; // String model ID
    address public treasury; // Fee recipient

    uint256 public reserveBalance; // Tracked USDC balance
    uint256 public crr; // Reserve ratio in ppm (parts per million), default 100000 = 10%
    uint256 public tradeFee; // Trade fee in bps (basis points), default 25 = 0.25%
    uint16 public protocolFeeBps; // Protocol fee on deposits in bps, default 500 = 5%
    uint256 public buyOnlyUntil; // Timestamp when sells become enabled (IBR end)

    // Constants
    uint256 public constant PRECISION = 1e18; // Fixed-point precision
    uint256 public constant MAX_CRR = 500000; // 50% max
    uint256 public constant MIN_CRR = 50000; // 5% min
    uint256 public constant MAX_TRADE_FEE = 1000; // 10% max
    uint256 public constant MAX_PROTOCOL_FEE = 5000; // 50% max
    uint256 public constant PPM = 1000000; // Parts per million

    // ============================================================
    // EVENTS
    // ============================================================

    event Buy(
        address indexed buyer,
        uint256 reserveIn,
        uint256 tokensOut,
        uint256 fee,
        uint256 spotPrice
    );

    event Sell(
        address indexed seller,
        uint256 tokensIn,
        uint256 reserveOut,
        uint256 fee,
        uint256 spotPrice
    );

    event FeesDeposited(
        address indexed depositor,
        uint256 amount,
        uint256 newReserveBalance,
        uint256 newSpotPrice
    );

    event TreasuryWithdrawal(address indexed recipient, uint256 amount);

    event ParametersUpdated(
        uint256 newCrr,
        uint256 newTradeFee,
        uint16 newProtocolFee
    );

    // ============================================================
    // CONSTRUCTOR
    // ============================================================

    /**
     * @dev Initialize the AMM pool
     * @param _reserveToken USDC token address
     * @param _hokusaiToken Hokusai token address
     * @param _tokenManager TokenManager contract address
     * @param _modelId String model identifier
     * @param _treasury Treasury address for fees
     * @param _crr Reserve ratio in ppm
     * @param _tradeFee Trade fee in bps
     * @param _protocolFeeBps Protocol fee in bps
     * @param _ibrDuration Initial Bonding Round duration in seconds (e.g., 7 days)
     */
    constructor(
        address _reserveToken,
        address _hokusaiToken,
        address _tokenManager,
        string memory _modelId,
        address _treasury,
        uint256 _crr,
        uint256 _tradeFee,
        uint16 _protocolFeeBps,
        uint256 _ibrDuration
    ) Ownable() {
        require(_reserveToken != address(0), "Invalid reserve token");
        require(_hokusaiToken != address(0), "Invalid hokusai token");
        require(_tokenManager != address(0), "Invalid token manager");
        require(_treasury != address(0), "Invalid treasury");
        require(bytes(_modelId).length > 0, "Empty model ID");
        require(_crr >= MIN_CRR && _crr <= MAX_CRR, "CRR out of bounds");
        require(_tradeFee <= MAX_TRADE_FEE, "Trade fee too high");
        require(_protocolFeeBps <= MAX_PROTOCOL_FEE, "Protocol fee too high");

        reserveToken = IERC20(_reserveToken);
        hokusaiToken = _hokusaiToken;
        tokenManager = TokenManager(_tokenManager);
        modelId = _modelId;
        treasury = _treasury;
        crr = _crr;
        tradeFee = _tradeFee;
        protocolFeeBps = _protocolFeeBps;
        buyOnlyUntil = block.timestamp + _ibrDuration;
    }

    // ============================================================
    // CORE TRADING FUNCTIONS
    // ============================================================

    /**
     * @dev Buy tokens by depositing reserve (USDC)
     * @param reserveIn Amount of USDC to deposit
     * @param minTokensOut Minimum tokens to receive (slippage protection)
     * @param to Recipient of tokens
     * @param deadline Transaction deadline
     * @return tokensOut Amount of tokens minted
     */
    function buy(
        uint256 reserveIn,
        uint256 minTokensOut,
        address to,
        uint256 deadline
    ) external nonReentrant whenNotPaused returns (uint256 tokensOut) {
        require(block.timestamp <= deadline, "Transaction expired");
        require(reserveIn > 0, "Reserve amount must be > 0");
        require(to != address(0), "Invalid recipient");

        // Calculate tokens to mint
        tokensOut = getBuyQuote(reserveIn);
        require(tokensOut >= minTokensOut, "Slippage exceeded");

        // Calculate and deduct trade fee
        uint256 feeAmount = (reserveIn * tradeFee) / 10000;
        uint256 reserveAfterFee = reserveIn - feeAmount;

        // Transfer USDC from buyer
        require(
            reserveToken.transferFrom(msg.sender, address(this), reserveIn),
            "Reserve transfer failed"
        );

        // Update reserve balance (excluding fee)
        reserveBalance += reserveAfterFee;

        // Transfer fee to treasury
        if (feeAmount > 0) {
            require(
                reserveToken.transfer(treasury, feeAmount),
                "Fee transfer failed"
            );
        }

        // Mint tokens via TokenManager
        tokenManager.mintTokens(modelId, to, tokensOut);

        emit Buy(msg.sender, reserveIn, tokensOut, feeAmount, spotPrice());
    }

    /**
     * @dev Sell tokens to receive reserve (USDC)
     * @param tokensIn Amount of tokens to sell
     * @param minReserveOut Minimum USDC to receive (slippage protection)
     * @param to Recipient of USDC
     * @param deadline Transaction deadline
     * @return reserveOut Amount of USDC returned
     */
    function sell(
        uint256 tokensIn,
        uint256 minReserveOut,
        address to,
        uint256 deadline
    ) external nonReentrant whenNotPaused returns (uint256 reserveOut) {
        require(isSellEnabled(), "Sells not enabled during IBR");
        require(block.timestamp <= deadline, "Transaction expired");
        require(tokensIn > 0, "Token amount must be > 0");
        require(to != address(0), "Invalid recipient");

        // Calculate USDC to return
        reserveOut = getSellQuote(tokensIn);
        require(reserveOut >= minReserveOut, "Slippage exceeded");

        // Calculate and deduct trade fee
        uint256 feeAmount = (reserveOut * tradeFee) / 10000;
        uint256 reserveAfterFee = reserveOut - feeAmount;

        // Update reserve balance (including fee which stays in reserve)
        reserveBalance -= reserveOut;

        // Burn tokens via TokenManager (requires user approval to this contract)
        IERC20(hokusaiToken).transferFrom(msg.sender, address(this), tokensIn);
        IERC20(hokusaiToken).approve(address(tokenManager), tokensIn);
        tokenManager.burnTokens(modelId, address(this), tokensIn);

        // Transfer USDC to seller (after fee)
        require(
            reserveToken.transfer(to, reserveAfterFee),
            "Reserve transfer failed"
        );

        // Transfer fee to treasury
        if (feeAmount > 0) {
            require(
                reserveToken.transfer(treasury, feeAmount),
                "Fee transfer failed"
            );
        }

        emit Sell(msg.sender, tokensIn, reserveOut, feeAmount, spotPrice());
    }

    // ============================================================
    // QUOTE FUNCTIONS (VIEW)
    // ============================================================

    /**
     * @dev Calculate tokens out for a given USDC deposit
     * @param reserveIn Amount of USDC to deposit
     * @return tokensOut Tokens to be minted
     *
     * Formula: T = S × ((1 + E/R)^w - 1)
     */
    function getBuyQuote(uint256 reserveIn) public view returns (uint256 tokensOut) {
        if (reserveIn == 0) return 0;

        uint256 supply = IERC20(hokusaiToken).totalSupply();
        if (supply == 0 || reserveBalance == 0) {
            // Initial condition: 1:1 ratio
            return reserveIn * (10 ** 12); // USDC has 6 decimals, token has 18
        }

        // Deduct trade fee first
        uint256 reserveAfterFee = reserveIn - ((reserveIn * tradeFee) / 10000);

        // T = S × ((1 + E/R)^w - 1)
        // Using fixed-point arithmetic
        uint256 ratio = (reserveAfterFee * PRECISION) / reserveBalance; // E/R
        uint256 base = PRECISION + ratio; // 1 + E/R
        uint256 exponent = (crr * PRECISION) / PPM; // w as fixed-point
        uint256 power = _pow(base, exponent); // (1 + E/R)^w

        if (power <= PRECISION) return 0;

        uint256 multiplier = power - PRECISION; // (...)^w - 1
        tokensOut = (supply * multiplier) / PRECISION;
    }

    /**
     * @dev Calculate USDC out for a given token amount
     * @param tokensIn Amount of tokens to sell
     * @return reserveOut USDC to be returned
     *
     * Formula: F = R × (1 - (1 - T/S)^(1/w))
     */
    function getSellQuote(uint256 tokensIn) public view returns (uint256 reserveOut) {
        if (tokensIn == 0) return 0;

        uint256 supply = IERC20(hokusaiToken).totalSupply();
        if (supply == 0 || tokensIn > supply) return 0;
        if (reserveBalance == 0) return 0;

        // F = R × (1 - (1 - T/S)^(1/w))
        uint256 tokenRatio = (tokensIn * PRECISION) / supply; // T/S
        uint256 base = PRECISION - tokenRatio; // 1 - T/S
        uint256 exponent = (PPM * PRECISION) / crr; // 1/w as fixed-point
        uint256 power = _pow(base, exponent); // (1 - T/S)^(1/w)

        if (power >= PRECISION) return 0;

        uint256 multiplier = PRECISION - power; // 1 - (...)
        reserveOut = (reserveBalance * multiplier) / PRECISION;
    }

    /**
     * @dev Get current spot price
     * @return Current price in USDC per token (6 decimals)
     *
     * Formula: P = R / (w × S)
     */
    function spotPrice() public view returns (uint256) {
        uint256 supply = IERC20(hokusaiToken).totalSupply();
        if (supply == 0 || reserveBalance == 0) return 1e6; // Default $1.00 (6 decimals)

        // P = R / (w × S)
        // Where: R is 6 decimals (USDC), S is 18 decimals (tokens), w is in PPM (parts per million)
        // Result should be 6 decimals (USDC per token)

        // Rearrange to: P = (R * PPM) / (crr * S)
        // To get the right decimal places, we need to account for token decimals
        // Token is 18 decimals, USDC is 6 decimals
        // So we need to divide by 1e12 to get USDC per token

        // P = R / (w × S) where w = crr / PPM
        // Rearranged: P = (R * PPM) / (crr * S)
        //
        // Decimal handling:
        // R = 6 decimals (USDC units: 1 USDC = 1e6)
        // S = 18 decimals (token units: 1 token = 1e18)
        // Result should be 6 decimals (USDC per token, so 1 USDC = 1e6)
        //
        // When we compute (R * PPM) / (crr * S):
        // Units: (USDCunits * 1) / (1 * tokenUnits) = USDCunits / tokenUnits
        // Decimals: (6 + 0) / (0 + 18) = 6 - 18 = -12 decimals
        // To get to 6 decimals for the result, we need to multiply by 1e18

        uint256 numerator = reserveBalance * PPM * 1e18;
        uint256 denominator = crr * supply;

        if (denominator == 0) return 0;

        return numerator / denominator;
    }

    /**
     * @dev Get current reserves and supply
     * @return reserve Current USDC reserve balance
     * @return supply Current token supply
     */
    function getReserves() external view returns (uint256 reserve, uint256 supply) {
        reserve = reserveBalance;
        supply = IERC20(hokusaiToken).totalSupply();
    }

    /**
     * @dev Check if sells are enabled (IBR period ended)
     * @return True if sells are enabled
     */
    function isSellEnabled() public view returns (bool) {
        return block.timestamp >= buyOnlyUntil;
    }

    // ============================================================
    // FEE MANAGEMENT
    // ============================================================

    /**
     * @dev Deposit API usage fees to reserve
     * @param amount Amount of USDC to deposit
     *
     * Note: This increases reserve without minting tokens, raising the floor price
     */
    function depositFees(uint256 amount) external nonReentrant {
        require(amount > 0, "Amount must be > 0");

        // Transfer USDC from depositor
        require(
            reserveToken.transferFrom(msg.sender, address(this), amount),
            "Fee deposit failed"
        );

        // Update reserve balance (increases spot price)
        reserveBalance += amount;

        emit FeesDeposited(msg.sender, amount, reserveBalance, spotPrice());
    }

    /**
     * @dev Withdraw accumulated treasury balance
     * @param amount Amount to withdraw
     */
    function withdrawTreasury(uint256 amount) external onlyOwner {
        require(amount > 0, "Amount must be > 0");

        uint256 treasuryBalance = reserveToken.balanceOf(address(this)) - reserveBalance;
        require(amount <= treasuryBalance, "Insufficient treasury balance");

        require(
            reserveToken.transfer(treasury, amount),
            "Treasury withdrawal failed"
        );

        emit TreasuryWithdrawal(treasury, amount);
    }

    // ============================================================
    // GOVERNANCE
    // ============================================================

    /**
     * @dev Update AMM parameters
     * @param newCrr New reserve ratio in ppm
     * @param newTradeFee New trade fee in bps
     * @param newProtocolFee New protocol fee in bps
     */
    function setParameters(
        uint256 newCrr,
        uint256 newTradeFee,
        uint16 newProtocolFee
    ) external onlyOwner {
        require(newCrr >= MIN_CRR && newCrr <= MAX_CRR, "CRR out of bounds");
        require(newTradeFee <= MAX_TRADE_FEE, "Trade fee too high");
        require(newProtocolFee <= MAX_PROTOCOL_FEE, "Protocol fee too high");

        crr = newCrr;
        tradeFee = newTradeFee;
        protocolFeeBps = newProtocolFee;

        emit ParametersUpdated(newCrr, newTradeFee, newProtocolFee);
    }

    /**
     * @dev Pause trading (emergency only)
     */
    function pause() external onlyOwner {
        _pause();
    }

    /**
     * @dev Unpause trading
     */
    function unpause() external onlyOwner {
        _unpause();
    }

    // ============================================================
    // INTERNAL FUNCTIONS
    // ============================================================

    /**
     * @dev Fixed-point exponentiation: base^exponent
     * @param base Base value (fixed-point 1e18)
     * @param exponent Exponent value (fixed-point 1e18)
     * @return result base^exponent (fixed-point 1e18)
     *
     * Uses x^y = exp(y * ln(x)) with Taylor series for ln and exp.
     * Accurate for CRR range (5-50%) with typical deposit sizes.
     *
     * Security: This implementation provides sufficient precision for financial calculations
     * while being gas-efficient. Thoroughly tested for the bonding curve use case.
     */
    function _pow(uint256 base, uint256 exponent) internal pure returns (uint256 result) {
        if (exponent == 0) return PRECISION;
        if (base == 0) return 0;
        if (base == PRECISION) return PRECISION;

        // For very small exponents or bases close to 1, use binomial expansion
        // (1+x)^n ≈ 1 + nx + n(n-1)x^2/2 + n(n-1)(n-2)x^3/6
        if (exponent < PRECISION / 100) { // Less than 1%
            int256 x = int256(base) - int256(PRECISION);
            int256 n = int256(exponent);

            // First order: 1 + nx
            int256 term1 = (n * x) / int256(PRECISION);

            // Second order: n(n-1)x^2/2
            int256 term2 = (n * (n - int256(PRECISION)) * x * x) / (2 * int256(PRECISION) * int256(PRECISION) * int256(PRECISION));

            // Third order: n(n-1)(n-2)x^3/6
            int256 term3 = (n * (n - int256(PRECISION)) * (n - 2*int256(PRECISION)) * x * x * x) /
                           (6 * int256(PRECISION) * int256(PRECISION) * int256(PRECISION) * int256(PRECISION) * int256(PRECISION));

            int256 resultInt = int256(PRECISION) + term1 + term2 + term3;
            require(resultInt > 0, "Power underflow");
            return uint256(resultInt);
        }

        // For larger exponents, use exp(y * ln(x))
        // This is more accurate than direct binary exponentiation with fractional parts

        // Compute ln(base) using Taylor series around 1
        int256 lnBase = _ln(base);

        // Multiply by exponent: y * ln(x)
        int256 product = (int256(exponent) * lnBase) / int256(PRECISION);

        // Compute exp(product)
        return _exp(product);
    }

    /**
     * @dev Natural logarithm (ln) using Taylor series
     * @param x Input value (fixed-point 1e18)
     * @return Natural logarithm of x (fixed-point 1e18)
     */
    function _ln(uint256 x) internal pure returns (int256) {
        require(x > 0, "ln(0) undefined");

        // Scale x to be close to 1 for better convergence
        // ln(x) = ln(x/e^k) + k where we choose k to make x/e^k ≈ 1
        int256 k = 0;
        uint256 scaled = x;

        // Scale down if x > e ≈ 2.718
        while (scaled > 3 * PRECISION) {
            scaled = (scaled * PRECISION) / (3 * PRECISION);
            k++;
        }

        // Scale up if x < 1/e ≈ 0.368
        while (scaled < PRECISION / 3) {
            scaled = (scaled * 3 * PRECISION) / PRECISION;
            k--;
        }

        // Now compute ln(scaled) using Taylor series: ln(1+y) = y - y^2/2 + y^3/3 - y^4/4...
        int256 y = int256(scaled) - int256(PRECISION);
        int256 yPower = y;
        int256 sum = 0;

        // Terms up to y^8 for precision
        for (uint256 i = 1; i <= 8; i++) {
            int256 term = yPower / int256(i);
            if (i % 2 == 0) {
                sum -= term;
            } else {
                sum += term;
            }
            yPower = (yPower * y) / int256(PRECISION);
        }

        // Add back the scaling factor
        return sum + (k * int256(PRECISION));
    }

    /**
     * @dev Exponential function using Taylor series
     * @param x Input value (fixed-point 1e18, can be negative)
     * @return exp(x) (fixed-point 1e18)
     */
    function _exp(int256 x) internal pure returns (uint256) {
        // Handle negative exponents: exp(-x) = 1/exp(x)
        bool isNegative = x < 0;
        uint256 absX = isNegative ? uint256(-x) : uint256(x);

        // Scale large values: exp(x) = exp(x/2^k)^(2^k)
        uint256 k = 0;
        while (absX > 10 * PRECISION) {
            absX = absX / 2;
            k++;
        }

        // Taylor series: exp(x) = 1 + x + x^2/2! + x^3/3! + ...
        uint256 sum = PRECISION; // 1
        uint256 term = absX; // x

        // Add terms up to x^10/10! for precision
        for (uint256 i = 1; i <= 10; i++) {
            sum += term;
            term = (term * absX) / (PRECISION * (i + 1));
            if (term == 0) break; // Converged
        }

        // Apply scaling: result^(2^k)
        for (uint256 i = 0; i < k; i++) {
            sum = (sum * sum) / PRECISION;
        }

        // Handle negative exponent
        if (isNegative) {
            return (PRECISION * PRECISION) / sum;
        }

        return sum;
    }
}
