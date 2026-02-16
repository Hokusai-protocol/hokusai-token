const hre = require("hardhat");
const { ethers } = hre;

/**
 * Comprehensive LSCOR Token Validation Script
 * Validates on-chain state for HOK-681 Token Issuance Testing
 */
async function main() {
  console.log("\n=== LSCOR Comprehensive On-Chain Validation ===\n");

  // Addresses from sepolia-latest.json
  const ADDRESSES = {
    token: "0x0fC57906d2E34826c4b7e76Eaf6D421EFaD31cfD",
    pool: "0xf01873C0324A213f8268Fb5a5c234113185D20c1",
    tokenManager: "0xe08da225C1B49610DB0d3606Ee2642b043B5Db08",
    modelRegistry: "0xf88844FB75e44030f775BFA1ed0A6BFd5685F2Fc",
    factory: "0xaB877Ce2b3e193103374c813E44522f964137e1d",
    deltaVerifier: "0x8dE6dc062beca7C202A8E3C8B6bdb45bc7C4637b",
    usageFeeRouter: "0x7e3593642BF99bF648e7EB810635bE3b191258fC",
    mockUSDC: "0x2e0336fB2f65aa2953ABF2035Fd812572D68AAF9",
    deployer: "0x3018Cf81729c932Bc3E733A264e5F4a0A08deD5B",
  };
  const MODEL_ID = "21";

  let results = [];
  let passed = 0;
  let failed = 0;

  function check(name, condition, detail) {
    if (condition) {
      console.log(`  [PASS] ${name}: ${detail}`);
      passed++;
    } else {
      console.log(`  [FAIL] ${name}: ${detail}`);
      failed++;
    }
    results.push({ name, condition, detail });
  }

  // --- 1. Token Supply ---
  console.log("\n--- 1. LSCOR Token Supply ---");
  try {
    const token = await ethers.getContractAt("HokusaiToken", ADDRESSES.token);
    const totalSupply = await token.totalSupply();
    const name = await token.name();
    const symbol = await token.symbol();
    const formattedSupply = ethers.formatEther(totalSupply);

    check("Token name", name === "Hokusai LSCOR", `"${name}"`);
    check("Token symbol", symbol === "LSCOR", `"${symbol}"`);
    check("Total supply > 0", totalSupply > 0n, `${formattedSupply} LSCOR`);
    console.log(`  [INFO] Total supply: ${formattedSupply} LSCOR`);
  } catch (e) {
    console.log(`  [ERROR] Token query failed: ${e.message}`);
    failed++;
  }

  // --- 2. Token Controller ---
  console.log("\n--- 2. Token Controller ---");
  try {
    const token = await ethers.getContractAt("HokusaiToken", ADDRESSES.token);
    const controller = await token.controller();
    check(
      "Controller is TokenManager",
      controller.toLowerCase() === ADDRESSES.tokenManager.toLowerCase(),
      `controller=${controller}`
    );
  } catch (e) {
    console.log(`  [ERROR] Controller query failed: ${e.message}`);
    failed++;
  }

  // --- 3. Model Registry Mapping ---
  console.log("\n--- 3. Model Registry (Model 21 -> LSCOR) ---");
  try {
    const registry = await ethers.getContractAt("ModelRegistry", ADDRESSES.modelRegistry);
    const registeredToken = await registry.getTokenAddress(MODEL_ID);
    check(
      "Model 21 maps to LSCOR token",
      registeredToken.toLowerCase() === ADDRESSES.token.toLowerCase(),
      `registered=${registeredToken}`
    );
  } catch (e) {
    console.log(`  [ERROR] Registry query failed: ${e.message}`);
    failed++;
  }

  // --- 4. AMM Pool State ---
  console.log("\n--- 4. AMM Pool State ---");
  try {
    const pool = await ethers.getContractAt("HokusaiAMM", ADDRESSES.pool);

    const threshold = await pool.FLAT_CURVE_THRESHOLD();
    const price = await pool.FLAT_CURVE_PRICE();
    const crr = await pool.crr();
    const reserveBalance = await pool.reserveBalance();
    const currentPhase = await pool.getCurrentPhase();
    const hasGraduated = await pool.hasGraduated();

    const thresholdUSD = ethers.formatUnits(threshold, 6);
    const priceUSD = ethers.formatUnits(price, 6);
    const reserveUSD = ethers.formatUnits(reserveBalance, 6);
    const crrPercent = (Number(crr) / 10000).toFixed(1);

    check("Threshold is $25,000", threshold === ethers.parseUnits("25000", 6), `$${thresholdUSD}`);
    check("Flat price is $0.01", price === ethers.parseUnits("0.01", 6), `$${priceUSD}`);
    check("CRR is 10%", crr === 100000n, `${crrPercent}% (raw: ${crr})`);
    console.log(`  [INFO] Reserve: $${reserveUSD}`);
    console.log(`  [INFO] Phase: ${currentPhase === 0n ? "FLAT_PRICE" : "BONDING_CURVE"}`);
    console.log(`  [INFO] hasGraduated: ${hasGraduated}`);

    // If reserve > threshold, expect graduated
    if (reserveBalance >= threshold) {
      check("Graduated (reserve >= threshold)", hasGraduated === true, `hasGraduated=${hasGraduated}`);
      check("Phase is BONDING_CURVE after graduation", currentPhase === 1n, `phase=${currentPhase}`);
    } else {
      check("Not yet graduated (reserve < threshold)", hasGraduated === false, `hasGraduated=${hasGraduated}`);
      check("Phase is FLAT_PRICE before graduation", currentPhase === 0n, `phase=${currentPhase}`);
    }

    // Test buy quote
    const buyQuote = await pool.getBuyQuote(ethers.parseUnits("100", 6));
    const buyQuoteFormatted = ethers.formatEther(buyQuote);
    console.log(`  [INFO] Buy quote for $100: ${buyQuoteFormatted} tokens`);

    if (hasGraduated) {
      check("Buy quote uses bonding curve (not flat)", Number(buyQuoteFormatted) < 10000, `${buyQuoteFormatted} (flat would be 10000)`);
    }
  } catch (e) {
    console.log(`  [ERROR] Pool query failed: ${e.message}`);
    failed++;
  }

  // --- 5. TokenManager State ---
  console.log("\n--- 5. TokenManager State ---");
  try {
    const tm = await ethers.getContractAt("TokenManager", ADDRESSES.tokenManager);
    const tokenAddr = await tm.getTokenAddress(MODEL_ID);
    check(
      "TokenManager maps model 21 to LSCOR",
      tokenAddr.toLowerCase() === ADDRESSES.token.toLowerCase(),
      `token=${tokenAddr}`
    );

    const deltaVerifierAddr = await tm.deltaVerifier();
    check(
      "DeltaVerifier set on TokenManager",
      deltaVerifierAddr.toLowerCase() === ADDRESSES.deltaVerifier.toLowerCase(),
      `deltaVerifier=${deltaVerifierAddr}`
    );
  } catch (e) {
    console.log(`  [ERROR] TokenManager query failed: ${e.message}`);
    failed++;
  }

  // --- 6. DeltaVerifier State ---
  console.log("\n--- 6. DeltaVerifier State ---");
  try {
    const dv = await ethers.getContractAt("DeltaVerifier", ADDRESSES.deltaVerifier);
    const tmAddr = await dv.tokenManager();
    check(
      "DeltaVerifier points to TokenManager",
      tmAddr.toLowerCase() === ADDRESSES.tokenManager.toLowerCase(),
      `tokenManager=${tmAddr}`
    );
    const registryAddr = await dv.modelRegistry();
    check(
      "DeltaVerifier points to ModelRegistry",
      registryAddr.toLowerCase() === ADDRESSES.modelRegistry.toLowerCase(),
      `modelRegistry=${registryAddr}`
    );
  } catch (e) {
    console.log(`  [ERROR] DeltaVerifier query failed: ${e.message}`);
    failed++;
  }

  // --- Summary ---
  console.log("\n" + "=".repeat(60));
  console.log(`\nResults: ${passed} passed, ${failed} failed out of ${passed + failed} checks`);
  if (failed === 0) {
    console.log("All on-chain state validated successfully!\n");
  } else {
    console.log("Some checks failed - review above for details.\n");
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
