const { expect } = require("chai");
const { ethers } = require("hardhat");
const { runBackfill, parseArgs, parseModelIds } = require("../../scripts/backfill-canonical-registration");

describe("backfill-canonical-registration", function () {
  let owner;
  let TOKEN_A;
  let TOKEN_B;

  before(async function () {
    const signers = await ethers.getSigners();
    owner = signers[0];
    TOKEN_A = signers[1].address;
    TOKEN_B = signers[2].address;
  });

  function makeMockRegistry({
    numericRegistered = false,
    numericToken = null,
    stringRegistered = true,
    stringToken = null,
    active = true,
    metric = "accuracy",
    ownerAddr = null,
  } = {}) {
    return {
      owner: async () => ownerAddr ?? owner.address,
      isRegistered: async () => numericRegistered,
      getTokenAddress: async () => numericToken ?? ethers.ZeroAddress,
      isStringRegistered: async () => stringRegistered,
      modelsByString: async () => ({
        tokenAddress: stringToken ?? TOKEN_A,
        performanceMetric: metric,
        active,
      }),
      registerModel: async () => ({
        wait: async () => ({ hash: "0x" + "ab".repeat(32), gasUsed: 50000n }),
      }),
    };
  }

  function makeMockTokenManager({ hasToken = true, tokenAddress = null } = {}) {
    return {
      hasToken: async () => hasToken,
      getTokenAddress: async () => tokenAddress ?? TOKEN_A,
    };
  }

  describe("dry-run mode", function () {
    it("returns would_register without sending any transaction", async function () {
      let registerCalled = false;
      const registry = makeMockRegistry({ numericRegistered: false });
      registry.registerModel = async () => {
        registerCalled = true;
        return { wait: async () => ({ hash: "0x" + "ab".repeat(32), gasUsed: 50000n }) };
      };

      const results = await runBackfill({
        modelIds: ["28"],
        dryRun: true,
        modelRegistry: registry,
        tokenManager: makeMockTokenManager(),
        signer: owner,
      });

      expect(results).to.have.lengthOf(1);
      expect(results[0].action).to.equal("would_register");
      expect(results[0].modelId).to.equal("28");
      expect(results[0].token).to.equal(TOKEN_A);
      expect(registerCalled).to.equal(false);
    });

    it("reports would_register for all models that need backfill", async function () {
      const results = await runBackfill({
        modelIds: ["28", "30"],
        dryRun: true,
        modelRegistry: makeMockRegistry({ numericRegistered: false }),
        tokenManager: makeMockTokenManager(),
        signer: owner,
      });

      expect(results).to.have.lengthOf(2);
      expect(results.every((r) => r.action === "would_register")).to.equal(true);
    });
  });

  describe("idempotency", function () {
    it("skips models already registered with the correct token", async function () {
      let registerCalled = false;
      const registry = makeMockRegistry({
        numericRegistered: true,
        numericToken: TOKEN_A,
      });
      registry.registerModel = async () => {
        registerCalled = true;
        return { wait: async () => ({ hash: "0x" + "ab".repeat(32), gasUsed: 50000n }) };
      };

      const results = await runBackfill({
        modelIds: ["27"],
        dryRun: false,
        modelRegistry: registry,
        tokenManager: makeMockTokenManager({ tokenAddress: TOKEN_A }),
        signer: owner,
      });

      expect(results).to.have.lengthOf(1);
      expect(results[0].action).to.equal("skip");
      expect(results[0].reason).to.equal("already_registered");
      expect(registerCalled).to.equal(false);
    });

    it("is idempotent: calling twice leaves the second run as skip", async function () {
      let registerCount = 0;
      let isNumericRegistered = false;

      const registry = {
        owner: async () => owner.address,
        isRegistered: async () => isNumericRegistered,
        getTokenAddress: async () => (isNumericRegistered ? TOKEN_A : ethers.ZeroAddress),
        isStringRegistered: async () => true,
        modelsByString: async () => ({ tokenAddress: TOKEN_A, performanceMetric: "f1", active: true }),
        registerModel: async () => {
          registerCount += 1;
          isNumericRegistered = true;
          return { wait: async () => ({ hash: "0x" + "ab".repeat(32), gasUsed: 50000n }) };
        },
      };

      const firstRun = await runBackfill({
        modelIds: ["28"],
        dryRun: false,
        modelRegistry: registry,
        tokenManager: makeMockTokenManager(),
        signer: owner,
      });
      expect(firstRun[0].action).to.equal("registered");
      expect(registerCount).to.equal(1);

      const secondRun = await runBackfill({
        modelIds: ["28"],
        dryRun: false,
        modelRegistry: registry,
        tokenManager: makeMockTokenManager(),
        signer: owner,
      });
      expect(secondRun[0].action).to.equal("skip");
      expect(registerCount).to.equal(1);
    });
  });

  describe("RegistrationConflict detection", function () {
    it("throws when numeric registry token differs from TokenManager token", async function () {
      const registry = makeMockRegistry({
        numericRegistered: true,
        numericToken: TOKEN_B,
        stringToken: TOKEN_A,
      });

      await expect(
        runBackfill({
          modelIds: ["28"],
          dryRun: false,
          modelRegistry: registry,
          tokenManager: makeMockTokenManager({ tokenAddress: TOKEN_A }),
          signer: owner,
        }),
      ).to.be.rejectedWith("RegistrationConflict");
    });

    it("throws RegistrationConflict in dry-run mode too when tokens already conflict", async function () {
      const registry = makeMockRegistry({
        numericRegistered: true,
        numericToken: TOKEN_B,
        stringToken: TOKEN_A,
      });

      await expect(
        runBackfill({
          modelIds: ["28"],
          dryRun: true,
          modelRegistry: registry,
          tokenManager: makeMockTokenManager({ tokenAddress: TOKEN_A }),
          signer: owner,
        }),
      ).to.be.rejectedWith("RegistrationConflict");
    });
  });

  describe("precondition checks", function () {
    it("throws when TokenManager has no entry for the model", async function () {
      await expect(
        runBackfill({
          modelIds: ["28"],
          dryRun: true,
          modelRegistry: makeMockRegistry(),
          tokenManager: makeMockTokenManager({ hasToken: false, tokenAddress: ethers.ZeroAddress }),
          signer: owner,
        }),
      ).to.be.rejectedWith("TokenManager has no token mapping");
    });

    it("throws when string registry is missing for the model", async function () {
      await expect(
        runBackfill({
          modelIds: ["28"],
          dryRun: true,
          modelRegistry: makeMockRegistry({ stringRegistered: false }),
          tokenManager: makeMockTokenManager(),
          signer: owner,
        }),
      ).to.be.rejectedWith("String registry is missing or inactive");
    });
  });

  describe("parseModelIds", function () {
    it("parses a comma-separated list of numeric model IDs", function () {
      expect(parseModelIds("27,28,30")).to.deep.equal(["27", "28", "30"]);
    });

    it("rejects non-numeric model IDs", function () {
      expect(() => parseModelIds("foo")).to.throw('Invalid model id "foo"');
    });
  });

  describe("parseArgs", function () {
    it("defaults to dry-run=false and the default model list", function () {
      const opts = parseArgs([]);
      expect(opts.dryRun).to.equal(false);
      expect(opts.modelIds).to.deep.equal(["27", "28", "30"]);
    });

    it("enables dry-run with --dry-run flag", function () {
      const opts = parseArgs(["--dry-run"]);
      expect(opts.dryRun).to.equal(true);
    });

    it("overrides model list with --models flag", function () {
      const opts = parseArgs(["--models", "1,2"]);
      expect(opts.modelIds).to.deep.equal(["1", "2"]);
    });
  });
});
