const { expect } = require("chai");
const fs = require("fs");
const os = require("os");
const path = require("path");
const hre = require("hardhat");

const {
  add,
  addBatch,
  buildSafeTransaction,
  check,
  getWhitelistContract,
  remove,
  resolveWhitelistAddress,
} = require("../../scripts/lib/purchaser-whitelist");

const ORIGINAL_ADMIN_SAFE_ADDRESS = process.env.ADMIN_SAFE_ADDRESS;

function writeDeployment(address) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hok-whitelist-artifact-"));
  const deploymentPath = path.join(tmpDir, "hardhat-latest.json");
  fs.writeFileSync(
    deploymentPath,
    JSON.stringify(
      {
        network: "hardhat",
        chainId: "31337",
        contracts: {
          PurchaserWhitelist: address,
        },
      },
      null,
      2
    )
  );
  return deploymentPath;
}

describe("purchaser whitelist helper", function () {
  let owner;
  let a1;
  let a2;
  let whitelist;
  let deploymentPath;

  beforeEach(async function () {
    [owner, a1, a2] = await hre.ethers.getSigners();
    const PurchaserWhitelist = await hre.ethers.getContractFactory("PurchaserWhitelist");
    whitelist = await PurchaserWhitelist.deploy(owner.address);
    await whitelist.waitForDeployment();
    deploymentPath = writeDeployment(await whitelist.getAddress());
    delete process.env.WHITELIST_ADDRESS;
    delete process.env.ADMIN_SAFE_ADDRESS;
  });

  afterEach(function () {
    delete process.env.WHITELIST_ADDRESS;
    if (ORIGINAL_ADMIN_SAFE_ADDRESS) {
      process.env.ADMIN_SAFE_ADDRESS = ORIGINAL_ADMIN_SAFE_ADDRESS;
    } else {
      delete process.env.ADMIN_SAFE_ADDRESS;
    }
  });

  it("adds, checks, and removes a single wallet", async function () {
    expect(await check(hre, a1.address, { deploymentPath })).to.deep.equal({
      address: a1.address,
      isWhitelisted: false,
    });

    const added = await add(hre, a1.address, { deploymentPath });
    expect(added.txHash).to.match(/^0x[0-9a-fA-F]{64}$/);
    expect(BigInt(added.gasUsed)).to.be.greaterThan(0n);
    expect(await whitelist.isWhitelisted(a1.address)).to.equal(true);

    const removed = await remove(hre, a1.address, { deploymentPath });
    expect(removed.txHash).to.match(/^0x[0-9a-fA-F]{64}$/);
    expect(await whitelist.isWhitelisted(a1.address)).to.equal(false);
  });

  it("chunks large batch additions", async function () {
    const addresses = Array.from({ length: 201 }, () => hre.ethers.Wallet.createRandom().address);
    const result = await addBatch(hre, addresses, { deploymentPath });

    expect(result.count).to.equal(201);
    expect(result.chunks).to.equal(2);
    expect(result.receipts).to.have.lengthOf(2);
    expect(result.receipts[0].size).to.equal(200);
    expect(result.receipts[1].size).to.equal(1);
    expect(await whitelist.isWhitelisted(addresses[0])).to.equal(true);
    expect(await whitelist.isWhitelisted(addresses[200])).to.equal(true);
  });

  it("prefers WHITELIST_ADDRESS override over the artifact", async function () {
    const PurchaserWhitelist = await hre.ethers.getContractFactory("PurchaserWhitelist");
    const overrideWhitelist = await PurchaserWhitelist.deploy(owner.address);
    await overrideWhitelist.waitForDeployment();

    process.env.WHITELIST_ADDRESS = await overrideWhitelist.getAddress();
    const resolved = resolveWhitelistAddress(hre, {
      contracts: { PurchaserWhitelist: await whitelist.getAddress() },
    });
    expect(resolved.address).to.equal(await overrideWhitelist.getAddress());
    expect(resolved.source).to.equal("WHITELIST_ADDRESS");

    const contractInfo = await getWhitelistContract(hre, { deploymentPath });
    expect(contractInfo.address).to.equal(await overrideWhitelist.getAddress());
  });

  it("builds Safe transaction batches for mainnet-style whitelist updates", async function () {
    const addresses = Array.from({ length: 201 }, () => hre.ethers.Wallet.createRandom().address);
    const whitelistAddress = await whitelist.getAddress();
    const safeTx = buildSafeTransaction({
      runtime: hre,
      deployment: {
        chainId: "1",
        governance: { adminSafe: owner.address },
      },
      whitelistAddress,
      method: "addBatch",
      addresses,
    });
    const iface = new hre.ethers.Interface(["function addBatch(address[] accounts)"]);

    expect(safeTx.chainId).to.equal("1");
    expect(safeTx.safe).to.equal(owner.address);
    expect(safeTx.transactions).to.have.lengthOf(2);
    expect(safeTx.transactions[0].to).to.equal(whitelistAddress);
    expect(safeTx.transactions[0].value).to.equal("0");

    const decodedFirst = iface.decodeFunctionData("addBatch", safeTx.transactions[0].data);
    const decodedSecond = iface.decodeFunctionData("addBatch", safeTx.transactions[1].data);
    expect(decodedFirst.accounts).to.have.lengthOf(200);
    expect(decodedSecond.accounts).to.deep.equal([addresses[200]]);
  });
});
