const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { parseEther, parseUnits, ZeroAddress } = require("ethers");

const { buildInitialParams, buildVestingConfig, deployTestToken } = require("../helpers/tokenDeployment");
const { buildMintRequestPayload } = require("../helpers/mintRequest");

function makeRng(seed) {
  let state = BigInt(seed);
  return {
    next() {
      state = (state * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n);
      return state;
    },
    int(min, max) {
      const span = BigInt(max - min + 1);
      return min + Number(this.next() % span);
    },
    pick(values) {
      return values[this.int(0, values.length - 1)];
    },
  };
}

function randomWeights(rng, count) {
  if (count === 1) return [10000];

  const cuts = new Set();
  while (cuts.size < count - 1) {
    cuts.add(rng.int(1, 9999));
  }

  const points = [0, ...[...cuts].sort((a, b) => a - b), 10000];
  return points.slice(1).map((point, index) => point - points[index]);
}

function splitReward(totalReward, weights) {
  const rewards = weights.map((weight) => (totalReward * BigInt(weight)) / 10000n);
  const distributed = rewards.reduce((sum, reward) => sum + reward, 0n);
  if (totalReward > distributed) {
    rewards[0] += totalReward - distributed;
  }
  return rewards;
}

async function now() {
  return (await ethers.provider.getBlock("latest")).timestamp;
}

describe("Property fuzz invariants", function () {
  const MODEL_ID = 1;
  const MODEL_ID_STR = "1";
  const TOKENS_PER_DELTA_ONE = parseEther("500000");
  const MAX_REWARD = parseEther("1000000");
  const MIN_IMPROVEMENT_BPS = 100;
  const IMMEDIATE_UNLOCK_BPS = 1000n;
  const TRADE_FEE_BPS = 30n;
  const IBR_SECONDS = 24 * 60 * 60;

  async function deployDeltaVerifierFixture() {
    const signers = await ethers.getSigners();
    const [owner, submitter, outsider] = signers;
    const contributors = signers.slice(3, 11);

    const ModelRegistry = await ethers.getContractFactory("ModelRegistry");
    const modelRegistry = await ModelRegistry.deploy();
    await modelRegistry.waitForDeployment();

    const TokenManager = await ethers.getContractFactory("TokenManager");
    const tokenManager = await TokenManager.deploy(await modelRegistry.getAddress());
    await tokenManager.waitForDeployment();

    const RewardVestingVault = await ethers.getContractFactory("RewardVestingVault");
    const vestingVault = await RewardVestingVault.deploy(await tokenManager.getAddress());
    await vestingVault.waitForDeployment();
    await tokenManager.setVestingVault(await vestingVault.getAddress());

    const DataContributionRegistry = await ethers.getContractFactory("DataContributionRegistry");
    const contributionRegistry = await DataContributionRegistry.deploy();
    await contributionRegistry.waitForDeployment();

    const DeltaVerifier = await ethers.getContractFactory("DeltaVerifier");
    const deltaVerifier = await DeltaVerifier.deploy(
      await modelRegistry.getAddress(),
      await tokenManager.getAddress(),
      await contributionRegistry.getAddress(),
      parseEther("1000"),
      MIN_IMPROVEMENT_BPS,
      MAX_REWARD,
    );
    await deltaVerifier.waitForDeployment();

    await tokenManager.setDeltaVerifier(await deltaVerifier.getAddress());
    await contributionRegistry.grantRole(await contributionRegistry.RECORDER_ROLE(), await deltaVerifier.getAddress());
    await deltaVerifier.grantRole(await deltaVerifier.SUBMITTER_ROLE(), submitter.address);

    const params = buildInitialParams(owner.address, {
      tokensPerDeltaOne: TOKENS_PER_DELTA_ONE,
      vestingConfig: buildVestingConfig({
        enabled: true,
        immediateUnlockBps: Number(IMMEDIATE_UNLOCK_BPS),
        vestingDurationSeconds: 365 * 24 * 60 * 60,
        cliffSeconds: 0,
      }),
    });

    const tokenAddress = await tokenManager.deployTokenWithParams.staticCall(
      MODEL_ID_STR,
      "Fuzz Reward Token",
      "FUZR",
      parseEther("1000000"),
      params,
    );
    await tokenManager.deployTokenWithParams(MODEL_ID_STR, "Fuzz Reward Token", "FUZR", parseEther("1000000"), params);

    const token = await ethers.getContractAt("HokusaiToken", tokenAddress);
    await modelRegistry.registerModel(MODEL_ID, tokenAddress, "accuracy");

    return { submitter, outsider, contributors, token, tokenManager, contributionRegistry, deltaVerifier, vestingVault };
  }

  async function deployAmmFixture() {
    const [owner, treasury, user1, user2, user3, outsider] = await ethers.getSigners();
    const users = [user1, user2, user3];
    const modelId = "1211";

    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    const mockUSDC = await MockUSDC.deploy();
    await mockUSDC.waitForDeployment();

    const ModelRegistry = await ethers.getContractFactory("ModelRegistry");
    const modelRegistry = await ModelRegistry.deploy();
    await modelRegistry.waitForDeployment();

    const TokenManager = await ethers.getContractFactory("TokenManager");
    const tokenManager = await TokenManager.deploy(await modelRegistry.getAddress());
    await tokenManager.waitForDeployment();

    await deployTestToken(tokenManager, modelId, "Fuzz AMM Token", "FUZA", parseEther("1000000"), owner.address);
    const tokenAddress = await tokenManager.getTokenAddress(modelId);
    const token = await ethers.getContractAt("HokusaiToken", tokenAddress);

    const HokusaiAMM = await ethers.getContractFactory("HokusaiAMM");
    const amm = await HokusaiAMM.deploy(
      await mockUSDC.getAddress(),
      tokenAddress,
      await tokenManager.getAddress(),
      modelId,
      treasury.address,
      200000,
      TRADE_FEE_BPS,
      IBR_SECONDS,
      parseUnits("1000", 6),
      parseUnits("0.01", 6),
    );
    await amm.waitForDeployment();
    await tokenManager.authorizeAMM(await amm.getAddress());
    await amm.setMaxTradeBps(5000);

    await mockUSDC.mint(owner.address, parseUnits("10000", 6));
    await mockUSDC.approve(await amm.getAddress(), parseUnits("10000", 6));
    await amm.depositFees(parseUnits("10000", 6));

    for (const user of users) {
      await mockUSDC.mint(user.address, parseUnits("250000", 6));
      await mockUSDC.connect(user).approve(await amm.getAddress(), parseUnits("250000", 6));
    }

    await network.provider.send("evm_increaseTime", [IBR_SECONDS + 1]);
    await network.provider.send("evm_mine");

    return { amm, token, mockUSDC, tokenManager, users, outsider, treasury, modelId };
  }

  describe("DeltaVerifier reward distribution", function () {
    it("fuzzes contributor splits without over-minting or double-minting", async function () {
      const fixture = await loadFixture(deployDeltaVerifierFixture);
      const { submitter, contributors, token, contributionRegistry, deltaVerifier, vestingVault } = fixture;
      const rng = makeRng(0xdecafbad);

      for (let i = 0; i < 32; i += 1) {
        const contributorCount = rng.int(1, contributors.length);
        const selected = contributors.slice(0, contributorCount);
        const weights = randomWeights(rng, contributorCount);
        const baselineScoreBps = rng.int(1000, 8800);
        const deltaBps = rng.int(0, 1200);
        const candidateScoreBps = Math.min(10000, baselineScoreBps + deltaBps);
        const effectiveDeltaBps = candidateScoreBps - baselineScoreBps;
        const expectedTotalReward = effectiveDeltaBps < MIN_IMPROVEMENT_BPS
          ? 0n
          : ((BigInt(effectiveDeltaBps) * TOKENS_PER_DELTA_ONE) / 100n > MAX_REWARD
              ? MAX_REWARD
              : (BigInt(effectiveDeltaBps) * TOKENS_PER_DELTA_ONE) / 100n);
        const expectedRewards = splitReward(expectedTotalReward, weights);
        const fuzzContributors = selected.map((signer, index) => ({
          walletAddress: signer.address,
          weight: weights[index],
        }));
        const payload = buildMintRequestPayload({
          pipelineRunId: `fuzz-delta-${i}`,
          baselineScoreBps,
          candidateScoreBps,
          totalSamples: rng.int(1, 1_000_000),
          anchors: { idempotencyKey: ethers.id(`fuzz-delta-${i}`) },
        });

        const balancesBefore = await Promise.all(selected.map((signer) => token.balanceOf(signer.address)));
        const vaultBefore = await token.balanceOf(await vestingVault.getAddress());
        const countsBefore = await Promise.all(
          selected.map((signer) => contributionRegistry.getContributorContributionCount(signer.address)),
        );
        const schedulesBefore = await Promise.all(
          selected.map((signer) => vestingVault.getSchedulesByBeneficiary(signer.address)),
        );

        const staticReward = await deltaVerifier.connect(submitter).submitMintRequest.staticCall(MODEL_ID, payload, fuzzContributors);
        expect(staticReward).to.equal(expectedTotalReward);
        await deltaVerifier.connect(submitter).submitMintRequest(MODEL_ID, payload, fuzzContributors);

        const balancesAfter = await Promise.all(selected.map((signer) => token.balanceOf(signer.address)));
        const vaultAfter = await token.balanceOf(await vestingVault.getAddress());
        const countsAfter = await Promise.all(
          selected.map((signer) => contributionRegistry.getContributorContributionCount(signer.address)),
        );
        const schedulesAfter = await Promise.all(
          selected.map((signer) => vestingVault.getSchedulesByBeneficiary(signer.address)),
        );

        let totalImmediate = 0n;
        let totalVested = 0n;
        for (let j = 0; j < selected.length; j += 1) {
          const immediate = (expectedRewards[j] * IMMEDIATE_UNLOCK_BPS) / 10000n;
          const vested = expectedRewards[j] - immediate;
          totalImmediate += immediate;
          totalVested += vested;
          expect(balancesAfter[j] - balancesBefore[j]).to.equal(immediate);

          if (expectedTotalReward > 0n) {
            expect(countsAfter[j]).to.equal(countsBefore[j] + 1n);
            expect(schedulesAfter[j].length).to.equal(schedulesBefore[j].length + 1);
            const schedule = await vestingVault.getSchedule(schedulesAfter[j][schedulesAfter[j].length - 1]);
            expect(schedule.totalAmount).to.equal(vested);
          } else {
            expect(countsAfter[j]).to.equal(countsBefore[j]);
            expect(schedulesAfter[j].length).to.equal(schedulesBefore[j].length);
          }
        }

        expect(totalImmediate + totalVested).to.equal(expectedTotalReward);
        expect(vaultAfter - vaultBefore).to.equal(totalVested);
        expect(await deltaVerifier.processedIdempotencyKeys(payload.anchors.idempotencyKey)).to.equal(true);
        await expect(
          deltaVerifier.connect(submitter).submitMintRequest(MODEL_ID, payload, fuzzContributors)
        ).to.be.revertedWith("Idempotency key already processed");
      }
    });

    it("fuzzes invalid contributor weights and addresses without minting", async function () {
      const { submitter, contributors, token, deltaVerifier } = await loadFixture(deployDeltaVerifierFixture);
      const rng = makeRng(0xbadc0de);

      for (let i = 0; i < 20; i += 1) {
        const balanceBefore = await token.balanceOf(contributors[0].address);
        const payload = buildMintRequestPayload({
          pipelineRunId: `fuzz-invalid-${i}`,
          anchors: { idempotencyKey: ethers.id(`fuzz-invalid-${i}`) },
        });

        const invalidMode = rng.pick(["low", "high", "zero"]);
        const invalidContributors = invalidMode === "zero"
          ? [{ walletAddress: ZeroAddress, weight: 10000 }]
          : [{ walletAddress: contributors[0].address, weight: invalidMode === "low" ? rng.int(1, 9999) : rng.int(10001, 20000) }];

        const assertion = expect(
          deltaVerifier.connect(submitter).submitMintRequest(MODEL_ID, payload, invalidContributors)
        );
        if (invalidMode === "zero") {
          await assertion.to.be.revertedWithCustomError(deltaVerifier, "ZeroAddress");
        } else {
          await assertion.to.be.revertedWith("Weights must sum to 100%");
        }
        expect(await token.balanceOf(contributors[0].address)).to.equal(balanceBefore);
      }
    });
  });

  describe("AMM reserve and supply accounting", function () {
    it("fuzzes buy, sell, and fee-deposit sequences while preserving accounting invariants", async function () {
      const { amm, token, mockUSDC, users } = await loadFixture(deployAmmFixture);
      const rng = makeRng(0xa11ce);

      for (let i = 0; i < 48; i += 1) {
        const action = rng.pick(["buy", "sell", "deposit"]);
        const actor = rng.pick(users);

        if (action === "buy") {
          const reserveBefore = await amm.reserveBalance();
          const amount = parseUnits(rng.int(1, 2500).toString(), 6);
          const maxTrade = (reserveBefore * await amm.maxTradeBps()) / 10000n;
          if (amount > maxTrade) {
            await expect(
              amm.connect(actor).buy(amount, 0, actor.address, (await now()) + 300)
            ).to.be.revertedWith("Trade exceeds max size limit");
          } else {
            const quote = await amm.getBuyQuote(amount);
            await mockUSDC.connect(actor).approve(await amm.getAddress(), amount);
            await amm.connect(actor).buy(amount, quote, actor.address, (await now()) + 300);
            const fee = (amount * TRADE_FEE_BPS) / 10000n;
            expect(await amm.reserveBalance()).to.equal(reserveBefore + amount - fee);
          }
        } else if (action === "sell") {
          const balance = await token.balanceOf(actor.address);
          if (balance > 0n) {
            const tokensIn = balance / BigInt(rng.int(8, 40));
            const quote = await amm.getSellQuote(tokensIn);
            const maxTrade = (await amm.reserveBalance() * await amm.maxTradeBps()) / 10000n;
            if (quote > maxTrade) {
              await token.connect(actor).approve(await amm.getAddress(), tokensIn);
              await expect(
                amm.connect(actor).sell(tokensIn, 0, actor.address, (await now()) + 300)
              ).to.be.revertedWith("Trade exceeds max size limit");
            } else if (tokensIn > 0n && quote > 0n) {
              const reserveBefore = await amm.reserveBalance();
              await token.connect(actor).approve(await amm.getAddress(), tokensIn);
              await amm.connect(actor).sell(tokensIn, quote - 1n, actor.address, (await now()) + 300);
              expect(await amm.reserveBalance()).to.equal(reserveBefore - quote);
            }
          }
        } else {
          const amount = parseUnits(rng.int(1, 500).toString(), 6);
          const reserveBefore = await amm.reserveBalance();
          await mockUSDC.connect(actor).approve(await amm.getAddress(), amount);
          await amm.connect(actor).depositFees(amount);
          expect(await amm.reserveBalance()).to.equal(reserveBefore + amount);
        }

        const reserve = await amm.reserveBalance();
        const ammUsdc = await mockUSDC.balanceOf(await amm.getAddress());
        const [, reportedSupply] = await amm.getReserves();
        expect(reserve).to.be.lte(ammUsdc);
        expect(reportedSupply).to.equal(await token.totalSupply());
        expect(await amm.spotPrice()).to.be.gt(0);
      }
    });

    it("fuzzes access control and pause-state blocking for state-changing methods", async function () {
      const { amm, tokenManager, token, users, outsider, modelId } = await loadFixture(deployAmmFixture);
      const rng = makeRng(0x515ec);

      for (let i = 0; i < 16; i += 1) {
        const unauthorizedAmount = parseEther(rng.int(1, 100).toString());
        await expect(
          tokenManager.connect(outsider).mintTokens(modelId, outsider.address, unauthorizedAmount)
        ).to.be.revertedWith("Caller is not authorized to mint");
        await expect(
          tokenManager.connect(outsider).burnTokens(modelId, users[0].address, unauthorizedAmount)
        ).to.be.revertedWith("Caller is not authorized to burn");
      }

      await amm.pause();
      await expect(
        amm.connect(users[0]).buy(parseUnits("1", 6), 0, users[0].address, (await now()) + 300)
      ).to.be.revertedWith("Pausable: paused");

      const balance = await token.balanceOf(users[0].address);
      if (balance > 0n) {
        await token.connect(users[0]).approve(await amm.getAddress(), balance / 100n);
        await expect(
          amm.connect(users[0]).sell(balance / 100n, 0, users[0].address, (await now()) + 300)
        ).to.be.revertedWith("Pausable: paused");
      }
    });
  });
});
