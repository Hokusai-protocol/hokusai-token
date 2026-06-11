const { expect } = require("chai");

const {
  EXPECTED_ADDRESSES,
  assertExpectedAddress,
  buildUpdatedDeploymentArtifact,
  parseArgs,
  parseConfirmations,
  parseInteger,
  requireChecksummedAddress,
} = require("../../scripts/lib/sepolia-fee-ops");

describe("sepolia fee ops helpers", function () {
  it("parses long-form argv pairs and boolean flags", function () {
    expect(
      parseArgs(["--wallet", "0xabc", "--confirmations", "3", "--json"]),
    ).to.deep.equal({
      wallet: "0xabc",
      confirmations: "3",
      json: true,
    });
  });

  it("requires checksum-cased settlement wallet addresses", function () {
    const address = "0x3018Cf81729c932Bc3E733A264e5F4a0A08deD5B";
    expect(requireChecksummedAddress(address, "wallet")).to.equal(address);
    expect(() => requireChecksummedAddress(address.toLowerCase(), "wallet")).to.throw(
      "wallet must use checksum casing",
    );
  });

  it("validates confirmation counts and integer values", function () {
    expect(parseConfirmations(undefined)).to.equal(1);
    expect(parseConfirmations("2")).to.equal(2);
    expect(() => parseConfirmations("0")).to.throw("confirmations must be an integer >= 1");

    expect(parseInteger("1000000", "amount")).to.equal(1000000n);
    expect(() => parseInteger("1.5", "amount")).to.throw(
      "amount must be a non-negative integer.",
    );
  });

  it("updates the deployment artifact with backend service and grant tx metadata", function () {
    const settlementWallet = "0x1234567890AbcdEF1234567890aBcdef12345678";
    const artifact = buildUpdatedDeploymentArtifact(
      {
        backendService: null,
        roles: {
          UsageFeeRouter: {
            FEE_DEPOSITOR_ROLE: ["0x3018cf81729c932bc3e733a264e5f4a0a08ded5b"],
          },
        },
      },
      settlementWallet,
      "0xgranttx",
    );

    expect(artifact.backendService).to.equal(settlementWallet);
    expect(artifact.roles.UsageFeeRouter.FEE_DEPOSITOR_ROLE).to.deep.equal([
      "0x3018Cf81729c932Bc3E733A264e5F4a0A08deD5B",
      settlementWallet,
    ]);
    expect(artifact.roles.UsageFeeRouter.feeDepositorGrantTx).to.deep.equal({
      [settlementWallet]: "0xgranttx",
    });
  });

  it("asserts canonical deployment addresses", function () {
    expect(
      assertExpectedAddress(
        EXPECTED_ADDRESSES.UsageFeeRouter.toLowerCase(),
        EXPECTED_ADDRESSES.UsageFeeRouter,
        "router",
      ),
    ).to.equal(EXPECTED_ADDRESSES.UsageFeeRouter);

    expect(() =>
      assertExpectedAddress(
        EXPECTED_ADDRESSES.MockUSDC,
        EXPECTED_ADDRESSES.UsageFeeRouter,
        "router",
      ),
    ).to.throw("router mismatch");
  });
});
