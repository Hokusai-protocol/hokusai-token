🌀 Hokusai CRR AMM – Project Overview

This document describes the updated contract architecture for Hokusai tokens, replacing the original auction + burn design with a constant-reserve-ratio (CRR) AMM backed by USDC.

The goal is to create a transparent, trustless pricing system where:
	•	Investors can buy and sell tokens at deterministic prices.
	•	API usage fees fund the reserve instead of burning tokens.
	•	Performance-driven token inflation (from verified DeltaOne improvements) integrates naturally into the curve.

⸻

🔑 Core Principles
	1.	Performance-Based Inflation
	•	DeltaVerifier mints new tokens only when data contributions produce ≥1pp improvement on the benchmark.
	•	This inflation dilutes supply unless offset by usage-driven demand.
	2.	Usage-Driven Funding
	•	API users pay fees in USDC.
	•	Fees are routed to the AMM’s reserve instead of burning tokens.
	•	A small cut of deposits goes to the Hokusai Treasury.
	3.	Bonding-Curve Liquidity
	•	Each Hokusai token has its own AMM pool.
	•	Pricing follows the CRR formula:
	•	Buy (mint): T = S * ( (1 + E/R)^w - 1 )
	•	Sell (redeem): F = R * (1 - (1 - T/S)^(1/w))
	•	Spot Price: P = R / (w * S)
	•	Investors can always enter/exit without external market makers.

⸻

📦 Contract Components

1. Existing Contracts (unchanged)
	•	ModelRegistry.sol: maps model IDs → token addresses → AMM pools.
	•	HokusaiToken.sol: ERC20 token with mint/burn gated through TokenManager.
	•	TokenManager.sol: central issuance gateway; authorizes both AMMs and DeltaVerifier.
	•	DeltaVerifier.sol: validates DeltaOne improvements and instructs TokenManager to mint rewards.

2. New Contracts

HokusaiAMMFactory.sol
	•	Deploys a new AMM pool for each Hokusai token.
	•	Initializes with (s0, r0) = tiny values, enabling the Initial Bonding Round (IBR).
	•	Registers the pool with ModelRegistry.

HokusaiAMM.sol (per token)
	•	Implements the CRR bonding-curve logic.
	•	Manages reserve (USDC) and supply state.
	•	Enforces buy-only mode for the first 7 days (no sells).
	•	Routes trade fees and protocol cuts on deposits to Treasury.
	•	Delegates all mint/burn to TokenManager.

Key functions:
	•	buy(reserveIn, minTokensOut, to, deadline)
	•	sell(tokensIn, minReserveOut, to, deadline) (disabled for 7 days after launch)
	•	depositFees(amount) (called by UsageFeeRouter)
	•	spotPrice(), getBuyQuote(), getSellQuote()

UsageFeeRouter.sol
	•	Collects API usage fees in USDC.
	•	Forwards them to the correct pool via depositFees().
	•	Skims a protocol cut to Treasury before crediting the reserve.

⸻

🚀 Lifecycle

A. Launch & Seeding — Initial Bonding Round (IBR)
	•	Pool is created with tiny (s0, r0) just enough to make formulas valid.
	•	For the first 7 days, pool is buy-only:
	•	Early investors deposit USDC, tokens mint along the curve.
	•	No sells allowed, ensuring reserve builds before redemptions.
	•	This creates organic price discovery with low treasury capital.

B. Post-IBR (Normal Operation)
	•	Both buy() and sell() enabled.
	•	API fees continually strengthen the reserve (R ↑), raising price floor.
	•	Trade fees (e.g., 25 bps) go to Treasury.
	•	Protocol cut on deposits (e.g., 5%) goes to Treasury.

C. Performance Rewards
	•	When a contributor’s data improves a model, DeltaVerifier instructs TokenManager to mint reward tokens.
	•	Supply S increases → spot price naturally adjusts down unless reserve growth offsets dilution.
	•	Creates direct economic linkage between real performance gains and token supply.

⸻

⚖️ Governance & Parameters
	•	CRR (w): default 10% (100,000 ppm), adjustable within bounds (5%–50%) via timelock.
	•	Trade Fee: default 25 bps → Hokusai Treasury.
	•	Protocol Fee on Deposits: default 5% → Treasury.
	•	Buy-Only Phase: enforced for 7 days post-deployment.
	•	Pause Mechanism: emergency only, timelocked changes to parameters.

⸻

🛡️ Safety & Invariants
	•	Reserve asset = USDC for stability.
	•	AMM cannot mint/burn directly: must go through TokenManager.
	•	Reentrancy guards + slippage protection.
	•	Quotes monotonic with inputs.
	•	Deposit fees always increase reserve balance unless paused.

⸻

🏦 Treasury Flows
	•	From Trades: all trade fees (reserve side on buys, token fee-burn on sells) → Treasury.
	•	From API Fees: protocol cut (configurable, e.g., 5%) → Treasury.
	•	Net Effect: Treasury accrues both demand-driven revenue (trades) and usage-driven revenue (API fees).

⸻

🧪 Test Plan (Essentials)
	1.	Initial Bonding Round
	•	Buys succeed; sells revert until buyOnlyUntil.
	•	Reserve grows; price discovery along curve.
	2.	Post-Lift
	•	Sells enabled; redeem formulas correct; fee-tokens burned.
	•	API fee deposits increase reserve & spot price.
	3.	Governance
	•	CRR changes bounded & timelocked.
	•	Trade/protocol fee updates bounded.
	4.	Integration
	•	TokenManager mints correctly for buys & DeltaVerifier.
	•	Treasury balances match expected flows.

⸻

✅ Why This Design Works for Hokusai
	•	Aligns economic incentives: contributors earn from real performance, users fund the system via fees, investors back liquidity.
	•	Creates a transparent, trustless market for each model’s token.
	•	Preserves performance-based inflation while introducing usage-driven deflationary pressure through reserve growth.
	•	Supports early price discovery without heavy treasury seeding (via IBR).
	•	Keeps mint/burn control centralized through TokenManager, simplifying audits and preventing role sprawl.

