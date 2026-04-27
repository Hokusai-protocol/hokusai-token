const { expect } = require("chai");
const { ethers } = require("hardhat");
const { ZeroAddress, ZeroHash, keccak256, toUtf8Bytes } = require("ethers");
const { wholeTokens } = require("./helpers/tokenDeployment");

describe("HokusaiParams", function () {
  let HokusaiParams;
  let params;
  let owner;
  let governor;
  let user1;
  let addrs;

  const DEFAULT_TOKENS_PER_DELTA_ONE = wholeTokens(1000);
  const DEFAULT_INFRASTRUCTURE_ACCRUAL_BPS = 8000; // 80%
  const DEFAULT_LICENSE_HASH = keccak256(toUtf8Bytes("default-license"));
  const DEFAULT_LICENSE_URI = "https://hokusai.ai/licenses/default";
  const TOKENS_PER_DELTA_ONE_BOUNDS_ERROR =
    "tokensPerDeltaOne must be between 100 and 10000000 whole tokens (wei-scaled)";

  beforeEach(async function () {
    [owner, governor, user1, ...addrs] = await ethers.getSigners();
    HokusaiParams = await ethers.getContractFactory("HokusaiParams");

    params = await HokusaiParams.deploy(
      DEFAULT_TOKENS_PER_DELTA_ONE,
      DEFAULT_INFRASTRUCTURE_ACCRUAL_BPS,
      DEFAULT_LICENSE_HASH,
      DEFAULT_LICENSE_URI,
      governor.address
    );
    await params.waitForDeployment();
  });

  describe("Constructor", function () {
    it("Should initialize with correct default values", async function () {
      expect(await params.metricType()).to.equal(0);
      expect(await params.tokensPerDeltaOne()).to.equal(DEFAULT_TOKENS_PER_DELTA_ONE);
      expect(await params.infrastructureAccrualBps()).to.equal(DEFAULT_INFRASTRUCTURE_ACCRUAL_BPS);
      expect(await params.getProfitShareBps()).to.equal(10000 - DEFAULT_INFRASTRUCTURE_ACCRUAL_BPS);
      expect(await params.licenseHash()).to.equal(DEFAULT_LICENSE_HASH);
      expect(await params.licenseURI()).to.equal(DEFAULT_LICENSE_URI);
    });

    it("Should grant GOV_ROLE to the specified governor", async function () {
      const GOV_ROLE = await params.GOV_ROLE();
      expect(await params.hasRole(GOV_ROLE, governor.address)).to.be.true;
    });

    it("Should grant DEFAULT_ADMIN_ROLE to the deployer", async function () {
      const DEFAULT_ADMIN_ROLE = await params.DEFAULT_ADMIN_ROLE();
      expect(await params.hasRole(DEFAULT_ADMIN_ROLE, owner.address)).to.be.true;
    });

    it("Should return license reference correctly", async function () {
      const [hash, uri] = await params.licenseRef();
      expect(hash).to.equal(DEFAULT_LICENSE_HASH);
      expect(uri).to.equal(DEFAULT_LICENSE_URI);
    });

    it("Should reject zero address governor", async function () {
      await expect(
        HokusaiParams.deploy(
          DEFAULT_TOKENS_PER_DELTA_ONE,
          DEFAULT_INFRASTRUCTURE_ACCRUAL_BPS,
          DEFAULT_LICENSE_HASH,
          DEFAULT_LICENSE_URI,
          ZeroAddress
        )
      ).to.be.revertedWith("Governor cannot be zero address");
    });

    it("Should reject tokensPerDeltaOne below minimum", async function () {
      await expect(
        HokusaiParams.deploy(
          99, // Below minimum of 100
          DEFAULT_INFRASTRUCTURE_ACCRUAL_BPS,
          DEFAULT_LICENSE_HASH,
          DEFAULT_LICENSE_URI,
          governor.address
        )
      ).to.be.revertedWith(TOKENS_PER_DELTA_ONE_BOUNDS_ERROR);
    });

    it("Should reject tokensPerDeltaOne above maximum", async function () {
      await expect(
        HokusaiParams.deploy(
          10000001, // Above maximum of 10,000,000
          DEFAULT_INFRASTRUCTURE_ACCRUAL_BPS,
          DEFAULT_LICENSE_HASH,
          DEFAULT_LICENSE_URI,
          governor.address
        )
      ).to.be.revertedWith(TOKENS_PER_DELTA_ONE_BOUNDS_ERROR);
    });

    it("Should reject infrastructureAccrualBps below minimum (1000)", async function () {
      await expect(
        HokusaiParams.deploy(
          DEFAULT_TOKENS_PER_DELTA_ONE,
          999, // Below minimum of 1000 (10%)
          DEFAULT_LICENSE_HASH,
          DEFAULT_LICENSE_URI,
          governor.address
        )
      ).to.be.revertedWith("infrastructureAccrualBps must be between 1000 and 10000");
    });

    it("Should reject infrastructureAccrualBps above maximum (10000)", async function () {
      await expect(
        HokusaiParams.deploy(
          DEFAULT_TOKENS_PER_DELTA_ONE,
          10001, // Above maximum of 10000 (100%)
          DEFAULT_LICENSE_HASH,
          DEFAULT_LICENSE_URI,
          governor.address
        )
      ).to.be.revertedWith("infrastructureAccrualBps must be between 1000 and 10000");
    });
  });

  describe("Access Control", function () {
    it("Should allow governor to update tokensPerDeltaOne", async function () {
      const newValue = wholeTokens(2000);
      await expect(params.connect(governor).setTokensPerDeltaOne(newValue))
        .to.emit(params, "TokensPerDeltaOneSet")
        .withArgs(DEFAULT_TOKENS_PER_DELTA_ONE, newValue, governor.address);

      expect(await params.tokensPerDeltaOne()).to.equal(newValue);
    });

    it("Should allow governor to update metricType", async function () {
      await expect(params.connect(governor).setMetricType(1))
        .to.emit(params, "MetricTypeSet")
        .withArgs(0, 1, governor.address);

      expect(await params.metricType()).to.equal(1);
    });

    it("Should prevent non-governor from updating tokensPerDeltaOne", async function () {
      const newValue = wholeTokens(2000);
      await expect(
        params.connect(user1).setTokensPerDeltaOne(newValue)
      ).to.be.reverted;
    });

    it("Should prevent non-governor from updating metricType", async function () {
      await expect(
        params.connect(user1).setMetricType(1)
      ).to.be.reverted;
    });

    it("Should allow governor to update infrastructureAccrualBps", async function () {
      const newBps = 7000; // 70%
      await expect(params.connect(governor).setInfrastructureAccrualBps(newBps))
        .to.emit(params, "InfrastructureAccrualBpsSet")
        .withArgs(DEFAULT_INFRASTRUCTURE_ACCRUAL_BPS, newBps, governor.address);

      expect(await params.infrastructureAccrualBps()).to.equal(newBps);
      expect(await params.getProfitShareBps()).to.equal(10000 - newBps);
    });

    it("Should prevent non-governor from updating infrastructureAccrualBps", async function () {
      const newBps = 7000;
      await expect(
        params.connect(user1).setInfrastructureAccrualBps(newBps)
      ).to.be.reverted;
    });

    it("Should allow governor to update license reference", async function () {
      const newHash = keccak256(toUtf8Bytes("new-license"));
      const newUri = "https://hokusai.ai/licenses/new";

      await expect(params.connect(governor).setLicenseRef(newHash, newUri))
        .to.emit(params, "LicenseRefSet")
        .withArgs(DEFAULT_LICENSE_HASH, newHash, newUri, governor.address);

      expect(await params.licenseHash()).to.equal(newHash);
      expect(await params.licenseURI()).to.equal(newUri);

      const [hash, uri] = await params.licenseRef();
      expect(hash).to.equal(newHash);
      expect(uri).to.equal(newUri);
    });

    it("Should prevent non-governor from updating license reference", async function () {
      const newHash = keccak256(toUtf8Bytes("new-license"));
      const newUri = "https://hokusai.ai/licenses/new";

      await expect(
        params.connect(user1).setLicenseRef(newHash, newUri)
      ).to.be.reverted;
    });
  });

  describe("Parameter Bounds Validation", function () {
    it("Should reject unsupported metricType values", async function () {
      await expect(
        params.connect(governor).setMetricType(2)
      ).to.be.revertedWith("Invalid metric type");
    });

    it("Should reject tokensPerDeltaOne below minimum (100)", async function () {
      await expect(
        params.connect(governor).setTokensPerDeltaOne(99)
      ).to.be.revertedWith(TOKENS_PER_DELTA_ONE_BOUNDS_ERROR);
    });

    it("Should reject tokensPerDeltaOne above maximum (10000000)", async function () {
      await expect(
        params.connect(governor).setTokensPerDeltaOne(10000001)
      ).to.be.revertedWith(TOKENS_PER_DELTA_ONE_BOUNDS_ERROR);
    });

    it("Should accept tokensPerDeltaOne at minimum boundary", async function () {
      await expect(params.connect(governor).setTokensPerDeltaOne(100))
        .to.emit(params, "TokensPerDeltaOneSet")
        .withArgs(DEFAULT_TOKENS_PER_DELTA_ONE, wholeTokens(100), governor.address);

      expect(await params.tokensPerDeltaOne()).to.equal(wholeTokens(100));
    });

    it("Should accept tokensPerDeltaOne at maximum boundary", async function () {
      await expect(params.connect(governor).setTokensPerDeltaOne(10000000))
        .to.emit(params, "TokensPerDeltaOneSet")
        .withArgs(DEFAULT_TOKENS_PER_DELTA_ONE, wholeTokens(10000000), governor.address);

      expect(await params.tokensPerDeltaOne()).to.equal(wholeTokens(10000000));
    });

    it("Should reject infrastructureAccrualBps below minimum (1000)", async function () {
      await expect(
        params.connect(governor).setInfrastructureAccrualBps(999)
      ).to.be.revertedWith("infrastructureAccrualBps must be between 1000 and 10000");
    });

    it("Should reject infrastructureAccrualBps above maximum (10000)", async function () {
      await expect(
        params.connect(governor).setInfrastructureAccrualBps(10001)
      ).to.be.revertedWith("infrastructureAccrualBps must be between 1000 and 10000");
    });

    it("Should accept infrastructureAccrualBps at minimum boundary (10%)", async function () {
      await expect(params.connect(governor).setInfrastructureAccrualBps(1000))
        .to.emit(params, "InfrastructureAccrualBpsSet")
        .withArgs(DEFAULT_INFRASTRUCTURE_ACCRUAL_BPS, 1000, governor.address);

      expect(await params.infrastructureAccrualBps()).to.equal(1000);
      expect(await params.getProfitShareBps()).to.equal(9000); // 90% profit
    });

    it("Should accept infrastructureAccrualBps at maximum boundary (100%)", async function () {
      await expect(params.connect(governor).setInfrastructureAccrualBps(10000))
        .to.emit(params, "InfrastructureAccrualBpsSet")
        .withArgs(DEFAULT_INFRASTRUCTURE_ACCRUAL_BPS, 10000, governor.address);

      expect(await params.infrastructureAccrualBps()).to.equal(10000);
      expect(await params.getProfitShareBps()).to.equal(0); // 0% profit
    });
  });

  describe("Profit Share Calculation", function () {
    it("Should correctly calculate profit share (10/90 split)", async function () {
      await params.connect(governor).setInfrastructureAccrualBps(1000);
      expect(await params.getProfitShareBps()).to.equal(9000); // 90%
    });

    it("Should correctly calculate profit share (20/80 split)", async function () {
      await params.connect(governor).setInfrastructureAccrualBps(2000);
      expect(await params.getProfitShareBps()).to.equal(8000); // 80%
    });

    it("Should correctly calculate profit share (30/70 split)", async function () {
      await params.connect(governor).setInfrastructureAccrualBps(3000);
      expect(await params.getProfitShareBps()).to.equal(7000); // 70%
    });

    it("Should correctly calculate profit share (40/60 split)", async function () {
      await params.connect(governor).setInfrastructureAccrualBps(4000);
      expect(await params.getProfitShareBps()).to.equal(6000); // 60%
    });

    it("Should correctly calculate profit share (50/50 split)", async function () {
      await params.connect(governor).setInfrastructureAccrualBps(5000);
      expect(await params.getProfitShareBps()).to.equal(5000); // 50%
    });

    it("Should correctly calculate profit share (70/30 split)", async function () {
      await params.connect(governor).setInfrastructureAccrualBps(7000);
      expect(await params.getProfitShareBps()).to.equal(3000); // 30%
    });

    it("Should correctly calculate profit share (80/20 split)", async function () {
      await params.connect(governor).setInfrastructureAccrualBps(8000);
      expect(await params.getProfitShareBps()).to.equal(2000); // 20%
    });

    it("Should correctly calculate profit share (90/10 split)", async function () {
      await params.connect(governor).setInfrastructureAccrualBps(9000);
      expect(await params.getProfitShareBps()).to.equal(1000); // 10%
    });

    it("Should correctly calculate profit share (100/0 split)", async function () {
      await params.connect(governor).setInfrastructureAccrualBps(10000);
      expect(await params.getProfitShareBps()).to.equal(0); // 0%
    });
  });

  describe("Event Emission", function () {
    it("Should emit TokensPerDeltaOneSet with correct parameters", async function () {
      const newValue = wholeTokens(1500);
      const tx = await params.connect(governor).setTokensPerDeltaOne(newValue);

      await expect(tx)
        .to.emit(params, "TokensPerDeltaOneSet")
        .withArgs(DEFAULT_TOKENS_PER_DELTA_ONE, newValue, governor.address);
    });

    it("Should emit InfrastructureAccrualBpsSet with correct parameters", async function () {
      const newBps = 6000;
      const tx = await params.connect(governor).setInfrastructureAccrualBps(newBps);

      await expect(tx)
        .to.emit(params, "InfrastructureAccrualBpsSet")
        .withArgs(DEFAULT_INFRASTRUCTURE_ACCRUAL_BPS, newBps, governor.address);
    });

    it("Should emit LicenseRefSet with correct parameters", async function () {
      const newHash = keccak256(toUtf8Bytes("updated-license"));
      const newUri = "https://hokusai.ai/licenses/updated";
      const tx = await params.connect(governor).setLicenseRef(newHash, newUri);

      await expect(tx)
        .to.emit(params, "LicenseRefSet")
        .withArgs(DEFAULT_LICENSE_HASH, newHash, newUri, governor.address);
    });
  });

  describe("Multiple Parameter Updates", function () {
    it("Should handle sequential parameter updates correctly", async function () {
      // Update tokensPerDeltaOne
      await params.connect(governor).setTokensPerDeltaOne(1500);
      expect(await params.tokensPerDeltaOne()).to.equal(wholeTokens(1500));

      // Update infrastructureAccrualBps
      await params.connect(governor).setInfrastructureAccrualBps(7500);
      expect(await params.infrastructureAccrualBps()).to.equal(7500);
      expect(await params.getProfitShareBps()).to.equal(2500);

      // Update license reference
      const newHash = keccak256(toUtf8Bytes("sequence-license"));
      const newUri = "https://hokusai.ai/licenses/sequence";
      await params.connect(governor).setLicenseRef(newHash, newUri);

      expect(await params.licenseHash()).to.equal(newHash);
      expect(await params.licenseURI()).to.equal(newUri);

      // Verify all values are still correct
      expect(await params.tokensPerDeltaOne()).to.equal(wholeTokens(1500));
      expect(await params.infrastructureAccrualBps()).to.equal(7500);

      const [hash, uri] = await params.licenseRef();
      expect(hash).to.equal(newHash);
      expect(uri).to.equal(newUri);
    });

    it("Should maintain state consistency across multiple updates", async function () {
      const updates = [
        { tokens: 200, infra: 5000 },
        { tokens: 5000, infra: 7500 },
        { tokens: 99999, infra: 9500 }
      ];

      for (const update of updates) {
        await params.connect(governor).setTokensPerDeltaOne(update.tokens);
        await params.connect(governor).setInfrastructureAccrualBps(update.infra);

        expect(await params.tokensPerDeltaOne()).to.equal(wholeTokens(update.tokens));
        expect(await params.infrastructureAccrualBps()).to.equal(update.infra);
        expect(await params.getProfitShareBps()).to.equal(10000 - update.infra);
      }
    });
  });

  describe("Edge Cases", function () {
    it("Should handle empty license URI", async function () {
      const newHash = keccak256(toUtf8Bytes("empty-uri-license"));
      const emptyUri = "";

      await expect(params.connect(governor).setLicenseRef(newHash, emptyUri))
        .to.emit(params, "LicenseRefSet")
        .withArgs(DEFAULT_LICENSE_HASH, newHash, emptyUri, governor.address);

      expect(await params.licenseURI()).to.equal(emptyUri);
    });

    it("Should handle zero hash for license", async function () {
      const zeroHash = ZeroHash;
      const newUri = "https://hokusai.ai/licenses/zero-hash";

      await expect(params.connect(governor).setLicenseRef(zeroHash, newUri))
        .to.emit(params, "LicenseRefSet")
        .withArgs(DEFAULT_LICENSE_HASH, zeroHash, newUri, governor.address);

      expect(await params.licenseHash()).to.equal(zeroHash);
    });

    it("Should handle setting same value twice", async function () {
      const value = wholeTokens(1500);

      // Set initial value
      await params.connect(governor).setTokensPerDeltaOne(value);
      expect(await params.tokensPerDeltaOne()).to.equal(value);

      // Set same value again - should still emit event
      await expect(params.connect(governor).setTokensPerDeltaOne(value))
        .to.emit(params, "TokensPerDeltaOneSet")
        .withArgs(value, value, governor.address);

      expect(await params.tokensPerDeltaOne()).to.equal(value);
    });
  });

  describe("Role Management", function () {
    it("Should allow admin to grant GOV_ROLE to new address", async function () {
      const GOV_ROLE = await params.GOV_ROLE();

      await params.connect(owner).grantRole(GOV_ROLE, user1.address);
      expect(await params.hasRole(GOV_ROLE, user1.address)).to.be.true;

      // New governor should be able to update parameters
      const newValue = wholeTokens(3000);
      await expect(params.connect(user1).setTokensPerDeltaOne(newValue))
        .to.emit(params, "TokensPerDeltaOneSet")
        .withArgs(DEFAULT_TOKENS_PER_DELTA_ONE, newValue, user1.address);
    });

    it("Should allow admin to revoke GOV_ROLE", async function () {
      const GOV_ROLE = await params.GOV_ROLE();

      await params.connect(owner).revokeRole(GOV_ROLE, governor.address);
      expect(await params.hasRole(GOV_ROLE, governor.address)).to.be.false;

      // Revoked governor should not be able to update parameters
      await expect(
        params.connect(governor).setTokensPerDeltaOne(2000)
      ).to.be.reverted;
    });
  });

  describe("Epoch-Based Price Locking", function () {
    const TEST_MODEL_ID = "model-test-123";
    const EPOCH_DURATION_DAYS = 30;
    const EPOCH_DURATION = EPOCH_DURATION_DAYS * 24 * 60 * 60;

    describe("Epoch Configuration", function () {
      it("Should have correct default epoch duration", async function () {
        expect(await params.priceEpochDuration()).to.equal(EPOCH_DURATION);
      });

      it("Should initialize model epoch on first queue", async function () {
        const epochInfoBefore = await params.getPriceEpochInfo(TEST_MODEL_ID);
        expect(epochInfoBefore.epochStart).to.equal(0);
        expect(epochInfoBefore.epochEnd).to.equal(0);
        expect(epochInfoBefore.hasPendingUpdates).to.be.false;

        await params.connect(governor).queueParamUpdate(TEST_MODEL_ID, "tokensPerDeltaOne", 2000);

        const epochInfoAfter = await params.getPriceEpochInfo(TEST_MODEL_ID);
        expect(epochInfoAfter.epochStart).to.be.gt(0);
        expect(epochInfoAfter.epochEnd).to.equal(epochInfoAfter.epochStart + BigInt(EPOCH_DURATION));
        expect(epochInfoAfter.hasPendingUpdates).to.be.true;
      });

      it("Should return global defaults for uninitialized models", async function () {
        const tokensPerDeltaOne = await params.getModelTokensPerDeltaOne("uninitialized-model");
        const infraBps = await params.getModelInfrastructureAccrualBps("uninitialized-model");

        expect(tokensPerDeltaOne).to.equal(DEFAULT_TOKENS_PER_DELTA_ONE);
        expect(infraBps).to.equal(DEFAULT_INFRASTRUCTURE_ACCRUAL_BPS);
      });
    });

    describe("Queue Parameter Updates", function () {
      it("Should queue tokensPerDeltaOne update", async function () {
        const newValue = wholeTokens(2000);

        await expect(
          params.connect(governor).queueParamUpdate(TEST_MODEL_ID, "tokensPerDeltaOne", newValue)
        ).to.emit(params, "ParamUpdateQueued")
          .withArgs(TEST_MODEL_ID, "tokensPerDeltaOne", DEFAULT_TOKENS_PER_DELTA_ONE, newValue, await ethers.provider.getBlock("latest").then(b => b.timestamp + 1 + EPOCH_DURATION));

        const epochInfo = await params.getPriceEpochInfo(TEST_MODEL_ID);
        expect(epochInfo.hasPendingUpdates).to.be.true;
      });

      it("Should queue infrastructureAccrualBps update", async function () {
        const newBps = 7000;

        await expect(
          params.connect(governor).queueParamUpdate(TEST_MODEL_ID, "infrastructureAccrualBps", newBps)
        ).to.emit(params, "ParamUpdateQueued");

        const epochInfo = await params.getPriceEpochInfo(TEST_MODEL_ID);
        expect(epochInfo.hasPendingUpdates).to.be.true;
      });

      it("Should allow queuing multiple parameter updates in same epoch", async function () {
        await params.connect(governor).queueParamUpdate(TEST_MODEL_ID, "tokensPerDeltaOne", 3000);
        await params.connect(governor).queueParamUpdate(TEST_MODEL_ID, "infrastructureAccrualBps", 9000);

        const epochInfo = await params.getPriceEpochInfo(TEST_MODEL_ID);
        expect(epochInfo.hasPendingUpdates).to.be.true;
      });

      it("Should reject queue with invalid parameter name", async function () {
        await expect(
          params.connect(governor).queueParamUpdate(TEST_MODEL_ID, "invalidParam", 1000)
        ).to.be.revertedWith("Invalid parameter name");
      });

      it("Should reject queue with empty model ID", async function () {
        await expect(
          params.connect(governor).queueParamUpdate("", "tokensPerDeltaOne", 2000)
        ).to.be.revertedWith("Model ID cannot be empty");
      });

      it("Should reject queue with out-of-bounds value", async function () {
        await expect(
          params.connect(governor).queueParamUpdate(TEST_MODEL_ID, "tokensPerDeltaOne", 50)
        ).to.be.revertedWith(TOKENS_PER_DELTA_ONE_BOUNDS_ERROR);

        await expect(
          params.connect(governor).queueParamUpdate(TEST_MODEL_ID, "infrastructureAccrualBps", 500)
        ).to.be.revertedWith("infrastructureAccrualBps must be between 1000 and 10000");
      });

      it("Should prevent non-governor from queuing updates", async function () {
        await expect(
          params.connect(user1).queueParamUpdate(TEST_MODEL_ID, "tokensPerDeltaOne", 2000)
        ).to.be.reverted;
      });
    });

    describe("Apply Pending Updates", function () {
      it("Should fail to apply updates before epoch ends", async function () {
        await params.connect(governor).queueParamUpdate(TEST_MODEL_ID, "tokensPerDeltaOne", 5000);

        await expect(
          params.applyPendingUpdates(TEST_MODEL_ID)
        ).to.be.revertedWith("Epoch has not ended yet");
      });

      it("Should successfully apply updates after epoch boundary", async function () {
        const MODEL_ID = "model-apply-test";
        const newValue = wholeTokens(5000);

        // Queue update
        await params.connect(governor).queueParamUpdate(MODEL_ID, "tokensPerDeltaOne", newValue);

        // Fast forward past epoch boundary
        await ethers.provider.send("evm_increaseTime", [EPOCH_DURATION + 1]);
        await ethers.provider.send("evm_mine");

        // Apply updates
        await expect(params.applyPendingUpdates(MODEL_ID))
          .to.emit(params, "ParamUpdateApplied")
          .withArgs(MODEL_ID, "tokensPerDeltaOne", DEFAULT_TOKENS_PER_DELTA_ONE, newValue);

        // Verify new value
        expect(await params.getModelTokensPerDeltaOne(MODEL_ID)).to.equal(newValue);
      });

      it("Should apply multiple parameter updates", async function () {
        const MODEL_ID = "model-multi-apply";
        const newTokens = 8000;
        const newInfra = 9500;

        // Queue both updates
        await params.connect(governor).queueParamUpdate(MODEL_ID, "tokensPerDeltaOne", newTokens);
        await params.connect(governor).queueParamUpdate(MODEL_ID, "infrastructureAccrualBps", newInfra);

        // Fast forward
        await ethers.provider.send("evm_increaseTime", [EPOCH_DURATION + 1]);
        await ethers.provider.send("evm_mine");

        // Apply updates
        const tx = await params.applyPendingUpdates(MODEL_ID);
        const receipt = await tx.wait();

        // Verify both events were emitted
        const events = receipt.logs.filter(log => {
          try {
            return params.interface.parseLog(log).name === "ParamUpdateApplied";
          } catch {
            return false;
          }
        });
        expect(events.length).to.equal(2);

        // Verify new values
        expect(await params.getModelTokensPerDeltaOne(MODEL_ID)).to.equal(wholeTokens(newTokens));
        expect(await params.getModelInfrastructureAccrualBps(MODEL_ID)).to.equal(newInfra);
      });

      it("Should start new epoch after applying updates", async function () {
        const MODEL_ID = "model-new-epoch";

        await params.connect(governor).queueParamUpdate(MODEL_ID, "tokensPerDeltaOne", 7000);

        const epochBefore = await params.getPriceEpochInfo(MODEL_ID);

        // Fast forward and apply
        await ethers.provider.send("evm_increaseTime", [EPOCH_DURATION + 1]);
        await ethers.provider.send("evm_mine");
        await params.applyPendingUpdates(MODEL_ID);

        const epochAfter = await params.getPriceEpochInfo(MODEL_ID);

        expect(epochAfter.epochStart).to.be.gt(epochBefore.epochStart);
        expect(epochAfter.hasPendingUpdates).to.be.false;
      });

      it("Should be permissionless (anyone can call)", async function () {
        const MODEL_ID = "model-permissionless";

        await params.connect(governor).queueParamUpdate(MODEL_ID, "tokensPerDeltaOne", 4000);

        await ethers.provider.send("evm_increaseTime", [EPOCH_DURATION + 1]);
        await ethers.provider.send("evm_mine");

        // Non-governor user can apply updates
        await expect(params.connect(user1).applyPendingUpdates(MODEL_ID))
          .to.emit(params, "ParamUpdateApplied");
      });

      it("Should reject apply for uninitialized model", async function () {
        await expect(
          params.applyPendingUpdates("never-initialized")
        ).to.be.revertedWith("Model not initialized");
      });
    });

    describe("Cancel Pending Updates", function () {
      it("Should allow governor to cancel pending update", async function () {
        const MODEL_ID = "model-cancel-test";

        await params.connect(governor).queueParamUpdate(MODEL_ID, "tokensPerDeltaOne", 6000);

        let epochInfo = await params.getPriceEpochInfo(MODEL_ID);
        expect(epochInfo.hasPendingUpdates).to.be.true;

        await params.connect(governor).cancelPendingUpdate(MODEL_ID, "tokensPerDeltaOne");

        epochInfo = await params.getPriceEpochInfo(MODEL_ID);
        expect(epochInfo.hasPendingUpdates).to.be.false;
      });

      it("Should reject cancel if no pending update exists", async function () {
        const MODEL_ID = "model-no-pending";

        await params.connect(governor).queueParamUpdate(MODEL_ID, "tokensPerDeltaOne", 6000);

        await expect(
          params.connect(governor).cancelPendingUpdate(MODEL_ID, "infrastructureAccrualBps")
        ).to.be.revertedWith("No pending update for this parameter");
      });

      it("Should prevent non-governor from canceling updates", async function () {
        const MODEL_ID = "model-cancel-auth";

        await params.connect(governor).queueParamUpdate(MODEL_ID, "tokensPerDeltaOne", 6000);

        await expect(
          params.connect(user1).cancelPendingUpdate(MODEL_ID, "tokensPerDeltaOne")
        ).to.be.reverted;
      });
    });

    describe("Emergency Override", function () {
      it("Should allow admin to force-apply parameter change", async function () {
        const MODEL_ID = "model-emergency";
        const newValue = wholeTokens(15000);
        const reason = "Critical bug fix required";

        await expect(
          params.connect(owner).emergencySetParam(MODEL_ID, "tokensPerDeltaOne", newValue, reason)
        ).to.emit(params, "EmergencyParamOverride")
          .withArgs(MODEL_ID, "tokensPerDeltaOne", newValue, reason);

        expect(await params.getModelTokensPerDeltaOne(MODEL_ID)).to.equal(newValue);
      });

      it("Should bypass epoch boundary", async function () {
        const MODEL_ID = "model-bypass-epoch";
        const newValue = wholeTokens(25000);

        // Emergency set should work immediately
        await params.connect(owner).emergencySetParam(
          MODEL_ID,
          "tokensPerDeltaOne",
          newValue,
          "Urgent pricing adjustment"
        );

        expect(await params.getModelTokensPerDeltaOne(MODEL_ID)).to.equal(newValue);
      });

      it("Should clear pending update if exists", async function () {
        const MODEL_ID = "model-clear-pending";

        // Queue an update
        await params.connect(governor).queueParamUpdate(MODEL_ID, "tokensPerDeltaOne", 5000);

        let epochInfo = await params.getPriceEpochInfo(MODEL_ID);
        expect(epochInfo.hasPendingUpdates).to.be.true;

        // Emergency override
        await params.connect(owner).emergencySetParam(
          MODEL_ID,
          "tokensPerDeltaOne",
          10000,
          "Override pending update"
        );

        epochInfo = await params.getPriceEpochInfo(MODEL_ID);
        expect(epochInfo.hasPendingUpdates).to.be.false;
      });

      it("Should require DEFAULT_ADMIN_ROLE", async function () {
        await expect(
          params.connect(governor).emergencySetParam("model", "tokensPerDeltaOne", 5000, "reason")
        ).to.be.reverted;

        await expect(
          params.connect(user1).emergencySetParam("model", "tokensPerDeltaOne", 5000, "reason")
        ).to.be.reverted;
      });

      it("Should reject empty reason", async function () {
        await expect(
          params.connect(owner).emergencySetParam("model", "tokensPerDeltaOne", 5000, "")
        ).to.be.revertedWith("Reason cannot be empty");
      });

      it("Should validate parameter bounds", async function () {
        await expect(
          params.connect(owner).emergencySetParam("model", "tokensPerDeltaOne", 50, "Invalid value")
        ).to.be.revertedWith(TOKENS_PER_DELTA_ONE_BOUNDS_ERROR);
      });
    });

    describe("Edge Cases and Integration", function () {
      it("Should handle multiple epochs correctly", async function () {
        const MODEL_ID = "model-multi-epoch";

        // Epoch 1: Queue and apply
        await params.connect(governor).queueParamUpdate(MODEL_ID, "tokensPerDeltaOne", 2000);
        await ethers.provider.send("evm_increaseTime", [EPOCH_DURATION + 1]);
        await ethers.provider.send("evm_mine");
        await params.applyPendingUpdates(MODEL_ID);
        expect(await params.getModelTokensPerDeltaOne(MODEL_ID)).to.equal(wholeTokens(2000));

        // Epoch 2: Queue and apply
        await params.connect(governor).queueParamUpdate(MODEL_ID, "tokensPerDeltaOne", 3000);
        await ethers.provider.send("evm_increaseTime", [EPOCH_DURATION + 1]);
        await ethers.provider.send("evm_mine");
        await params.applyPendingUpdates(MODEL_ID);
        expect(await params.getModelTokensPerDeltaOne(MODEL_ID)).to.equal(wholeTokens(3000));
      });

      it("Should handle overwriting queued updates", async function () {
        const MODEL_ID = "model-overwrite";

        await params.connect(governor).queueParamUpdate(MODEL_ID, "tokensPerDeltaOne", 4000);
        await params.connect(governor).queueParamUpdate(MODEL_ID, "tokensPerDeltaOne", 6000);

        await ethers.provider.send("evm_increaseTime", [EPOCH_DURATION + 1]);
        await ethers.provider.send("evm_mine");
        await params.applyPendingUpdates(MODEL_ID);

        // Should apply the latest queued value
        expect(await params.getModelTokensPerDeltaOne(MODEL_ID)).to.equal(wholeTokens(6000));
      });

      it("Should handle different models independently", async function () {
        const MODEL_A = "model-a";
        const MODEL_B = "model-b";

        await params.connect(governor).queueParamUpdate(MODEL_A, "tokensPerDeltaOne", 5000);
        await params.connect(governor).queueParamUpdate(MODEL_B, "tokensPerDeltaOne", 7000);

        await ethers.provider.send("evm_increaseTime", [EPOCH_DURATION + 1]);
        await ethers.provider.send("evm_mine");

        await params.applyPendingUpdates(MODEL_A);
        await params.applyPendingUpdates(MODEL_B);

        expect(await params.getModelTokensPerDeltaOne(MODEL_A)).to.equal(wholeTokens(5000));
        expect(await params.getModelTokensPerDeltaOne(MODEL_B)).to.equal(wholeTokens(7000));
      });
    });
  });
});
