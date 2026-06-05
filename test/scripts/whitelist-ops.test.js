const { expect } = require("chai");
const fs = require("fs");
const os = require("os");
const path = require("path");
const hre = require("hardhat");

const {
  chunkAddresses,
  loadWhitelistAddress,
  loadWhitelistContract,
  parseAddressesFromArgv,
  runAdd,
  runCheck,
  runRemove,
} = require("../../scripts/lib/whitelist-ops");

describe("whitelist ops", function () {
  let owner;
  let other;
  let whitelist;

  beforeEach(async function () {
    [owner, other] = await hre.ethers.getSigners();
    const PurchaserWhitelist = await hre.ethers.getContractFactory("PurchaserWhitelist");
    whitelist = await PurchaserWhitelist.deploy(owner.address);
    await whitelist.waitForDeployment();
  });

  it("loads whitelist address from deployment artifact", function () {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "whitelist-artifact-"));
    fs.writeFileSync(path.join(tempDir, "sepolia-latest.json"), JSON.stringify({
      contracts: { PurchaserWhitelist: whitelist.target },
    }, null, 2));

    expect(loadWhitelistAddress({ network: "sepolia", deploymentsDir: tempDir })).to.equal(whitelist.target);
  });

  it("prefers whitelist override env var", function () {
    process.env.WHITELIST_ADDRESS_OVERRIDE = other.address;
    try {
      expect(loadWhitelistAddress({ network: "sepolia" })).to.equal(other.address);
    } finally {
      delete process.env.WHITELIST_ADDRESS_OVERRIDE;
    }
  });

  it("parses argv addresses and file inputs", function () {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "whitelist-file-"));
    const filepath = path.join(tempDir, "wallets.txt");
    fs.writeFileSync(filepath, `${owner.address}\n${other.address}\n`);

    expect(parseAddressesFromArgv([owner.address, other.address])).to.deep.equal([owner.address, other.address]);
    expect(parseAddressesFromArgv(["--file", filepath])).to.deep.equal([owner.address, other.address]);
  });

  it("rejects invalid addresses", function () {
    expect(() => parseAddressesFromArgv(["not-an-address"])).to.throw("Invalid address: not-an-address");
  });

  it("chunks addresses above MAX_BATCH", function () {
    const addresses = Array.from({ length: 401 }, () => hre.ethers.Wallet.createRandom().address);
    const chunks = chunkAddresses(addresses, 200);
    expect(chunks).to.have.lengthOf(3);
    expect(chunks[0]).to.have.lengthOf(200);
    expect(chunks[1]).to.have.lengthOf(200);
    expect(chunks[2]).to.have.lengthOf(1);
  });

  it("adds, checks, and removes addresses end to end", async function () {
    const contract = await loadWhitelistContract(whitelist.target, owner);
    const added = await runAdd({ whitelist: contract, addresses: [other.address], logger: { log() {} } });
    expect(added.added).to.deep.equal([other.address]);
    expect(added.results[0].whitelisted).to.equal(true);

    const checked = await runCheck({ whitelist: contract, addresses: [other.address] });
    expect(checked.results[0]).to.deep.equal({ address: other.address, whitelisted: true });

    const removed = await runRemove({ whitelist: contract, addresses: [other.address], logger: { log() {} } });
    expect(removed.removed).to.deep.equal([other.address]);
    expect(removed.results[0].whitelisted).to.equal(false);
  });
});
