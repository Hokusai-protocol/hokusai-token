const { expect } = require("chai");
const { ethers } = require("hardhat");
const { parseEther } = require("ethers");
const {
    deployTestToken,
    deployTestTokenAddress,
} = require("./helpers/tokenDeployment");

describe("Phase 4: Factory Emergency Pause", function () {
    let modelRegistry;
    let tokenManager;
    let factory;
    let mockUSDC;
    let owner;
    let treasury;
    let pauser;
    let attacker;
    let newOwner;

    async function deployFactoryFixture() {
        [owner, treasury, pauser, attacker, newOwner] = await ethers.getSigners();

        const ModelRegistry = await ethers.getContractFactory("ModelRegistry");
        modelRegistry = await ModelRegistry.deploy();
        await modelRegistry.waitForDeployment();

        const TokenManager = await ethers.getContractFactory("TokenManager");
        tokenManager = await TokenManager.deploy(await modelRegistry.getAddress());
        await tokenManager.waitForDeployment();
        await modelRegistry.setStringModelTokenManager(await tokenManager.getAddress());

        const MockUSDC = await ethers.getContractFactory("MockUSDC");
        mockUSDC = await MockUSDC.deploy();
        await mockUSDC.waitForDeployment();

        const HokusaiAMMFactory = await ethers.getContractFactory("HokusaiAMMFactory");
        factory = await HokusaiAMMFactory.deploy(
            await modelRegistry.getAddress(),
            await tokenManager.getAddress(),
            await mockUSDC.getAddress(),
            treasury.address
        );
        await factory.waitForDeployment();
    }

    async function createPool(modelId) {
        const tokenAddress = await deployTestTokenAddress(
            tokenManager,
            modelId,
            `${modelId} Token`,
            modelId.slice(0, 5).toUpperCase(),
            parseEther("1"),
            owner.address
        );
        await deployTestToken(
            tokenManager,
            modelId,
            `${modelId} Token`,
            modelId.slice(0, 5).toUpperCase(),
            parseEther("1"),
            owner.address
        );
        await modelRegistry.registerStringModel(modelId, tokenAddress, "Test metric");
        await factory.createPool(modelId, tokenAddress);
        return ethers.getContractAt("HokusaiAMM", await factory.getPool(modelId));
    }

    async function createPools(modelIds) {
        const pools = {};

        for (const modelId of modelIds) {
            pools[modelId] = await createPool(modelId);
        }

        return pools;
    }

    function getEventArgs(receipt, eventName) {
        return receipt.logs
            .filter(log => log.fragment && log.fragment.name === eventName)
            .map(log => log.args);
    }

    beforeEach(async function () {
        await deployFactoryFixture();
    });

    describe("setPauser", function () {
        it("updates the pauser and emits the change", async function () {
            await expect(factory.setPauser(pauser.address))
                .to.emit(factory, "PauserUpdated")
                .withArgs(ethers.ZeroAddress, pauser.address);

            expect(await factory.pauser()).to.equal(pauser.address);
        });

        it("only allows the owner to set the pauser", async function () {
            await expect(
                factory.connect(attacker).setPauser(pauser.address)
            ).to.be.revertedWith("Ownable: caller is not the owner");
        });

        it("allows revoking the pauser by setting zero address", async function () {
            const pool = await createPool("model-alpha");
            await factory.setPauser(pauser.address);
            await factory.connect(pauser).pausePool("model-alpha");

            await expect(factory.setPauser(ethers.ZeroAddress))
                .to.emit(factory, "PauserUpdated")
                .withArgs(pauser.address, ethers.ZeroAddress);

            await factory.unpausePool("model-alpha");
            await expect(
                factory.connect(pauser).pausePool("model-alpha")
            ).to.be.revertedWith("Not owner or pauser");
        });
    });

    describe("pausePool", function () {
        it("pauses a pool and emits the pause event", async function () {
            const pool = await createPool("model-alpha");

            await expect(factory.pausePool("model-alpha"))
                .to.emit(factory, "PoolPaused")
                .withArgs("model-alpha", await pool.getAddress(), owner.address);

            expect(await pool.paused()).to.be.true;
        });

        it("allows the pauser role to pause", async function () {
            const pool = await createPool("model-alpha");
            await factory.setPauser(pauser.address);

            await expect(factory.connect(pauser).pausePool("model-alpha"))
                .to.emit(factory, "PoolPaused")
                .withArgs("model-alpha", await pool.getAddress(), pauser.address);

            expect(await pool.paused()).to.be.true;
        });

        it("rejects unknown pools", async function () {
            await expect(
                factory.pausePool("unknown-model")
            ).to.be.revertedWith("Pool not found");
        });

        it("bubbles the pool revert on double pause", async function () {
            await createPool("model-alpha");
            await factory.pausePool("model-alpha");

            await expect(
                factory.pausePool("model-alpha")
            ).to.be.revertedWith("Pausable: paused");
        });

        it("rejects callers that are neither owner nor pauser", async function () {
            await createPool("model-alpha");

            await expect(
                factory.connect(attacker).pausePool("model-alpha")
            ).to.be.revertedWith("Not owner or pauser");
        });
    });

    describe("unpausePool", function () {
        it("unpauses a pool and emits the unpause event", async function () {
            const pool = await createPool("model-alpha");
            await factory.pausePool("model-alpha");

            await expect(factory.unpausePool("model-alpha"))
                .to.emit(factory, "PoolUnpaused")
                .withArgs("model-alpha", await pool.getAddress(), owner.address);

            expect(await pool.paused()).to.be.false;
        });

        it("rejects unknown pools", async function () {
            await expect(
                factory.unpausePool("unknown-model")
            ).to.be.revertedWith("Pool not found");
        });

        it("bubbles the pool revert on unpause when already active", async function () {
            await createPool("model-alpha");

            await expect(
                factory.unpausePool("model-alpha")
            ).to.be.revertedWith("Pausable: not paused");
        });

        it("does not allow the pauser role to unpause", async function () {
            await createPool("model-alpha");
            await factory.setPauser(pauser.address);
            await factory.pausePool("model-alpha");

            await expect(
                factory.connect(pauser).unpausePool("model-alpha")
            ).to.be.revertedWith("Ownable: caller is not the owner");
        });

        it("rejects non-owner callers", async function () {
            await createPool("model-alpha");
            await factory.pausePool("model-alpha");

            await expect(
                factory.connect(attacker).unpausePool("model-alpha")
            ).to.be.revertedWith("Ownable: caller is not the owner");
        });
    });

    describe("pausePools", function () {
        it("pauses each pool in the list and emits one event per newly paused pool", async function () {
            const pools = await createPools(["m1", "m2", "m3"]);

            const receipt = await (await factory.pausePools(["m1", "m2", "m3"])).wait();
            const events = getEventArgs(receipt, "PoolPaused");

            expect(events).to.have.length(3);
            expect(events.map(event => event.modelId)).to.deep.equal(["m1", "m2", "m3"]);
            expect(events.map(event => event.pool)).to.deep.equal([
                await pools.m1.getAddress(),
                await pools.m2.getAddress(),
                await pools.m3.getAddress(),
            ]);
            expect(await pools.m1.paused()).to.be.true;
            expect(await pools.m2.paused()).to.be.true;
            expect(await pools.m3.paused()).to.be.true;
        });

        it("skips pools that are already paused", async function () {
            const pools = await createPools(["m1", "m2", "m3"]);
            await factory.pausePool("m2");

            const receipt = await (await factory.pausePools(["m1", "m2", "m3"])).wait();
            const events = getEventArgs(receipt, "PoolPaused");

            expect(events).to.have.length(2);
            expect(events.map(event => event.modelId)).to.deep.equal(["m1", "m3"]);
            expect(await pools.m2.paused()).to.be.true;
        });

        it("reverts atomically when any model is unknown", async function () {
            const pools = await createPools(["m1", "m2"]);

            await expect(
                factory.pausePools(["m1", "missing", "m2"])
            ).to.be.revertedWith("Pool not found");

            expect(await pools.m1.paused()).to.be.false;
            expect(await pools.m2.paused()).to.be.false;
        });

        it("rejects oversized batches", async function () {
            await createPool("m1");
            await expect(
                factory.pausePools(Array(51).fill("m1"))
            ).to.be.revertedWithCustomError(factory, "ArrayTooLarge");
        });

        it("rejects empty batches", async function () {
            await expect(
                factory.pausePools([])
            ).to.be.revertedWithCustomError(factory, "ArrayEmpty");
        });

        it("allows the pauser role to pause a batch", async function () {
            const pools = await createPools(["m1", "m2"]);
            await factory.setPauser(pauser.address);

            await factory.connect(pauser).pausePools(["m1", "m2"]);

            expect(await pools.m1.paused()).to.be.true;
            expect(await pools.m2.paused()).to.be.true;
        });

        it("rejects non-owner non-pauser callers", async function () {
            await createPools(["m1", "m2"]);

            await expect(
                factory.connect(attacker).pausePools(["m1", "m2"])
            ).to.be.revertedWith("Not owner or pauser");
        });
    });

    describe("unpausePools", function () {
        it("unpauses each paused pool in the list and emits one event per newly unpaused pool", async function () {
            const pools = await createPools(["m1", "m2", "m3"]);
            await factory.pausePools(["m1", "m2", "m3"]);

            const receipt = await (await factory.unpausePools(["m1", "m2", "m3"])).wait();
            const events = getEventArgs(receipt, "PoolUnpaused");

            expect(events).to.have.length(3);
            expect(events.map(event => event.modelId)).to.deep.equal(["m1", "m2", "m3"]);
            expect(await pools.m1.paused()).to.be.false;
            expect(await pools.m2.paused()).to.be.false;
            expect(await pools.m3.paused()).to.be.false;
        });

        it("skips pools that are already active", async function () {
            const pools = await createPools(["m1", "m2", "m3"]);
            await factory.pausePools(["m1", "m2"]);

            const receipt = await (await factory.unpausePools(["m1", "m2", "m3"])).wait();
            const events = getEventArgs(receipt, "PoolUnpaused");

            expect(events).to.have.length(2);
            expect(events.map(event => event.modelId)).to.deep.equal(["m1", "m2"]);
            expect(await pools.m3.paused()).to.be.false;
        });

        it("reverts atomically when any model is unknown", async function () {
            const pools = await createPools(["m1", "m2"]);
            await factory.pausePools(["m1", "m2"]);

            await expect(
                factory.unpausePools(["m1", "missing", "m2"])
            ).to.be.revertedWith("Pool not found");

            expect(await pools.m1.paused()).to.be.true;
            expect(await pools.m2.paused()).to.be.true;
        });

        it("rejects oversized batches", async function () {
            await createPool("m1");
            await expect(
                factory.unpausePools(Array(51).fill("m1"))
            ).to.be.revertedWithCustomError(factory, "ArrayTooLarge");
        });

        it("rejects empty batches", async function () {
            await expect(
                factory.unpausePools([])
            ).to.be.revertedWithCustomError(factory, "ArrayEmpty");
        });

        it("does not allow the pauser role to unpause a batch", async function () {
            await createPools(["m1", "m2"]);
            await factory.setPauser(pauser.address);
            await factory.pausePools(["m1", "m2"]);

            await expect(
                factory.connect(pauser).unpausePools(["m1", "m2"])
            ).to.be.revertedWith("Ownable: caller is not the owner");
        });
    });

    describe("pauseAllPools", function () {
        it("pauses pools across paginated calls", async function () {
            const pools = await createPools(["m1", "m2", "m3", "m4", "m5"]);

            const firstReceipt = await (await factory.pauseAllPools(0, 3)).wait();
            const secondReceipt = await (await factory.pauseAllPools(3, 3)).wait();

            expect(getEventArgs(firstReceipt, "PoolPaused")).to.have.length(3);
            expect(getEventArgs(secondReceipt, "PoolPaused")).to.have.length(2);
            expect(await pools.m1.paused()).to.be.true;
            expect(await pools.m2.paused()).to.be.true;
            expect(await pools.m3.paused()).to.be.true;
            expect(await pools.m4.paused()).to.be.true;
            expect(await pools.m5.paused()).to.be.true;
        });

        it("returns without reverting when start is past the end", async function () {
            await createPools(["m1", "m2", "m3", "m4", "m5"]);

            const receipt = await (await factory.pauseAllPools(10, 3)).wait();
            expect(getEventArgs(receipt, "PoolPaused")).to.have.length(0);
        });

        it("skips pools that are already paused within the page", async function () {
            await createPools(["m1", "m2", "m3"]);
            await factory.pausePool("m2");

            const receipt = await (await factory.pauseAllPools(0, 3)).wait();
            const events = getEventArgs(receipt, "PoolPaused");

            expect(events).to.have.length(2);
            expect(events.map(event => event.modelId)).to.deep.equal(["m1", "m3"]);
        });

        it("rejects limits above the batch maximum", async function () {
            await expect(
                factory.pauseAllPools(0, 51)
            ).to.be.revertedWith("Limit exceeds max batch");
        });

        it("allows the pauser role to pause a page", async function () {
            const pools = await createPools(["m1", "m2"]);
            await factory.setPauser(pauser.address);

            await factory.connect(pauser).pauseAllPools(0, 2);

            expect(await pools.m1.paused()).to.be.true;
            expect(await pools.m2.paused()).to.be.true;
        });

        it("rejects non-owner non-pauser callers", async function () {
            await createPools(["m1", "m2"]);

            await expect(
                factory.connect(attacker).pauseAllPools(0, 2)
            ).to.be.revertedWith("Not owner or pauser");
        });
    });

    describe("access control and ownership transfer", function () {
        it("keeps pool states unchanged for unauthorized callers across all new entrypoints", async function () {
            const pools = await createPools(["m1", "m2"]);
            await factory.setPauser(pauser.address);

            await expect(
                factory.connect(attacker).pausePool("m1")
            ).to.be.revertedWith("Not owner or pauser");
            await expect(
                factory.connect(attacker).pausePools(["m1", "m2"])
            ).to.be.revertedWith("Not owner or pauser");
            await expect(
                factory.connect(attacker).pauseAllPools(0, 2)
            ).to.be.revertedWith("Not owner or pauser");
            await expect(
                factory.connect(attacker).unpausePool("m1")
            ).to.be.revertedWith("Ownable: caller is not the owner");
            await expect(
                factory.connect(attacker).unpausePools(["m1", "m2"])
            ).to.be.revertedWith("Ownable: caller is not the owner");
            await expect(
                factory.connect(attacker).setPauser(attacker.address)
            ).to.be.revertedWith("Ownable: caller is not the owner");

            expect(await pools.m1.paused()).to.be.false;
            expect(await pools.m2.paused()).to.be.false;
            expect(await factory.pauser()).to.equal(pauser.address);
        });

        it("moves owner-only permissions to the new owner after ownership transfer", async function () {
            const pool = await createPool("model-alpha");
            await factory.transferOwnership(newOwner.address);

            await expect(
                factory.setPauser(pauser.address)
            ).to.be.revertedWith("Ownable: caller is not the owner");

            await factory.connect(newOwner).setPauser(pauser.address);
            await factory.connect(pauser).pausePool("model-alpha");

            await expect(
                factory.unpausePool("model-alpha")
            ).to.be.revertedWith("Ownable: caller is not the owner");

            await factory.connect(newOwner).unpausePool("model-alpha");
            expect(await pool.paused()).to.be.false;
        });
    });
});
