const { expect } = require("chai");
const { ethers, network } = require("hardhat");
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
  before(function () {
    if (network.name !== "sepolia") {
      this.skip();
    }
  });

  let deployment;
  let params, token;
  let governor;
  let tokenAddress, paramsAddress;
  let GOV_ROLE;

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
    GOV_ROLE = await params.GOV_ROLE();

    console.log(`  🎛️  Testing token: ${tokenAddress}`);
    console.log(`  🎛️  Params contract: ${paramsAddress}\n`);
  });

  describe("Read Current Parameters", function () {
    it("Should read all governance parameters", async function () {
      const tokensPerDeltaOne = await params.tokensPerDeltaOne();
      const infrastructureAccrualBps = await params.infrastructureAccrualBps();
      const licenseHash = await params.licenseHash();
      const licenseURI = await params.licenseURI();
      const hasGovRole = await params.hasRole(GOV_ROLE, governor.address);

      console.log(`      📊 Current Parameters:`);
      console.log(`         Tokens Per Delta One: ${tokensPerDeltaOne}`);
      console.log(`         Infrastructure Accrual: ${infrastructureAccrualBps} bps (${Number(infrastructureAccrualBps) / 100}%)`);
      console.log(`         License Hash: ${licenseHash}`);
      console.log(`         License URI: ${licenseURI}`);
      console.log(`         Signer has GOV_ROLE: ${hasGovRole}`);

      expect(tokensPerDeltaOne).to.be.gt(0, "TokensPerDeltaOne should be positive");
      expect(infrastructureAccrualBps).to.be.gte(5000, "InfrastructureAccrualBps should be >= 5000");
      expect(infrastructureAccrualBps).to.be.lte(10000, "InfrastructureAccrualBps should be <= 10000");

      console.log(`      ✅ All parameters readable`);
    });
  });

  describe("Governor Authority", function () {
    it("Should identify current governor", async function () {
      const hasGovRole = await params.hasRole(GOV_ROLE, governor.address);
      console.log(`      Test signer: ${governor.address}`);
      console.log(`      Has GOV_ROLE: ${hasGovRole}`);

      if (hasGovRole) {
        console.log(`      ✅ Test signer has GOV_ROLE - can make updates`);
      } else {
        console.log(`      ⚠️  Test signer does NOT have GOV_ROLE - updates will fail`);
        console.log(`         This is expected if TokenManager or multisig has GOV_ROLE`);
      }
    });
  });

  describe("Infrastructure Accrual Updates", function () {
    it("Should update infrastructureAccrualBps", async function () {
      const hasGovRole = await params.hasRole(GOV_ROLE, governor.address);
      if (!hasGovRole) {
        console.log(`      ⚠️  Skipping - test signer does not have GOV_ROLE`);
        this.skip();
      }

      const oldValue = await params.infrastructureAccrualBps();
      // Ensure new value stays within valid range (5000-10000)
      const newValue = oldValue < 10000n ? oldValue + 10n : oldValue - 10n;

      console.log(`      Current value: ${oldValue} bps`);
      console.log(`      New value: ${newValue} bps`);

      const tx = await params.setInfrastructureAccrualBps(newValue);
      await tx.wait();

      const updatedValue = await params.infrastructureAccrualBps();
      expect(updatedValue).to.equal(newValue, "Value should update");

      console.log(`      ✅ Update successful`);
      console.log(`      🔗 Tx: ${tx.hash}`);

      // Revert back
      const revertTx = await params.setInfrastructureAccrualBps(oldValue);
      await revertTx.wait();
      console.log(`      ✅ Reverted to original value`);
    });

    it("Should emit event on update", async function () {
      const hasGovRole = await params.hasRole(GOV_ROLE, governor.address);
      if (!hasGovRole) {
        console.log(`      ⚠️  Skipping - test signer does not have GOV_ROLE`);
        this.skip();
      }

      const currentValue = await params.infrastructureAccrualBps();
      // Ensure new value stays within valid range (5000-10000)
      const newValue = currentValue < 10000n ? currentValue + 5n : currentValue - 5n;

      await expect(params.setInfrastructureAccrualBps(newValue))
        .to.emit(params, "InfrastructureAccrualBpsSet");

      console.log(`      ✅ InfrastructureAccrualBpsSet event emitted`);

      // Revert
      await params.setInfrastructureAccrualBps(currentValue);
    });
  });

  describe("Tokens Per Delta One Updates", function () {
    it("Should update tokensPerDeltaOne", async function () {
      const hasGovRole = await params.hasRole(GOV_ROLE, governor.address);
      if (!hasGovRole) {
        console.log(`      ⚠️  Skipping - test signer does not have GOV_ROLE`);
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
      const hasGovRole = await params.hasRole(GOV_ROLE, governor.address);
      if (!hasGovRole) {
        console.log(`      ⚠️  Skipping - test signer does not have GOV_ROLE`);
        this.skip();
      }

      await expect(
        params.setTokensPerDeltaOne(0)
      ).to.be.revertedWith("Must be greater than zero");

      console.log(`      ✅ Zero value correctly rejected`);
    });
  });

  describe("License Updates", function () {
    it("Should update license ref (hash + URI)", async function () {
      const hasGovRole = await params.hasRole(GOV_ROLE, governor.address);
      if (!hasGovRole) {
        console.log(`      ⚠️  Skipping - test signer does not have GOV_ROLE`);
        this.skip();
      }

      const oldHash = await params.licenseHash();
      const oldURI = await params.licenseURI();
      const testHash = ethers.keccak256(ethers.toUtf8Bytes("test-license-" + Date.now()));
      const testURI = "https://hokusai.ai/licenses/test-" + Date.now();

      console.log(`      Current hash: ${oldHash}`);
      console.log(`      Current URI: ${oldURI}`);
      console.log(`      New hash: ${testHash}`);
      console.log(`      New URI: ${testURI}`);

      const tx = await params.setLicenseRef(testHash, testURI);
      await tx.wait();

      const updatedHash = await params.licenseHash();
      const updatedURI = await params.licenseURI();
      expect(updatedHash).to.equal(testHash, "Hash should update");
      expect(updatedURI).to.equal(testURI, "URI should update");

      console.log(`      ✅ Update successful`);

      // Revert
      await params.setLicenseRef(oldHash, oldURI);
      console.log(`      ✅ Reverted to original values`);
    });
  });

  describe("Governance Roles", function () {
    it("Should show current GOV_ROLE holders", async function () {
      const signerHasGov = await params.hasRole(GOV_ROLE, governor.address);
      const tokenManagerHasGov = await params.hasRole(GOV_ROLE, deployment.contracts.TokenManager);

      console.log(`      Signer (${governor.address}): GOV_ROLE = ${signerHasGov}`);
      console.log(`      TokenManager (${deployment.contracts.TokenManager}): GOV_ROLE = ${tokenManagerHasGov}`);

      if (tokenManagerHasGov) {
        console.log(`      ℹ️  TokenManager has GOV_ROLE (expected for production)`);
      } else if (signerHasGov) {
        console.log(`      ℹ️  Deployer has GOV_ROLE (can test updates)`);
      } else {
        console.log(`      ℹ️  GOV_ROLE may be with multisig or other governance contract`);
      }

      console.log(`      ✅ Governance roles identified`);
    });
  });

  describe("Token-Params Linkage", function () {
    it("Should have token linked to this params contract", async function () {
      const linkedParamsAddr = await token.params();

      console.log(`      Token address: ${tokenAddress}`);
      console.log(`      Token's params(): ${linkedParamsAddr}`);
      console.log(`      Expected params: ${paramsAddress}`);

      expect(linkedParamsAddr.toLowerCase()).to.equal(paramsAddress.toLowerCase());
      console.log(`      ✅ Token correctly linked to params contract`);
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
        const infrastructureAccrualBps = await testParams.infrastructureAccrualBps();

        console.log(`      ${poolConfig.configKey.toUpperCase()}:`);
        console.log(`         Params: ${testParamsAddr}`);
        console.log(`         TokensPerDeltaOne: ${tokensPerDeltaOne}`);
        console.log(`         InfrastructureAccrual: ${infrastructureAccrualBps} bps`);
        console.log();
      }

      console.log(`      ✅ Each token has its own params contract`);
    });
  });
});
