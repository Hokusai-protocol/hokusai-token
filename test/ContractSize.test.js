const { expect } = require("chai");
const hre = require("hardhat");

describe("Contract size regression guard", function () {
  it("keeps HokusaiAMMFactory runtime bytecode below the EVM limit", async function () {
    const artifact = await hre.artifacts.readArtifact("HokusaiAMMFactory");
    const deployedBytecodeBytes = (artifact.deployedBytecode.length - 2) / 2;

    expect(deployedBytecodeBytes).to.be.lessThan(24576);
  });
});
