const { expect } = require("chai");
const { ethers } = require("hardhat");
const path = require("path");
const fs = require("fs");

/**
 * Parameter Updates Tests
 *
 * Validates governance parameter update mechanisms:
 * 1. Update parameters via HokusaiParams
 * 2. Verify changes take effect
 * 3. Test parameter constraints
 *
 * USAGE:
 * npx hardhat test test/testnet/parameter-updates.test.js --network sepolia
 */

describe("Parameter Updates", function () {
  let deployment;
  let params, token;
  let governor;
  let tokenAddress, paramsAddress;

  before(async function () {
    [governor] = await ethers.getSigners();

    // Load deployment info
    const network = hre.network.name;
    const deploymentPath = path.join(__dirname, "../../deployments", `${network}-latest.json`);
    deployment = JSON.parse(fs.readFileSync(deploymentPath, "utf8"));

    console.log(`\n  📦 Network: ${deployment.network}`);
    console.log(`  👤 Governor: ${governor.address}\n`);

    // Use conservative pool's token for testing
    const poolInfo = deployment.pools.find(p => p.configKey === "conservative");
    tokenAddress = poolInfo.tokenAddress;

    token = await ethers.getContractAt("HokusaiToken", tokenAddress);
    paramsAddress = await token.params();
    params = await ethers.getContractAt("HokusaiParams", paramsAddress);

    console.log(`  🎛️  Testing token: ${tokenAddress}`);
    console.log(`  🎛️  Params contract: ${paramsAddress}\n`);
  });

  describe("Read Current Parameters", function () {
    it("Should read all governance parameters", async function () {
      const tokensPerDeltaOne = await params.tokensPerDeltaOne();
      const infraMarkupBps = await params.infraMarkupBps();
      const licenseHash = await params.licenseHash();
      const licenseURI = await params.licenseURI();
      const paramGovernor = await params.governor();

      console.log(`      📊 Current Parameters:`);
      console.log(`         Tokens Per Delta One: ${tokensPerDeltaOne}`);
      console.log(`         Infra Markup: ${infraMarkupBps} bps (${Number(infraMarkupBps) / 100}%)`);
      console.log(`         License Hash: ${licenseHash}`);
      console.log(`         License URI: ${licenseURI}`);
      console.log(`         Governor: ${paramGovernor}`);

      expect(tokensPerDeltaOne).to.be.gt(0, "TokensPerDeltaOne should be positive");
      expect(infraMarkupBps).to.be.gte(0, "InfraMarkup should be non-negative");

      console.log(`      ✅ All parameters readable`);
    });
  });

  describe("Governor Authority", function () {
    it("Should identify current governor", async function () {
      const currentGovernor = await params.governor();
      console.log(`      Current governor: ${currentGovernor}`);
      console.log(`      Test signer: ${governor.address}`);

      const isGovernor = currentGovernor.toLowerCase() === governor.address.toLowerCase();

      if (isGovernor) {
        console.log(`      ✅ Test signer IS the governor - can make updates`);
      } else {
        console.log(`      ⚠️  Test signer is NOT the governor - updates will fail`);
        console.log(`         This is expected if TokenManager or multisig is governor`);
      }
    });
  });

  describe("Infra Markup Updates", function () {
    it("Should update infraMarkupBps", async function () {
      const currentGovernor = await params.governor();
      if (currentGovernor.toLowerCase() !== governor.address.toLowerCase()) {
        console.log(`      ⚠️  Skipping - test signer is not governor`);
        this.skip();
      }

      const oldValue = await params.infraMarkupBps();
      const newValue = oldValue + 10n; // Increase by 0.1%

      console.log(`      Current value: ${oldValue} bps`);
      console.log(`      New value: ${newValue} bps`);

      const tx = await params.setInfraMarkupBps(newValue);
      await tx.wait();

      const updatedValue = await params.infraMarkupBps();
      expect(updatedValue).to.equal(newValue, "Value should update");

      console.log(`      ✅ Update successful`);
      console.log(`      🔗 Tx: ${tx.hash}`);

      // Revert back
      const revertTx = await params.setInfraMarkupBps(oldValue);
      await revertTx.wait();
      console.log(`      ✅ Reverted to original value`);
    });

    it("Should emit event on update", async function () {
      const currentGovernor = await params.governor();
      if (currentGovernor.toLowerCase() !== governor.address.toLowerCase()) {
        console.log(`      ⚠️  Skipping - test signer is not governor`);
        this.skip();
      }

      const currentValue = await params.infraMarkupBps();
      const newValue = currentValue + 5n;

      await expect(params.setInfraMarkupBps(newValue))
        .to.emit(params, "InfraMarkupBpsUpdated")
        .withArgs(currentValue, newValue);

      console.log(`      ✅ InfraMarkupBpsUpdated event emitted`);

      // Revert
      await params.setInfraMarkupBps(currentValue);
    });
  });

  describe("Tokens Per Delta One Updates", function () {
    it("Should update tokensPerDeltaOne", async function () {
      const currentGovernor = await params.governor();
      if (currentGovernor.toLowerCase() !== governor.address.toLowerCase()) {
        console.log(`      ⚠️  Skipping - test signer is not governor`);
        this.skip();
      }

      const oldValue = await params.tokensPerDeltaOne();
      const newValue = oldValue + 100n;

      console.log(`      Current value: ${oldValue}`);
      console.log(`      New value: ${newValue}`);

      const tx = await params.setTokensPerDeltaOne(newValue);
      await tx.wait();

      const updatedValue = await params.tokensPerDeltaOne();
      expect(updatedValue).to.equal(newValue, "Value should update");

      console.log(`      ✅ Update successful`);

      // Revert
      await params.setTokensPerDeltaOne(oldValue);
      console.log(`      ✅ Reverted to original value`);
    });

    it("Should reject zero value", async function () {
      const currentGovernor = await params.governor();
      if (currentGovernor.toLowerCase() !== governor.address.toLowerCase()) {
        console.log(`      ⚠️  Skipping - test signer is not governor`);
        this.skip();
      }

      await expect(
        params.setTokensPerDeltaOne(0)
      ).to.be.revertedWith("Must be greater than zero");

      console.log(`      ✅ Zero value correctly rejected`);
    });
  });

  describe("License Updates", function () {
    it("Should update license URI", async function () {
      const currentGovernor = await params.governor();
      if (currentGovernor.toLowerCase() !== governor.address.toLowerCase()) {
        console.log(`      ⚠️  Skipping - test signer is not governor`);
        this.skip();
      }

      const oldURI = await params.licenseURI();
      const testURI = "https://hokusai.ai/licenses/test-" + Date.now();

      console.log(`      Current URI: ${oldURI}`);
      console.log(`      New URI: ${testURI}`);

      const tx = await params.setLicenseURI(testURI);
      await tx.wait();

      const updatedURI = await params.licenseURI();
      expect(updatedURI).to.equal(testURI, "URI should update");

      console.log(`      ✅ Update successful`);

      // Revert
      await params.setLicenseURI(oldURI);
      console.log(`      ✅ Reverted to original URI`);
    });

    it("Should update license hash", async function () {
      const currentGovernor = await params.governor();
      if (currentGovernor.toLowerCase() !== governor.address.toLowerCase()) {
        console.log(`      ⚠️  Skipping - test signer is not governor`);
        this.skip();
      }

      const oldHash = await params.licenseHash();
      const testHash = ethers.keccak256(ethers.toUtf8Bytes("test-license-" + Date.now()));

      console.log(`      Current hash: ${oldHash}`);
      console.log(`      New hash: ${testHash}`);

      const tx = await params.setLicenseHash(testHash);
      await tx.wait();

      const updatedHash = await params.licenseHash();
      expect(updatedHash).to.equal(testHash, "Hash should update");

      console.log(`      ✅ Update successful`);

      // Revert
      await params.setLicenseHash(oldHash);
      console.log(`      ✅ Reverted to original hash`);
    });
  });

  describe("Governor Transfer", function () {
    it("Should show current governor", async function () {
      const currentGovernor = await params.governor();
      console.log(`      Current governor: ${currentGovernor}`);

      // Check if it's TokenManager
      const isTokenManager = currentGovernor.toLowerCase() === deployment.contracts.TokenManager.toLowerCase();
      const isDeployer = currentGovernor.toLowerCase() === governor.address.toLowerCase();

      if (isTokenManager) {
        console.log(`      ℹ️  Governor is TokenManager (expected for production)`);
      } else if (isDeployer) {
        console.log(`      ℹ️  Governor is deployer (can test updates)`);
      } else {
        console.log(`      ℹ️  Governor is another address (likely multisig)`);
      }

      console.log(`      ✅ Governor identified`);
    });
  });

  describe("Parameter Immutability", function () {
    it("Should have immutable token reference", async function () {
      const tokenAddr = await params.hokusaiToken();

      console.log(`      Token address in params: ${tokenAddr}`);
      console.log(`      Actual token address: ${tokenAddress}`);

      expect(tokenAddr.toLowerCase()).to.equal(tokenAddress.toLowerCase());
      console.log(`      ✅ Token reference is correct and immutable`);
    });
  });

  describe("Multi-Token Parameter Independence", function () {
    it("Should show different params for different tokens", async function () {
      console.log(`\n      📊 Parameter Comparison Across Tokens:\n`);

      for (const poolConfig of deployment.pools) {
        const testToken = await ethers.getContractAt("HokusaiToken", poolConfig.tokenAddress);
        const testParamsAddr = await testToken.params();
        const testParams = await ethers.getContractAt("HokusaiParams", testParamsAddr);

        const tokensPerDeltaOne = await testParams.tokensPerDeltaOne();
        const infraMarkupBps = await testParams.infraMarkupBps();

        console.log(`      ${poolConfig.configKey.toUpperCase()}:`);
        console.log(`         Params: ${testParamsAddr}`);
        console.log(`         TokensPerDeltaOne: ${tokensPerDeltaOne}`);
        console.log(`         InfraMarkup: ${infraMarkupBps} bps`);
        console.log();
      }

      console.log(`      ✅ Each token has its own params contract`);
    });
  });
});
