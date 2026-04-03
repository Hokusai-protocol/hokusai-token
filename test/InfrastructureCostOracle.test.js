const { expect } = require("chai");
const { ethers } = require("hardhat");
const { parseUnits } = require("ethers");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("InfrastructureCostOracle", function () {
  let oracle;
  let owner, governor, admin, user1;

  const MODEL_ID_1 = "model-alpha";
  const MODEL_ID_2 = "model-beta";
  const INITIAL_GROSS_MARGIN_BPS = 2000; // 20% markup

  beforeEach(async function () {
    [owner, governor, admin, user1] = await ethers.getSigners();

    const InfrastructureCostOracle = await ethers.getContractFactory("InfrastructureCostOracle");
    oracle = await InfrastructureCostOracle.deploy(owner.address, INITIAL_GROSS_MARGIN_BPS);
    await oracle.waitForDeployment();

    // Grant governor role to governor address
    const GOV_ROLE = await oracle.GOV_ROLE();
    await oracle.grantRole(GOV_ROLE, governor.address);
  });

  // ============================================================
  // DEPLOYMENT & INITIALIZATION
  // ============================================================

  describe("Deployment", function () {
    it("Should grant admin role to deployer", async function () {
      const DEFAULT_ADMIN_ROLE = await oracle.DEFAULT_ADMIN_ROLE();
      expect(await oracle.hasRole(DEFAULT_ADMIN_ROLE, owner.address)).to.be.true;
    });

    it("Should grant GOV_ROLE to deployer", async function () {
      const GOV_ROLE = await oracle.GOV_ROLE();
      expect(await oracle.hasRole(GOV_ROLE, owner.address)).to.be.true;
    });

    it("Should set default epoch duration to 30 days", async function () {
      expect(await oracle.epochDuration()).to.equal(30 * 24 * 60 * 60);
    });

    it("Should set initial gross margin", async function () {
      expect(await oracle.grossMarginBps()).to.equal(INITIAL_GROSS_MARGIN_BPS);
    });

    it("Should start with zero costs for all models", async function () {
      expect(await oracle.getEstimatedCost(MODEL_ID_1)).to.equal(0);
      expect(await oracle.hasCost(MODEL_ID_1)).to.be.false;
    });

    it("Should revert if gross margin exceeds 100%", async function () {
      const InfrastructureCostOracle = await ethers.getContractFactory("InfrastructureCostOracle");
      await expect(
        InfrastructureCostOracle.deploy(owner.address, 10001)
      ).to.be.revertedWith("Gross margin cannot exceed 100%");
    });
  });

  // ============================================================
  // SET ESTIMATED COST (QUEUE UPDATE)
  // ============================================================

  describe("Set Estimated Cost", function () {
    it("Should queue first cost update for immediate application", async function () {
      const cost = parseUnits("500", 6); // $500 per 1000 calls

      await expect(oracle.connect(governor).setEstimatedCost(MODEL_ID_1, cost, 0))
        .to.emit(oracle, "CostUpdateQueued");

      const [exists, pendingCost, queuedAt] = await oracle.getPendingUpdate(MODEL_ID_1);
      expect(exists).to.be.true;
      expect(pendingCost).to.equal(cost);
      expect(queuedAt).to.be.gt(0);
    });

    it("Should allow specifying custom effective epoch", async function () {
      const cost = parseUnits("500", 6);
      const futureTime = (await time.latest()) + 7 * 24 * 60 * 60; // 7 days from now

      await expect(oracle.connect(governor).setEstimatedCost(MODEL_ID_1, cost, futureTime))
        .to.emit(oracle, "CostUpdateQueued")
        .withArgs(MODEL_ID_1, 0, cost, futureTime, governor.address);
    });

    it("Should emit CostUpdateQueued event with correct parameters", async function () {
      const cost = parseUnits("500", 6);

      const tx = await oracle.connect(governor).setEstimatedCost(MODEL_ID_1, cost, 0);
      const receipt = await tx.wait();
      const block = await ethers.provider.getBlock(receipt.blockNumber);

      await expect(tx)
        .to.emit(oracle, "CostUpdateQueued")
        .withArgs(MODEL_ID_1, 0, cost, block.timestamp, governor.address);
    });

    it("Should allow setting cost to zero", async function () {
      await oracle.connect(governor).setEstimatedCost(MODEL_ID_1, 0, 0);

      const [exists, pendingCost] = await oracle.getPendingUpdate(MODEL_ID_1);
      expect(exists).to.be.true;
      expect(pendingCost).to.equal(0);
    });

    it("Should revert if model ID is empty", async function () {
      await expect(
        oracle.connect(governor).setEstimatedCost("", parseUnits("500", 6), 0)
      ).to.be.reverted;
    });

    it("Should revert if caller is not governor", async function () {
      await expect(
        oracle.connect(user1).setEstimatedCost(MODEL_ID_1, parseUnits("500", 6), 0)
      ).to.be.reverted;
    });

    it("Should replace pending update if called again before application", async function () {
      await oracle.connect(governor).setEstimatedCost(MODEL_ID_1, parseUnits("500", 6), 0);
      await oracle.connect(governor).setEstimatedCost(MODEL_ID_1, parseUnits("600", 6), 0);

      const [exists, pendingCost] = await oracle.getPendingUpdate(MODEL_ID_1);
      expect(exists).to.be.true;
      expect(pendingCost).to.equal(parseUnits("600", 6));
    });
  });

  // ============================================================
  // APPLY PENDING UPDATE
  // ============================================================

  describe("Apply Pending Update", function () {
    it("Should apply first pending update immediately", async function () {
      const cost = parseUnits("500", 6);
      await oracle.connect(governor).setEstimatedCost(MODEL_ID_1, cost, 0);

      await expect(oracle.connect(user1).applyPendingUpdate(MODEL_ID_1))
        .to.emit(oracle, "CostUpdateApplied")
        .withArgs(MODEL_ID_1, 0, cost, user1.address);

      expect(await oracle.getEstimatedCost(MODEL_ID_1)).to.equal(cost);
      expect(await oracle.hasCost(MODEL_ID_1)).to.be.true;
    });

    it("Should enforce epoch boundary for subsequent updates", async function () {
      const cost1 = parseUnits("500", 6);
      const cost2 = parseUnits("600", 6);

      // First update
      await oracle.connect(governor).setEstimatedCost(MODEL_ID_1, cost1, 0);
      await oracle.connect(user1).applyPendingUpdate(MODEL_ID_1);

      // Queue second update
      await oracle.connect(governor).setEstimatedCost(MODEL_ID_1, cost2, 0);

      // Should revert before epoch boundary
      await expect(
        oracle.connect(user1).applyPendingUpdate(MODEL_ID_1)
      ).to.be.revertedWith("Epoch boundary not reached");

      // Should succeed after epoch boundary
      await time.increase(30 * 24 * 60 * 60); // 30 days
      await expect(oracle.connect(user1).applyPendingUpdate(MODEL_ID_1))
        .to.emit(oracle, "CostUpdateApplied")
        .withArgs(MODEL_ID_1, cost1, cost2, user1.address);

      expect(await oracle.getEstimatedCost(MODEL_ID_1)).to.equal(cost2);
    });

    it("Should update lastUpdated timestamp", async function () {
      const cost = parseUnits("500", 6);
      await oracle.connect(governor).setEstimatedCost(MODEL_ID_1, cost, 0);

      const timestampBefore = await time.latest();
      await oracle.connect(user1).applyPendingUpdate(MODEL_ID_1);

      const lastUpdated = await oracle.getLastUpdated(MODEL_ID_1);
      expect(lastUpdated).to.be.gte(timestampBefore);
      expect(lastUpdated).to.be.lte(await time.latest());
    });

    it("Should delete pending update after application", async function () {
      const cost = parseUnits("500", 6);
      await oracle.connect(governor).setEstimatedCost(MODEL_ID_1, cost, 0);
      await oracle.connect(user1).applyPendingUpdate(MODEL_ID_1);

      const [exists] = await oracle.getPendingUpdate(MODEL_ID_1);
      expect(exists).to.be.false;
    });

    it("Should allow anyone to apply pending update", async function () {
      const cost = parseUnits("500", 6);
      await oracle.connect(governor).setEstimatedCost(MODEL_ID_1, cost, 0);

      // Non-privileged user can apply
      await expect(oracle.connect(user1).applyPendingUpdate(MODEL_ID_1))
        .to.not.be.reverted;
    });

    it("Should revert if no pending update exists", async function () {
      await expect(
        oracle.connect(user1).applyPendingUpdate(MODEL_ID_1)
      ).to.be.revertedWith("No pending update for this model");
    });

    it("Should revert if model ID is empty", async function () {
      await expect(
        oracle.connect(user1).applyPendingUpdate("")
      ).to.be.reverted;
    });
  });

  // ============================================================
  // END USER PRICE
  // ============================================================

  describe("Get End User Price", function () {
    it("Should calculate end-user price with gross margin", async function () {
      const cost = parseUnits("1000", 6); // $1000 per 1000 calls
      await oracle.connect(governor).setEstimatedCost(MODEL_ID_1, cost, 0);
      await oracle.connect(user1).applyPendingUpdate(MODEL_ID_1);

      // Expected: $1000 + 20% = $1200
      const expectedPrice = parseUnits("1200", 6);
      expect(await oracle.getEndUserPrice(MODEL_ID_1)).to.equal(expectedPrice);
    });

    it("Should return zero if no cost is set", async function () {
      expect(await oracle.getEndUserPrice(MODEL_ID_1)).to.equal(0);
    });

    it("Should handle zero gross margin", async function () {
      // Deploy new oracle with 0% margin
      const InfrastructureCostOracle = await ethers.getContractFactory("InfrastructureCostOracle");
      const zeroMarginOracle = await InfrastructureCostOracle.deploy(owner.address, 0);

      const GOV_ROLE = await zeroMarginOracle.GOV_ROLE();
      await zeroMarginOracle.grantRole(GOV_ROLE, governor.address);

      const cost = parseUnits("1000", 6);
      await zeroMarginOracle.connect(governor).setEstimatedCost(MODEL_ID_1, cost, 0);
      await zeroMarginOracle.connect(user1).applyPendingUpdate(MODEL_ID_1);

      expect(await zeroMarginOracle.getEndUserPrice(MODEL_ID_1)).to.equal(cost);
    });

    it("Should handle 100% gross margin", async function () {
      // Deploy new oracle with 100% margin
      const InfrastructureCostOracle = await ethers.getContractFactory("InfrastructureCostOracle");
      const fullMarginOracle = await InfrastructureCostOracle.deploy(owner.address, 10000);

      const GOV_ROLE = await fullMarginOracle.GOV_ROLE();
      await fullMarginOracle.grantRole(GOV_ROLE, governor.address);

      const cost = parseUnits("1000", 6);
      await fullMarginOracle.connect(governor).setEstimatedCost(MODEL_ID_1, cost, 0);
      await fullMarginOracle.connect(user1).applyPendingUpdate(MODEL_ID_1);

      // Expected: $1000 + 100% = $2000
      const expectedPrice = parseUnits("2000", 6);
      expect(await fullMarginOracle.getEndUserPrice(MODEL_ID_1)).to.equal(expectedPrice);
    });

    it("Should update end-user price when gross margin changes", async function () {
      const cost = parseUnits("1000", 6);
      await oracle.connect(governor).setEstimatedCost(MODEL_ID_1, cost, 0);
      await oracle.connect(user1).applyPendingUpdate(MODEL_ID_1);

      // Initial: $1000 + 20% = $1200
      expect(await oracle.getEndUserPrice(MODEL_ID_1)).to.equal(parseUnits("1200", 6));

      // Change margin to 30%
      await oracle.connect(governor).setGrossMarginBps(3000);

      // New: $1000 + 30% = $1300
      expect(await oracle.getEndUserPrice(MODEL_ID_1)).to.equal(parseUnits("1300", 6));
    });
  });

  // ============================================================
  // EPOCH DURATION
  // ============================================================

  describe("Set Epoch Duration", function () {
    it("Should allow admin to change epoch duration", async function () {
      const newDuration = 60 * 24 * 60 * 60; // 60 days

      await expect(oracle.connect(owner).setEpochDuration(newDuration))
        .to.emit(oracle, "EpochDurationSet")
        .withArgs(30 * 24 * 60 * 60, newDuration, owner.address);

      expect(await oracle.epochDuration()).to.equal(newDuration);
    });

    it("Should enforce minimum epoch duration", async function () {
      const tooShort = 12 * 60 * 60; // 12 hours

      await expect(
        oracle.connect(owner).setEpochDuration(tooShort)
      ).to.be.revertedWith("Epoch duration must be between 1 and 365 days");
    });

    it("Should enforce maximum epoch duration", async function () {
      const tooLong = 366 * 24 * 60 * 60; // 366 days

      await expect(
        oracle.connect(owner).setEpochDuration(tooLong)
      ).to.be.revertedWith("Epoch duration must be between 1 and 365 days");
    });

    it("Should accept minimum boundary (1 day)", async function () {
      const minDuration = 24 * 60 * 60; // 1 day

      await expect(oracle.connect(owner).setEpochDuration(minDuration))
        .to.not.be.reverted;

      expect(await oracle.epochDuration()).to.equal(minDuration);
    });

    it("Should accept maximum boundary (365 days)", async function () {
      const maxDuration = 365 * 24 * 60 * 60; // 365 days

      await expect(oracle.connect(owner).setEpochDuration(maxDuration))
        .to.not.be.reverted;

      expect(await oracle.epochDuration()).to.equal(maxDuration);
    });

    it("Should revert if caller is not admin", async function () {
      await expect(
        oracle.connect(governor).setEpochDuration(60 * 24 * 60 * 60)
      ).to.be.reverted;
    });
  });

  // ============================================================
  // GROSS MARGIN
  // ============================================================

  describe("Set Gross Margin", function () {
    it("Should allow governor to change gross margin", async function () {
      const newMargin = 3000; // 30%

      await expect(oracle.connect(governor).setGrossMarginBps(newMargin))
        .to.emit(oracle, "GrossMarginBpsSet")
        .withArgs(INITIAL_GROSS_MARGIN_BPS, newMargin, governor.address);

      expect(await oracle.grossMarginBps()).to.equal(newMargin);
    });

    it("Should enforce maximum gross margin of 100%", async function () {
      await expect(
        oracle.connect(governor).setGrossMarginBps(10001)
      ).to.be.revertedWith("Gross margin cannot exceed 100%");
    });

    it("Should allow zero gross margin", async function () {
      await expect(oracle.connect(governor).setGrossMarginBps(0))
        .to.not.be.reverted;

      expect(await oracle.grossMarginBps()).to.equal(0);
    });

    it("Should allow 100% gross margin", async function () {
      await expect(oracle.connect(governor).setGrossMarginBps(10000))
        .to.not.be.reverted;

      expect(await oracle.grossMarginBps()).to.equal(10000);
    });

    it("Should revert if caller is not governor", async function () {
      await expect(
        oracle.connect(user1).setGrossMarginBps(3000)
      ).to.be.reverted;
    });
  });

  // ============================================================
  // VIEW FUNCTIONS
  // ============================================================

  describe("View Functions", function () {
    it("Should return zero for model with no cost set", async function () {
      expect(await oracle.getEstimatedCost("non-existent-model")).to.equal(0);
      expect(await oracle.hasCost("non-existent-model")).to.be.false;
    });

    it("Should return zero lastUpdated for never-updated model", async function () {
      expect(await oracle.getLastUpdated(MODEL_ID_1)).to.equal(0);
    });

    it("Should return false for non-existent pending update", async function () {
      const [exists] = await oracle.getPendingUpdate(MODEL_ID_1);
      expect(exists).to.be.false;
    });
  });

  // ============================================================
  // ACCESS CONTROL
  // ============================================================

  describe("Access Control", function () {
    it("Should allow admin to grant GOV_ROLE", async function () {
      const GOV_ROLE = await oracle.GOV_ROLE();
      await oracle.connect(owner).grantRole(GOV_ROLE, user1.address);

      expect(await oracle.hasRole(GOV_ROLE, user1.address)).to.be.true;
    });

    it("Should allow admin to revoke GOV_ROLE", async function () {
      const GOV_ROLE = await oracle.GOV_ROLE();
      await oracle.connect(owner).revokeRole(GOV_ROLE, governor.address);

      expect(await oracle.hasRole(GOV_ROLE, governor.address)).to.be.false;
    });

    it("Should prevent non-admin from granting roles", async function () {
      const GOV_ROLE = await oracle.GOV_ROLE();

      await expect(
        oracle.connect(user1).grantRole(GOV_ROLE, user1.address)
      ).to.be.reverted;
    });

    it("Should have correct role constants", async function () {
      const GOV_ROLE = await oracle.GOV_ROLE();
      const expectedRole = ethers.keccak256(ethers.toUtf8Bytes("GOV_ROLE"));

      expect(GOV_ROLE).to.equal(expectedRole);
    });
  });

  // ============================================================
  // EDGE CASES
  // ============================================================

  describe("Edge Cases", function () {
    it("Should handle very large costs", async function () {
      const largeCost = parseUnits("1000000", 6); // $1M per 1000 calls
      await oracle.connect(governor).setEstimatedCost(MODEL_ID_1, largeCost, 0);
      await oracle.connect(user1).applyPendingUpdate(MODEL_ID_1);

      expect(await oracle.getEstimatedCost(MODEL_ID_1)).to.equal(largeCost);
      // End-user price: $1M + 20% = $1.2M
      expect(await oracle.getEndUserPrice(MODEL_ID_1)).to.equal(parseUnits("1200000", 6));
    });

    it("Should handle very small costs", async function () {
      const smallCost = 1; // 1e-6 USDC per 1000 calls
      await oracle.connect(governor).setEstimatedCost(MODEL_ID_1, smallCost, 0);
      await oracle.connect(user1).applyPendingUpdate(MODEL_ID_1);

      expect(await oracle.getEstimatedCost(MODEL_ID_1)).to.equal(smallCost);
      // End-user price: 1 + 20% = 1 (rounds down due to integer division)
      expect(await oracle.getEndUserPrice(MODEL_ID_1)).to.equal(1);
    });

    it("Should handle multiple models independently", async function () {
      const cost1 = parseUnits("500", 6);
      const cost2 = parseUnits("700", 6);

      await oracle.connect(governor).setEstimatedCost(MODEL_ID_1, cost1, 0);
      await oracle.connect(governor).setEstimatedCost(MODEL_ID_2, cost2, 0);

      await oracle.connect(user1).applyPendingUpdate(MODEL_ID_1);
      await oracle.connect(user1).applyPendingUpdate(MODEL_ID_2);

      expect(await oracle.getEstimatedCost(MODEL_ID_1)).to.equal(cost1);
      expect(await oracle.getEstimatedCost(MODEL_ID_2)).to.equal(cost2);
    });

    it("Should handle epoch boundaries correctly across multiple updates", async function () {
      const cost1 = parseUnits("500", 6);
      const cost2 = parseUnits("600", 6);
      const cost3 = parseUnits("700", 6);

      // First update
      await oracle.connect(governor).setEstimatedCost(MODEL_ID_1, cost1, 0);
      await oracle.connect(user1).applyPendingUpdate(MODEL_ID_1);

      // Second update after epoch
      await time.increase(30 * 24 * 60 * 60);
      await oracle.connect(governor).setEstimatedCost(MODEL_ID_1, cost2, 0);
      await oracle.connect(user1).applyPendingUpdate(MODEL_ID_1);

      // Third update after another epoch
      await time.increase(30 * 24 * 60 * 60);
      await oracle.connect(governor).setEstimatedCost(MODEL_ID_1, cost3, 0);
      await oracle.connect(user1).applyPendingUpdate(MODEL_ID_1);

      expect(await oracle.getEstimatedCost(MODEL_ID_1)).to.equal(cost3);
    });

    it("Should handle zero cost correctly in end-user price", async function () {
      await oracle.connect(governor).setEstimatedCost(MODEL_ID_1, 0, 0);
      await oracle.connect(user1).applyPendingUpdate(MODEL_ID_1);

      expect(await oracle.getEstimatedCost(MODEL_ID_1)).to.equal(0);
      expect(await oracle.getEndUserPrice(MODEL_ID_1)).to.equal(0);
    });
  });
});
