const { expect } = require("chai");
const { ethers } = require("hardhat");
const { parseEther, ZeroAddress, keccak256, toUtf8Bytes } = require("ethers");

describe("HokusaiToken", function () {
  let token;
  let params;
  let owner;
  let controller;
  let user1;
  let user2;
  let addrs;

  beforeEach(async function () {
    [owner, controller, user1, user2, ...addrs] = await ethers.getSigners();

    // Deploy params first
    const HokusaiParams = await ethers.getContractFactory("HokusaiParams");
    params = await HokusaiParams.deploy(
      1000, // tokensPerDeltaOne
      8000, // infrastructureAccrualBps (80%)
      keccak256(toUtf8Bytes("test-license")), // licenseHash
      "https://test.license", // licenseURI
      owner.address // governor
    );
    await params.waitForDeployment();

    const Token = await ethers.getContractFactory("HokusaiToken");
    token = await Token.deploy("Hokusai Token", "HOKU", controller.address, await params.getAddress(), parseEther("10000"));
    await token.waitForDeployment();
  });

  describe("Deployment", function () {
    it("Should set the correct token metadata", async function () {
      expect(await token.name()).to.equal("Hokusai Token");
      expect(await token.symbol()).to.equal("HOKU");
      expect(await token.decimals()).to.equal(18);
    });

    it("Should set the deployer as owner", async function () {
      expect(await token.owner()).to.equal(owner.address);
    });

    it("Should have correct initial supply", async function () {
      expect(await token.totalSupply()).to.equal(parseEther("10000"));
      expect(await token.balanceOf(controller.address)).to.equal(parseEther("10000"));
    });
  });

  describe("ERC20 Standard Functionality", function () {
    beforeEach(async function () {
      // Set controller and mint some tokens for testing
      await token.setController(controller.address);
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
      await expect(token.setController(controller.address))
        .to.emit(token, "ControllerUpdated")
        .withArgs(controller.address);
      
      expect(await token.controller()).to.equal(controller.address);
    });

    it("Should revert when non-owner tries to set controller", async function () {
      await expect(
        token.connect(user1).setController(controller.address)
      ).to.be.revertedWith("Ownable: caller is not the owner");
    });

    it("Should revert when setting zero address as controller", async function () {
      await expect(
        token.setController(ZeroAddress)
      ).to.be.revertedWith("Controller cannot be zero address");
    });

    it("Should handle multiple rapid controller updates", async function () {
      // Set initial controller
      await token.setController(controller.address);
      expect(await token.controller()).to.equal(controller.address);
      
      // Rapid updates
      await token.setController(user1.address);
      await token.setController(user2.address);
      await token.setController(controller.address);
      
      expect(await token.controller()).to.equal(controller.address);
    });

    it("Should revoke minting permissions from old controller after update", async function () {
      // Set initial controller and verify they can mint
      await token.setController(controller.address);
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

    it("Should maintain owner permissions regardless of controller", async function () {
      // Set controller to non-owner
      await token.setController(controller.address);
      
      // Owner should still be able to change controller
      await expect(token.setController(user1.address))
        .to.emit(token, "ControllerUpdated")
        .withArgs(user1.address);
      
      // But owner cannot mint if not the controller
      await expect(
        token.connect(owner).mint(user2.address, parseEther("100"))
      ).to.be.revertedWith("Only controller can call this function");
    });
  });

  describe("Minting", function () {
    beforeEach(async function () {
      await token.setController(controller.address);
    });

    it("Should allow controller to mint tokens", async function () {
      const mintAmount = parseEther("1000");
      
      await expect(token.connect(controller).mint(user1.address, mintAmount))
        .to.emit(token, "Transfer")
        .withArgs(ZeroAddress, user1.address, mintAmount);
      
      expect(await token.balanceOf(user1.address)).to.equal(mintAmount);
      expect(await token.totalSupply()).to.equal(parseEther("10000") + mintAmount);
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
      
      expect(await token.totalSupply()).to.equal(parseEther("10000") + mintAmount1 + mintAmount2);
    });

    it("Should emit Minted event when minting tokens", async function () {
      const mintAmount = parseEther("1000");
      
      await expect(token.connect(controller).mint(user1.address, mintAmount))
        .to.emit(token, "Minted")
        .withArgs(user1.address, mintAmount);
    });

    it("Should handle minting zero tokens", async function () {
      // Minting zero tokens should succeed but not change balances
      const initialBalance = await token.balanceOf(user1.address);
      const initialSupply = await token.totalSupply();
      
      await expect(token.connect(controller).mint(user1.address, 0))
        .to.emit(token, "Minted")
        .withArgs(user1.address, 0);
      
      expect(await token.balanceOf(user1.address)).to.equal(initialBalance);
      expect(await token.totalSupply()).to.equal(initialSupply);
    });

    it("Should handle minting large values without overflow", async function () {
      const largeAmount = parseEther("1000000"); // 1 million tokens

      await expect(token.connect(controller).mint(user1.address, largeAmount))
        .to.emit(token, "Minted")
        .withArgs(user1.address, largeAmount);

      expect(await token.balanceOf(user1.address)).to.equal(largeAmount);
      expect(await token.totalSupply()).to.equal(parseEther("10000") + largeAmount);
    });

    it("Should measure gas usage for minting operations", async function () {
      const mintAmount = parseEther("1000");
      
      const tx = await token.connect(controller).mint(user1.address, mintAmount);
      const receipt = await tx.wait();
      
      // Minting should be reasonably gas efficient (less than 100k gas)
      expect(receipt.gasUsed).to.be.below(100000);
    });

    it("Should handle sequential minting to same address", async function () {
      const amount1 = parseEther("100");
      const amount2 = parseEther("200");
      const amount3 = parseEther("300");
      
      await token.connect(controller).mint(user1.address, amount1);
      await token.connect(controller).mint(user1.address, amount2);
      await token.connect(controller).mint(user1.address, amount3);
      
      expect(await token.balanceOf(user1.address)).to.equal(amount1 + amount2 + amount3);
      expect(await token.totalSupply()).to.equal(parseEther("10000") + amount1 + amount2 + amount3);
    });
  });

  describe("Burning", function () {
    beforeEach(async function () {
      await token.setController(controller.address);
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
        .withArgs(user1.address, ZeroAddress, burnAmount);
      
      expect(await token.balanceOf(user1.address)).to.equal(initialBalance - burnAmount);
      expect(await token.totalSupply()).to.equal(initialSupply - burnAmount);
    });

    it("Should allow users to burn their own tokens", async function () {
      const burnAmount = parseEther("100");
      const initialBalance = await token.balanceOf(user1.address);
      const initialSupply = await token.totalSupply();
      
      await expect(token.connect(user1).burn(burnAmount))
        .to.emit(token, "Transfer")
        .withArgs(user1.address, ZeroAddress, burnAmount);
      
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

    it("Should decrease total supply when burning", async function () {
      const burnAmount1 = parseEther("100");
      const burnAmount2 = parseEther("50");
      const initialSupply = await token.totalSupply();
      
      await token.connect(user1).burn(burnAmount1);
      await token.connect(controller).burnFrom(user2.address, burnAmount2);
      
      expect(await token.totalSupply()).to.equal(
        initialSupply - burnAmount1 - burnAmount2
      );
    });

    it("Should handle user burning their entire balance", async function () {
      const balance = await token.balanceOf(user1.address);
      
      await token.connect(user1).burn(balance);
      
      expect(await token.balanceOf(user1.address)).to.equal(0);
    });

    it("Should emit Burned event when user burns their tokens", async function () {
      const burnAmount = parseEther("300");
      
      await expect(token.connect(user1).burn(burnAmount))
        .to.emit(token, "Burned")
        .withArgs(user1.address, burnAmount);
    });

    it("Should emit Burned event when controller burns tokens using burnFrom", async function () {
      const burnAmount = parseEther("200");
      
      await expect(token.connect(controller).burnFrom(user2.address, burnAmount))
        .to.emit(token, "Burned")
        .withArgs(user2.address, burnAmount);
    });
  });

  describe("Integration scenarios", function () {
    it("Should handle complex mint, transfer, and burn flow", async function () {
      await token.setController(controller.address);
      
      // Controller mints to user1
      await token.connect(controller).mint(user1.address, parseEther("1000"));
      
      // user1 transfers to user2
      await token.connect(user1).transfer(user2.address, parseEther("300"));
      
      // user1 burns their own tokens, controller burns from user2
      await token.connect(user1).burn(parseEther("200"));
      await token.connect(controller).burnFrom(user2.address, parseEther("100"));
      
      expect(await token.balanceOf(user1.address)).to.equal(parseEther("500"));
      expect(await token.balanceOf(user2.address)).to.equal(parseEther("200"));
      expect(await token.totalSupply()).to.equal(parseEther("10700")); // 10000 initial + 1000 minted - 300 burned
    });
  });

  describe("Event Filtering", function () {
    it("Should support filtering Minted events by recipient", async function () {
      await token.setController(controller.address);
      
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
      await token.setController(controller.address);
      await token.setController(user1.address);
      await token.setController(user2.address);
      
      // Query all ControllerUpdated events
      const filter = token.filters.ControllerUpdated();
      const events = await token.queryFilter(filter);
      
      expect(events.length).to.equal(4); // 1 from constructor + 3 from setController calls
      expect(events[0].args.newController).to.equal(controller.address); // From constructor
      expect(events[1].args.newController).to.equal(controller.address);
      expect(events[2].args.newController).to.equal(user1.address);
      expect(events[3].args.newController).to.equal(user2.address);
    });
  });
});