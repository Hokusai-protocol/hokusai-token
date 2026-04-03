const { expect } = require("chai");
const { ethers } = require("hardhat");
const { parseUnits, ZeroAddress } = require("ethers");

describe("InfrastructureCostOracle", function () {
  let oracle;
  let owner, updater, user1;

  const MODEL_ID_1 = "model-alpha";
  const MODEL_ID_2 = "model-beta";

  beforeEach(async function () {
    [owner, updater, user1] = await ethers.getSigners();

    const InfrastructureCostOracle = await ethers.getContractFactory("InfrastructureCostOracle");
    oracle = await InfrastructureCostOracle.deploy(owner.address);
    await oracle.waitForDeployment();

    // Grant updater role to updater address
    const COST_UPDATER_ROLE = await oracle.COST_UPDATER_ROLE();
    await oracle.grantRole(COST_UPDATER_ROLE, updater.address);
  });

  // ============================================================
  // DEPLOYMENT & INITIALIZATION
  // ============================================================

  describe("Deployment", function () {
    it("Should grant admin role to deployer", async function () {
      const DEFAULT_ADMIN_ROLE = await oracle.DEFAULT_ADMIN_ROLE();
      expect(await oracle.hasRole(DEFAULT_ADMIN_ROLE, owner.address)).to.be.true;
    });

    it("Should grant updater role to deployer", async function () {
      const COST_UPDATER_ROLE = await oracle.COST_UPDATER_ROLE();
      expect(await oracle.hasRole(COST_UPDATER_ROLE, owner.address)).to.be.true;
    });

    it("Should start with zero costs for all models", async function () {
      expect(await oracle.getEstimatedCost(MODEL_ID_1)).to.equal(0);
      expect(await oracle.hasCost(MODEL_ID_1)).to.be.false;
    });
  });

  // ============================================================
  // SET COST
  // ============================================================

  describe("Set Cost", function () {
    it("Should set cost for a model", async function () {
      const cost = parseUnits("500", 6); // $500 per 1000 calls

      await oracle.connect(updater).setCost(MODEL_ID_1, cost);

      expect(await oracle.getEstimatedCost(MODEL_ID_1)).to.equal(cost);
      expect(await oracle.hasCost(MODEL_ID_1)).to.be.true;
    });

    it("Should emit CostUpdated event", async function () {
      const cost = parseUnits("500", 6);

      await expect(oracle.connect(updater).setCost(MODEL_ID_1, cost))
        .to.emit(oracle, "CostUpdated")
        .withArgs(MODEL_ID_1, 0, cost, updater.address);
    });

    it("Should update existing cost", async function () {
      await oracle.connect(updater).setCost(MODEL_ID_1, parseUnits("500", 6));

      const newCost = parseUnits("600", 6);
      await expect(oracle.connect(updater).setCost(MODEL_ID_1, newCost))
        .to.emit(oracle, "CostUpdated")
        .withArgs(MODEL_ID_1, parseUnits("500", 6), newCost, updater.address);

      expect(await oracle.getEstimatedCost(MODEL_ID_1)).to.equal(newCost);
    });

    it("Should allow setting cost to zero", async function () {
      await oracle.connect(updater).setCost(MODEL_ID_1, parseUnits("500", 6));
      await oracle.connect(updater).setCost(MODEL_ID_1, 0);

      expect(await oracle.getEstimatedCost(MODEL_ID_1)).to.equal(0);
      expect(await oracle.hasCost(MODEL_ID_1)).to.be.false;
    });

    it("Should revert if model ID is empty", async function () {
      await expect(
        oracle.connect(updater).setCost("", parseUnits("500", 6))
      ).to.be.reverted;
    });

    it("Should revert if caller is not updater", async function () {
      await expect(
        oracle.connect(user1).setCost(MODEL_ID_1, parseUnits("500", 6))
      ).to.be.reverted;
    });

    it("Should track costs independently for different models", async function () {
      await oracle.connect(updater).setCost(MODEL_ID_1, parseUnits("500", 6));
      await oracle.connect(updater).setCost(MODEL_ID_2, parseUnits("700", 6));

      expect(await oracle.getEstimatedCost(MODEL_ID_1)).to.equal(parseUnits("500", 6));
      expect(await oracle.getEstimatedCost(MODEL_ID_2)).to.equal(parseUnits("700", 6));
    });
  });

  // ============================================================
  // BATCH SET COSTS
  // ============================================================

  describe("Batch Set Costs", function () {
    it("Should set costs for multiple models", async function () {
      const modelIds = [MODEL_ID_1, MODEL_ID_2];
      const costs = [parseUnits("400", 6), parseUnits("600", 6)];

      await oracle.connect(updater).batchSetCosts(modelIds, costs);

      expect(await oracle.getEstimatedCost(MODEL_ID_1)).to.equal(costs[0]);
      expect(await oracle.getEstimatedCost(MODEL_ID_2)).to.equal(costs[1]);
    });

    it("Should emit CostUpdated events for each model", async function () {
      const modelIds = [MODEL_ID_1, MODEL_ID_2];
      const costs = [parseUnits("400", 6), parseUnits("600", 6)];

      const tx = await oracle.connect(updater).batchSetCosts(modelIds, costs);

      await expect(tx)
        .to.emit(oracle, "CostUpdated")
        .withArgs(MODEL_ID_1, 0, costs[0], updater.address);

      await expect(tx)
        .to.emit(oracle, "CostUpdated")
        .withArgs(MODEL_ID_2, 0, costs[1], updater.address);
    });

    it("Should revert if array lengths mismatch", async function () {
      await expect(
        oracle.connect(updater).batchSetCosts(
          [MODEL_ID_1, MODEL_ID_2],
          [parseUnits("500", 6)] // Only 1 cost
        )
      ).to.be.reverted;
    });

    it("Should revert if arrays are empty", async function () {
      await expect(
        oracle.connect(updater).batchSetCosts([], [])
      ).to.be.reverted;
    });

    it("Should revert if any model ID is empty", async function () {
      await expect(
        oracle.connect(updater).batchSetCosts(
          [MODEL_ID_1, ""],
          [parseUnits("500", 6), parseUnits("600", 6)]
        )
      ).to.be.reverted;
    });

    it("Should revert if caller is not updater", async function () {
      await expect(
        oracle.connect(user1).batchSetCosts(
          [MODEL_ID_1],
          [parseUnits("500", 6)]
        )
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

    it("Should check updater role correctly", async function () {
      expect(await oracle.isUpdater(updater.address)).to.be.true;
      expect(await oracle.isUpdater(user1.address)).to.be.false;
    });
  });

  // ============================================================
  // ACCESS CONTROL
  // ============================================================

  describe("Access Control", function () {
    it("Should allow admin to grant COST_UPDATER_ROLE", async function () {
      const COST_UPDATER_ROLE = await oracle.COST_UPDATER_ROLE();
      await oracle.connect(owner).grantRole(COST_UPDATER_ROLE, user1.address);

      expect(await oracle.hasRole(COST_UPDATER_ROLE, user1.address)).to.be.true;
    });

    it("Should allow admin to revoke COST_UPDATER_ROLE", async function () {
      const COST_UPDATER_ROLE = await oracle.COST_UPDATER_ROLE();
      await oracle.connect(owner).revokeRole(COST_UPDATER_ROLE, updater.address);

      expect(await oracle.hasRole(COST_UPDATER_ROLE, updater.address)).to.be.false;
    });

    it("Should prevent non-admin from granting roles", async function () {
      const COST_UPDATER_ROLE = await oracle.COST_UPDATER_ROLE();

      await expect(
        oracle.connect(user1).grantRole(COST_UPDATER_ROLE, user1.address)
      ).to.be.reverted;
    });

    it("Should have correct role constants", async function () {
      const COST_UPDATER_ROLE = await oracle.COST_UPDATER_ROLE();
      const expectedRole = ethers.keccak256(ethers.toUtf8Bytes("COST_UPDATER_ROLE"));

      expect(COST_UPDATER_ROLE).to.equal(expectedRole);
    });
  });

  // ============================================================
  // EDGE CASES
  // ============================================================

  describe("Edge Cases", function () {
    it("Should handle very large costs", async function () {
      const largeCost = parseUnits("1000000", 6); // $1M per 1000 calls
      await oracle.connect(updater).setCost(MODEL_ID_1, largeCost);

      expect(await oracle.getEstimatedCost(MODEL_ID_1)).to.equal(largeCost);
    });

    it("Should handle very small costs", async function () {
      const smallCost = 1; // 1e-6 USDC per 1000 calls
      await oracle.connect(updater).setCost(MODEL_ID_1, smallCost);

      expect(await oracle.getEstimatedCost(MODEL_ID_1)).to.equal(smallCost);
    });
  });
});
