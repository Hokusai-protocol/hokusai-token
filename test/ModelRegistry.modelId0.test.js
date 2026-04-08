const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("ModelRegistry - Model ID 0 Fix", function () {
    let modelRegistry;
    let params;
    let owner;
    let token0, token1, token2;
    let token0Addr, token1Addr, token2Addr;

    beforeEach(async function () {
        [owner] = await ethers.getSigners();

        // Deploy ModelRegistry
        const ModelRegistry = await ethers.getContractFactory("ModelRegistry");
        modelRegistry = await ModelRegistry.deploy();
        await modelRegistry.waitForDeployment();

        // Deploy HokusaiParams for tokens
        const HokusaiParams = await ethers.getContractFactory("HokusaiParams");
        params = await HokusaiParams.deploy(
            1000, // tokensPerDeltaOne
            8000, // infrastructureAccrualBps
            ethers.keccak256(ethers.toUtf8Bytes("test-license")),
            "https://test.license",
            owner.address
        );
        await params.waitForDeployment();

        // Deploy mock ERC20 tokens
        const MockToken = await ethers.getContractFactory("HokusaiToken");
        token0 = await MockToken.deploy(
            "Token0",
            "TK0",
            await modelRegistry.getAddress(),
            await params.getAddress(),
            1, // initialSupply
            0, // maxSupply
            0, // modelSupplierAllocation
            ethers.ZeroAddress // modelSupplierRecipient
        );
        await token0.waitForDeployment();
        token0Addr = await token0.getAddress();

        token1 = await MockToken.deploy(
            "Token1",
            "TK1",
            await modelRegistry.getAddress(),
            await params.getAddress(),
            1,
            0,
            0,
            ethers.ZeroAddress
        );
        await token1.waitForDeployment();
        token1Addr = await token1.getAddress();

        token2 = await MockToken.deploy(
            "Token2",
            "TK2",
            await modelRegistry.getAddress(),
            await params.getAddress(),
            1,
            0,
            0,
            ethers.ZeroAddress
        );
        await token2.waitForDeployment();
        token2Addr = await token2.getAddress();
    });

    describe("Model ID 0 Registration", function () {
        it("should successfully register model ID 0", async function () {
            await modelRegistry.registerModel(0, token0Addr, "accuracy");

            expect(await modelRegistry.isRegistered(0)).to.be.true;
            expect(await modelRegistry.getTokenAddress(0)).to.equal(token0Addr);
        });

        it("should allow reverse lookup for model ID 0", async function () {
            await modelRegistry.registerModel(0, token0Addr, "accuracy");

            const modelId = await modelRegistry.getModelId(token0Addr);
            expect(modelId).to.equal(0);
        });

        it("should prevent duplicate token registration with model ID 0", async function () {
            await modelRegistry.registerModel(0, token0Addr, "accuracy");

            // Attempting to register the same token to a different model should fail
            await expect(
                modelRegistry.registerModel(1, token0Addr, "f1-score")
            ).to.be.revertedWith("Token already registered");
        });

        it("should prevent re-registration of model ID 0", async function () {
            await modelRegistry.registerModel(0, token0Addr, "accuracy");

            // Attempting to register model 0 again should fail
            await expect(
                modelRegistry.registerModel(0, token1Addr, "accuracy")
            ).to.be.revertedWith("Model already registered");
        });

        it("should handle token updates for model ID 0", async function () {
            await modelRegistry.registerModel(0, token0Addr, "accuracy");

            // Update model 0 to use token1
            await modelRegistry.updateModel(0, token1Addr);

            // Verify forward lookup
            expect(await modelRegistry.getTokenAddress(0)).to.equal(token1Addr);

            // Verify reverse lookup for new token
            expect(await modelRegistry.getModelId(token1Addr)).to.equal(0);

            // Verify old token is no longer registered
            await expect(
                modelRegistry.getModelId(token0Addr)
            ).to.be.revertedWith("Token not registered");

            // Verify old token can be reused
            await modelRegistry.registerModel(1, token0Addr, "f1-score");
            expect(await modelRegistry.getModelId(token0Addr)).to.equal(1);
        });

        it("should allow model 0 and model 1 to coexist", async function () {
            await modelRegistry.registerModel(0, token0Addr, "accuracy");
            await modelRegistry.registerModel(1, token1Addr, "f1-score");

            expect(await modelRegistry.getTokenAddress(0)).to.equal(token0Addr);
            expect(await modelRegistry.getTokenAddress(1)).to.equal(token1Addr);

            expect(await modelRegistry.getModelId(token0Addr)).to.equal(0);
            expect(await modelRegistry.getModelId(token1Addr)).to.equal(1);
        });
    });

    describe("isTokenRegistered Mapping", function () {
        it("should correctly track token registration status", async function () {
            expect(await modelRegistry.isTokenRegistered(token0Addr)).to.be.false;

            await modelRegistry.registerModel(0, token0Addr, "accuracy");
            expect(await modelRegistry.isTokenRegistered(token0Addr)).to.be.true;
        });

        it("should clear token registration on update", async function () {
            await modelRegistry.registerModel(0, token0Addr, "accuracy");
            expect(await modelRegistry.isTokenRegistered(token0Addr)).to.be.true;

            await modelRegistry.updateModel(0, token1Addr);
            expect(await modelRegistry.isTokenRegistered(token0Addr)).to.be.false;
            expect(await modelRegistry.isTokenRegistered(token1Addr)).to.be.true;
        });

        it("should enforce token registration check in registerModel", async function () {
            await modelRegistry.registerModel(0, token0Addr, "accuracy");

            await expect(
                modelRegistry.registerModel(1, token0Addr, "f1-score")
            ).to.be.revertedWith("Token already registered");
        });

        it("should enforce token registration check in registerModelAutoId", async function () {
            await modelRegistry.registerModel(0, token0Addr, "accuracy");

            await expect(
                modelRegistry.registerModelAutoId(token0Addr, "f1-score")
            ).to.be.revertedWith("Token already registered");
        });

        it("should enforce token registration check in updateModel", async function () {
            await modelRegistry.registerModel(0, token0Addr, "accuracy");
            await modelRegistry.registerModel(1, token1Addr, "f1-score");

            await expect(
                modelRegistry.updateModel(0, token1Addr)
            ).to.be.revertedWith("Token already registered");
        });
    });

    describe("Auto-increment with Model ID 0 Fix", function () {
        it("should start auto-increment at 1, not conflict with manually registered 0", async function () {
            // Manually register model 0
            await modelRegistry.registerModel(0, token0Addr, "accuracy");

            // Auto-increment should start at 1
            await modelRegistry.registerModelAutoId(token1Addr, "f1-score");

            const modelId = await modelRegistry.getModelId(token1Addr);
            expect(modelId).to.equal(1);

            // Both should be accessible
            expect(await modelRegistry.getTokenAddress(0)).to.equal(token0Addr);
            expect(await modelRegistry.getTokenAddress(1)).to.equal(token1Addr);
        });
    });
});
