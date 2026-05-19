const { expect } = require("chai");
const { ethers } = require("hardhat");
const { parseEther, ZeroAddress, keccak256, toUtf8Bytes } = require("ethers");

describe("HokusaiToken - Cap-based allocation buckets", function () {
  let Token;
  let HokusaiParams;
  let params;
  let owner;
  let controller;
  let governor;
  let user1;
  let user2;

  const TOKENS_PER_DELTA_ONE = parseEther("500000");
  const MODEL_SUPPLIER_ALLOCATION = parseEther("2500000");
  const INVESTOR_ALLOCATION = parseEther("10000000");
  const MAX_SUPPLY = MODEL_SUPPLIER_ALLOCATION + INVESTOR_ALLOCATION;
  const REWARD_ALLOCATION = 100n * TOKENS_PER_DELTA_ONE;

  beforeEach(async function () {
    [owner, controller, governor, user1, user2] = await ethers.getSigners();
    Token = await ethers.getContractFactory("HokusaiToken");
    HokusaiParams = await ethers.getContractFactory("HokusaiParams");

    params = await HokusaiParams.deploy(
      TOKENS_PER_DELTA_ONE,
      8000,
      0,
      keccak256(toUtf8Bytes("test-license")),
      "https://test.license",
      governor.address,
      { enabled: false, immediateUnlockBps: 10000, vestingDurationSeconds: 0, cliffSeconds: 0 }
    );
    await params.waitForDeployment();
  });

  async function deployCapped() {
    const token = await Token.deploy(
      "Capped Token", "CAP", controller.address, await params.getAddress(),
      0, MAX_SUPPLY, MODEL_SUPPLIER_ALLOCATION, owner.address
    );
    await token.waitForDeployment();
    return token;
  }

  async function deployLegacy() {
    const token = await Token.deploy(
      "Legacy Token", "LEG", controller.address, await params.getAddress(),
      parseEther("1000000"), 0, 0, ZeroAddress
    );
    await token.waitForDeployment();
    return token;
  }

  it("sets investorAllocation and rewardAllocation correctly for cap-based tokens", async function () {
    const token = await deployCapped();
    expect(await token.investorAllocation()).to.equal(INVESTOR_ALLOCATION);
    expect(await token.rewardAllocation()).to.equal(REWARD_ALLOCATION);
    expect(await token.investorMinted()).to.equal(0);
    expect(await token.rewardMinted()).to.equal(0);
  });

  it("emits TokenAllocationsConfigured on cap-based deployment", async function () {
    const token = await Token.deploy(
      "Capped Token", "CAP", controller.address, await params.getAddress(),
      0, MAX_SUPPLY, MODEL_SUPPLIER_ALLOCATION, owner.address
    );
    const receipt = await token.deploymentTransaction().wait();

    const iface = new ethers.Interface([
      "event TokenAllocationsConfigured(uint256 maxSupply, uint256 modelSupplierAllocation, uint256 investorAllocation, uint256 rewardAllocation)"
    ]);
    const parsed = receipt.logs.map(l => { try { return iface.parseLog(l); } catch { return null; } }).filter(Boolean);
    expect(parsed.length).to.equal(1);
    expect(parsed[0].args.investorAllocation).to.equal(INVESTOR_ALLOCATION);
    expect(parsed[0].args.rewardAllocation).to.equal(REWARD_ALLOCATION);
  });

  it("mint() reverts for cap-based tokens", async function () {
    const token = await deployCapped();
    await expect(
      token.connect(controller).mint(user1.address, 1)
    ).to.be.revertedWith("Use mintInvestor or mintReward for cap-based tokens");
  });

  it("mintInvestor enforces investor allocation cap", async function () {
    const token = await deployCapped();

    await token.connect(controller).mintInvestor(user1.address, INVESTOR_ALLOCATION - 1n);
    expect(await token.investorMinted()).to.equal(INVESTOR_ALLOCATION - 1n);

    await expect(
      token.connect(controller).mintInvestor(user1.address, 2)
    ).to.be.revertedWith("Investor allocation exhausted");

    await token.connect(controller).mintInvestor(user1.address, 1);
    expect(await token.investorMinted()).to.equal(INVESTOR_ALLOCATION);
  });

  it("mintReward succeeds after investor allocation is fully consumed", async function () {
    const token = await deployCapped();
    await token.connect(controller).mintInvestor(user1.address, INVESTOR_ALLOCATION);

    await expect(
      token.connect(controller).mintInvestor(user1.address, 1)
    ).to.be.revertedWith("Investor allocation exhausted");

    await token.connect(controller).mintReward(user2.address, parseEther("1000"));
    expect(await token.rewardMinted()).to.equal(parseEther("1000"));
    expect(await token.investorMinted()).to.equal(INVESTOR_ALLOCATION);
  });

  it("mintInvestor succeeds after reward allocation is fully consumed", async function () {
    const token = await deployCapped();
    await token.connect(controller).mintReward(user1.address, REWARD_ALLOCATION);

    await expect(
      token.connect(controller).mintReward(user1.address, 1)
    ).to.be.revertedWith("Reward allocation exhausted");

    await token.connect(controller).mintInvestor(user2.address, parseEther("1000"));
    expect(await token.investorMinted()).to.equal(parseEther("1000"));
  });

  it("distributeModelSupplierAllocation does not affect investor or reward counters", async function () {
    const token = await deployCapped();
    await token.connect(controller).distributeModelSupplierAllocation();

    expect(await token.investorMinted()).to.equal(0);
    expect(await token.rewardMinted()).to.equal(0);
    expect(await token.totalSupply()).to.equal(MODEL_SUPPLIER_ALLOCATION);
  });

  it("rewardAllocation is immutable to params changes", async function () {
    const token = await deployCapped();
    const originalRewardAllocation = await token.rewardAllocation();

    await params.connect(governor).setTokensPerDeltaOne(parseEther("1000000"));
    expect(await token.rewardAllocation()).to.equal(originalRewardAllocation);
  });

  it("reward cap enforcement: reverts with 'Reward allocation exhausted'", async function () {
    const token = await deployCapped();
    await token.connect(controller).mintReward(user1.address, REWARD_ALLOCATION - 1n);

    await expect(
      token.connect(controller).mintReward(user1.address, 2)
    ).to.be.revertedWith("Reward allocation exhausted");

    await token.connect(controller).mintReward(user1.address, 1);
    expect(await token.rewardMinted()).to.equal(REWARD_ALLOCATION);
  });

  it("investorRemaining and rewardRemaining views work correctly", async function () {
    const token = await deployCapped();

    expect(await token.investorRemaining()).to.equal(INVESTOR_ALLOCATION);
    expect(await token.rewardRemaining()).to.equal(REWARD_ALLOCATION);

    const investorMint = parseEther("1000000");
    const rewardMint = parseEther("500");
    await token.connect(controller).mintInvestor(user1.address, investorMint);
    await token.connect(controller).mintReward(user2.address, rewardMint);

    expect(await token.investorRemaining()).to.equal(INVESTOR_ALLOCATION - investorMint);
    expect(await token.rewardRemaining()).to.equal(REWARD_ALLOCATION - rewardMint);
  });

  it("getRemainingSupply aggregates all buckets", async function () {
    const token = await deployCapped();
    const fullRemaining = INVESTOR_ALLOCATION + REWARD_ALLOCATION + MODEL_SUPPLIER_ALLOCATION;
    expect(await token.getRemainingSupply()).to.equal(fullRemaining);

    await token.connect(controller).distributeModelSupplierAllocation();
    expect(await token.getRemainingSupply()).to.equal(INVESTOR_ALLOCATION + REWARD_ALLOCATION);

    const investorMint = parseEther("1000");
    await token.connect(controller).mintInvestor(user1.address, investorMint);
    expect(await token.getRemainingSupply()).to.equal(INVESTOR_ALLOCATION - investorMint + REWARD_ALLOCATION);
  });

  describe("Legacy token behavior", function () {
    it("mint() works on legacy tokens", async function () {
      const token = await deployLegacy();
      await token.connect(controller).mint(user1.address, parseEther("100"));
      expect(await token.balanceOf(user1.address)).to.equal(parseEther("100"));
    });

    it("mintInvestor and mintReward work on legacy tokens without cap checks", async function () {
      const token = await deployLegacy();
      await token.connect(controller).mintInvestor(user1.address, parseEther("100"));
      await token.connect(controller).mintReward(user2.address, parseEther("200"));

      expect(await token.balanceOf(user1.address)).to.equal(parseEther("100"));
      expect(await token.balanceOf(user2.address)).to.equal(parseEther("200"));
      expect(await token.investorMinted()).to.equal(0);
      expect(await token.rewardMinted()).to.equal(0);
    });

    it("investorRemaining and rewardRemaining return max uint for legacy", async function () {
      const token = await deployLegacy();
      const maxUint = 2n ** 256n - 1n;
      expect(await token.investorRemaining()).to.equal(maxUint);
      expect(await token.rewardRemaining()).to.equal(maxUint);
      expect(await token.getRemainingSupply()).to.equal(maxUint);
    });
  });

  it("emits InvestorMinted and RewardMinted events", async function () {
    const token = await deployCapped();

    await expect(token.connect(controller).mintInvestor(user1.address, parseEther("100")))
      .to.emit(token, "InvestorMinted")
      .withArgs(user1.address, parseEther("100"), parseEther("100"));

    await expect(token.connect(controller).mintReward(user2.address, parseEther("50")))
      .to.emit(token, "RewardMinted")
      .withArgs(user2.address, parseEther("50"), parseEther("50"));
  });

  it("only controller can call mintInvestor and mintReward", async function () {
    const token = await deployCapped();
    await expect(
      token.connect(user1).mintInvestor(user2.address, 1)
    ).to.be.revertedWith("Only controller can call this function");
    await expect(
      token.connect(user1).mintReward(user2.address, 1)
    ).to.be.revertedWith("Only controller can call this function");
  });
});
