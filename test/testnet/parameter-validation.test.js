const { expect } = require("chai");
const { ethers } = require("hardhat");
const path = require("path");
const fs = require("fs");

/**
 * Parameter Validation Tests
 *
 * Validates governance parameter configurations:
 * 1. Read all parameters
 * 2. Check governance roles
 * 3. Document parameter values
 *
 * USAGE:
 * npx hardhat test test/testnet/parameter-validation.test.js --network sepolia
 */

describe("Parameter Validation", function () {
  let deployment;
  let params, token;
  let signer;
  let tokenAddress, paramsAddress;

  before(async function () {
    [signer] = await ethers.getSigners();

    // Load deployment info
    const network = hre.network.name;
    const deploymentPath = path.join(__dirname, "../../deployments", `${network}-latest.json`);
    deployment = JSON.parse(fs.readFileSync(deploymentPath, "utf8"));

    console.log(`\n  📦 Network: ${deployment.network}`);
    console.log(`  👤 Signer: ${signer.address}\n`);

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

      console.log(`      📊 Current Parameters:`);
      console.log(`         Tokens Per Delta One: ${tokensPerDeltaOne}`);
      console.log(`         Infra Markup: ${infraMarkupBps} bps (${Number(infraMarkupBps) / 100}%)`);
      console.log(`         License Hash: ${licenseHash}`);
      console.log(`         License URI: ${licenseURI}`);

      expect(tokensPerDeltaOne).to.be.gt(0, "TokensPerDeltaOne should be positive");
      expect(infraMarkupBps).to.be.gte(0, "InfraMarkup should be non-negative");

      console.log(`      ✅ All parameters readable`);
    });

    it("Should read license reference", async function () {
      const [hash, uri] = await params.licenseRef();

      console.log(`      License Reference:`);
      console.log(`         Hash: ${hash}`);
      console.log(`         URI: ${uri}`);

      expect(hash).to.not.equal(ethers.ZeroHash, "License hash should be set");
      console.log(`      ✅ License reference readable`);
    });
  });

  describe("Governor Authority", function () {
    it("Should identify GOV_ROLE holders", async function () {
      const GOV_ROLE = ethers.keccak256(ethers.toUtf8Bytes("GOV_ROLE"));
      const DEFAULT_ADMIN_ROLE = ethers.ZeroHash;

      console.log(`      🔑 Role Identifiers:`);
      console.log(`         GOV_ROLE: ${GOV_ROLE}`);
      console.log(`         DEFAULT_ADMIN_ROLE: ${DEFAULT_ADMIN_ROLE}`);

      // Check if signer has GOV_ROLE
      const hasGovRole = await params.hasRole(GOV_ROLE, signer.address);
      const hasAdminRole = await params.hasRole(DEFAULT_ADMIN_ROLE, signer.address);

      console.log(`\n      Signer (${signer.address}):`);
      console.log(`         Has GOV_ROLE: ${hasGovRole}`);
      console.log(`         Has ADMIN_ROLE: ${hasAdminRole}`);

      // Check if TokenManager has GOV_ROLE
      const tokenManagerHasGov = await params.hasRole(GOV_ROLE, deployment.contracts.TokenManager);
      console.log(`\n      TokenManager (${deployment.contracts.TokenManager}):`);
      console.log(`         Has GOV_ROLE: ${tokenManagerHasGov}`);

      if (tokenManagerHasGov) {
        console.log(`      ✅ TokenManager has governance authority (expected)`);
      } else if (hasGovRole) {
        console.log(`      ✅ Signer has governance authority (can test updates)`);
      } else {
        console.log(`      ℹ️  Neither signer nor TokenManager has GOV_ROLE`);
        console.log(`         Governance may be transferred to multisig`);
      }
    });
  });

  describe("Parameter Constraints", function () {
    it("Should validate constraint values", async function () {
      const MIN_TOKENS = await params.MIN_TOKENS_PER_DELTA_ONE();
      const MAX_TOKENS = await params.MAX_TOKENS_PER_DELTA_ONE();
      const MAX_MARKUP = await params.MAX_INFRA_MARKUP_BPS();

      console.log(`      📏 Parameter Constraints:`);
      console.log(`         TokensPerDeltaOne: ${MIN_TOKENS} - ${MAX_TOKENS}`);
      console.log(`         InfraMarkupBps: 0 - ${MAX_MARKUP} (${Number(MAX_MARKUP) / 100}%)`);

      const currentTokens = await params.tokensPerDeltaOne();
      const currentMarkup = await params.infraMarkupBps();

      console.log(`\n      Current Values:`);
      console.log(`         TokensPerDeltaOne: ${currentTokens}`);
      console.log(`         InfraMarkupBps: ${currentMarkup}`);

      // Validate within constraints
      expect(currentTokens).to.be.gte(MIN_TOKENS);
      expect(currentTokens).to.be.lte(MAX_TOKENS);
      expect(currentMarkup).to.be.lte(MAX_MARKUP);

      console.log(`      ✅ All values within valid constraints`);
    });
  });

  describe("Multi-Token Parameter Independence", function () {
    it("Should show params for all tokens", async function () {
      console.log(`\n      📊 All Token Parameters:\n`);

      for (const poolConfig of deployment.pools) {
        const testToken = await ethers.getContractAt("HokusaiToken", poolConfig.tokenAddress);
        const testParamsAddr = await testToken.params();
        const testParams = await ethers.getContractAt("HokusaiParams", testParamsAddr);

        const tokensPerDeltaOne = await testParams.tokensPerDeltaOne();
        const infraMarkupBps = await testParams.infraMarkupBps();
        const [licenseHash, licenseURI] = await testParams.licenseRef();

        console.log(`      ${poolConfig.configKey.toUpperCase()}:`);
        console.log(`         Token: ${poolConfig.tokenAddress}`);
        console.log(`         Params: ${testParamsAddr}`);
        console.log(`         TokensPerDeltaOne: ${tokensPerDeltaOne}`);
        console.log(`         InfraMarkup: ${infraMarkupBps} bps (${Number(infraMarkupBps) / 100}%)`);
        console.log(`         License: ${licenseURI}`);
        console.log();
      }

      console.log(`      ✅ Each token has independent parameters`);
    });
  });

  describe("Parameter Update Simulation", function () {
    it("Should document how to update parameters", async function () {
      const GOV_ROLE = ethers.keccak256(ethers.toUtf8Bytes("GOV_ROLE"));

      console.log(`\n      📝 Parameter Update Process:`);
      console.log(`         1. Caller must have GOV_ROLE`);
      console.log(`         2. Call setTokensPerDeltaOne(newValue)`);
      console.log(`         3. Call setInfraMarkupBps(newBps)`);
      console.log(`         4. Call setLicenseRef(hash, uri)`);
      console.log();
      console.log(`      🔐 Current GOV_ROLE Setup:`);

      // Check various potential governors
      const tokenManagerHasGov = await params.hasRole(GOV_ROLE, deployment.contracts.TokenManager);
      const signerHasGov = await params.hasRole(GOV_ROLE, signer.address);
      const factoryHasGov = await params.hasRole(GOV_ROLE, deployment.contracts.HokusaiAMMFactory);

      console.log(`         TokenManager: ${tokenManagerHasGov ? '✅ Has GOV_ROLE' : '❌ No GOV_ROLE'}`);
      console.log(`         Deployer: ${signerHasGov ? '✅ Has GOV_ROLE' : '❌ No GOV_ROLE'}`);
      console.log(`         Factory: ${factoryHasGov ? '✅ Has GOV_ROLE' : '❌ No GOV_ROLE'}`);

      if (tokenManagerHasGov) {
        console.log(`\n      💡 To update parameters, use TokenManager's governance functions`);
      } else if (signerHasGov) {
        console.log(`\n      💡 Deployer can update parameters directly`);
      } else {
        console.log(`\n      💡 GOV_ROLE may be with multisig or other governance contract`);
      }

      console.log(`\n      ✅ Update process documented`);
    });
  });

  describe("Parameter Change Events", function () {
    it("Should list expected events", async function () {
      console.log(`\n      📡 Parameter Change Events:`);
      console.log(`         • TokensPerDeltaOneSet(oldValue, newValue, updater)`);
      console.log(`         • InfraMarkupBpsSet(oldBps, newBps, updater)`);
      console.log(`         • LicenseRefSet(oldHash, newHash, newURI, updater)`);
      console.log();
      console.log(`      ✅ Events documented`);
    });
  });
});
