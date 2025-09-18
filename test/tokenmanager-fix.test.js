const { expect } = require("chai");
const { ethers } = require("hardhat");
const { parseEther } = require("ethers");

describe("TokenManager Frontend Integration Fix", function () {
  let tokenManager;
  let modelRegistry;
  let owner;
  let user;
  let addr2;

  beforeEach(async function () {
    [owner, user, addr2] = await ethers.getSigners();

    // Deploy ModelRegistry
    const ModelRegistry = await ethers.getContractFactory("ModelRegistry");
    modelRegistry = await ModelRegistry.deploy();
    await modelRegistry.waitForDeployment();

    // Deploy TokenManager with ModelRegistry address
    const TokenManager = await ethers.getContractFactory("TokenManager");
    tokenManager = await TokenManager.deploy(await modelRegistry.getAddress());
    await tokenManager.waitForDeployment();
  });

  describe("Frontend Expected Interface", function () {
    it("Should deploy token with string modelId and totalSupply parameter", async function () {
      // Frontend expects this signature:
      // deployToken(string modelId, string name, string symbol, uint256 totalSupply)
      const modelId = "21";
      const tokenName = "Test Token";
      const tokenSymbol = "TEST";
      const totalSupply = parseEther("1000000");

      // Check deployment fee
      const deploymentFee = await tokenManager.deploymentFee();

      // Deploy token with frontend's expected parameters
      const tx = await tokenManager.connect(user).deployToken(
        modelId,
        tokenName,
        tokenSymbol,
        totalSupply,
        { value: deploymentFee }
      );

      const receipt = await tx.wait();

      // Check event was emitted with correct parameters
      const tokenDeployedEvent = receipt.logs.find(log => {
        try {
          const parsed = tokenManager.interface.parseLog(log);
          return parsed && parsed.name === "TokenDeployed";
        } catch {
          return false;
        }
      });

      expect(tokenDeployedEvent).to.not.be.undefined;
      const parsedEvent = tokenManager.interface.parseLog(tokenDeployedEvent);
      // For indexed string parameters, we need to compare the hash
      const expectedHash = ethers.keccak256(ethers.toUtf8Bytes(modelId));
      expect(parsedEvent.args.modelId.hash).to.equal(expectedHash);
      expect(parsedEvent.args.name).to.equal(tokenName);
      expect(parsedEvent.args.symbol).to.equal(tokenSymbol);
      expect(parsedEvent.args.totalSupply).to.equal(totalSupply);

      // Get deployed token address
      const tokenAddress = parsedEvent.args.tokenAddress;
      expect(tokenAddress).to.not.equal(ethers.ZeroAddress);

      // Verify token was deployed with correct parameters
      const HokusaiToken = await ethers.getContractFactory("HokusaiToken");
      const token = HokusaiToken.attach(tokenAddress);

      expect(await token.name()).to.equal(tokenName);
      expect(await token.symbol()).to.equal(tokenSymbol);
      expect(await token.totalSupply()).to.equal(totalSupply);
    });

    it("Should store and retrieve token address with string modelId", async function () {
      const modelId = "42";
      const tokenName = "Model Token";
      const tokenSymbol = "MDL";
      const totalSupply = parseEther("500000");

      // Deploy token
      await tokenManager.connect(user).deployToken(
        modelId,
        tokenName,
        tokenSymbol,
        totalSupply,
        { value: await tokenManager.deploymentFee() }
      );

      // Frontend expects: modelTokens(string) returns address
      const tokenAddress = await tokenManager.modelTokens(modelId);
      expect(tokenAddress).to.not.equal(ethers.ZeroAddress);
    });

    it("Should prevent duplicate token deployment for same modelId", async function () {
      const modelId = "100";
      const tokenName = "First Token";
      const tokenSymbol = "FIRST";
      const totalSupply = parseEther("100000");

      // Deploy first token
      await tokenManager.connect(user).deployToken(
        modelId,
        tokenName,
        tokenSymbol,
        totalSupply,
        { value: await tokenManager.deploymentFee() }
      );

      // Try to deploy second token for same model
      await expect(
        tokenManager.connect(user).deployToken(
          modelId,
          "Second Token",
          "SECOND",
          totalSupply,
          { value: await tokenManager.deploymentFee() }
        )
      ).to.be.revertedWith("Token already deployed for this model");
    });

    it("Should handle deployment fee correctly", async function () {
      // Set a deployment fee
      const fee = parseEther("0.001");
      await tokenManager.connect(owner).setDeploymentFee(fee);

      const modelId = "200";
      const tokenName = "Fee Token";
      const tokenSymbol = "FEE";
      const totalSupply = parseEther("50000");

      // Should fail without fee
      await expect(
        tokenManager.connect(user).deployToken(
          modelId,
          tokenName,
          tokenSymbol,
          totalSupply,
          { value: 0 }
        )
      ).to.be.revertedWith("Insufficient deployment fee");

      // Should succeed with correct fee
      const initialBalance = await ethers.provider.getBalance(
        await tokenManager.feeRecipient()
      );

      await tokenManager.connect(user).deployToken(
        modelId,
        tokenName,
        tokenSymbol,
        totalSupply,
        { value: fee }
      );

      const finalBalance = await ethers.provider.getBalance(
        await tokenManager.feeRecipient()
      );
      expect(finalBalance - initialBalance).to.equal(fee);
    });

    it("Should emit TokenDeployed event with string modelId", async function () {
      const modelId = "event-test-1";
      const tokenName = "Event Token";
      const tokenSymbol = "EVT";
      const totalSupply = parseEther("75000");
      const deploymentFee = await tokenManager.deploymentFee();

      await expect(
        tokenManager.connect(user).deployToken(
          modelId,
          tokenName,
          tokenSymbol,
          totalSupply,
          { value: deploymentFee }
        )
      ).to.emit(tokenManager, "TokenDeployed");
    });

    it("Should validate totalSupply is greater than zero", async function () {
      const modelId = "zero-supply";
      const tokenName = "Zero Token";
      const tokenSymbol = "ZERO";
      const totalSupply = 0;

      await expect(
        tokenManager.connect(user).deployToken(
          modelId,
          tokenName,
          tokenSymbol,
          totalSupply,
          { value: await tokenManager.deploymentFee() }
        )
      ).to.be.revertedWith("Total supply must be greater than zero");
    });

    it("Should validate modelId is not empty", async function () {
      const modelId = "";
      const tokenName = "Empty Model Token";
      const tokenSymbol = "EMT";
      const totalSupply = parseEther("10000");

      await expect(
        tokenManager.connect(user).deployToken(
          modelId,
          tokenName,
          tokenSymbol,
          totalSupply,
          { value: await tokenManager.deploymentFee() }
        )
      ).to.be.revertedWith("Model ID cannot be empty");
    });
  });

  describe("Method Signatures", function () {
    it("Should have correct deploymentFee() signature", async function () {
      // This should work without parameters
      const fee = await tokenManager.deploymentFee();
      expect(fee).to.be.gte(0);
    });

    it("Should support gas estimation for deployToken", async function () {
      const modelId = "gas-test";
      const tokenName = "Gas Test Token";
      const tokenSymbol = "GAS";
      const totalSupply = parseEther("25000");
      const deploymentFee = await tokenManager.deploymentFee();

      // Frontend needs to estimate gas before sending transaction
      const gasEstimate = await tokenManager.connect(user).deployToken.estimateGas(
        modelId,
        tokenName,
        tokenSymbol,
        totalSupply,
        { value: deploymentFee }
      );

      expect(gasEstimate).to.be.gt(0);
      expect(gasEstimate).to.be.lt(10000000); // Reasonable gas limit
    });
  });
});