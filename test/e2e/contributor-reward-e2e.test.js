/*
 * HOK-2248: end-to-end contributor-reward flow, proven at the contract layer on the canary
 * model 930 (separate lineage; NEVER touches production Model 30).
 *
 * This exercises the two acceptance cases from the epic (HOK-2242) using the PRODUCTION mint
 * path (`submitMintRequest`, attester-signed) with vesting enabled and the PendingClaimsEscrow:
 *
 *   (a) Registered-wallet contributor — the account already has a verified wallet, so the mint
 *       pays that wallet directly: 10% liquid immediately + 90% into a vesting schedule the
 *       contributor later `claim()`s. Lineage advances and the request is replay-protected
 *       (the on-chain half of "detector reconciles clean").
 *
 *   (b) Pending / no-wallet contributor (the fairness case) — the account has no verified
 *       wallet at earn-time, so the tranche is minted into the escrow (NOT dropped): 10% liquid
 *       held by the escrow + 90% vested with the escrow as beneficiary. Once a wallet is
 *       verified, a RELEASER releases the liquid tranche, then pulls the vested portion
 *       (`claimVested`) and releases that too. A non-releaser attempt is rejected.
 *
 * The off-chain seams (account -> attribution -> MintRequest, mint -> reward_entitlement ingest,
 * escrow-release authorization) are covered by unit/integration tests in hokusai-data-pipeline
 * and hokusai-auth-service. This file is the on-chain capstone: it asserts the money actually
 * moves the way those seams assume.
 *
 * For the LIVE Sepolia drill against the deployed canary 930 (funded wallet + KMS/Ledger
 * signer + deployed auth/pipeline), see scripts/setup-canary-model.js + scripts/deltaone-
 * reconcile-drill.js; this test is the deterministic, repeatable CI form of the same flow.
 */
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { parseEther } = require("ethers");
const { buildInitialParams, buildVestingConfig } = require("../helpers/tokenDeployment");
const {
  payloadForNextLink,
  attestMintRequest,
  configureLaunchAttester,
  configureMintBudget,
  configureLineageGenesis,
} = require("../helpers/mintRequest");

// Canary lineage — distinct from production Model 30. _uintToString(930) == "930", which is the
// string id the TokenManager/registry mint keys use.
const MODEL_ID_UINT = 930;
const MODEL_ID_STR = "930";

// buildVestingConfig(): 10% immediate unlock, 90% vested linearly over 1 year, no cliff.
const IMMEDIATE_BPS = 1000n;
const BPS_DENOM = 10000n;
const VESTING_DURATION = 365 * 24 * 60 * 60;

// tokensPerDeltaOne is locked at the canonical 250k (never reintroduce 500k). Reward magnitude is
// read from on-chain balances below, so assertions don't actually depend on this value.
const CANARY_TOKENS_PER_DELTA_ONE = parseEther("250000");
const MAX_REWARD = parseEther("100000000");

describe("HOK-2248 contributor-reward E2E (canary model 930)", function () {
  let owner; // registration authority + attester + escrow admin
  let submitter; // holds SUBMITTER_ROLE (the consumer)
  let walletContributor; // case (a): account with a verified wallet
  let escrowReleaser; // case (b): backend key holding RELEASER_ROLE
  let lateWallet; // case (b): wallet verified AFTER the tranche was earned
  let outsider; // unauthorized actor
  let deltaVerifier;
  let tokenManager;
  let vestingVault;
  let escrow;
  let modelRegistry;
  let token;
  let tokenAddr;
  let vaultAddr;
  let escrowAddr;

  function liquidOf(total) {
    return (total * IMMEDIATE_BPS) / BPS_DENOM;
  }

  async function mintToCanary(contributors) {
    const payload = await payloadForNextLink(deltaVerifier, MODEL_ID_UINT);
    const sigs = await attestMintRequest(deltaVerifier, owner, MODEL_ID_UINT, payload, contributors);
    const tx = await deltaVerifier
      .connect(submitter)
      .submitMintRequest(MODEL_ID_UINT, payload, contributors, sigs);
    await tx.wait();
    return { payload, sigs };
  }

  beforeEach(async function () {
    [owner, submitter, walletContributor, escrowReleaser, lateWallet, outsider] =
      await ethers.getSigners();

    const ModelRegistry = await ethers.getContractFactory("ModelRegistry");
    modelRegistry = await ModelRegistry.deploy();
    await modelRegistry.waitForDeployment();

    const TokenManager = await ethers.getContractFactory("TokenManager");
    tokenManager = await TokenManager.deploy(await modelRegistry.getAddress());
    await tokenManager.waitForDeployment();

    // Vesting vault must be wired before the token is deployed so reward mints split 10/90.
    const RewardVestingVault = await ethers.getContractFactory("RewardVestingVault");
    vestingVault = await RewardVestingVault.deploy(await tokenManager.getAddress());
    await vestingVault.waitForDeployment();
    await tokenManager.setVestingVault(await vestingVault.getAddress());

    const DataContributionRegistry = await ethers.getContractFactory("DataContributionRegistry");
    const contributionRegistry = await DataContributionRegistry.deploy();
    await contributionRegistry.waitForDeployment();

    const DeltaVerifier = await ethers.getContractFactory("DeltaVerifier");
    deltaVerifier = await DeltaVerifier.deploy(
      await modelRegistry.getAddress(),
      await tokenManager.getAddress(),
      await contributionRegistry.getAddress(),
      parseEther("1000"),
      100, // minImprovementBps
      MAX_REWARD
    );
    await deltaVerifier.waitForDeployment();

    const PendingClaimsEscrow = await ethers.getContractFactory("PendingClaimsEscrow");
    escrow = await PendingClaimsEscrow.deploy(owner.address);
    await escrow.waitForDeployment();
    await escrow.grantRole(await escrow.RELEASER_ROLE(), escrowReleaser.address);

    // Deploy the canary token (model 930) with vesting on.
    await tokenManager.deployTokenWithParams(
      MODEL_ID_STR,
      "Hokusai Router Canary",
      "HROUTC",
      parseEther("1000000"),
      buildInitialParams(owner.address, {
        tokensPerDeltaOne: CANARY_TOKENS_PER_DELTA_ONE,
        vestingConfig: buildVestingConfig(),
      })
    );
    tokenAddr = await tokenManager.getTokenAddress(MODEL_ID_STR);
    token = await ethers.getContractAt("HokusaiToken", tokenAddr);
    vaultAddr = await vestingVault.getAddress();
    escrowAddr = await escrow.getAddress();

    await modelRegistry.registerModel(MODEL_ID_UINT, tokenAddr, "router_quality_score");
    await tokenManager.grantRole(await tokenManager.MINTER_ROLE(), await deltaVerifier.getAddress());
    await tokenManager.setDeltaVerifier(await deltaVerifier.getAddress());
    const recorderRole = await contributionRegistry.RECORDER_ROLE();
    await contributionRegistry.grantRole(recorderRole, await deltaVerifier.getAddress());

    await deltaVerifier.grantRole(await deltaVerifier.SUBMITTER_ROLE(), submitter.address);
    await configureLaunchAttester(deltaVerifier, owner, owner);
    await configureMintBudget(deltaVerifier, owner, MODEL_ID_UINT);
    await configureLineageGenesis(modelRegistry, owner, MODEL_ID_UINT);
  });

  describe("(a) registered-wallet contributor", function () {
    it("mints 10% liquid to the wallet + 90% into a vesting schedule, advances lineage, and is replay-protected", async function () {
      const contributors = [{ walletAddress: walletContributor.address, weight: 10000 }];

      const { payload } = await mintToCanary(contributors);

      const liquid = await token.balanceOf(walletContributor.address);
      const vested = await token.balanceOf(vaultAddr);
      const total = liquid + vested;

      // Reward actually paid, split exactly 10% liquid / 90% vested.
      expect(total).to.be.gt(0n);
      expect(liquid).to.equal(liquidOf(total));
      expect(vested).to.equal(total - liquidOf(total));

      // One vesting schedule for the contributor's wallet (beneficiary == wallet).
      expect(await vestingVault.getSchedulesByBeneficiary(walletContributor.address)).to.deep.equal([0n]);

      // On-chain "reconciles clean": lineage advanced to the candidate and the request is burned.
      expect(await deltaVerifier.currentModelHead(MODEL_ID_UINT)).to.equal(payload.candidateCommitment);
      const replaySigs = await attestMintRequest(
        deltaVerifier,
        owner,
        MODEL_ID_UINT,
        payload,
        contributors
      );
      await expect(
        deltaVerifier.connect(submitter).submitMintRequest(MODEL_ID_UINT, payload, contributors, replaySigs)
      ).to.be.revertedWith("Idempotency key already processed");
    });

    it("lets the contributor claim the vested portion to their wallet over time", async function () {
      const contributors = [{ walletAddress: walletContributor.address, weight: 10000 }];
      await mintToCanary(contributors);

      const total = (await token.balanceOf(walletContributor.address)) + (await token.balanceOf(vaultAddr));

      await time.increase(VESTING_DURATION + 1);
      await vestingVault.connect(walletContributor).claim(0);

      // Fully vested: the contributor now holds the entire reward in their own wallet.
      expect(await token.balanceOf(walletContributor.address)).to.equal(total);
      expect(await token.balanceOf(vaultAddr)).to.equal(0n);
    });
  });

  describe("(b) pending / no-wallet contributor via escrow", function () {
    it("mints the tranche into the escrow (not dropped), then a releaser releases liquid + vested to the verified wallet", async function () {
      // No verified wallet at earn-time -> the on-chain recipient is the escrow (the routing the
      // mint orchestrator applies for accounts without a wallet).
      const contributors = [{ walletAddress: escrowAddr, weight: 10000 }];
      await mintToCanary(contributors);

      const escrowLiquid = await token.balanceOf(escrowAddr);
      const vested = await token.balanceOf(vaultAddr);
      const total = escrowLiquid + vested;

      // The tranche was preserved in the escrow, split 10/90, beneficiary = escrow.
      expect(total).to.be.gt(0n);
      expect(escrowLiquid).to.equal(liquidOf(total));
      expect(vested).to.equal(total - liquidOf(total));
      expect(await vestingVault.getSchedulesByBeneficiary(escrowAddr)).to.deep.equal([0n]);

      // Wallet is verified later -> releaser releases the immediately-available (liquid) tranche.
      const refLiquid = ethers.id("reward-930-liquid");
      await expect(
        escrow.connect(escrowReleaser).release(tokenAddr, lateWallet.address, escrowLiquid, refLiquid)
      )
        .to.emit(escrow, "Released")
        .withArgs(tokenAddr, lateWallet.address, escrowLiquid, refLiquid);
      expect(await token.balanceOf(lateWallet.address)).to.equal(escrowLiquid);

      // Later, the vested portion matures; the escrow pulls it from the vault, then releases it too.
      await time.increase(VESTING_DURATION + 1);
      await escrow.connect(escrowReleaser).claimVested(vaultAddr, 0);
      const escrowAfterVest = await token.balanceOf(escrowAddr);
      expect(escrowAfterVest).to.equal(vested);

      const refVested = ethers.id("reward-930-vested");
      await escrow.connect(escrowReleaser).release(tokenAddr, lateWallet.address, escrowAfterVest, refVested);

      // The account ends up with the entire reward, the escrow is drained.
      expect(await token.balanceOf(lateWallet.address)).to.equal(total);
      expect(await token.balanceOf(escrowAddr)).to.equal(0n);
      expect(await escrow.totalReleased(tokenAddr)).to.equal(total);
    });

    it("rejects an unauthorized release attempt", async function () {
      const contributors = [{ walletAddress: escrowAddr, weight: 10000 }];
      await mintToCanary(contributors);
      const escrowLiquid = await token.balanceOf(escrowAddr);

      await expect(
        escrow.connect(outsider).release(tokenAddr, outsider.address, escrowLiquid, ethers.id("reward-steal"))
      ).to.be.reverted;
      // Funds untouched.
      expect(await token.balanceOf(escrowAddr)).to.equal(escrowLiquid);
      expect(await token.balanceOf(outsider.address)).to.equal(0n);
    });
  });
});
