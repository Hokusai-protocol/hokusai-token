const { expect } = require("chai");
const { ethers } = require("hardhat");
const { ZeroAddress, ZeroHash, keccak256, toUtf8Bytes } = require("ethers");

describe("HokusaiParams", function () {
  let HokusaiParams;
  let params;
  let owner;
  let governor;
  let user1;
  let addrs;

  const DEFAULT_TOKENS_PER_DELTA_ONE = 1000;
  const DEFAULT_INFRASTRUCTURE_ACCRUAL_BPS = 8000; // 80%
  const DEFAULT_LICENSE_HASH = keccak256(toUtf8Bytes("default-license"));
  const DEFAULT_LICENSE_URI = "https://hokusai.ai/licenses/default";

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
      ).to.be.revertedWith("tokensPerDeltaOne must be between 100 and 100000");
    });

    it("Should reject tokensPerDeltaOne above maximum", async function () {
      await expect(
        HokusaiParams.deploy(
          100001, // Above maximum of 100000
          DEFAULT_INFRASTRUCTURE_ACCRUAL_BPS,
          DEFAULT_LICENSE_HASH,
          DEFAULT_LICENSE_URI,
          governor.address
        )
      ).to.be.revertedWith("tokensPerDeltaOne must be between 100 and 100000");
    });

    it("Should reject infrastructureAccrualBps below minimum (5000)", async function () {
      await expect(
        HokusaiParams.deploy(
          DEFAULT_TOKENS_PER_DELTA_ONE,
          4999, // Below minimum of 5000 (50%)
          DEFAULT_LICENSE_HASH,
          DEFAULT_LICENSE_URI,
          governor.address
        )
      ).to.be.revertedWith("infrastructureAccrualBps must be between 5000 and 10000");
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
      ).to.be.revertedWith("infrastructureAccrualBps must be between 5000 and 10000");
    });
  });

  describe("Access Control", function () {
    it("Should allow governor to update tokensPerDeltaOne", async function () {
      const newValue = 2000;
      await expect(params.connect(governor).setTokensPerDeltaOne(newValue))
        .to.emit(params, "TokensPerDeltaOneSet")
        .withArgs(DEFAULT_TOKENS_PER_DELTA_ONE, newValue, governor.address);

      expect(await params.tokensPerDeltaOne()).to.equal(newValue);
    });

    it("Should prevent non-governor from updating tokensPerDeltaOne", async function () {
      const newValue = 2000;
      await expect(
        params.connect(user1).setTokensPerDeltaOne(newValue)
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
    it("Should reject tokensPerDeltaOne below minimum (100)", async function () {
      await expect(
        params.connect(governor).setTokensPerDeltaOne(99)
      ).to.be.revertedWith("tokensPerDeltaOne must be between 100 and 100000");
    });

    it("Should reject tokensPerDeltaOne above maximum (100000)", async function () {
      await expect(
        params.connect(governor).setTokensPerDeltaOne(100001)
      ).to.be.revertedWith("tokensPerDeltaOne must be between 100 and 100000");
    });

    it("Should accept tokensPerDeltaOne at minimum boundary", async function () {
      await expect(params.connect(governor).setTokensPerDeltaOne(100))
        .to.emit(params, "TokensPerDeltaOneSet")
        .withArgs(DEFAULT_TOKENS_PER_DELTA_ONE, 100, governor.address);

      expect(await params.tokensPerDeltaOne()).to.equal(100);
    });

    it("Should accept tokensPerDeltaOne at maximum boundary", async function () {
      await expect(params.connect(governor).setTokensPerDeltaOne(100000))
        .to.emit(params, "TokensPerDeltaOneSet")
        .withArgs(DEFAULT_TOKENS_PER_DELTA_ONE, 100000, governor.address);

      expect(await params.tokensPerDeltaOne()).to.equal(100000);
    });

    it("Should reject infrastructureAccrualBps below minimum (5000)", async function () {
      await expect(
        params.connect(governor).setInfrastructureAccrualBps(4999)
      ).to.be.revertedWith("infrastructureAccrualBps must be between 5000 and 10000");
    });

    it("Should reject infrastructureAccrualBps above maximum (10000)", async function () {
      await expect(
        params.connect(governor).setInfrastructureAccrualBps(10001)
      ).to.be.revertedWith("infrastructureAccrualBps must be between 5000 and 10000");
    });

    it("Should accept infrastructureAccrualBps at minimum boundary (50%)", async function () {
      await expect(params.connect(governor).setInfrastructureAccrualBps(5000))
        .to.emit(params, "InfrastructureAccrualBpsSet")
        .withArgs(DEFAULT_INFRASTRUCTURE_ACCRUAL_BPS, 5000, governor.address);

      expect(await params.infrastructureAccrualBps()).to.equal(5000);
      expect(await params.getProfitShareBps()).to.equal(5000); // 50% profit
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
    it("Should correctly calculate profit share (80/20 split)", async function () {
      await params.connect(governor).setInfrastructureAccrualBps(8000);
      expect(await params.getProfitShareBps()).to.equal(2000); // 20%
    });

    it("Should correctly calculate profit share (70/30 split)", async function () {
      await params.connect(governor).setInfrastructureAccrualBps(7000);
      expect(await params.getProfitShareBps()).to.equal(3000); // 30%
    });

    it("Should correctly calculate profit share (90/10 split)", async function () {
      await params.connect(governor).setInfrastructureAccrualBps(9000);
      expect(await params.getProfitShareBps()).to.equal(1000); // 10%
    });

    it("Should correctly calculate profit share (50/50 split)", async function () {
      await params.connect(governor).setInfrastructureAccrualBps(5000);
      expect(await params.getProfitShareBps()).to.equal(5000); // 50%
    });

    it("Should correctly calculate profit share (100/0 split)", async function () {
      await params.connect(governor).setInfrastructureAccrualBps(10000);
      expect(await params.getProfitShareBps()).to.equal(0); // 0%
    });
  });

  describe("Event Emission", function () {
    it("Should emit TokensPerDeltaOneSet with correct parameters", async function () {
      const newValue = 1500;
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
      expect(await params.tokensPerDeltaOne()).to.equal(1500);

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
      expect(await params.tokensPerDeltaOne()).to.equal(1500);
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

        expect(await params.tokensPerDeltaOne()).to.equal(update.tokens);
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
      const value = 1500;

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
      const newValue = 3000;
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
});
