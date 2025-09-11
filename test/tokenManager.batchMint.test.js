const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("TokenManager Batch Minting", function () {
  let tokenManager;
  let hokusaiToken;
  let modelRegistry;
  let owner;
  let minter;
  let recipient1;
  let recipient2;
  let recipient3;
  let unauthorizedUser;

  const MODEL_ID = 1;

  beforeEach(async function () {
    [owner, minter, recipient1, recipient2, recipient3, unauthorizedUser] = 
      await ethers.getSigners();

    // Deploy contracts
    const ModelRegistry = await ethers.getContractFactory("ModelRegistry");
    modelRegistry = await ModelRegistry.deploy();
    await modelRegistry.waitForDeployment();

    const HokusaiToken = await ethers.getContractFactory("HokusaiToken");
    hokusaiToken = await HokusaiToken.deploy("Hokusai Token", "HOKU", owner.address);
    await hokusaiToken.waitForDeployment();

    const TokenManager = await ethers.getContractFactory("TokenManager");
    tokenManager = await TokenManager.deploy(await modelRegistry.getAddress());
    await tokenManager.waitForDeployment();

    // Set up permissions
    await hokusaiToken.setController(await tokenManager.getAddress());
    await tokenManager.grantRole(await tokenManager.MINTER_ROLE(), minter.address);

    // Register model
    await modelRegistry.registerModel(
      MODEL_ID,
      await hokusaiToken.getAddress(),
      "accuracy"
    );
  });

  describe("Batch Minting Functionality", function () {
    it("should mint tokens to multiple recipients in one transaction", async function () {
      const recipients = [
        recipient1.address,
        recipient2.address,
        recipient3.address
      ];
      const amounts = [
        ethers.parseEther("100"),
        ethers.parseEther("200"),
        ethers.parseEther("300")
      ];

      await tokenManager.connect(minter).batchMintTokens(MODEL_ID, recipients, amounts);

      // Verify balances
      expect(await hokusaiToken.balanceOf(recipient1.address))
        .to.equal(ethers.parseEther("100"));
      expect(await hokusaiToken.balanceOf(recipient2.address))
        .to.equal(ethers.parseEther("200"));
      expect(await hokusaiToken.balanceOf(recipient3.address))
        .to.equal(ethers.parseEther("300"));
    });

    it("should emit BatchMinted event", async function () {
      const recipients = [recipient1.address, recipient2.address];
      const amounts = [
        ethers.parseEther("100"),
        ethers.parseEther("200")
      ];

      await expect(
        tokenManager.connect(minter).batchMintTokens(MODEL_ID, recipients, amounts)
      )
        .to.emit(tokenManager, "BatchMinted")
        .withArgs(MODEL_ID, recipients, amounts, ethers.parseEther("300"));
    });

    it("should revert if arrays have different lengths", async function () {
      const recipients = [recipient1.address, recipient2.address];
      const amounts = [ethers.parseEther("100")]; // Only one amount

      await expect(
        tokenManager.connect(minter).batchMintTokens(MODEL_ID, recipients, amounts)
      ).to.be.revertedWith("Array length mismatch");
    });

    it("should revert if empty arrays provided", async function () {
      await expect(
        tokenManager.connect(minter).batchMintTokens(MODEL_ID, [], [])
      ).to.be.revertedWith("Empty recipients array");
    });

    it("should revert if any recipient is zero address", async function () {
      const recipients = [
        recipient1.address,
        ethers.ZeroAddress,
        recipient2.address
      ];
      const amounts = [
        ethers.parseEther("100"),
        ethers.parseEther("200"),
        ethers.parseEther("300")
      ];

      await expect(
        tokenManager.connect(minter).batchMintTokens(MODEL_ID, recipients, amounts)
      ).to.be.revertedWith("Invalid recipient address");
    });

    it("should revert if any amount is zero", async function () {
      const recipients = [recipient1.address, recipient2.address];
      const amounts = [ethers.parseEther("100"), 0];

      await expect(
        tokenManager.connect(minter).batchMintTokens(MODEL_ID, recipients, amounts)
      ).to.be.revertedWith("Amount must be greater than zero");
    });

    it("should enforce access control", async function () {
      const recipients = [recipient1.address];
      const amounts = [ethers.parseEther("100")];

      await expect(
        tokenManager.connect(unauthorizedUser).batchMintTokens(MODEL_ID, recipients, amounts)
      ).to.be.revertedWith("Unauthorized");
    });

    it("should revert for non-existent model", async function () {
      const recipients = [recipient1.address];
      const amounts = [ethers.parseEther("100")];

      await expect(
        tokenManager.connect(minter).batchMintTokens(999, recipients, amounts)
      ).to.be.revertedWith("Model not registered");
    });

    it("should handle large batch efficiently", async function () {
      // Create 20 recipients
      const recipients = [];
      const amounts = [];
      const signers = await ethers.getSigners();
      
      for (let i = 0; i < 20; i++) {
        if (signers[i]) {
          recipients.push(signers[i].address);
          amounts.push(ethers.parseEther((i + 1).toString()));
        }
      }

      const tx = await tokenManager.connect(minter).batchMintTokens(
        MODEL_ID, 
        recipients.slice(0, 20), 
        amounts.slice(0, 20)
      );
      const receipt = await tx.wait();
      
      console.log("Gas used for 20 recipients:", receipt.gasUsed.toString());

      // Verify some balances
      expect(await hokusaiToken.balanceOf(recipients[0]))
        .to.equal(ethers.parseEther("1"));
      expect(await hokusaiToken.balanceOf(recipients[19]))
        .to.equal(ethers.parseEther("20"));
    });

    it("should have reasonable gas limit for batch size", async function () {
      // Test that contract enforces maximum batch size
      const recipients = [];
      const amounts = [];
      
      // Try to create a batch of 101 recipients (assuming 100 is the limit)
      for (let i = 0; i < 101; i++) {
        recipients.push(recipient1.address); // Use same address for simplicity
        amounts.push(ethers.parseEther("1"));
      }

      await expect(
        tokenManager.connect(minter).batchMintTokens(MODEL_ID, recipients, amounts)
      ).to.be.revertedWith("Batch size exceeds limit");
    });
  });

  describe("Backward Compatibility", function () {
    it("should maintain single mintTokens function", async function () {
      const amount = ethers.parseEther("100");
      
      await tokenManager.connect(minter).mintTokens(
        MODEL_ID,
        recipient1.address,
        amount
      );

      expect(await hokusaiToken.balanceOf(recipient1.address)).to.equal(amount);
    });

    it("should allow both single and batch minting in same transaction flow", async function () {
      // Single mint
      await tokenManager.connect(minter).mintTokens(
        MODEL_ID,
        recipient1.address,
        ethers.parseEther("100")
      );

      // Batch mint
      await tokenManager.connect(minter).batchMintTokens(
        MODEL_ID,
        [recipient2.address, recipient3.address],
        [ethers.parseEther("200"), ethers.parseEther("300")]
      );

      // Verify all balances
      expect(await hokusaiToken.balanceOf(recipient1.address))
        .to.equal(ethers.parseEther("100"));
      expect(await hokusaiToken.balanceOf(recipient2.address))
        .to.equal(ethers.parseEther("200"));
      expect(await hokusaiToken.balanceOf(recipient3.address))
        .to.equal(ethers.parseEther("300"));
    });
  });

  describe("Integration with DeltaVerifier", function () {
    it("should work with contributor data from DeltaVerifier", async function () {
      // Simulate contributor data that would come from DeltaVerifier
      const contributorData = [
        { recipient: recipient1.address, amount: ethers.parseEther("600") },
        { recipient: recipient2.address, amount: ethers.parseEther("300") },
        { recipient: recipient3.address, amount: ethers.parseEther("100") }
      ];

      // Extract arrays for batch minting
      const recipients = contributorData.map(c => c.recipient);
      const amounts = contributorData.map(c => c.amount);

      await tokenManager.connect(minter).batchMintTokens(MODEL_ID, recipients, amounts);

      // Verify distribution matches weights (60%, 30%, 10%)
      const total = ethers.parseEther("1000");
      expect(await hokusaiToken.balanceOf(recipient1.address))
        .to.equal((total * 60n) / 100n);
      expect(await hokusaiToken.balanceOf(recipient2.address))
        .to.equal((total * 30n) / 100n);
      expect(await hokusaiToken.balanceOf(recipient3.address))
        .to.equal((total * 10n) / 100n);
    });
  });

  describe("Gas Comparison", function () {
    it("should compare gas costs: single vs batch minting", async function () {
      const recipients = [
        recipient1.address,
        recipient2.address,
        recipient3.address
      ];
      const amounts = [
        ethers.parseEther("100"),
        ethers.parseEther("200"),
        ethers.parseEther("300")
      ];

      // Test individual minting
      let totalGasIndividual = 0n;
      for (let i = 0; i < recipients.length; i++) {
        const tx = await tokenManager.connect(minter).mintTokens(
          MODEL_ID,
          recipients[i],
          amounts[i]
        );
        const receipt = await tx.wait();
        totalGasIndividual = totalGasIndividual + receipt.gasUsed;
      }

      // Reset balances by deploying new contracts
      const HokusaiToken2 = await ethers.getContractFactory("HokusaiToken");
      const hokusaiToken2 = await HokusaiToken2.deploy();
      await hokusaiToken2.waitForDeployment();
      await hokusaiToken2.setController(await tokenManager.getAddress());
      await modelRegistry.registerModel(2, await hokusaiToken2.getAddress(), "accuracy");

      // Test batch minting
      const batchTx = await tokenManager.connect(minter).batchMintTokens(
        2, // MODEL_ID 2
        recipients,
        amounts
      );
      const batchReceipt = await batchTx.wait();

      console.log("Gas for 3 individual mints:", totalGasIndividual.toString());
      console.log("Gas for batch mint of 3:", batchReceipt.gasUsed.toString());
      console.log("Gas savings:", 
        Number((totalGasIndividual - batchReceipt.gasUsed) * 100n / totalGasIndividual) + "%"
      );

      // Batch should be more efficient
      expect(batchReceipt.gasUsed).to.be.lt(totalGasIndividual);
    });
  });
});