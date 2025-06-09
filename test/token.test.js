const { expect } = require("chai");

describe("HokusaiToken", function () {
  it("mints and burns with controller", async function () {
    const [owner, controller, user] = await ethers.getSigners();
    const Token = await ethers.getContractFactory("HokusaiToken");
    const token = await Token.deploy("Hokusai Token", "HOK");
    await token.deployed();

    await token.setController(controller.address);

    const tokenFromController = token.connect(controller);
    await tokenFromController.mint(user.address, 1000);
    expect(await token.balanceOf(user.address)).to.equal(1000);
  });
});
