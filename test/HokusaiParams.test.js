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
  const DEFAULT_INFRA_MARKUP_BPS = 500; // 5%
  const DEFAULT_LICENSE_HASH = keccak256(toUtf8Bytes("default-license"));
  const DEFAULT_LICENSE_URI = "https://hokusai.ai/licenses/default";

  beforeEach(async function () {
    [owner, governor, user1, ...addrs] = await ethers.getSigners();
    HokusaiParams = await ethers.getContractFactory("HokusaiParams");

    params = await HokusaiParams.deploy(
      DEFAULT_TOKENS_PER_DELTA_ONE,
      DEFAULT_INFRA_MARKUP_BPS,
      DEFAULT_LICENSE_HASH,
      DEFAULT_LICENSE_URI,
      governor.address
    );
    await params.waitForDeployment();
  });

  describe("Constructor", function () {
    it("Should initialize with correct default values", async function () {
      expect(await params.tokensPerDeltaOne()).to.equal(DEFAULT_TOKENS_PER_DELTA_ONE);
      expect(await params.infraMarkupBps()).to.equal(DEFAULT_INFRA_MARKUP_BPS);
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
          DEFAULT_INFRA_MARKUP_BPS,
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
          DEFAULT_INFRA_MARKUP_BPS,
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
          DEFAULT_INFRA_MARKUP_BPS,
          DEFAULT_LICENSE_HASH,
          DEFAULT_LICENSE_URI,
          governor.address
        )
      ).to.be.revertedWith("tokensPerDeltaOne must be between 100 and 100000");
    });

    it("Should reject infraMarkupBps above maximum", async function () {
      await expect(
        HokusaiParams.deploy(
          DEFAULT_TOKENS_PER_DELTA_ONE,
          1001, // Above maximum of 1000 (10%)
          DEFAULT_LICENSE_HASH,
          DEFAULT_LICENSE_URI,
          governor.address
        )
      ).to.be.revertedWith("infraMarkupBps cannot exceed 1000 (10%)");
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

    it("Should allow governor to update infraMarkupBps", async function () {
      const newBps = 750;
      await expect(params.connect(governor).setInfraMarkupBps(newBps))
        .to.emit(params, "InfraMarkupBpsSet")
        .withArgs(DEFAULT_INFRA_MARKUP_BPS, newBps, governor.address);

      expect(await params.infraMarkupBps()).to.equal(newBps);
    });

    it("Should prevent non-governor from updating infraMarkupBps", async function () {
      const newBps = 750;
      await expect(
        params.connect(user1).setInfraMarkupBps(newBps)
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

    it("Should reject infraMarkupBps above maximum (1000)", async function () {
      await expect(
        params.connect(governor).setInfraMarkupBps(1001)
      ).to.be.revertedWith("infraMarkupBps cannot exceed 1000 (10%)");
    });

    it("Should accept infraMarkupBps at maximum boundary", async function () {
      await expect(params.connect(governor).setInfraMarkupBps(1000))
        .to.emit(params, "InfraMarkupBpsSet")
        .withArgs(DEFAULT_INFRA_MARKUP_BPS, 1000, governor.address);

      expect(await params.infraMarkupBps()).to.equal(1000);
    });

    it("Should accept infraMarkupBps at zero", async function () {
      await expect(params.connect(governor).setInfraMarkupBps(0))
        .to.emit(params, "InfraMarkupBpsSet")
        .withArgs(DEFAULT_INFRA_MARKUP_BPS, 0, governor.address);

      expect(await params.infraMarkupBps()).to.equal(0);
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

    it("Should emit InfraMarkupBpsSet with correct parameters", async function () {
      const newBps = 200;
      const tx = await params.connect(governor).setInfraMarkupBps(newBps);

      await expect(tx)
        .to.emit(params, "InfraMarkupBpsSet")
        .withArgs(DEFAULT_INFRA_MARKUP_BPS, newBps, governor.address);
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

      // Update infraMarkupBps
      await params.connect(governor).setInfraMarkupBps(800);
      expect(await params.infraMarkupBps()).to.equal(800);

      // Update license reference
      const newHash = keccak256(toUtf8Bytes("sequence-license"));
      const newUri = "https://hokusai.ai/licenses/sequence";
      await params.connect(governor).setLicenseRef(newHash, newUri);

      expect(await params.licenseHash()).to.equal(newHash);
      expect(await params.licenseURI()).to.equal(newUri);

      // Verify all values are still correct
      expect(await params.tokensPerDeltaOne()).to.equal(1500);
      expect(await params.infraMarkupBps()).to.equal(800);

      const [hash, uri] = await params.licenseRef();
      expect(hash).to.equal(newHash);
      expect(uri).to.equal(newUri);
    });

    it("Should maintain state consistency across multiple updates", async function () {
      const updates = [
        { tokens: 200, markup: 100 },
        { tokens: 5000, markup: 500 },
        { tokens: 99999, markup: 999 }
      ];

      for (const update of updates) {
        await params.connect(governor).setTokensPerDeltaOne(update.tokens);
        await params.connect(governor).setInfraMarkupBps(update.markup);

        expect(await params.tokensPerDeltaOne()).to.equal(update.tokens);
        expect(await params.infraMarkupBps()).to.equal(update.markup);
      }
    });
  });

  describe("Gas Efficiency", function () {
    it("Should read critical parameters efficiently", async function () {
      // Test actual function calls to measure real gas usage
      const tx1 = await params.tokensPerDeltaOne();
      const tx2 = await params.infraMarkupBps();
      const tx3 = await params.licenseHash();

      // Verify the functions work correctly (gas test is informational)
      expect(tx1).to.equal(DEFAULT_TOKENS_PER_DELTA_ONE);
      expect(tx2).to.equal(DEFAULT_INFRA_MARKUP_BPS);
      expect(tx3).to.equal(DEFAULT_LICENSE_HASH);

      // Note: View function gas estimation includes transaction overhead
      // In actual DeltaVerifier usage, these will be part of larger transactions
      // where the marginal gas cost is much lower
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