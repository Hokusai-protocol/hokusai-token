const { expect } = require("chai");
const { ethers } = require("hardhat");
const { parseEther, ZeroAddress } = require("ethers");

describe("HokusaiToken", function () {
  let Token;
  let token;
  let owner;
  let controller;
  let user1;
  let user2;
  let addrs;

  beforeEach(async function () {
    [owner, controller, user1, user2, ...addrs] = await ethers.getSigners();
    Token = await ethers.getContractFactory("HokusaiToken");
  });

  describe("Constructor", function () {
    it("Should deploy with custom name, symbol, and controller", async function () {
      const customName = "Custom Model Token";
      const customSymbol = "CMT";
      
      token = await Token.deploy(customName, customSymbol, controller.address);
      await token.waitForDeployment();
      
      expect(await token.name()).to.equal(customName);
      expect(await token.symbol()).to.equal(customSymbol);
      expect(await token.controller()).to.equal(controller.address);
      expect(await token.decimals()).to.equal(18);
    });

    it("Should emit ControllerUpdated event during deployment", async function () {
      const tx = await Token.deploy("Test Token", "TEST", controller.address);
      const deployReceipt = await tx.deploymentTransaction().wait();
      
      // Find the ControllerUpdated event in the deployment transaction
      const iface = new ethers.Interface([
        "event ControllerUpdated(address indexed newController)"
      ]);
      
      const logs = deployReceipt.logs.map(log => {
        try {
          return iface.parseLog(log);
        } catch {
          return null;
        }
      }).filter(log => log !== null);
      
      expect(logs.length).to.be.greaterThan(0);
      expect(logs[0].args.newController).to.equal(controller.address);
    });

    it("Should set the deployer as owner", async function () {
      token = await Token.deploy("Test Token", "TEST", controller.address);
      await token.waitForDeployment();
      
      expect(await token.owner()).to.equal(owner.address);
    });

    it("Should have zero total supply initially", async function () {
      token = await Token.deploy("Test Token", "TEST", controller.address);
      await token.waitForDeployment();
      
      expect(await token.totalSupply()).to.equal(0);
    });

    it("Should revert with empty name", async function () {
      await expect(
        Token.deploy("", "TEST", controller.address)
      ).to.be.revertedWith("Token name cannot be empty");
    });

    it("Should revert with empty symbol", async function () {
      await expect(
        Token.deploy("Test Token", "", controller.address)
      ).to.be.revertedWith("Token symbol cannot be empty");
    });

    it("Should revert with zero address controller", async function () {
      await expect(
        Token.deploy("Test Token", "TEST", ZeroAddress)
      ).to.be.revertedWith("Controller cannot be zero address");
    });

    it("Should handle long token names and symbols", async function () {
      const longName = "A".repeat(100);
      const longSymbol = "B".repeat(50);
      
      token = await Token.deploy(longName, longSymbol, controller.address);
      await token.waitForDeployment();
      
      expect(await token.name()).to.equal(longName);
      expect(await token.symbol()).to.equal(longSymbol);
    });

    it("Should handle unicode characters in name and symbol", async function () {
      const unicodeName = "🎨 Hokusai Model Token 🚀";
      const unicodeSymbol = "🎨HMT";
      
      token = await Token.deploy(unicodeName, unicodeSymbol, controller.address);
      await token.waitForDeployment();
      
      expect(await token.name()).to.equal(unicodeName);
      expect(await token.symbol()).to.equal(unicodeSymbol);
    });

    it("Should allow same address to be both owner and controller", async function () {
      token = await Token.deploy("Test Token", "TEST", owner.address);
      await token.waitForDeployment();
      
      expect(await token.owner()).to.equal(owner.address);
      expect(await token.controller()).to.equal(owner.address);
    });

    it("Should deploy multiple tokens with different parameters", async function () {
      const token1 = await Token.deploy("Token One", "TOK1", controller.address);
      const token2 = await Token.deploy("Token Two", "TOK2", user1.address);
      const token3 = await Token.deploy("Token Three", "TOK3", user2.address);
      
      await token1.waitForDeployment();
      await token2.waitForDeployment();
      await token3.waitForDeployment();
      
      expect(await token1.name()).to.equal("Token One");
      expect(await token1.symbol()).to.equal("TOK1");
      expect(await token1.controller()).to.equal(controller.address);
      
      expect(await token2.name()).to.equal("Token Two");
      expect(await token2.symbol()).to.equal("TOK2");
      expect(await token2.controller()).to.equal(user1.address);
      
      expect(await token3.name()).to.equal("Token Three");
      expect(await token3.symbol()).to.equal("TOK3");
      expect(await token3.controller()).to.equal(user2.address);
    });
  });

  describe("Standard Deployment Tests", function () {
    beforeEach(async function () {
      // Deploy with standard parameters for remaining tests
      token = await Token.deploy("Hokusai Token", "HOKU", controller.address);
      await token.waitForDeployment();
    });

    describe("ERC20 Standard Functionality", function () {
      beforeEach(async function () {
        // Mint some tokens for testing
        await token.connect(controller).mint(user1.address, parseEther("1000"));
      });

      it("Should transfer tokens between accounts", async function () {
        const transferAmount = parseEther("50");
        
        await token.connect(user1).transfer(user2.address, transferAmount);
        
        expect(await token.balanceOf(user1.address)).to.equal(parseEther("950"));
        expect(await token.balanceOf(user2.address)).to.equal(transferAmount);
      });

      it("Should fail if sender doesn't have enough tokens", async function () {
        const initialBalance = await token.balanceOf(user1.address);
        
        await expect(
          token.connect(user1).transfer(user2.address, initialBalance + 1n)
        ).to.be.reverted;
      });

      it("Should update allowances correctly", async function () {
        const approveAmount = parseEther("100");
        
        await token.connect(user1).approve(user2.address, approveAmount);
        
        expect(await token.allowance(user1.address, user2.address)).to.equal(approveAmount);
      });

      it("Should transfer tokens using transferFrom", async function () {
        const approveAmount = parseEther("100");
        const transferAmount = parseEther("50");
        
        await token.connect(user1).approve(user2.address, approveAmount);
        await token.connect(user2).transferFrom(user1.address, user2.address, transferAmount);
        
        expect(await token.balanceOf(user2.address)).to.equal(transferAmount);
        expect(await token.allowance(user1.address, user2.address)).to.equal(
          approveAmount - transferAmount
        );
      });

      it("Should emit Transfer events", async function () {
        const transferAmount = parseEther("50");
        
        await expect(token.connect(user1).transfer(user2.address, transferAmount))
          .to.emit(token, "Transfer")
          .withArgs(user1.address, user2.address, transferAmount);
      });
    });

    describe("Access Control", function () {
      it("Should allow owner to set controller", async function () {
        await expect(token.setController(user1.address))
          .to.emit(token, "ControllerUpdated")
          .withArgs(user1.address);
        
        expect(await token.controller()).to.equal(user1.address);
      });

      it("Should revert when non-owner tries to set controller", async function () {
        await expect(
          token.connect(user1).setController(user2.address)
        ).to.be.revertedWith("Ownable: caller is not the owner");
      });

      it("Should revert when setting zero address as controller", async function () {
        await expect(
          token.setController(ZeroAddress)
        ).to.be.revertedWith("Controller cannot be zero address");
      });

      it("Should maintain controller privileges after ownership transfer", async function () {
        // Transfer ownership
        await token.transferOwnership(user1.address);
        
        // Original controller should still be able to mint
        await expect(
          token.connect(controller).mint(user2.address, parseEther("100"))
        ).to.not.be.reverted;
        
        // New owner should be able to change controller
        await expect(
          token.connect(user1).setController(user2.address)
        ).to.emit(token, "ControllerUpdated")
        .withArgs(user2.address);
      });

      it("Should revoke minting permissions from old controller after update", async function () {
        // Verify current controller can mint
        await token.connect(controller).mint(user1.address, parseEther("100"));
        
        // Change controller
        await token.setController(user2.address);
        
        // Old controller should not be able to mint
        await expect(
          token.connect(controller).mint(user1.address, parseEther("100"))
        ).to.be.revertedWith("Only controller can call this function");
        
        // New controller should be able to mint
        await expect(
          token.connect(user2).mint(user1.address, parseEther("100"))
        ).to.not.be.reverted;
      });
    });

    describe("Minting", function () {
      it("Should allow controller to mint tokens", async function () {
        const mintAmount = parseEther("1000");
        
        await expect(token.connect(controller).mint(user1.address, mintAmount))
          .to.emit(token, "Transfer")
          .withArgs(ZeroAddress, user1.address, mintAmount)
          .and.to.emit(token, "Minted")
          .withArgs(user1.address, mintAmount);
        
        expect(await token.balanceOf(user1.address)).to.equal(mintAmount);
        expect(await token.totalSupply()).to.equal(mintAmount);
      });

      it("Should revert when non-controller tries to mint", async function () {
        await expect(
          token.connect(user1).mint(user2.address, parseEther("100"))
        ).to.be.revertedWith("Only controller can call this function");
      });

      it("Should revert when minting to zero address", async function () {
        await expect(
          token.connect(controller).mint(ZeroAddress, parseEther("100"))
        ).to.be.reverted;
      });

      it("Should increase total supply when minting", async function () {
        const mintAmount1 = parseEther("1000");
        const mintAmount2 = parseEther("500");
        
        await token.connect(controller).mint(user1.address, mintAmount1);
        await token.connect(controller).mint(user2.address, mintAmount2);
        
        expect(await token.totalSupply()).to.equal(mintAmount1 + mintAmount2);
      });

      it("Should handle minting zero tokens", async function () {
        const initialBalance = await token.balanceOf(user1.address);
        const initialSupply = await token.totalSupply();
        
        await expect(token.connect(controller).mint(user1.address, 0))
          .to.emit(token, "Minted")
          .withArgs(user1.address, 0);
        
        expect(await token.balanceOf(user1.address)).to.equal(initialBalance);
        expect(await token.totalSupply()).to.equal(initialSupply);
      });
    });

    describe("Burning", function () {
      beforeEach(async function () {
        // Mint some tokens first
        await token.connect(controller).mint(user1.address, parseEther("1000"));
        await token.connect(controller).mint(user2.address, parseEther("500"));
      });

      it("Should allow controller to burn tokens from any address using burnFrom", async function () {
        const burnAmount = parseEther("300");
        const initialBalance = await token.balanceOf(user1.address);
        const initialSupply = await token.totalSupply();
        
        await expect(token.connect(controller).burnFrom(user1.address, burnAmount))
          .to.emit(token, "Transfer")
          .withArgs(user1.address, ZeroAddress, burnAmount)
          .and.to.emit(token, "Burned")
          .withArgs(user1.address, burnAmount);
        
        expect(await token.balanceOf(user1.address)).to.equal(initialBalance - burnAmount);
        expect(await token.totalSupply()).to.equal(initialSupply - burnAmount);
      });

      it("Should allow users to burn their own tokens", async function () {
        const burnAmount = parseEther("100");
        const initialBalance = await token.balanceOf(user1.address);
        const initialSupply = await token.totalSupply();
        
        await expect(token.connect(user1).burn(burnAmount))
          .to.emit(token, "Transfer")
          .withArgs(user1.address, ZeroAddress, burnAmount)
          .and.to.emit(token, "Burned")
          .withArgs(user1.address, burnAmount);
        
        expect(await token.balanceOf(user1.address)).to.equal(initialBalance - burnAmount);
        expect(await token.totalSupply()).to.equal(initialSupply - burnAmount);
      });

      it("Should revert when non-controller tries to use burnFrom", async function () {
        await expect(
          token.connect(user1).burnFrom(user2.address, parseEther("100"))
        ).to.be.revertedWith("Only controller can call this function");
      });

      it("Should revert when user burns more than their balance", async function () {
        const balance = await token.balanceOf(user1.address);
        
        await expect(
          token.connect(user1).burn(balance + 1n)
        ).to.be.reverted;
      });

      it("Should revert when controller burns more than balance using burnFrom", async function () {
        const balance = await token.balanceOf(user1.address);
        
        await expect(
          token.connect(controller).burnFrom(user1.address, balance + 1n)
        ).to.be.reverted;
      });
    });

    describe("Integration scenarios", function () {
      it("Should handle complex mint, transfer, and burn flow", async function () {
        // Controller mints to user1
        await token.connect(controller).mint(user1.address, parseEther("1000"));
        
        // user1 transfers to user2
        await token.connect(user1).transfer(user2.address, parseEther("300"));
        
        // user1 burns their own tokens, controller burns from user2
        await token.connect(user1).burn(parseEther("200"));
        await token.connect(controller).burnFrom(user2.address, parseEther("100"));
        
        expect(await token.balanceOf(user1.address)).to.equal(parseEther("500"));
        expect(await token.balanceOf(user2.address)).to.equal(parseEther("200"));
        expect(await token.totalSupply()).to.equal(parseEther("700"));
      });

      it("Should maintain functionality after controller changes", async function () {
        // Initial setup
        await token.connect(controller).mint(user1.address, parseEther("1000"));
        
        // Change controller
        await token.setController(user2.address);
        
        // New controller should be able to mint and burn
        await token.connect(user2).mint(user1.address, parseEther("500"));
        await token.connect(user2).burnFrom(user1.address, parseEther("300"));
        
        expect(await token.balanceOf(user1.address)).to.equal(parseEther("1200"));
        expect(await token.totalSupply()).to.equal(parseEther("1200"));
      });
    });
  });

  describe("Custom Token Scenarios", function () {
    it("Should work correctly with AI model specific tokens", async function () {
      // Deploy tokens for different AI models
      const gptToken = await Token.deploy("GPT Model Token", "GPT", controller.address);
      const dalleToken = await Token.deploy("DALL-E Model Token", "DALLE", controller.address);
      const clipToken = await Token.deploy("CLIP Model Token", "CLIP", controller.address);
      
      await gptToken.waitForDeployment();
      await dalleToken.waitForDeployment();
      await clipToken.waitForDeployment();
      
      // Mint different amounts for each model
      await gptToken.connect(controller).mint(user1.address, parseEther("1000"));
      await dalleToken.connect(controller).mint(user1.address, parseEther("2000"));
      await clipToken.connect(controller).mint(user1.address, parseEther("3000"));
      
      // Verify each token works independently
      expect(await gptToken.balanceOf(user1.address)).to.equal(parseEther("1000"));
      expect(await dalleToken.balanceOf(user1.address)).to.equal(parseEther("2000"));
      expect(await clipToken.balanceOf(user1.address)).to.equal(parseEther("3000"));
      
      expect(await gptToken.name()).to.equal("GPT Model Token");
      expect(await dalleToken.name()).to.equal("DALL-E Model Token");
      expect(await clipToken.name()).to.equal("CLIP Model Token");
    });

    it("Should handle gas optimization for batch deployments", async function () {
      const tokenConfigs = [
        { name: "Model A Token", symbol: "MA", controller: controller.address },
        { name: "Model B Token", symbol: "MB", controller: user1.address },
        { name: "Model C Token", symbol: "MC", controller: user2.address }
      ];
      
      const deployedTokens = [];
      
      for (const config of tokenConfigs) {
        const tx = await Token.deploy(config.name, config.symbol, config.controller);
        const receipt = await tx.deploymentTransaction().wait();
        deployedTokens.push(tx);
        
        // Deployment should be gas efficient (less than 2M gas)
        expect(receipt.gasUsed).to.be.below(2000000);
      }
      
      // Verify all deployments were successful
      for (let i = 0; i < deployedTokens.length; i++) {
        const token = deployedTokens[i];
        const config = tokenConfigs[i];
        
        expect(await token.name()).to.equal(config.name);
        expect(await token.symbol()).to.equal(config.symbol);
        expect(await token.controller()).to.equal(config.controller);
      }
    });
  });

  describe("Edge Cases and Error Handling", function () {
    it("Should handle very large token names and symbols", async function () {
      // Test with maximum practical sizes
      const maxName = "A".repeat(1000);
      const maxSymbol = "B".repeat(100);
      
      token = await Token.deploy(maxName, maxSymbol, controller.address);
      await token.waitForDeployment();
      
      expect(await token.name()).to.equal(maxName);
      expect(await token.symbol()).to.equal(maxSymbol);
    });

    it("Should handle special characters in token metadata", async function () {
      const specialName = "Token with 特殊字符 and émojis 🎯";
      const specialSymbol = "SPÉ¢IAL";
      
      token = await Token.deploy(specialName, specialSymbol, controller.address);
      await token.waitForDeployment();
      
      expect(await token.name()).to.equal(specialName);
      expect(await token.symbol()).to.equal(specialSymbol);
    });

    it("Should validate constructor parameters independently", async function () {
      // Test each parameter validation independently
      await expect(Token.deploy("", "VALID", controller.address))
        .to.be.revertedWith("Token name cannot be empty");
      
      await expect(Token.deploy("Valid", "", controller.address))
        .to.be.revertedWith("Token symbol cannot be empty");
      
      await expect(Token.deploy("Valid", "VALID", ZeroAddress))
        .to.be.revertedWith("Controller cannot be zero address");
    });

    it("Should handle whitespace-only names and symbols", async function () {
      // Test with strings that contain only whitespace
      await expect(Token.deploy("   ", "VALID", controller.address))
        .to.not.be.reverted; // Whitespace is considered valid content
      
      await expect(Token.deploy("VALID", "   ", controller.address))
        .to.not.be.reverted; // Whitespace is considered valid content
    });
  });

  describe("Event Filtering and Querying", function () {
    beforeEach(async function () {
      token = await Token.deploy("Test Token", "TEST", controller.address);
      await token.waitForDeployment();
    });

    it("Should support filtering Minted events by recipient", async function () {
      // Mint to different users
      await token.connect(controller).mint(user1.address, parseEther("100"));
      await token.connect(controller).mint(user2.address, parseEther("200"));
      await token.connect(controller).mint(user1.address, parseEther("300"));
      
      // Query events for user1 only
      const filter = token.filters.Minted(user1.address);
      const events = await token.queryFilter(filter);
      
      expect(events.length).to.equal(2);
      expect(events[0].args.to).to.equal(user1.address);
      expect(events[0].args.amount).to.equal(parseEther("100"));
      expect(events[1].args.to).to.equal(user1.address);
      expect(events[1].args.amount).to.equal(parseEther("300"));
    });

    it("Should support filtering ControllerUpdated events", async function () {
      // Update controller multiple times
      await token.setController(user1.address);
      await token.setController(user2.address);
      await token.setController(controller.address);
      
      // Query all ControllerUpdated events (including the one from constructor)
      const filter = token.filters.ControllerUpdated();
      const events = await token.queryFilter(filter);
      
      expect(events.length).to.equal(4); // 1 from constructor + 3 from setController calls
      expect(events[1].args.newController).to.equal(user1.address);
      expect(events[2].args.newController).to.equal(user2.address);
      expect(events[3].args.newController).to.equal(controller.address);
    });
  });
});