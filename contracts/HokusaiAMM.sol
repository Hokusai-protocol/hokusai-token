// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/security/PausableUpgradeable.sol";
import "./TokenManager.sol";
import "./interfaces/IPurchaserWhitelist.sol";
import "./libraries/ValidationLib.sol";
import "./libraries/FeeLib.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";
import {ud} from "@prb/math/src/UD60x18.sol";

/**
 * @title HokusaiAMM
 * @dev Two-phase AMM for Hokusai tokens: Fixed price initial period, then CRR bonding curve
 *
 * Phase 1 (Flat Price): Simple pricing until threshold
 * - Price: Fixed (e.g., $0.01 per token)
 * - Formula: tokens = reserveIn / FLAT_CURVE_PRICE
 * - No overflow issues, unlimited trade sizes
 *
 * Phase 2 (Bonding Curve): once the reserve reaches the threshold the pool
 * graduates (permanently) and records the graduation supply S_g. From then on
 * the reserve R backs the redeemable supply S along a fixed curve shape f:
 *
 *   f(s) = s                                   for s <= S_g
 *   f(s) = S_g × ((1 - w) + w × (s/S_g)^(1/w))  for s >  S_g
 *
 * scaled to the actual reserve, k = R / f(S). Spot is k × f'(S): constant
 * (reserve per token) up to S_g, then the CRR curve, with the slope matching
 * at S_g so the price does not jump at graduation (HOK-3317). Trades move
 * along the curve with k fixed:
 * - Buy E:  f(S') = f(S) × (R + E) / R
 * - Sell T: F = R × (f(S) - f(S - T)) / f(S)
 * Selling the whole supply returns the whole reserve, so fees deposited to
 * the reserve (before or after graduation) raise every holder's value pro
 * rata, and a buy followed by a sell cannot return more than was paid.
 * Above S_g this is the Bancor curve on the reserve above (1 - w) × k × S_g.
 * Supply that enters or leaves without a pool trade (reward and supplier
 * unlocks, vesting claims, tokens sent to the vault) rescales S_g in
 * proportion, so it dilutes or concentrates every holder evenly instead of
 * moving the pool along the curve.
 *
 * Where:
 *   S = redeemable supply, R = reserve balance (USDC), w = CRR
 *
 * Upgradeability: each pool is a TransparentUpgradeableProxy over a shared
 * implementation, so fixes keep the pool address and state. Configuration that
 * was immutable (tokens, TokenManager, flat-phase threshold and price) is set
 * once in initialize() and has no setters. Append new state only, and shrink
 * __gap by the same number of slots.
 */
contract HokusaiAMM is Initializable, OwnableUpgradeable, ReentrancyGuardUpgradeable, PausableUpgradeable {
    error NotWhitelisted(address buyer);

    // ============================================================
    // STATE VARIABLES
    // ============================================================

    IERC20 public reserveToken; // USDC (set once in initialize)
    address public hokusaiToken; // Model's token (set once in initialize)
    TokenManager public tokenManager; // For mint/burn delegation (set once in initialize)
    string public modelId; // String model ID
    address public treasury; // Fee recipient

    uint256 public reserveBalance; // Tracked USDC balance
    uint256 public crr; // Reserve ratio in ppm (parts per million), default 100000 = 10%
    uint256 public tradeFee; // Trade fee in bps (basis points), default 30 = 0.30%
    uint256 public buyOnlyUntil; // Timestamp when sells become enabled (IBR end)
    uint256 public maxTradeBps; // Maximum trade size as % of reserve in bps, default 2000 = 20%
    IPurchaserWhitelist public purchaserWhitelist;

    // Two-phase pricing parameters (set once in initialize, no setters)
    uint256 public FLAT_CURVE_THRESHOLD; // Reserve amount where bonding curve activates (6 decimals)
    uint256 public FLAT_CURVE_PRICE;     // Fixed price during flat period (6 decimals)

    // Graduation flag - once true, permanently in bonding curve phase
    bool public hasGraduated;

    // Absolute per-trade floor (reserve-token units): the trade limit is the
    // greater of this and maxTradeBps of the reserve, so small pools can still
    // take or release meaningful liquidity in one trade.
    uint256 public minTradeCap;

    // Anchor S_g of the post-graduation curve (see contract docs): the
    // redeemable supply at graduation, rescaled for supply changes outside the
    // pool. 0 while graduated only by fees with no supply: the next buy sets it.
    uint256 public graduationSupply;
    // Redeemable supply when graduationSupply was last recorded; the anchor in
    // force is graduationSupply × current supply / anchorBasisSupply.
    uint256 public anchorBasisSupply;

    // Reserved slots for state added by future implementations (17 used above).
    uint256[33] private __gap;

    // Constants
    uint256 public constant PRECISION = 1e18; // Fixed-point precision
    uint256 public constant MAX_CRR = 1000000; // 100% max
    uint256 public constant MIN_CRR = 50000; // 5% min
    uint256 public constant MAX_TRADE_FEE = 1000; // 10% max
    uint256 public constant MAX_TRADE_BPS_LIMIT = 5000; // 50% max trade size
    uint256 public constant DEFAULT_MIN_TRADE_CAP = 5000e6; // $5,000 (6-decimal USDC)
    uint256 public constant MAX_MIN_TRADE_CAP = 50000e6; // $50,000
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

    // Compliance-focused purchase event with stable, export-friendly fields.
    event InvestorPurchase(
        address indexed wallet,
        uint256 usdcAmount,
        uint256 tokenAmount
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
    event MinTradeCapUpdated(uint256 oldCap, uint256 newCap);
    event PurchaserWhitelistUpdated(address indexed oldWhitelist, address indexed newWhitelist);

    // ============================================================
    // INITIALIZATION
    // ============================================================

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @dev Initialize the AMM pool with two-phase pricing. The caller becomes owner.
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
    function initialize(
        address _reserveToken,
        address _hokusaiToken,
        address payable _tokenManager,
        string memory _modelId,
        address _treasury,
        uint256 _crr,
        uint256 _tradeFee,
        uint256 _ibrDuration,
        uint256 _flatCurveThreshold,
        uint256 _flatCurvePrice
    ) external initializer {
        __Ownable_init();
        __ReentrancyGuard_init();
        __Pausable_init();

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
        minTradeCap = DEFAULT_MIN_TRADE_CAP;

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
        if (
            address(purchaserWhitelist) != address(0) &&
            !purchaserWhitelist.isWhitelisted(msg.sender)
        ) {
            revert NotWhitelisted(msg.sender);
        }

        require(block.timestamp <= deadline, "Transaction expired");
        require(reserveIn > 0, "Reserve amount must be > 0");
        require(to != address(0), "Invalid recipient");

        // Store phase before trade
        PricingPhase phaseBefore = getCurrentPhase();

        // Check trade size limit only in bonding curve phase
        // During flat phase, unlimited trade sizes are allowed
        if (phaseBefore == PricingPhase.BONDING_CURVE) {
            require(reserveIn <= maxTradeSize(), "Trade exceeds max size limit");
        }

        // Calculate and deduct trade fee using FeeLib
        (uint256 reserveAfterFee, uint256 feeAmount) = FeeLib.applyFee(reserveIn, tradeFee);

        // Calculate tokens to mint
        uint256 anchorSupply;
        uint256 supplyBefore;
        (tokensOut, anchorSupply, supplyBefore) = _buyQuote(reserveAfterFee);
        require(tokensOut >= minTokensOut, "Slippage exceeded");
        require(tokensOut > 0, "Insufficient output");

        // Transfer USDC from buyer
        require(
            reserveToken.transferFrom(msg.sender, address(this), reserveIn),
            "Reserve transfer failed"
        );

        // Update reserve balance (excluding fee)
        reserveBalance += reserveAfterFee;

        // Graduation (permanent) and the curve anchor for the new supply
        if (anchorSupply != 0) {
            if (!hasGraduated) hasGraduated = true;
            _recordAnchor(anchorSupply, supplyBefore + tokensOut);
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
        emit InvestorPurchase(msg.sender, reserveIn, tokensOut);
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
        uint256 anchorSupply;
        uint256 supplyBefore;
        (reserveOut, anchorSupply, supplyBefore) = _sellQuote(tokensIn);
        require(reserveOut >= minReserveOut, "Slippage exceeded");
        require(reserveOut > 0, "Insufficient output");

        // Check trade size limit (prevents whale manipulation and flash loan attacks)
        require(reserveOut <= maxTradeSize(), "Trade exceeds max size limit");
        // Flat-phase quotes are tokens x price and not bounded by the reserve;
        // with the absolute floor the limit alone can exceed what the pool holds.
        require(reserveOut <= reserveBalance, "Insufficient reserve");

        // Calculate and deduct trade fee using FeeLib
        (uint256 reserveAfterFee, uint256 feeAmount) = FeeLib.applyFee(reserveOut, tradeFee);

        // Update reserve balance (including fee which stays in reserve)
        reserveBalance -= reserveOut;
        if (anchorSupply != 0) _recordAnchor(anchorSupply, supplyBefore - tokensIn);

        // Burn tokens via TokenManager (requires user approval to this contract)
        require(
            IERC20(hokusaiToken).transferFrom(msg.sender, address(this), tokensIn),
            "Token transfer failed"
        );
        require(
            IERC20(hokusaiToken).approve(address(tokenManager), tokensIn),
            "Token approve failed"
        );
        tokenManager.burnAMMTokens(modelId, address(this), tokensIn);

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
     * @dev Returns the redeemable circulating supply used by the AMM curve.
     */
    function _redeemableSupply() internal view returns (uint256) {
        return tokenManager.getRedeemableSupply(modelId);
    }

    /**
     * @dev Calculate tokens out for a given USDC deposit
     * @param reserveIn Amount of USDC to deposit (before the trade fee)
     * @return tokensOut Tokens to be minted
     *
     * Before graduation buys are at the flat price; a buy that reaches the
     * threshold buys the rest on the curve anchored at that point. After
     * graduation every buy moves along the curve (see contract docs).
     */
    function getBuyQuote(uint256 reserveIn) public view returns (uint256 tokensOut) {
        if (reserveIn == 0) return 0;
        (tokensOut, , ) = _buyQuote(reserveIn - FeeLib.calculateFee(reserveIn, tradeFee));
    }

    /**
     * @dev Calculate USDC out for a given token amount
     * @param tokensIn Amount of tokens to sell
     * @return reserveOut USDC to be returned (before the trade fee)
     *
     * Flat price before graduation; after graduation the reserve released by
     * moving the supply down the curve, R × (f(S) - f(S - T)) / f(S).
     */
    function getSellQuote(uint256 tokensIn) public view returns (uint256 reserveOut) {
        (reserveOut, , ) = _sellQuote(tokensIn);
    }

    /**
     * @dev Get current spot price from redeemable circulating supply
     * @return Current price in USDC per token (6 decimals)
     *
     * Flat price before graduation, k × f'(S) after (see contract docs).
     */
    function spotPrice() public view returns (uint256) {
        if (!hasGraduated) return FLAT_CURVE_PRICE;
        uint256 supply = _redeemableSupply();
        return _spotPriceAt(reserveBalance, supply, _anchorSupply(supply));
    }

    /**
     * @dev Get current reserves and redeemable circulating supply
     * @return reserve Current USDC reserve balance
     * @return supply Current redeemable circulating supply
     */
    function getReserves() external view returns (uint256 reserve, uint256 supply) {
        reserve = reserveBalance;
        supply = _redeemableSupply();
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
     * @return supply Current redeemable circulating supply
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
        supply = _redeemableSupply();
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
        uint256 reserveAfterFee = reserveIn - FeeLib.calculateFee(reserveIn, tradeFee);
        uint256 anchorSupply;
        uint256 supply;
        (tokensOut, anchorSupply, supply) = _buyQuote(reserveAfterFee);

        newSpotPrice = anchorSupply == 0
            ? FLAT_CURVE_PRICE
            : _spotPriceAt(reserveBalance + reserveAfterFee, supply + tokensOut, anchorSupply);

        // Price impact = (newPrice - oldPrice) / oldPrice * 10000
        if (currentSpot > 0 && newSpotPrice > currentSpot) {
            priceImpact = ((newSpotPrice - currentSpot) * 10000) / currentSpot;
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

        uint256 supply = _redeemableSupply();
        if (!hasGraduated) {
            newSpotPrice = FLAT_CURVE_PRICE;
        } else if (tokensIn < supply) {
            newSpotPrice = _spotPriceAt(reserveBalance - reserveOut, supply - tokensIn, _anchorSupply(supply));
        }

        // Price impact = (oldPrice - newPrice) / oldPrice * 10000
        if (currentSpot > newSpotPrice) {
            priceImpact = ((currentSpot - newSpotPrice) * 10000) / currentSpot;
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

        // Graduation (permanent): anchor the curve at the current supply, so
        // fees count toward each holder's backing like purchases do. With no
        // supply yet the next buy anchors it.
        if (!hasGraduated && reserveBalance >= FLAT_CURVE_THRESHOLD) {
            hasGraduated = true;
            uint256 supply = _redeemableSupply();
            _recordAnchor(supply, supply);
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

    // Pools are owned by HokusaiAMMFactory; every owner function here is
    // reached through the timelocked factory.callPool.

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
        // Changing CRR reshapes the curve under existing holders.
        require(!hasGraduated || newCrr == crr, "CRR fixed after graduation");

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
     * @dev Update the absolute per-trade floor
     * @param newMinTradeCap New floor in reserve-token units (0 = percentage limit only)
     *
     * Range: 0 to MAX_MIN_TRADE_CAP. Default: DEFAULT_MIN_TRADE_CAP ($5,000).
     */
    function setMinTradeCap(uint256 newMinTradeCap) external onlyOwner {
        require(newMinTradeCap <= MAX_MIN_TRADE_CAP, "Min trade cap too high");

        emit MinTradeCapUpdated(minTradeCap, newMinTradeCap);
        minTradeCap = newMinTradeCap;
    }

    /**
     * @dev Maximum single-trade size in reserve-token units: the greater of
     * maxTradeBps of the current reserve and the absolute minTradeCap floor.
     * Applies to sells always and to buys once the pool is in BONDING_CURVE.
     */
    function maxTradeSize() public view returns (uint256) {
        uint256 percentCap = (reserveBalance * maxTradeBps) / 10000;
        return percentCap > minTradeCap ? percentCap : minTradeCap;
    }

    function setPurchaserWhitelist(address whitelist) external onlyOwner {
        address oldWhitelist = address(purchaserWhitelist);
        purchaserWhitelist = IPurchaserWhitelist(whitelist);
        emit PurchaserWhitelistUpdated(oldWhitelist, whitelist);
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
     * @dev Tokens for USDC at the flat price
     * @param reserveIn Amount of USDC after the trade fee (6 decimals)
     * @return Amount of tokens (18 decimals)
     */
    function _flatPriceTokens(uint256 reserveIn) internal view returns (uint256) {
        return (reserveIn * 1e18) / FLAT_CURVE_PRICE;
    }

    /**
     * @dev Tokens for a buy and the curve anchor in force after it
     * @param reserveIn Amount of USDC after the trade fee
     * @return tokensOut Tokens to mint
     * @return anchorSupply Curve anchor for this buy (0 = still flat)
     * @return supply Redeemable supply before the buy
     */
    function _buyQuote(uint256 reserveIn)
        internal
        view
        returns (uint256 tokensOut, uint256 anchorSupply, uint256 supply)
    {
        supply = _redeemableSupply();
        if (reserveIn == 0) return (0, 0, supply);

        if (hasGraduated) {
            anchorSupply = _anchorSupply(supply);
            if (anchorSupply == 0) {
                // Graduated with no supply (by fees, or every token sold back):
                // the first buyer enters at the flat price and anchors the curve.
                tokensOut = _flatPriceTokens(reserveIn);
                return (tokensOut, tokensOut, supply);
            }
            return (_curveTokens(reserveIn, reserveBalance, supply, anchorSupply), anchorSupply, supply);
        }

        uint256 flatPortion = reserveBalance < FLAT_CURVE_THRESHOLD ? FLAT_CURVE_THRESHOLD - reserveBalance : 0;
        if (reserveIn < flatPortion) return (_flatPriceTokens(reserveIn), 0, supply);

        // This buy graduates the pool: flat price up to the threshold, then
        // the curve anchored at the supply and reserve at that point.
        uint256 flatTokens = _flatPriceTokens(flatPortion);
        anchorSupply = supply + flatTokens;
        if (anchorSupply == 0) {
            tokensOut = _flatPriceTokens(reserveIn);
            return (tokensOut, tokensOut, supply);
        }
        tokensOut = flatTokens +
            _curveTokens(reserveIn - flatPortion, reserveBalance + flatPortion, anchorSupply, anchorSupply);
    }

    /**
     * @dev Tokens for a buy along the post-graduation curve: f(S') = f(S) × (R + E) / R
     */
    function _curveTokens(
        uint256 reserveIn,
        uint256 reserve,
        uint256 supply,
        uint256 anchor
    ) internal view returns (uint256) {
        if (reserveIn == 0) return 0;
        // No backing to scale from (reserve drained, or no supply): flat price.
        if (reserve == 0 || supply == 0) return _flatPriceTokens(reserveIn);

        uint256 newShape = Math.mulDiv(_curveShape(supply, anchor), reserve + reserveIn, reserve);
        uint256 newSupply = _curveShapeInverse(newShape, anchor);
        return newSupply > supply ? newSupply - supply : 0;
    }

    /**
     * @dev USDC for a sell, and for a graduated pool the curve anchor to record
     * @return reserveOut USDC to be returned (before the trade fee)
     * @return anchorSupply Curve anchor for this sell (0 before graduation)
     * @return supply Redeemable supply before the sell
     */
    function _sellQuote(uint256 tokensIn)
        internal
        view
        returns (uint256 reserveOut, uint256 anchorSupply, uint256 supply)
    {
        supply = _redeemableSupply();
        if (tokensIn == 0 || supply == 0 || tokensIn > supply || reserveBalance == 0) return (0, 0, supply);

        if (!hasGraduated) {
            // Selling at fixed price (fee applied in sell() function)
            return ((tokensIn * FLAT_CURVE_PRICE) / 1e18, 0, supply);
        }

        anchorSupply = _anchorSupply(supply);
        uint256 shapeNow = _curveShape(supply, anchorSupply);
        reserveOut = Math.mulDiv(reserveBalance, shapeNow - _curveShape(supply - tokensIn, anchorSupply), shapeNow);
    }

    /**
     * @dev Curve anchor for the current supply: the recorded anchor rescaled by
     * supply changes outside the pool since it was recorded. With no anchor yet
     * (graduated by fees with no supply) or no supply when it was recorded, the
     * current supply, which prices pro rata.
     */
    function _anchorSupply(uint256 supply) internal view returns (uint256) {
        uint256 anchor = graduationSupply;
        uint256 basis = anchorBasisSupply;
        if (anchor == 0 || basis == 0) return supply;
        return basis == supply ? anchor : Math.mulDiv(anchor, supply, basis);
    }

    /**
     * @dev Record the curve anchor and the supply it applies to after a trade
     */
    function _recordAnchor(uint256 anchor, uint256 supply) internal {
        if (graduationSupply != anchor) graduationSupply = anchor;
        if (anchorBasisSupply != supply) anchorBasisSupply = supply;
    }

    /**
     * @dev Spot price k × f'(S) for a graduated pool with reserve R and supply S
     */
    function _spotPriceAt(uint256 reserve, uint256 supply, uint256 anchor) internal view returns (uint256) {
        // No curve price exists without supply or reserve: report the launch
        // price, matching the flat-price bootstrap in _curveTokens.
        if (supply == 0 || reserve == 0) return FLAT_CURVE_PRICE;
        (uint256 shape, uint256 slope) = _curvePoint(supply, anchor);
        return Math.mulDiv(reserve, slope, shape);
    }

    /**
     * @dev Curve shape f(s) in token units (see contract docs)
     */
    function _curveShape(uint256 s, uint256 anchor) internal view returns (uint256 shape) {
        (shape, ) = _curvePoint(s, anchor);
    }

    /**
     * @dev Curve shape f(s) and slope f'(s) (PRECISION): the slope is 1 up to
     * S_g and (s/S_g)^(1/w - 1) above, and f uses (s/S_g)^(1/w) = (s/S_g) × slope.
     */
    function _curvePoint(uint256 s, uint256 anchor) internal view returns (uint256 shape, uint256 slope) {
        if (s <= anchor) return (s, PRECISION);
        uint256 ratio = Math.mulDiv(s, PRECISION, anchor);
        slope = ud(ratio).pow(ud(Math.mulDiv(PPM - crr, PRECISION, crr))).unwrap();
        uint256 grown = Math.mulDiv(ratio, slope, PRECISION);
        shape = grown <= PRECISION ? anchor : anchor + Math.mulDiv(anchor * crr, grown - PRECISION, PPM * PRECISION);
    }

    /**
     * @dev Inverse of f: s = S_g × ((f/S_g - (1 - w)) / w)^w above S_g
     */
    function _curveShapeInverse(uint256 shape, uint256 anchor) internal view returns (uint256) {
        if (shape <= anchor) return shape;
        uint256 base = PRECISION + Math.mulDiv(shape - anchor, PPM * PRECISION, anchor * crr);
        return Math.mulDiv(anchor, ud(base).pow(ud((crr * PRECISION) / PPM)).unwrap(), PRECISION);
    }
}
