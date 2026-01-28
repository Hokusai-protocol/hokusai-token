const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("AccessControlBase", function () {
    let AccessControlTest;
    let accessControl;
    let owner;
    let addr1;
    let addr2;
    let addr3;
    let MINTER_ROLE;
    let BURNER_ROLE;
    let PAUSER_ROLE;

    before(async function () {
        MINTER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("MINTER_ROLE"));
        BURNER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("BURNER_ROLE"));
        PAUSER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("PAUSER_ROLE"));
    });

    beforeEach(async function () {
        [owner, addr1, addr2, addr3] = await ethers.getSigners();

        // Deploy test harness contract that inherits AccessControlBase
        const AccessControlTestFactory = await ethers.getContractFactory("AccessControlBaseTestHarness");
        AccessControlTest = await AccessControlTestFactory.deploy(owner.address);
        await AccessControlTest.waitForDeployment();
        accessControl = AccessControlTest;
    });

    describe("Constructor", function () {
        it("should grant DEFAULT_ADMIN_ROLE to constructor parameter", async function () {
            const DEFAULT_ADMIN_ROLE = await accessControl.DEFAULT_ADMIN_ROLE();
            expect(await accessControl.hasRole(DEFAULT_ADMIN_ROLE, owner.address)).to.be.true;
        });

        it("should revert if admin is address(0)", async function () {
            const AccessControlTestFactory = await ethers.getContractFactory("AccessControlBaseTestHarness");
            await expect(
                AccessControlTestFactory.deploy(ethers.ZeroAddress)
            ).to.be.revertedWith("AccessControlBase: admin cannot be zero");
        });

        it("should only grant DEFAULT_ADMIN_ROLE, not other roles", async function () {
            expect(await accessControl.hasRole(MINTER_ROLE, owner.address)).to.be.false;
            expect(await accessControl.hasRole(BURNER_ROLE, owner.address)).to.be.false;
        });
    });

    describe("_grantRoles (batch grant to single account)", function () {
        it("should grant multiple roles to a single account", async function () {
            await accessControl.testGrantRoles([MINTER_ROLE, BURNER_ROLE], addr1.address);

            expect(await accessControl.hasRole(MINTER_ROLE, addr1.address)).to.be.true;
            expect(await accessControl.hasRole(BURNER_ROLE, addr1.address)).to.be.true;
        });

        it("should handle empty array gracefully", async function () {
            await expect(
                accessControl.testGrantRoles([], addr1.address)
            ).to.not.be.reverted;
        });

        it("should work with single role in array", async function () {
            await accessControl.testGrantRoles([MINTER_ROLE], addr1.address);
            expect(await accessControl.hasRole(MINTER_ROLE, addr1.address)).to.be.true;
        });

        it("should emit RoleGranted events from AccessControl", async function () {
            const DEFAULT_ADMIN_ROLE = await accessControl.DEFAULT_ADMIN_ROLE();

            await expect(accessControl.testGrantRoles([MINTER_ROLE], addr1.address))
                .to.emit(accessControl, "RoleGranted")
                .withArgs(MINTER_ROLE, addr1.address, owner.address);
        });
    });

    describe("_revokeRoles (batch revoke from single account)", function () {
        beforeEach(async function () {
            // Grant roles first
            await accessControl.testGrantRoles([MINTER_ROLE, BURNER_ROLE, PAUSER_ROLE], addr1.address);
        });

        it("should revoke multiple roles from a single account", async function () {
            await accessControl.testRevokeRoles([MINTER_ROLE, BURNER_ROLE], addr1.address);

            expect(await accessControl.hasRole(MINTER_ROLE, addr1.address)).to.be.false;
            expect(await accessControl.hasRole(BURNER_ROLE, addr1.address)).to.be.false;
            expect(await accessControl.hasRole(PAUSER_ROLE, addr1.address)).to.be.true; // Not revoked
        });

        it("should handle empty array gracefully", async function () {
            await expect(
                accessControl.testRevokeRoles([], addr1.address)
            ).to.not.be.reverted;
        });

        it("should emit RoleRevoked events from AccessControl", async function () {
            await expect(accessControl.testRevokeRoles([MINTER_ROLE], addr1.address))
                .to.emit(accessControl, "RoleRevoked")
                .withArgs(MINTER_ROLE, addr1.address, owner.address);
        });
    });

    describe("_grantRoleToMany (grant single role to multiple accounts)", function () {
        it("should grant role to multiple accounts", async function () {
            await accessControl.testGrantRoleToMany(
                MINTER_ROLE,
                [addr1.address, addr2.address, addr3.address]
            );

            expect(await accessControl.hasRole(MINTER_ROLE, addr1.address)).to.be.true;
            expect(await accessControl.hasRole(MINTER_ROLE, addr2.address)).to.be.true;
            expect(await accessControl.hasRole(MINTER_ROLE, addr3.address)).to.be.true;
        });

        it("should handle empty array gracefully", async function () {
            await expect(
                accessControl.testGrantRoleToMany(MINTER_ROLE, [])
            ).to.not.be.reverted;
        });

        it("should work with single account in array", async function () {
            await accessControl.testGrantRoleToMany(MINTER_ROLE, [addr1.address]);
            expect(await accessControl.hasRole(MINTER_ROLE, addr1.address)).to.be.true;
        });
    });

    describe("_revokeRoleFromMany (revoke single role from multiple accounts)", function () {
        beforeEach(async function () {
            // Grant role to multiple accounts first
            await accessControl.testGrantRoleToMany(
                MINTER_ROLE,
                [addr1.address, addr2.address, addr3.address]
            );
        });

        it("should revoke role from multiple accounts", async function () {
            await accessControl.testRevokeRoleFromMany(
                MINTER_ROLE,
                [addr1.address, addr2.address]
            );

            expect(await accessControl.hasRole(MINTER_ROLE, addr1.address)).to.be.false;
            expect(await accessControl.hasRole(MINTER_ROLE, addr2.address)).to.be.false;
            expect(await accessControl.hasRole(MINTER_ROLE, addr3.address)).to.be.true; // Not revoked
        });

        it("should handle empty array gracefully", async function () {
            await expect(
                accessControl.testRevokeRoleFromMany(MINTER_ROLE, [])
            ).to.not.be.reverted;
        });
    });

    describe("Integration with OpenZeppelin AccessControl", function () {
        it("should inherit all AccessControl functionality", async function () {
            const DEFAULT_ADMIN_ROLE = await accessControl.DEFAULT_ADMIN_ROLE();

            // Test standard AccessControl functions
            await accessControl.grantRole(MINTER_ROLE, addr1.address);
            expect(await accessControl.hasRole(MINTER_ROLE, addr1.address)).to.be.true;

            await accessControl.revokeRole(MINTER_ROLE, addr1.address);
            expect(await accessControl.hasRole(MINTER_ROLE, addr1.address)).to.be.false;

            expect(await accessControl.getRoleAdmin(MINTER_ROLE)).to.equal(DEFAULT_ADMIN_ROLE);
        });

        it("should allow admin to grant roles", async function () {
            await accessControl.grantRole(MINTER_ROLE, addr1.address);
            expect(await accessControl.hasRole(MINTER_ROLE, addr1.address)).to.be.true;
        });

        it("should prevent non-admin from granting roles", async function () {
            await expect(
                accessControl.connect(addr1).grantRole(MINTER_ROLE, addr2.address)
            ).to.be.reverted; // AccessControl reverts with specific message
        });
    });

    describe("Real-world usage pattern", function () {
        it("should replicate TokenManager initialization pattern", async function () {
            // Simulate TokenManager constructor behavior
            const roles = [MINTER_ROLE, BURNER_ROLE];
            await accessControl.testGrantRoles(roles, owner.address);

            expect(await accessControl.hasRole(MINTER_ROLE, owner.address)).to.be.true;
            expect(await accessControl.hasRole(BURNER_ROLE, owner.address)).to.be.true;

            const DEFAULT_ADMIN_ROLE = await accessControl.DEFAULT_ADMIN_ROLE();
            expect(await accessControl.hasRole(DEFAULT_ADMIN_ROLE, owner.address)).to.be.true;
        });

        it("should replicate multi-AMM authorization pattern", async function () {
            // Simulate granting MINTER_ROLE to multiple AMM pools
            const ammPools = [addr1.address, addr2.address, addr3.address];
            await accessControl.testGrantRoleToMany(MINTER_ROLE, ammPools);

            for (const pool of ammPools) {
                expect(await accessControl.hasRole(MINTER_ROLE, pool)).to.be.true;
            }
        });
    });
});
