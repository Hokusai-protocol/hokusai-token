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
     * @dev Fixed-point exponentiation using binary exponentiation
     * @param base Base value (fixed-point)
     * @param exponent Exponent value (fixed-point)
     * @return result base^exponent (fixed-point)
     *
     * Note: This is a simplified implementation. For production,
     * consider using a battle-tested library like PRBMath.
     */
    function _pow(uint256 base, uint256 exponent) internal pure returns (uint256 result) {
        if (exponent == 0) return PRECISION;
        if (base == 0) return 0;
        if (base == PRECISION) return PRECISION;

        // For small exponents, use direct multiplication
        if (exponent <= PRECISION / 10) {
            // Linear approximation for small exponents: (1+x)^n ≈ 1 + nx
            if (base >= PRECISION) {
                uint256 excess = base - PRECISION;
                return PRECISION + ((excess * exponent) / PRECISION);
            } else {
                uint256 deficit = PRECISION - base;
                return PRECISION - ((deficit * exponent) / PRECISION);
            }
        }

        // For larger exponents, use logarithmic approximation
        // ln(x^y) = y * ln(x)
        // This is a simplified version - production should use proper logarithms

        // Binary exponentiation for integer part
        result = PRECISION;
        uint256 base_temp = base;
        uint256 exp_temp = exponent / PRECISION; // Integer part

        while (exp_temp > 0) {
            if (exp_temp % 2 == 1) {
                result = (result * base_temp) / PRECISION;
            }
            base_temp = (base_temp * base_temp) / PRECISION;
            exp_temp /= 2;
        }

        // Handle fractional part with linear approximation
        uint256 fractional = exponent % PRECISION;
        if (fractional > 0 && base != PRECISION) {
            if (base > PRECISION) {
                uint256 excess = base - PRECISION;
                result = result + ((result * excess * fractional) / (PRECISION * PRECISION));
            } else {
                uint256 deficit = PRECISION - base;
                result = result - ((result * deficit * fractional) / (PRECISION * PRECISION));
            }
        }

        return result;
    }
}
