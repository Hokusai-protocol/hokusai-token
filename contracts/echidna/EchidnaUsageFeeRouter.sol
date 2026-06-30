// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../UsageFeeRouter.sol";
import "../mocks/MockUSDC.sol";

// --- Minimal ABI-compatible stubs ---------------------------------------------------------
// UsageFeeRouter casts its constructor args to concrete types (HokusaiAMMFactory, etc.) and
// reaches the params via factory.getPool -> pool.tokenManager -> tokenManager.getParamsAddress
// -> params.infrastructureAccrualBps. Casts are compile-time only, so stubs exposing the same
// selectors satisfy the view path used by calculateFeeSplit without the full AMM graph.

contract StubParams {
    uint16 public infraBps;
    function setInfraBps(uint16 v) external { infraBps = v; }
    function infrastructureAccrualBps() external view returns (uint16) { return infraBps; }
}

contract StubTokenManager {
    address public paramsAddr;
    constructor(address p) { paramsAddr = p; }
    function getParamsAddress(string memory) external view returns (address) { return paramsAddr; }
}

contract StubPool {
    address public tm;
    constructor(address tm_) { tm = tm_; }
    function tokenManager() external view returns (address) { return tm; }
}

contract StubFactory {
    address public pool;
    constructor(address pool_) { pool = pool_; }
    function getPool(string memory) external view returns (address) { return pool; }
}

contract StubCostOracle {
    uint256 public cost;
    uint256 public lastUpdated;
    function setCost(uint256 c, uint256 lu) external { cost = c; lastUpdated = lu; }
    function getEstimatedCost(string memory) external view returns (uint256) { return cost; }
    function getLastUpdated(string memory) external view returns (uint256) { return lastUpdated; }
}

/**
 * @dev Echidna harness for UsageFeeRouter fee-split math (security review H-4 hardening,
 * H-6 coverage). Drives the public view `calculateFeeSplit` across the oracle and
 * percentage-fallback paths with fuzzed oracle cost, freshness, callCount, infra-share
 * ceiling, and staleness window, asserting the split can never leak value or starve holders.
 *
 * Invariants (over every checked split):
 * - infrastructureAmount + profitAmount == amount (value-conserving; no dust, no inflation)
 * - infrastructureAmount <= amount (infra never exceeds the fee)
 * - oracle path: infrastructureAmount <= amount * maxInfraShareBps / 10000 (H-4 ceiling holds,
 *   so a high / manipulated cost or inflated callCount cannot route past the cap)
 * - a stale oracle cost is never used: it falls back to percentage splitting
 */
contract EchidnaUsageFeeRouter {
    string private constant MODEL_ID = "echidna-router-model";
    uint256 private constant MAX_USDC = 2_500_000e6;
    uint256 private constant MAX_COST = 1_000_000e6;
    uint256 private constant MAX_CALLS = 1_000_000_000;
    uint256 private constant MAX_AGE = 30 days;

    MockUSDC public usdc;
    StubParams public params;
    StubCostOracle public oracle;
    UsageFeeRouter public router;

    bool private splitNotConserved;
    bool private infraExceededAmount;
    bool private oracleCeilingBreached;
    bool private staleCostUsed;

    constructor() {
        usdc = new MockUSDC();
        params = new StubParams();
        params.setInfraBps(8000); // launch default infra share (80%)
        StubTokenManager tm = new StubTokenManager(address(params));
        StubPool pool = new StubPool(address(tm));
        StubFactory factory = new StubFactory(address(pool));
        oracle = new StubCostOracle();

        // infraReserve arg is only touched on the deposit path, never by calculateFeeSplit;
        // a non-zero address satisfies the constructor guard.
        router = new UsageFeeRouter(address(factory), address(usdc), address(usdc), address(oracle));
    }

    // --- configuration actions ---

    function configureOracle(uint256 c, uint256 ageBack) external {
        uint256 boundedCost = c % (MAX_COST + 1);
        // lastUpdated somewhere in [0, block.timestamp]; ageBack picks how stale.
        uint256 back = ageBack % (MAX_AGE + 1);
        uint256 lu = block.timestamp > back ? block.timestamp - back : 0;
        oracle.setCost(boundedCost, lu);
    }

    function configureInfraBps(uint256 bps) external {
        params.setInfraBps(uint16(bps % 10001));
    }

    function configureMaxInfraShare(uint256 bps) external {
        try router.setMaxInfraShareBps(uint16(bps % 10001)) {} catch {}
    }

    function configureMaxCostAge(uint256 age) external {
        try router.setMaxCostAge(age % (MAX_AGE + 1)) {} catch {}
    }

    // --- core checked action ---

    function checkSplit(uint256 amount, uint256 callCount) external {
        uint256 boundedAmount = (amount % MAX_USDC) + 1;
        uint256 boundedCalls = callCount % (MAX_CALLS + 1);

        try router.calculateFeeSplit(MODEL_ID, boundedAmount, boundedCalls) returns (
            uint256 infra,
            uint256 profit,
            UsageFeeRouter.CostBasis basis
        ) {
            if (infra + profit != boundedAmount) {
                splitNotConserved = true;
            }
            if (infra > boundedAmount) {
                infraExceededAmount = true;
            }

            if (basis == UsageFeeRouter.CostBasis.ORACLE) {
                uint256 ceiling = (boundedAmount * router.maxInfraShareBps()) / 10000;
                if (infra > ceiling) {
                    oracleCeilingBreached = true;
                }

                // If a freshness window is configured and the cost is older than it, the
                // oracle path must NOT have been taken.
                uint256 maxAge = router.maxCostAgeSeconds();
                uint256 lu = oracle.getLastUpdated(MODEL_ID);
                if (maxAge > 0 && lu > 0 && block.timestamp - lu > maxAge) {
                    staleCostUsed = true;
                }
            }
        } catch {}
    }

    // ============================================================
    // INVARIANTS
    // ============================================================

    function echidna_split_conserves() external view returns (bool) {
        return !splitNotConserved;
    }

    function echidna_infra_not_exceed_amount() external view returns (bool) {
        return !infraExceededAmount;
    }

    function echidna_oracle_ceiling_respected() external view returns (bool) {
        return !oracleCeilingBreached;
    }

    function echidna_stale_cost_falls_back() external view returns (bool) {
        return !staleCostUsed;
    }
}
