const { expect } = require("chai");

describe("DeployableTokenManager size guard", function () {
  it("deployed bytecode stays under the EIP-170 limit (24,576 bytes)", function () {
    const artifact = require("../artifacts/contracts/DeployableTokenManager.sol/DeployableTokenManager.json");
    const bytes = (artifact.deployedBytecode.length - 2) / 2;
    expect(bytes).to.be.at.most(
      24576,
      `DeployableTokenManager deployed bytecode is ${bytes} bytes, exceeds EIP-170 limit`
    );
  });
});
