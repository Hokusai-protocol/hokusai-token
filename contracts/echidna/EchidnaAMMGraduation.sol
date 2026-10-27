// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import "../HokusaiAMM.sol";
import "../HokusaiToken.sol";
import "../ModelRegistry.sol";
import "../TokenManager.sol";
import "../PurchaserWhitelist.sol";
import "../mocks/MockUSDC.sol";
import "../interfaces/IHokusaiParams.sol";

/**
 * @title GraduationVictim
 * @dev Flat-phase holder with its own msg.sender at the AMM.
 */
contract GraduationVictim {
    HokusaiAMM public immutable amm;

    constructor(HokusaiAMM _amm, IERC20 _usdc, IERC20 _token) {
        amm = _amm;
        _usdc.approve(address(_amm), type(uint256).max);
        _token.approve(address(_amm), type(uint256).max);
    }

    function buy(uint256 reserveIn) external returns (uint256) {
        return amm.buy(reserveIn, 0, address(this), type(uint256).max);
    }

    function sell(uint256 tokensIn) external returns (uint256) {
        return amm.sell(tokensIn, 0, address(this), type(uint256).max);
    }
}

/**
 * @title EchidnaAMMGraduation
 * @dev HOK-3317 (HOK-3289 AMM-H1): a victim buys at the flat price; the
 * harness is the attacker and buys across the graduation threshold, sells in
 * trade-cap-sized chunks, re-crosses, deposits fees from its own funds, and
 * toggles the purchaser whitelist. With a continuous curve none of this can
 * pay the attacker out of the victim's reserve.
 *
 * Assumptions:
 * - CRR 20%, 0.30% fee, no IBR, $25k threshold at $0.01 (the launch posture).
 * - The victim buys once and may sell; nobody else buys. Third-party fee
 *   deposits are excluded: they legitimately raise every holder's value,
 *   the attacker's included.
 * - A 1-token supplier allocation is the only supply the reserve never
 *   received, which bounds the rounding tolerances below.
 */
contract EchidnaAMMGraduation {
    string private constant MODEL_ID = "9104"; // numeric: ModelRegistry string IDs are decimal
    uint256 private constant SUPPLIER_ALLOCATION = 1 ether;
    uint256 private constant INVESTOR_ALLOCATION = 1_000_000_000 ether;
    uint256 private constant FLAT_THRESHOLD = 25_000e6;
    uint256 private constant FLAT_PRICE = 10_000;
    uint256 private constant TRADE_FEE = 30;
    uint256 private constant VICTIM_BUY = 16_500e6;
    uint256 private constant ATTACKER_USDC = 1_000_000e6;
    uint256 private constant MAX_TRADE = 60_000e6;
    uint256 private constant MAX_FEE_DEPOSIT = 5_000e6;
    uint256 private constant MAX_CHUNKS = 20;
    // Rounding the attacker may collect in total: $0.01.
    uint256 private constant ATTACKER_DUST = 10_000;
    address private constant SUPPLIER = address(0x4002);

    MockUSDC public usdc;
    ModelRegistry public registry;
    TokenManager public manager;
    HokusaiToken public token;
    HokusaiAMM public amm;
    PurchaserWhitelist public whitelist;
    GraduationVictim public victim;

    uint256 private immutable attackerStart;
    uint256 private victimFloor;
    bool private victimSold;

    constructor() {
        usdc = new MockUSDC();
        registry = new ModelRegistry();
        manager = new TokenManager(address(registry));

        _deployModel();
        token = HokusaiToken(manager.getTokenAddress(MODEL_ID));
        amm = HokusaiAMM(address(new ERC1967Proxy(
            address(new HokusaiAMM()),
            abi.encodeCall(HokusaiAMM.initialize, (
                address(usdc),
                address(token),
                payable(address(manager)),
                MODEL_ID,
                address(0xFEE),
                200_000,
                TRADE_FEE,
                0,
                FLAT_THRESHOLD,
                FLAT_PRICE
            ))
        )));
        registry.registerStringModel(MODEL_ID, address(token), "accuracy");
        registry.registerPool(MODEL_ID, address(amm));

        whitelist = new PurchaserWhitelist(address(this));
        victim = new GraduationVictim(amm, IERC20(address(usdc)), IERC20(address(token)));
        whitelist.addToWhitelist(address(victim));
        whitelist.addToWhitelist(address(this));

        usdc.mint(address(victim), VICTIM_BUY);
        victim.buy(VICTIM_BUY);
        // The flat price returns exactly what the victim's tokens cost after the fee.
        victimFloor = (token.balanceOf(address(victim)) * FLAT_PRICE) / 1e18;

        usdc.mint(address(this), ATTACKER_USDC);
        usdc.approve(address(amm), type(uint256).max);
        token.approve(address(amm), type(uint256).max);
        attackerStart = ATTACKER_USDC;
    }

    // ------------------------------------------------------------
    // Attacker actions
    // ------------------------------------------------------------

    function buy(uint256 reserveIn) external {
        uint256 bounded = _bound(reserveIn, MAX_TRADE);
        if (bounded == 0) return;
        try amm.buy(bounded, 0, address(this), type(uint256).max) {} catch {}
    }

    /// @dev Buy exactly up to the threshold plus `extra` (re-crossing after dips).
    function buyAcrossThreshold(uint256 extra) external {
        uint256 reserve = amm.reserveBalance();
        uint256 need = reserve < FLAT_THRESHOLD
            ? ((FLAT_THRESHOLD - reserve) * 10_000 + 10_000 - TRADE_FEE - 1) / (10_000 - TRADE_FEE)
            : 0;
        uint256 amount = need + _boundIncludingZero(extra, 10_000e6);
        if (amount == 0) return;
        try amm.buy(amount, 0, address(this), type(uint256).max) {} catch {}
    }

    function sell(uint256 tokensIn) external {
        uint256 bounded = _bound(tokensIn, token.balanceOf(address(this)));
        if (bounded == 0) return;
        try amm.sell(bounded, 0, address(this), type(uint256).max) {} catch {}
    }

    /// @dev Dump the whole position in the largest chunks the trade cap allows.
    function sellAllChunked() external {
        for (uint256 i = 0; i < MAX_CHUNKS; i++) {
            uint256 chunk = token.balanceOf(address(this));
            if (chunk == 0) return;
            uint256 cap = amm.maxTradeSize();
            uint256 reserve = amm.reserveBalance();
            while (chunk > 0) {
                uint256 quote = amm.getSellQuote(chunk);
                if (quote > 0 && quote <= cap && quote <= reserve) break;
                chunk = (chunk * 9) / 10;
            }
            if (chunk == 0) return;
            try amm.sell(chunk, 0, address(this), type(uint256).max) {} catch {
                return;
            }
        }
    }

    /// @dev Fees from the attacker's own funds (shared with every holder).
    function depositOwnFees(uint256 amount) external {
        uint256 bounded = _bound(amount, MAX_FEE_DEPOSIT);
        if (bounded == 0) return;
        try amm.depositFees(bounded) {} catch {}
    }

    function setWhitelistEnabled(bool enabled) external {
        amm.setPurchaserWhitelist(enabled ? address(whitelist) : address(0));
    }

    function setAttackerWhitelisted(bool listed) external {
        if (listed) {
            whitelist.addToWhitelist(address(this));
        } else {
            whitelist.removeFromWhitelist(address(this));
        }
    }

    // ------------------------------------------------------------
    // Victim actions
    // ------------------------------------------------------------

    function victimSell(uint256 tokensIn) external {
        uint256 bounded = _bound(tokensIn, token.balanceOf(address(victim)));
        if (bounded == 0) return;
        try victim.sell(bounded) {
            victimSold = true;
        } catch {}
    }

    // ------------------------------------------------------------
    // Properties
    // ------------------------------------------------------------

    /**
     * @dev AMM-H1: crossing the threshold and selling into the graduated pool
     * never pays the attacker more than it put in.
     */
    function echidna_attacker_never_profits() external view returns (bool) {
        return usdc.balanceOf(address(this)) <= attackerStart + ATTACKER_DUST;
    }

    /**
     * @dev AMM-H1: while the victim holds its flat-phase position, it can
     * redeem at least what it paid after the fee (up to the 1-token unbacked
     * supplier allocation's dilution, < 0.001%).
     */
    function echidna_victim_redeems_what_it_paid() external view returns (bool) {
        if (victimSold) return true;
        uint256 quote = amm.getSellQuote(token.balanceOf(address(victim)));
        return quote * 100_000 >= victimFloor * 99_999;
    }

    /**
     * @dev Selling the whole redeemable supply never releases more than the
     * reserve (the pool stays solvent for the last seller).
     */
    function echidna_supply_redeems_within_reserve() external view returns (bool) {
        return amm.getSellQuote(manager.getRedeemableSupply(MODEL_ID)) <= amm.reserveBalance();
    }

    function echidna_reserve_not_exceeds_usdc_balance() external view returns (bool) {
        return amm.reserveBalance() <= usdc.balanceOf(address(amm));
    }

    // ------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------

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
            "Echidna Graduation Token",
            "EGRD",
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
