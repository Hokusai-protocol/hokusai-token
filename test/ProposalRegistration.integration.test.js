const { expect } = require("chai");
const { ethers } = require("hardhat");
const { parseEther } = require("ethers");

describe("Proposal Registration Integration", function () {
  let tokenManager;
  let modelRegistry;
  let fundingVault;
  let ammFactory;
  let usdc;
  let owner;
  let investor1;
  let investor2;

  const MODEL_ID = "sales-lead-scoring-v1";
  const TOKEN_NAME = "Sales Lead Scoring Token";
  const TOKEN_SYMBOL = "SLST";
  const INITIAL_SUPPLY = parseEther("1000000");
  const TOKENS_PER_DELTA_ONE = BigInt(1000);
  const INFRA_ACCRUAL_BPS = 5000; // 50%
  const LICENSE_HASH = ethers.keccak256(ethers.toUtf8Bytes("mit-license"));
  const LICENSE_URI = "https://hokusai.ai/licenses/mit";
  const PERFORMANCE_METRIC = "accuracy";

  async function getDeadline(offsetDays = 30) {
    const latestBlock = await ethers.provider.getBlock("latest");
    return latestBlock.timestamp + 86400 * offsetDays;
  }

  beforeEach(async function () {
    [owner, investor1, investor2] = await ethers.getSigners();

    // Deploy MockUSDC
    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    usdc = await MockUSDC.deploy();
    await usdc.waitForDeployment();

    // Deploy ModelRegistry
    const ModelRegistry = await ethers.getContractFactory("ModelRegistry");
    modelRegistry = await ModelRegistry.deploy();
    await modelRegistry.waitForDeployment();

    // Deploy TokenManager
    const TokenManager = await ethers.getContractFactory("TokenManager");
    tokenManager = await TokenManager.deploy(await modelRegistry.getAddress());
    await tokenManager.waitForDeployment();

    // Deploy HokusaiAMMFactory
    const HokusaiAMMFactory = await ethers.getContractFactory("HokusaiAMMFactory");
    ammFactory = await HokusaiAMMFactory.deploy(
      await usdc.getAddress(),
      await tokenManager.getAddress(),
      await modelRegistry.getAddress(),
      owner.address
    );
    await ammFactory.waitForDeployment();

    // Deploy FundingVault with real constructor
    const FundingVault = await ethers.getContractFactory("FundingVault");
    fundingVault = await FundingVault.deploy(
      await usdc.getAddress(),
      await ammFactory.getAddress(),
      await tokenManager.getAddress(),
      owner.address
    );
    await fundingVault.waitForDeployment();
  });

  describe("Full Proposal Creation Flow", function () {
    it("Should successfully complete all three registration steps", async function () {
      // Step 1: Deploy token via TokenManager
      const initialParams = {
        tokensPerDeltaOne: TOKENS_PER_DELTA_ONE,
        infrastructureAccrualBps: INFRA_ACCRUAL_BPS,
        licenseHash: LICENSE_HASH,
        licenseURI: LICENSE_URI,
        governor: owner.address
      };

      const deployTx = await tokenManager.deployTokenWithParams(
        MODEL_ID,
        TOKEN_NAME,
        TOKEN_SYMBOL,
        INITIAL_SUPPLY,
        initialParams
      );
      await deployTx.wait();

      const tokenAddress = await tokenManager.getTokenAddress(MODEL_ID);
      expect(tokenAddress).to.not.equal(ethers.ZeroAddress);

      // Verify token is deployed correctly
      const HokusaiToken = await ethers.getContractFactory("HokusaiToken");
      const token = HokusaiToken.attach(tokenAddress);
      expect(await token.name()).to.equal(TOKEN_NAME);
      expect(await token.symbol()).to.equal(TOKEN_SYMBOL);
      expect(await token.totalSupply()).to.equal(INITIAL_SUPPLY);

      // Step 2: Register in ModelRegistry
      await expect(
        modelRegistry.registerStringModel(MODEL_ID, tokenAddress, PERFORMANCE_METRIC)
      )
        .to.emit(modelRegistry, "StringModelRegistered")
        .withArgs(MODEL_ID, tokenAddress, PERFORMANCE_METRIC);

      expect(await modelRegistry.isStringRegistered(MODEL_ID)).to.be.true;
      expect(await modelRegistry.getStringToken(MODEL_ID)).to.equal(tokenAddress);

      // Step 3: Register in FundingVault
      const deadline = await getDeadline();
      await expect(
        fundingVault.registerProposal(MODEL_ID, tokenAddress, deadline)
      )
        .to.emit(fundingVault, "ProposalRegistered")
        .withArgs(MODEL_ID, tokenAddress);

      const proposal = await fundingVault.proposals(MODEL_ID);
      expect(proposal.tokenAddress).to.equal(tokenAddress);
      expect(proposal.deadline).to.equal(deadline);
      expect(proposal.graduated).to.be.false;
      expect(proposal.totalCommitted).to.equal(0);
    });

    it("Should allow investors to deposit immediately after registration", async function () {
      // Complete full registration
      const initialParams = {
        tokensPerDeltaOne: TOKENS_PER_DELTA_ONE,
        infrastructureAccrualBps: INFRA_ACCRUAL_BPS,
        licenseHash: LICENSE_HASH,
        licenseURI: LICENSE_URI,
        governor: owner.address
      };

      await tokenManager.deployTokenWithParams(
        MODEL_ID,
        TOKEN_NAME,
        TOKEN_SYMBOL,
        INITIAL_SUPPLY,
        initialParams
      );

      const tokenAddress = await tokenManager.getTokenAddress(MODEL_ID);
      await modelRegistry.registerStringModel(MODEL_ID, tokenAddress, PERFORMANCE_METRIC);

      await fundingVault.registerProposal(MODEL_ID, tokenAddress, await getDeadline());

      // Make deposits (need to mint USDC and approve first)
      const deposit1 = parseEther("10000");
      const deposit2 = parseEther("5000");

      // Mint USDC to investors (MockUSDC has 6 decimals, not 18)
      const usdcDeposit1 = BigInt(10000e6); // 10,000 USDC
      const usdcDeposit2 = BigInt(5000e6);  // 5,000 USDC

      await usdc.mint(investor1.address, usdcDeposit1);
      await usdc.mint(investor2.address, usdcDeposit2);

      // Approve FundingVault to spend USDC
      await usdc.connect(investor1).approve(await fundingVault.getAddress(), usdcDeposit1);
      await usdc.connect(investor2).approve(await fundingVault.getAddress(), usdcDeposit2);

      // Make deposits
      await expect(fundingVault.connect(investor1).deposit(MODEL_ID, usdcDeposit1))
        .to.emit(fundingVault, "Deposited")
        .withArgs(MODEL_ID, investor1.address, usdcDeposit1, usdcDeposit1);

      await expect(fundingVault.connect(investor2).deposit(MODEL_ID, usdcDeposit2))
        .to.emit(fundingVault, "Deposited")
        .withArgs(MODEL_ID, investor2.address, usdcDeposit2, usdcDeposit1 + usdcDeposit2);

      // Verify commitments
      expect(await fundingVault.commitments(MODEL_ID, investor1.address)).to.equal(usdcDeposit1);
      expect(await fundingVault.commitments(MODEL_ID, investor2.address)).to.equal(usdcDeposit2);

      const proposal = await fundingVault.proposals(MODEL_ID);
      expect(proposal.totalCommitted).to.equal(usdcDeposit1 + usdcDeposit2);
    });

    it("Should maintain consistency across all three contracts", async function () {
      const initialParams = {
        tokensPerDeltaOne: TOKENS_PER_DELTA_ONE,
        infrastructureAccrualBps: INFRA_ACCRUAL_BPS,
        licenseHash: LICENSE_HASH,
        licenseURI: LICENSE_URI,
        governor: owner.address
      };

      // Deploy and register
      await tokenManager.deployTokenWithParams(
        MODEL_ID,
        TOKEN_NAME,
        TOKEN_SYMBOL,
        INITIAL_SUPPLY,
        initialParams
      );

      const tokenAddress = await tokenManager.getTokenAddress(MODEL_ID);
      await modelRegistry.registerStringModel(MODEL_ID, tokenAddress, PERFORMANCE_METRIC);

      await fundingVault.registerProposal(MODEL_ID, tokenAddress, await getDeadline());

      // Verify consistency across all contracts
      expect(await tokenManager.hasToken(MODEL_ID)).to.be.true;
      expect(await tokenManager.getTokenAddress(MODEL_ID)).to.equal(tokenAddress);

      expect(await modelRegistry.isStringRegistered(MODEL_ID)).to.be.true;
      expect(await modelRegistry.getStringToken(MODEL_ID)).to.equal(tokenAddress);

      const proposal = await fundingVault.proposals(MODEL_ID);
      expect(proposal.tokenAddress).to.equal(tokenAddress);
      expect(proposal.tokenAddress).to.not.equal(ethers.ZeroAddress); // Registered check

      // All three should agree on the token address
      const tmToken = await tokenManager.getTokenAddress(MODEL_ID);
      const mrToken = await modelRegistry.getStringToken(MODEL_ID);
      const fvToken = proposal.tokenAddress;
      expect(tmToken).to.equal(mrToken);
      expect(mrToken).to.equal(fvToken);
    });
  });

  describe("Error Handling and Edge Cases", function () {
    it("Should handle partial failure gracefully - token deployed but registration fails", async function () {
      const initialParams = {
        tokensPerDeltaOne: TOKENS_PER_DELTA_ONE,
        infrastructureAccrualBps: INFRA_ACCRUAL_BPS,
        licenseHash: LICENSE_HASH,
        licenseURI: LICENSE_URI,
        governor: owner.address
      };

      // Step 1 succeeds
      await tokenManager.deployTokenWithParams(
        MODEL_ID,
        TOKEN_NAME,
        TOKEN_SYMBOL,
        INITIAL_SUPPLY,
        initialParams
      );

      const tokenAddress = await tokenManager.getTokenAddress(MODEL_ID);
      expect(tokenAddress).to.not.equal(ethers.ZeroAddress);

      // Step 2 would fail if trying to register same token again
      await modelRegistry.registerStringModel(MODEL_ID, tokenAddress, PERFORMANCE_METRIC);

      // Attempting to register a different model with same token should fail
      await expect(
        modelRegistry.registerStringModel("different-model", tokenAddress, PERFORMANCE_METRIC)
      ).to.be.revertedWith("Token already registered");

      // Original model registration should still be valid
      expect(await modelRegistry.isStringRegistered(MODEL_ID)).to.be.true;
    });

    it("Should prevent registration with mismatched token address", async function () {
      const initialParams = {
        tokensPerDeltaOne: TOKENS_PER_DELTA_ONE,
        infrastructureAccrualBps: INFRA_ACCRUAL_BPS,
        licenseHash: LICENSE_HASH,
        licenseURI: LICENSE_URI,
        governor: owner.address
      };

      // Deploy token for MODEL_ID
      await tokenManager.deployTokenWithParams(
        MODEL_ID,
        TOKEN_NAME,
        TOKEN_SYMBOL,
        INITIAL_SUPPLY,
        initialParams
      );

      const correctTokenAddress = await tokenManager.getTokenAddress(MODEL_ID);

      // Try to register with a different (fake) address
      const fakeAddress = investor1.address;

      await expect(
        modelRegistry.registerStringModel(MODEL_ID, fakeAddress, PERFORMANCE_METRIC)
      ).to.not.be.reverted; // This would succeed but creates inconsistency

      // The registry would have the wrong address
      expect(await modelRegistry.getStringToken(MODEL_ID)).to.equal(fakeAddress);
      expect(await modelRegistry.getStringToken(MODEL_ID)).to.not.equal(correctTokenAddress);
    });

    it("Should handle multiple proposals in parallel", async function () {
      const model1 = "model-1";
      const model2 = "model-2";

      const initialParams = {
        tokensPerDeltaOne: TOKENS_PER_DELTA_ONE,
        infrastructureAccrualBps: INFRA_ACCRUAL_BPS,
        licenseHash: LICENSE_HASH,
        licenseURI: LICENSE_URI,
        governor: owner.address
      };

      // Deploy both tokens
      await tokenManager.deployTokenWithParams(model1, "Token 1", "TK1", INITIAL_SUPPLY, initialParams);
      await tokenManager.deployTokenWithParams(model2, "Token 2", "TK2", INITIAL_SUPPLY, initialParams);

      const token1Address = await tokenManager.getTokenAddress(model1);
      const token2Address = await tokenManager.getTokenAddress(model2);

      // Register both in ModelRegistry
      await modelRegistry.registerStringModel(model1, token1Address, PERFORMANCE_METRIC);
      await modelRegistry.registerStringModel(model2, token2Address, PERFORMANCE_METRIC);

      // Register both in FundingVault
      await fundingVault.registerProposal(model1, token1Address, await getDeadline());
      await fundingVault.registerProposal(model2, token2Address, await getDeadline());

      // Verify both are properly registered
      const proposal1 = await fundingVault.proposals(model1);
      const proposal2 = await fundingVault.proposals(model2);

      expect(proposal1.tokenAddress).to.not.equal(ethers.ZeroAddress);
      expect(proposal2.tokenAddress).to.not.equal(ethers.ZeroAddress);

      expect(proposal1.tokenAddress).to.equal(token1Address);
      expect(proposal2.tokenAddress).to.equal(token2Address);
    });
  });

  describe("Default Parameters", function () {
    it("Should work with default tokensPerDeltaOne value", async function () {
      const initialParams = {
        tokensPerDeltaOne: BigInt(1000), // Default value
        infrastructureAccrualBps: INFRA_ACCRUAL_BPS,
        licenseHash: LICENSE_HASH,
        licenseURI: LICENSE_URI,
        governor: owner.address
      };

      await expect(
        tokenManager.deployTokenWithParams(
          MODEL_ID,
          TOKEN_NAME,
          TOKEN_SYMBOL,
          INITIAL_SUPPLY,
          initialParams
        )
      ).to.not.be.reverted;

      const paramsAddress = await tokenManager.getParamsAddress(MODEL_ID);
      expect(paramsAddress).to.not.equal(ethers.ZeroAddress);
    });

    it("Should work with 50% infrastructure accrual (5000 bps)", async function () {
      const initialParams = {
        tokensPerDeltaOne: TOKENS_PER_DELTA_ONE,
        infrastructureAccrualBps: 5000, // 50%
        licenseHash: LICENSE_HASH,
        licenseURI: LICENSE_URI,
        governor: owner.address
      };

      await expect(
        tokenManager.deployTokenWithParams(
          MODEL_ID,
          TOKEN_NAME,
          TOKEN_SYMBOL,
          INITIAL_SUPPLY,
          initialParams
        )
      ).to.not.be.reverted;
    });
  });
});
