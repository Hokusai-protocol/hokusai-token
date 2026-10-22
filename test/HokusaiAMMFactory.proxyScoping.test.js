const { expect } = require("chai");
const { ethers, network, upgrades } = require("hardhat");
const { parseEther, parseUnits, ZeroAddress } = require("ethers");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const { deployTestToken, deployTestTokenAddress } = require("./helpers/tokenDeployment");
const { deployFactoryWithPoolDeployer } = require("./helpers/factoryDeployment");

// HOK-3283: proxy-deploying factory with a timelocked implementation setting,
// governance path to pool owner functions, per-model mint scoping in the
// TokenManager, and registry-based fee routing.
describe("HOK-3283: proxy factory, per-model mint scoping, registry fee routing", function () {
  const MODEL_A = "8101";
  const MODEL_B = "8102";
  const MODEL_C = "8103";

  let owner, treasury, buyer, outsider, depositor;

  beforeEach(async function () {
    [owner, treasury, buyer, outsider, depositor] = await ethers.getSigners();
  });

  async function deployManager(kind, registryAddress) {
    if (kind === "TokenManager") {
      return ethers.deployContract("TokenManager", [registryAddress]);
    }
    const tokenDeploymentFactory = await ethers.deployContract("TokenDeploymentFactory");
    return ethers.deployContract("DeployableTokenManager", [
      registryAddress,
      await tokenDeploymentFactory.getAddress(),
    ]);
  }

  async function addModel(env, modelId) {
    const tokenAddress = await deployTestTokenAddress(env.tokenManager, modelId, `T${modelId}`, `T${modelId}`, parseEther("1"), owner.address);
    await deployTestToken(env.tokenManager, modelId, `T${modelId}`, `T${modelId}`, parseEther("1"), owner.address);
    await env.modelRegistry.registerStringModel(modelId, tokenAddress, "accuracy");
    return tokenAddress;
  }

  async function createPool(factory, modelId, tokenAddress) {
    const poolAddress = await factory.createPool.staticCall(modelId, tokenAddress);
    await factory.createPool(modelId, tokenAddress);
    return ethers.getContractAt("HokusaiAMM", poolAddress);
  }

  async function deployEnv(managerKind = "DeployableTokenManager") {
    const modelRegistry = await ethers.deployContract("ModelRegistry");
    const tokenManager = await deployManager(managerKind, await modelRegistry.getAddress());
    await modelRegistry.setStringModelTokenManager(await tokenManager.getAddress());
    const usdc = await ethers.deployContract("MockUSDC");
    const { factory, poolDeployer } = await deployFactoryWithPoolDeployer(modelRegistry, tokenManager, usdc, treasury);
    await modelRegistry.setPoolRegistrar(await factory.getAddress(), true);

    const env = { modelRegistry, tokenManager, usdc, factory, poolDeployer };
    env.tokenA = await addModel(env, MODEL_A);
    env.tokenB = await addModel(env, MODEL_B);
    env.poolA = await createPool(factory, MODEL_A, env.tokenA);
    env.poolB = await createPool(factory, MODEL_B, env.tokenB);
    return env;
  }

  async function buy(env, pool, amount) {
    await env.usdc.mint(buyer.address, amount);
    await env.usdc.connect(buyer).approve(await pool.getAddress(), amount);
    await pool.connect(buyer).buy(amount, 0, buyer.address, (await time.latest()) + 3600);
  }

  async function impersonate(address) {
    await network.provider.request({ method: "hardhat_impersonateAccount", params: [address] });
    await network.provider.send("hardhat_setBalance", [address, "0xDE0B6B3A7640000"]);
    return ethers.getSigner(address);
  }

  async function stopImpersonating(address) {
    await network.provider.request({ method: "hardhat_stopImpersonatingAccount", params: [address] });
  }

  for (const managerKind of ["DeployableTokenManager", "TokenManager"]) {
    describe(`Per-model mint scoping (${managerKind})`, function () {
      let env, poolA, poolAAddress;

      beforeEach(async function () {
        env = await deployEnv(managerKind);
        poolAAddress = await env.poolA.getAddress();
        poolA = await impersonate(poolAAddress);
      });

      afterEach(async function () {
        await stopImpersonating(poolAAddress);
      });

      it("authorizes pools by registry binding alone, with no MINTER_ROLE or authorizeAMM", async function () {
        const MINTER_ROLE = await env.tokenManager.MINTER_ROLE();
        expect(await env.tokenManager.hasRole(MINTER_ROLE, poolAAddress)).to.be.false;
        expect(env.tokenManager.authorizeAMM).to.be.undefined;

        const token = await ethers.getContractAt("HokusaiToken", env.tokenA);
        await env.tokenManager.connect(poolA).mintTokens(MODEL_A, buyer.address, 1000n);
        expect(await token.balanceOf(buyer.address)).to.equal(1000n);
      });

      it("rejects pool A minting model B's token", async function () {
        await expect(
          env.tokenManager.connect(poolA).mintTokens(MODEL_B, buyer.address, 1000n)
        ).to.be.revertedWith("Caller is not authorized to mint");
      });

      it("rejects pool A burning model B's token, even from its own balance", async function () {
        await env.tokenManager.mintTokens(MODEL_B, poolAAddress, 1000n);
        await expect(
          env.tokenManager.connect(poolA).burnAMMTokens(MODEL_B, poolAAddress, 1000n)
        ).to.be.revertedWith("Caller is not authorized to burn");
      });

      it("lets a pool burn only its own balance", async function () {
        const token = await ethers.getContractAt("HokusaiToken", env.tokenA);
        await env.tokenManager.mintTokens(MODEL_A, poolAAddress, 1000n);
        await env.tokenManager.mintTokens(MODEL_A, outsider.address, 1000n);

        await expect(
          env.tokenManager.connect(poolA).burnAMMTokens(MODEL_A, outsider.address, 1n)
        ).to.be.revertedWith("Pool can only burn own balance");

        await env.tokenManager.connect(poolA).burnAMMTokens(MODEL_A, poolAAddress, 1000n);
        expect(await token.balanceOf(poolAAddress)).to.equal(0);
        expect(await token.balanceOf(outsider.address)).to.equal(1000n);
      });

      it("keeps pools off the MINTER_ROLE-only paths", async function () {
        await env.tokenManager.mintTokens(MODEL_A, outsider.address, 1000n);
        await expect(
          env.tokenManager.connect(poolA).burnTokens(MODEL_A, outsider.address, 1n)
        ).to.be.revertedWith("Caller is not authorized to burn");
        await expect(
          env.tokenManager.connect(poolA).burnInvestorTokens(MODEL_A, outsider.address, 1n)
        ).to.be.revertedWith("Caller is not authorized to burn");
        await expect(
          env.tokenManager.connect(poolA).mintReward(MODEL_A, outsider.address, 1n)
        ).to.be.revertedWith("Caller is not authorized to mint");
      });

      it("leaves owner mint/burn paths unchanged", async function () {
        const token = await ethers.getContractAt("HokusaiToken", env.tokenB);
        await env.tokenManager.mintTokens(MODEL_B, outsider.address, 1000n);
        await env.tokenManager.burnAMMTokens(MODEL_B, outsider.address, 400n);
        expect(await token.balanceOf(outsider.address)).to.equal(600n);
      });

      it("trades end to end through the real proxy pools", async function () {
        await buy(env, env.poolA, parseUnits("100", 6));
        const tokenA = await ethers.getContractAt("HokusaiToken", env.tokenA);
        expect(await tokenA.balanceOf(buyer.address)).to.be.gt(0);
        expect(await env.poolB.reserveBalance()).to.equal(0);
      });
    });
  }

  describe("Pool creation", function () {
    let env;

    beforeEach(async function () {
      env = await deployEnv();
    });

    it("deploys each pool as an initialized proxy with independent state", async function () {
      const implementation = await env.factory.poolImplementation();
      expect(implementation).to.equal(await env.poolDeployer.defaultImplementation());
      for (const pool of [env.poolA, env.poolB]) {
        expect(await upgrades.erc1967.getImplementationAddress(await pool.getAddress())).to.equal(implementation);
        expect(await pool.owner()).to.equal(await env.factory.getAddress());
      }
      expect(await env.modelRegistry.getPool(MODEL_A)).to.equal(await env.poolA.getAddress());
      expect(await env.modelRegistry.getPool(MODEL_B)).to.equal(await env.poolB.getAddress());

      await buy(env, env.poolA, parseUnits("100", 6));
      expect(await env.poolA.reserveBalance()).to.be.gt(0);
      expect(await env.poolB.reserveBalance()).to.equal(0);
    });

    it("cannot be taken over by re-running initialize", async function () {
      await expect(
        env.poolA.connect(outsider).initialize(
          await env.usdc.getAddress(),
          env.tokenA,
          await env.tokenManager.getAddress(),
          MODEL_A,
          outsider.address,
          200000,
          30,
          7 * 24 * 3600,
          parseUnits("25000", 6),
          parseUnits("0.01", 6)
        )
      ).to.be.revertedWith("Initializable: contract is already initialized");
    });

    async function expectNothingCreated(modelId, poolCountBefore) {
      expect(await env.factory.poolCount()).to.equal(poolCountBefore);
      expect(await env.factory.hasPool(modelId)).to.equal(modelId === MODEL_A || modelId === MODEL_B);
      if (modelId !== MODEL_A && modelId !== MODEL_B) {
        expect(await env.modelRegistry.getPool(modelId)).to.equal(ZeroAddress);
      }
    }

    it("rejects a duplicate pool without creating anything", async function () {
      const before = await env.factory.poolCount();
      await expect(env.factory.createPool(MODEL_A, env.tokenA)).to.be.revertedWith("Pool already exists");
      await expectNothingCreated(MODEL_A, before);
      expect(await env.modelRegistry.getPool(MODEL_A)).to.equal(await env.poolA.getAddress());
    });

    it("rejects the wrong token for a model without creating anything", async function () {
      await addModel(env, MODEL_C);
      const before = await env.factory.poolCount();
      await expect(env.factory.createPool(MODEL_C, env.tokenA)).to.be.revertedWith("Token address mismatch");
      await expectNothingCreated(MODEL_C, before);
    });

    it("rejects a model missing from the registry without creating anything", async function () {
      const tokenAddress = await deployTestTokenAddress(env.tokenManager, MODEL_C, "C", "C", parseEther("1"), owner.address);
      await deployTestToken(env.tokenManager, MODEL_C, "C", "C", parseEther("1"), owner.address);
      const before = await env.factory.poolCount();
      await expect(env.factory.createPool(MODEL_C, tokenAddress)).to.be.revertedWith(
        "Model not registered in ModelRegistry"
      );
      await expectNothingCreated(MODEL_C, before);
    });
  });

  describe("Implementation used for new pools", function () {
    let env, v2Implementation;

    beforeEach(async function () {
      env = await deployEnv();
      v2Implementation = await ethers.deployContract("HokusaiAMMV2Mock");
    });

    it("is owner (timelock) only and must be a contract", async function () {
      await expect(
        env.factory.connect(outsider).setPoolImplementation(await v2Implementation.getAddress())
      ).to.be.revertedWith("Ownable: caller is not the owner");
      await expect(env.factory.setPoolImplementation(outsider.address)).to.be.revertedWith(
        "Implementation has no code"
      );
      await expect(env.factory.setPoolImplementation(ZeroAddress)).to.be.revertedWith("Implementation has no code");
    });

    it("applies to new pools only; existing pools keep their implementation and state", async function () {
      await buy(env, env.poolA, parseUnits("100", 6));
      const defaultImplementation = await env.poolDeployer.defaultImplementation();
      const snapshot = async (pool) => ({
        implementation: await upgrades.erc1967.getImplementationAddress(await pool.getAddress()),
        reserve: await pool.reserveBalance(),
        owner: await pool.owner(),
        token: await pool.hokusaiToken(),
        modelId: await pool.modelId(),
      });
      const beforeA = await snapshot(env.poolA);
      const beforeB = await snapshot(env.poolB);

      await expect(env.factory.setPoolImplementation(await v2Implementation.getAddress()))
        .to.emit(env.factory, "PoolImplementationUpdated")
        .withArgs(defaultImplementation, await v2Implementation.getAddress());

      const tokenC = await addModel(env, MODEL_C);
      const poolCAddress = await (await createPool(env.factory, MODEL_C, tokenC)).getAddress();
      const poolC = await ethers.getContractAt("HokusaiAMMV2Mock", poolCAddress);
      expect(await upgrades.erc1967.getImplementationAddress(poolCAddress)).to.equal(
        await v2Implementation.getAddress()
      );
      expect(await poolC.version()).to.equal("v2");
      expect(await poolC.owner()).to.equal(await env.factory.getAddress());

      expect(await snapshot(env.poolA)).to.deep.equal(beforeA);
      expect(await snapshot(env.poolB)).to.deep.equal(beforeB);
      expect(beforeA.implementation).to.equal(defaultImplementation);

      // The new pool is a working, model-scoped pool.
      await buy(env, poolC, parseUnits("100", 6));
      expect(await poolC.reserveBalance()).to.be.gt(0);
    });
  });

  describe("Governance path to pool owner functions", function () {
    let env;

    beforeEach(async function () {
      env = await deployEnv();
    });

    it("forwards owner calls (params, whitelist, pause) to the named pool only", async function () {
      const setMaxTrade = env.poolA.interface.encodeFunctionData("setMaxTradeBps", [1234]);
      await expect(env.factory.callPool(MODEL_A, setMaxTrade))
        .to.emit(env.factory, "PoolCallExecuted")
        .withArgs(MODEL_A, await env.poolA.getAddress(), setMaxTrade.slice(0, 10));
      expect(await env.poolA.maxTradeBps()).to.equal(1234);
      expect(await env.poolB.maxTradeBps()).to.not.equal(1234);

      const whitelist = await ethers.deployContract("PurchaserWhitelist", [owner.address]);
      await env.factory.callPool(
        MODEL_B,
        env.poolB.interface.encodeFunctionData("setPurchaserWhitelist", [await whitelist.getAddress()])
      );
      expect(await env.poolB.purchaserWhitelist()).to.equal(await whitelist.getAddress());

      await env.factory.callPool(MODEL_A, env.poolA.interface.encodeFunctionData("pause"));
      expect(await env.poolA.paused()).to.be.true;
      expect(await env.poolB.paused()).to.be.false;
    });

    it("bubbles up pool reverts", async function () {
      await expect(
        env.factory.callPool(MODEL_A, env.poolA.interface.encodeFunctionData("unpause"))
      ).to.be.revertedWith("Pausable: not paused");
    });

    it("is owner only and rejects unknown models and missing selectors", async function () {
      const pause = env.poolA.interface.encodeFunctionData("pause");
      await expect(env.factory.connect(outsider).callPool(MODEL_A, pause)).to.be.revertedWith(
        "Ownable: caller is not the owner"
      );
      await expect(env.factory.callPool(MODEL_C, pause)).to.be.revertedWith("Pool not found");
      await expect(env.factory.callPool(MODEL_A, "0x1234")).to.be.revertedWith("Missing selector");
    });

    it("cannot move pool ownership away from the factory", async function () {
      await expect(
        env.factory.callPool(MODEL_A, env.poolA.interface.encodeFunctionData("transferOwnership", [outsider.address]))
      ).to.be.revertedWith("Pool ownership is fixed");
      await expect(
        env.factory.callPool(MODEL_A, env.poolA.interface.encodeFunctionData("renounceOwnership"))
      ).to.be.revertedWith("Pool ownership is fixed");
      expect(await env.poolA.owner()).to.equal(await env.factory.getAddress());
    });
  });

  describe("Registry-based fee routing", function () {
    let env, infraReserve, feeRouter;

    beforeEach(async function () {
      env = await deployEnv();
      infraReserve = await ethers.deployContract("InfrastructureReserve", [
        await env.usdc.getAddress(),
        await env.modelRegistry.getAddress(),
        treasury.address,
      ]);
      const costOracle = await ethers.deployContract("InfrastructureCostOracle", [owner.address, 2000]);
      feeRouter = await ethers.deployContract("UsageFeeRouter", [
        await env.modelRegistry.getAddress(),
        await env.tokenManager.getAddress(),
        await env.usdc.getAddress(),
        await infraReserve.getAddress(),
        await costOracle.getAddress(),
      ]);
      await infraReserve.grantRole(await infraReserve.DEPOSITOR_ROLE(), await feeRouter.getAddress());
      await feeRouter.grantRole(await feeRouter.FEE_DEPOSITOR_ROLE(), depositor.address);
      await env.usdc.mint(depositor.address, parseUnits("10000", 6));
      await env.usdc.connect(depositor).approve(await feeRouter.getAddress(), parseUnits("10000", 6));
    });

    async function expectSettles(modelId, pool) {
      const amount = parseUnits("1000", 6);
      const [infra, profit] = await feeRouter.calculateFeeSplit(modelId, amount, 0);
      expect(infra + profit).to.equal(amount);
      expect(infra).to.be.gt(0);
      expect(profit).to.be.gt(0);

      const poolReserveBefore = await pool.reserveBalance();
      await expect(feeRouter.connect(depositor).depositFee(modelId, amount, 0))
        .to.emit(feeRouter, "FeeDeposited")
        .withArgs(modelId, await pool.getAddress(), amount, infra, profit, depositor.address);

      expect(await pool.reserveBalance()).to.equal(poolReserveBefore + profit);
      expect(await infraReserve.accrued(modelId)).to.equal(infra);
    }

    it("settles a new model end to end: profit to the pool, infra share to the reserve", async function () {
      await expectSettles(MODEL_A, env.poolA);
    });

    it("keeps settling pools created by a replacement factory", async function () {
      const { factory: factory2 } = await deployFactoryWithPoolDeployer(
        env.modelRegistry,
        env.tokenManager,
        env.usdc,
        treasury
      );
      await env.modelRegistry.setPoolRegistrar(await factory2.getAddress(), true);
      const tokenC = await addModel(env, MODEL_C);
      const poolC = await createPool(factory2, MODEL_C, tokenC);

      await expectSettles(MODEL_C, poolC);
      await expect(feeRouter.connect(depositor).batchDepositFees([MODEL_A, MODEL_C], [1000n, 1000n], [0, 0])).to.not
        .be.reverted;
    });

    it("rejects unauthorized callers and models without a pool", async function () {
      await expect(feeRouter.connect(outsider).depositFee(MODEL_A, 1000n, 0)).to.be.reverted;
      await addModel(env, MODEL_C);
      await expect(feeRouter.connect(depositor).depositFee(MODEL_C, 1000n, 0)).to.be.revertedWith(
        "Pool does not exist"
      );
      await expect(infraReserve.connect(outsider).deposit(MODEL_A, 1000n)).to.be.reverted;
    });
  });
});
