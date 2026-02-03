// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "./TokenManager.sol";
import "./libraries/ValidationLib.sol";
import "./libraries/FeeLib.sol";
import "./libraries/BondingCurveMath.sol";

/**
 * @title HokusaiAMM
 * @dev Two-phase AMM for Hokusai tokens: Fixed price initial period, then CRR bonding curve
 *
 * Phase 1 (Flat Price): Simple pricing until threshold
 * - Price: Fixed (e.g., $0.01 per token)
 * - Formula: tokens = reserveIn / FLAT_CURVE_PRICE
 * - No overflow issues, unlimited trade sizes
 *
 * Phase 2 (Bonding Curve): Exponential pricing after threshold
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
    uint256 public tradeFee; // Trade fee in bps (basis points), default 30 = 0.30%
    uint256 public buyOnlyUntil; // Timestamp when sells become enabled (IBR end)
    uint256 public maxTradeBps; // Maximum trade size as % of reserve in bps, default 2000 = 20%

    // Two-phase pricing parameters (immutable)
    uint256 public immutable FLAT_CURVE_THRESHOLD; // Reserve amount where bonding curve activates (6 decimals)
    uint256 public immutable FLAT_CURVE_PRICE;     // Fixed price during flat period (6 decimals)

    // Graduation flag - once true, permanently in bonding curve phase
    bool public hasGraduated;

    // Constants
    uint256 public constant PRECISION = 1e18; // Fixed-point precision
    uint256 public constant MAX_CRR = 500000; // 50% max
    uint256 public constant MIN_CRR = 50000; // 5% min
    uint256 public constant MAX_TRADE_FEE = 1000; // 10% max
    uint256 public constant MAX_TRADE_BPS_LIMIT = 5000; // 50% max trade size
    uint256 public constant PPM = 1000000; // Parts per million

    // ============================================================
    // ENUMS
    // ============================================================

    enum PricingPhase {
        FLAT_PRICE,      // 0: Before threshold
        BONDING_CURVE    // 1: After threshold
    }

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

    event PhaseTransition(
        PricingPhase fromPhase,
        PricingPhase toPhase,
        uint256 reserveBalance,
        uint256 timestamp
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
        uint256 newTradeFee
    );

    event MaxTradeBpsUpdated(uint256 oldBps, uint256 newBps);

    // ============================================================
    // CONSTRUCTOR
    // ============================================================

    /**
     * @dev Initialize the AMM pool with two-phase pricing
     * @param _reserveToken USDC token address
     * @param _hokusaiToken Hokusai token address
     * @param _tokenManager TokenManager contract address
     * @param _modelId String model identifier
     * @param _treasury Treasury address for fees
     * @param _crr Reserve ratio in ppm
     * @param _tradeFee Trade fee in bps
     * @param _ibrDuration Initial Bonding Round duration in seconds (e.g., 7 days)
     * @param _flatCurveThreshold Reserve amount where bonding curve activates (6 decimals)
     * @param _flatCurvePrice Fixed price per token during flat period (6 decimals)
     */
    constructor(
        address _reserveToken,
        address _hokusaiToken,
        address _tokenManager,
        string memory _modelId,
        address _treasury,
        uint256 _crr,
        uint256 _tradeFee,
        uint256 _ibrDuration,
        uint256 _flatCurveThreshold,
        uint256 _flatCurvePrice
    ) Ownable() {
        // Use ValidationLib for cleaner validation
        ValidationLib.requireNonZeroAddress(_reserveToken, "reserve token");
        ValidationLib.requireNonZeroAddress(_hokusaiToken, "Hokusai token");
        ValidationLib.requireNonZeroAddress(_tokenManager, "token manager");
        ValidationLib.requireNonZeroAddress(_treasury, "treasury");
        ValidationLib.requireNonEmptyString(_modelId, "model ID");
        ValidationLib.requireInBounds(_crr, MIN_CRR, MAX_CRR);
        FeeLib.requireValidFee(_tradeFee, MAX_TRADE_FEE);
        ValidationLib.requirePositiveAmount(_flatCurveThreshold, "flat curve threshold");
        ValidationLib.requirePositiveAmount(_flatCurvePrice, "flat curve price");

        reserveToken = IERC20(_reserveToken);
        hokusaiToken = _hokusaiToken;
        tokenManager = TokenManager(_tokenManager);
        modelId = _modelId;
        treasury = _treasury;
        crr = _crr;
        tradeFee = _tradeFee;
        buyOnlyUntil = block.timestamp + _ibrDuration;
        maxTradeBps = 2000; // Default 20% of reserve

        FLAT_CURVE_THRESHOLD = _flatCurveThreshold;
        FLAT_CURVE_PRICE = _flatCurvePrice;

        // Pool starts with 0 reserve (reserveBalance is already 0 by default)
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

        // Store phase before trade
        PricingPhase phaseBefore = getCurrentPhase();

        // Check trade size limit only in bonding curve phase
        // During flat phase, unlimited trade sizes are allowed
        if (phaseBefore == PricingPhase.BONDING_CURVE) {
            uint256 maxTradeSize = (reserveBalance * maxTradeBps) / 10000;
            require(reserveIn <= maxTradeSize, "Trade exceeds max size limit");
        }

        // Calculate tokens to mint
        tokensOut = getBuyQuote(reserveIn);
        require(tokensOut >= minTokensOut, "Slippage exceeded");
        require(tokensOut > 0, "Insufficient output");

        // Calculate and deduct trade fee using FeeLib
        (uint256 reserveAfterFee, uint256 feeAmount) = FeeLib.applyFee(reserveIn, tradeFee);

        // Transfer USDC from buyer
        require(
            reserveToken.transferFrom(msg.sender, address(this), reserveIn),
            "Reserve transfer failed"
        );

        // Update reserve balance (excluding fee)
        reserveBalance += reserveAfterFee;

        // Check for graduation to bonding curve phase (permanent)
        if (!hasGraduated && reserveBalance >= FLAT_CURVE_THRESHOLD) {
            hasGraduated = true;
        }

        // Transfer fee to treasury
        if (feeAmount > 0) {
            require(
                reserveToken.transfer(treasury, feeAmount),
                "Fee transfer failed"
            );
        }

        // Mint tokens via TokenManager
        tokenManager.mintTokens(modelId, to, tokensOut);

        // Check if phase changed after trade
        PricingPhase phaseAfter = getCurrentPhase();
        if (phaseBefore != phaseAfter) {
            emit PhaseTransition(phaseBefore, phaseAfter, reserveBalance, block.timestamp);
        }

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

        // Check trade size limit (prevents whale manipulation and flash loan attacks)
        uint256 maxTradeSize = (reserveBalance * maxTradeBps) / 10000;
        require(reserveOut <= maxTradeSize, "Trade exceeds max size limit");

        // Calculate and deduct trade fee using FeeLib
        (uint256 reserveAfterFee, uint256 feeAmount) = FeeLib.applyFee(reserveOut, tradeFee);

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
     * Handles three cases:
     * 1. Entirely in flat price phase
     * 2. Entirely in bonding curve phase
     * 3. Trade crosses threshold (hybrid calculation)
     */
    function getBuyQuote(uint256 reserveIn) public view returns (uint256 tokensOut) {
        if (reserveIn == 0) return 0;

        uint256 supply = IERC20(hokusaiToken).totalSupply();
        uint256 futureReserve = reserveBalance + reserveIn;

        // Case 1: Entirely in flat price phase
        if (futureReserve <= FLAT_CURVE_THRESHOLD) {
            return _calculateFlatPriceTokens(reserveIn);
        }

        // Case 2: Entirely in bonding curve phase
        if (reserveBalance >= FLAT_CURVE_THRESHOLD) {
            return _calculateBondingCurveTokens(reserveIn, reserveBalance, supply);
        }

        // Case 3: Trade crosses threshold (hybrid calculation)
        uint256 flatPortion = FLAT_CURVE_THRESHOLD - reserveBalance;
        uint256 curvePortion = reserveIn - flatPortion;

        // Calculate tokens from flat price portion
        uint256 tokensFromFlat = _calculateFlatPriceTokens(flatPortion);

        // Calculate tokens from bonding curve portion
        // Use threshold as starting reserve and adjusted supply
        uint256 adjustedSupply = supply + tokensFromFlat;
        uint256 tokensFromCurve = _calculateBondingCurveTokens(
            curvePortion,
            FLAT_CURVE_THRESHOLD,
            adjustedSupply
        );

        return tokensFromFlat + tokensFromCurve;
    }

    /**
     * @dev Calculate USDC out for a given token amount
     * @param tokensIn Amount of tokens to sell
     * @return reserveOut USDC to be returned
     *
     * Uses flat price during flat phase, bonding curve formula otherwise
     */
    function getSellQuote(uint256 tokensIn) public view returns (uint256 reserveOut) {
        if (tokensIn == 0) return 0;

        uint256 supply = IERC20(hokusaiToken).totalSupply();
        if (supply == 0 || tokensIn > supply) return 0;
        if (reserveBalance == 0) return 0;

        // If we're in flat price phase, use flat pricing
        if (reserveBalance < FLAT_CURVE_THRESHOLD) {
            // Selling at fixed price (fee applied in sell() function)
            reserveOut = (tokensIn * FLAT_CURVE_PRICE) / 1e18;
            return reserveOut;
        }

        // Use BondingCurveMath library for bonding curve sell calculation
        reserveOut = BondingCurveMath.calculateSell(
            supply,
            reserveBalance,
            tokensIn,
            crr
        );
    }

    /**
     * @dev Get current spot price
     * @return Current price in USDC per token (6 decimals)
     *
     * Returns flat price during flat phase, bonding curve formula otherwise
     */
    function spotPrice() public view returns (uint256) {
        uint256 supply = IERC20(hokusaiToken).totalSupply();

        // During flat price phase, return fixed price
        if (reserveBalance < FLAT_CURVE_THRESHOLD) {
            return FLAT_CURVE_PRICE;
        }

        // After threshold, use bonding curve formula
        if (supply == 0 || reserveBalance == 0) {
            return FLAT_CURVE_PRICE; // Default to flat price
        }

        // P = R / (w × S)
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
    // ANALYTICS & VIEW FUNCTIONS
    // ============================================================

    /**
     * @dev Get comprehensive pool state
     * @return reserve Current USDC reserve balance
     * @return supply Current token supply
     * @return price Current spot price (6 decimals)
     * @return reserveRatio CRR in PPM
     * @return tradeFeeRate Trade fee in bps
     */
    function getPoolState()
        external
        view
        returns (
            uint256 reserve,
            uint256 supply,
            uint256 price,
            uint256 reserveRatio,
            uint256 tradeFeeRate
        )
    {
        reserve = reserveBalance;
        supply = IERC20(hokusaiToken).totalSupply();
        price = spotPrice();
        reserveRatio = crr;
        tradeFeeRate = tradeFee;
    }

    /**
     * @dev Get trading status information
     * @return sellsEnabled Whether sells are currently enabled
     * @return ibrEndTime Timestamp when IBR period ends
     * @return isPaused Whether trading is paused
     */
    function getTradeInfo()
        external
        view
        returns (
            bool sellsEnabled,
            uint256 ibrEndTime,
            bool isPaused
        )
    {
        sellsEnabled = isSellEnabled();
        ibrEndTime = buyOnlyUntil;
        isPaused = paused();
    }

    /**
     * @dev Calculate price impact for a buy
     * @param reserveIn Amount of USDC to deposit
     * @return tokensOut Tokens that would be minted
     * @return priceImpact Price impact in bps (10000 = 100%)
     * @return newSpotPrice Spot price after trade
     */
    function calculateBuyImpact(uint256 reserveIn)
        external
        view
        returns (
            uint256 tokensOut,
            uint256 priceImpact,
            uint256 newSpotPrice
        )
    {
        require(reserveIn > 0, "Amount must be > 0");

        uint256 currentSpot = spotPrice();
        tokensOut = getBuyQuote(reserveIn);

        // Calculate new spot price after trade
        // New reserve = current + reserveIn (after fee)
        uint256 feeAmount = (reserveIn * tradeFee) / 10000;
        uint256 newReserve = reserveBalance + (reserveIn - feeAmount);
        uint256 newSupply = IERC20(hokusaiToken).totalSupply() + tokensOut;

        // P = (R * PPM * 1e18) / (crr * S)
        newSpotPrice = (newReserve * PPM * 1e18) / (crr * newSupply);

        // Price impact = (newPrice - oldPrice) / oldPrice * 10000
        if (currentSpot > 0) {
            if (newSpotPrice > currentSpot) {
                priceImpact = ((newSpotPrice - currentSpot) * 10000) / currentSpot;
            } else {
                priceImpact = 0; // Price decreased (shouldn't happen on buy)
            }
        } else {
            priceImpact = 0;
        }
    }

    /**
     * @dev Calculate price impact for a sell
     * @param tokensIn Amount of tokens to sell
     * @return reserveOut USDC that would be returned
     * @return priceImpact Price impact in bps (10000 = 100%)
     * @return newSpotPrice Spot price after trade
     */
    function calculateSellImpact(uint256 tokensIn)
        external
        view
        returns (
            uint256 reserveOut,
            uint256 priceImpact,
            uint256 newSpotPrice
        )
    {
        require(tokensIn > 0, "Amount must be > 0");

        uint256 currentSpot = spotPrice();
        reserveOut = getSellQuote(tokensIn);

        // Calculate new spot price after trade
        // New supply = current - tokensIn
        uint256 newSupply = IERC20(hokusaiToken).totalSupply() - tokensIn;
        // New reserve = current - reserveOut
        uint256 newReserve = reserveBalance - reserveOut;

        if (newSupply > 0) {
            // P = (R * PPM * 1e18) / (crr * S)
            newSpotPrice = (newReserve * PPM * 1e18) / (crr * newSupply);
        } else {
            newSpotPrice = 0;
        }

        // Price impact = (oldPrice - newPrice) / oldPrice * 10000
        if (currentSpot > 0) {
            if (currentSpot > newSpotPrice) {
                priceImpact = ((currentSpot - newSpotPrice) * 10000) / currentSpot;
            } else {
                priceImpact = 0; // Price increased (shouldn't happen on sell)
            }
        } else {
            priceImpact = 0;
        }
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

        // Check for graduation to bonding curve phase (permanent)
        if (!hasGraduated && reserveBalance >= FLAT_CURVE_THRESHOLD) {
            hasGraduated = true;
        }

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
     */
    function setParameters(
        uint256 newCrr,
        uint256 newTradeFee
    ) external onlyOwner {
        require(newCrr >= MIN_CRR && newCrr <= MAX_CRR, "CRR out of bounds");
        require(newTradeFee <= MAX_TRADE_FEE, "Trade fee too high");

        crr = newCrr;
        tradeFee = newTradeFee;

        emit ParametersUpdated(newCrr, newTradeFee);
    }

    /**
     * @dev Update maximum trade size limit
     * @param newMaxTradeBps New max trade size in bps (basis points)
     *
     * Security: Prevents whale manipulation and flash loan attacks by limiting
     * single-transaction trade sizes relative to reserve balance.
     *
     * Range: 0 bps (disabled) to 5000 bps (50% max)
     * Default: 2000 bps (20% of reserve)
     */
    function setMaxTradeBps(uint256 newMaxTradeBps) external onlyOwner {
        require(newMaxTradeBps > 0, "Max trade bps must be > 0");
        require(newMaxTradeBps <= MAX_TRADE_BPS_LIMIT, "Max trade bps too high");

        emit MaxTradeBpsUpdated(maxTradeBps, newMaxTradeBps);
        maxTradeBps = newMaxTradeBps;
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
    // PHASE DETECTION
    // ============================================================

    /**
     * @dev Get current pricing phase
     * @return Current phase (FLAT_PRICE or BONDING_CURVE)
     * @notice Once graduated to bonding curve, phase is permanent regardless of reserve level
     */
    function getCurrentPhase() public view returns (PricingPhase) {
        if (hasGraduated) {
            return PricingPhase.BONDING_CURVE;
        }
        if (reserveBalance < FLAT_CURVE_THRESHOLD) {
            return PricingPhase.FLAT_PRICE;
        }
        return PricingPhase.BONDING_CURVE;
    }

    /**
     * @dev Get detailed phase information for frontend
     * @return currentPhase Current pricing phase
     * @return currentReserve Current reserve balance
     * @return thresholdReserve Threshold for phase transition
     * @return flatPrice Fixed price during flat period
     * @return percentToThreshold Progress toward threshold (0-100)
     */
    function getPhaseInfo() external view returns (
        PricingPhase currentPhase,
        uint256 currentReserve,
        uint256 thresholdReserve,
        uint256 flatPrice,
        uint256 percentToThreshold
    ) {
        currentPhase = getCurrentPhase();
        currentReserve = reserveBalance;
        thresholdReserve = FLAT_CURVE_THRESHOLD;
        flatPrice = FLAT_CURVE_PRICE;

        if (currentReserve >= FLAT_CURVE_THRESHOLD) {
            percentToThreshold = 100;
        } else if (FLAT_CURVE_THRESHOLD > 0) {
            percentToThreshold = (currentReserve * 100) / FLAT_CURVE_THRESHOLD;
        } else {
            percentToThreshold = 100;
        }
    }

    // ============================================================
    // INTERNAL CALCULATION FUNCTIONS
    // ============================================================

    /**
     * @dev Calculate tokens received for USDC at flat price
     * @param reserveIn Amount of USDC (6 decimals)
     * @return tokensOut Amount of tokens (18 decimals)
     */
    function _calculateFlatPriceTokens(uint256 reserveIn) internal view returns (uint256) {
        // Deduct trade fee using FeeLib
        (uint256 reserveAfterFee, ) = FeeLib.applyFee(reserveIn, tradeFee);

        // Simple fixed price calculation
        // USDC is 6 decimals, token is 18 decimals
        // reserveAfterFee is in USDC units (6 decimals)
        // FLAT_CURVE_PRICE is in USDC per token (6 decimals)
        // Result should be in token units (18 decimals)

        uint256 tokensOut = (reserveAfterFee * 1e18) / FLAT_CURVE_PRICE;
        return tokensOut;
    }

    /**
     * @dev Calculate tokens received using bonding curve formula
     * @param reserveIn Amount of USDC to spend (6 decimals)
     * @param currentReserve Current reserve balance (6 decimals)
     * @param currentSupply Current token supply (18 decimals)
     * @return tokensOut Amount of tokens (18 decimals)
     *
     * Formula: T = S × ((1 + E/R)^w - 1)
     */
    function _calculateBondingCurveTokens(
        uint256 reserveIn,
        uint256 currentReserve,
        uint256 currentSupply
    ) internal view returns (uint256) {
        if (currentReserve == 0 || currentSupply == 0) {
            // Safety fallback to flat pricing
            return _calculateFlatPriceTokens(reserveIn);
        }

        // Deduct trade fee using FeeLib
        (uint256 reserveAfterFee, ) = FeeLib.applyFee(reserveIn, tradeFee);

        // Use BondingCurveMath library for bonding curve calculation
        return BondingCurveMath.calculateBuy(
            currentSupply,
            currentReserve,
            reserveAfterFee,
            crr
        );
    }

    // ============================================================
    // NOTE: Mathematical functions (_pow, _ln, _exp) have been
    // extracted to BondingCurveMath library for reusability
    // ============================================================
}
