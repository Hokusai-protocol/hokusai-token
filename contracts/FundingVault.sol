// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "./libraries/AccessControlBase.sol";
import "./libraries/ValidationLib.sol";
import "./HokusaiAMMFactory.sol";
import "./TokenManager.sol";
import "./ModelRegistry.sol";

/**
 * @title FundingVault
 * @dev Holds USDC commitments from investors backing proposals without live AMM pools
 *
 * This contract implements the "Token at Proposal + Gated Pool Launch" pattern:
 * - HokusaiToken is deployed at proposal creation
 * - AMM pool is only created once the model meets quality criteria
 * - Investors can commit USDC before pool launch
 * - After graduation, investors claim tokens proportionally
 *
 * Key Features:
 * - Accepts USDC deposits for pre-launch proposals
 * - Allows withdrawals before graduation
 * - One-way graduation creates AMM pool
 * - Batch claim pattern for gas efficiency
 * - Access control via GRADUATOR_ROLE
 */
contract FundingVault is AccessControlBase, ReentrancyGuard {
    // ============================================================
    // STATE VARIABLES
    // ============================================================

    IERC20 public immutable usdc;
    HokusaiAMMFactory public immutable ammFactory;
    TokenManager public immutable tokenManager;
    ModelRegistry public immutable modelRegistry;

    bytes32 public constant GRADUATOR_ROLE = keccak256("GRADUATOR_ROLE");

    // Proposal state
    struct Proposal {
        address tokenAddress;
        uint256 deadline;
        uint256 totalCommitted;
        uint256 snapshotTotalCommitted;
        bool graduated;
        bool graduationAnnounced;
        address poolAddress;
        uint256 totalTokens; // Total tokens received from pool during graduation
    }

    // modelId => Proposal
    mapping(string => Proposal) public proposals;

    // modelId => user => commitment amount
    mapping(string => mapping(address => uint256)) public commitments;

    // modelId => user => claimed
    mapping(string => mapping(address => bool)) public claimed;

    // modelId => ordered list of depositors used for graduation snapshotting
    mapping(string => address[]) private depositors;

    // modelId => user => true if user has ever deposited for this proposal
    mapping(string => mapping(address => bool)) private isDepositor;

    // modelId => user => commitment amount frozen at graduation announcement
    mapping(string => mapping(address => uint256)) public snapshottedCommitments;

    // modelId => total number of accounts with non-zero snapshotted commitments
    mapping(string => uint256) public claimableAccounts;

    // modelId => number of successful claims
    mapping(string => uint256) public claimedAccounts;

    function _requireActiveModel(string memory modelId) internal view {
        require(modelRegistry.isStringRegistered(modelId), "Model not registered");
        require(modelRegistry.isStringActive(modelId), "Model is deactivated");
    }

    // ============================================================
    // EVENTS
    // ============================================================

    event ProposalRegistered(
        string indexed modelId,
        address indexed tokenAddress
    );

    event Deposited(
        string indexed modelId,
        address indexed user,
        uint256 amount,
        uint256 newTotal
    );

    event Withdrawn(
        string indexed modelId,
        address indexed user,
        uint256 amount
    );

    event GraduationAnnounced(
        string indexed modelId,
        uint256 totalCommitted,
        uint256 depositorCount
    );

    event Graduated(
        string indexed modelId,
        address indexed poolAddress,
        uint256 totalReserve
    );

    event Claimed(
        string indexed modelId,
        address indexed user,
        uint256 tokenAmount
    );

    event DustSwept(
        string indexed modelId,
        address indexed recipient,
        uint256 amount
    );

    // ============================================================
    // CONSTRUCTOR
    // ============================================================

    /**
     * @dev Initialize FundingVault with core dependencies
     * @param _usdc USDC token address
     * @param _ammFactory HokusaiAMMFactory address
     * @param _tokenManager TokenManager address
     * @param _modelRegistry ModelRegistry address
     * @param _admin Admin address for access control
     */
    constructor(
        address _usdc,
        address _ammFactory,
        address _tokenManager,
        address _modelRegistry,
        address _admin
    ) AccessControlBase(_admin) {
        ValidationLib.requireNonZeroAddress(_usdc, "USDC");
        ValidationLib.requireNonZeroAddress(_ammFactory, "AMM factory");
        ValidationLib.requireNonZeroAddress(_tokenManager, "token manager");
        ValidationLib.requireNonZeroAddress(_modelRegistry, "model registry");

        usdc = IERC20(_usdc);
        ammFactory = HokusaiAMMFactory(_ammFactory);
        tokenManager = TokenManager(_tokenManager);
        modelRegistry = ModelRegistry(_modelRegistry);

        // Grant GRADUATOR_ROLE to admin initially
        _grantRole(GRADUATOR_ROLE, _admin);
    }

    // ============================================================
    // PROPOSAL MANAGEMENT
    // ============================================================

    /**
     * @dev Register a new proposal in the vault
     * @param modelId String model identifier
     * @param tokenAddr HokusaiToken address for this model
     * @param deadline Timestamp after which new deposits are rejected
     *
     * Requirements:
     * - Caller must have DEFAULT_ADMIN_ROLE
     * - Model must be registered in ModelRegistry
     * - Token address must match TokenManager's registered address
     * - Model must not already be registered in vault
     * - Token address must be valid
     */
    function registerProposal(
        string memory modelId,
        address tokenAddr,
        uint256 deadline
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        ValidationLib.requireNonEmptyString(modelId, "model ID");
        ValidationLib.requireNonZeroAddress(tokenAddr, "token address");
        require(proposals[modelId].tokenAddress == address(0), "Proposal already registered");

        // Verify model is registered and active in ModelRegistry
        _requireActiveModel(modelId);

        // Verify token address matches what TokenManager has for this modelId
        require(tokenManager.getTokenAddress(modelId) == tokenAddr, "Token address mismatch");

        proposals[modelId] = Proposal({
            tokenAddress: tokenAddr,
            deadline: deadline,
            totalCommitted: 0,
            snapshotTotalCommitted: 0,
            graduated: false,
            graduationAnnounced: false,
            poolAddress: address(0),
            totalTokens: 0
        });

        emit ProposalRegistered(modelId, tokenAddr);
    }

    // ============================================================
    // INVESTOR OPERATIONS
    // ============================================================

    /**
     * @dev Deposit USDC to commit to a proposal
     * @param modelId String model identifier
     * @param amount USDC amount to deposit (6 decimals)
     *
     * Requirements:
     * - Proposal must be registered
     * - Not graduated
     * - Amount must be positive
     * - User must have approved USDC transfer
     */
    function deposit(string memory modelId, uint256 amount)
        external
        nonReentrant
    {
        ValidationLib.requireNonEmptyString(modelId, "model ID");
        ValidationLib.requirePositiveAmount(amount, "deposit amount");

        Proposal storage proposal = proposals[modelId];
        require(proposal.tokenAddress != address(0), "Proposal not registered");
        require(!proposal.graduated, "Already graduated");
        require(!proposal.graduationAnnounced, "Graduation announced");
        require(block.timestamp <= proposal.deadline, "Deadline passed");
        require(modelRegistry.isStringActive(modelId), "Model is deactivated");

        // Transfer USDC from caller to vault
        require(
            usdc.transferFrom(msg.sender, address(this), amount),
            "USDC transfer failed"
        );

        // Update state
        if (!isDepositor[modelId][msg.sender]) {
            isDepositor[modelId][msg.sender] = true;
            depositors[modelId].push(msg.sender);
        }
        commitments[modelId][msg.sender] += amount;
        proposal.totalCommitted += amount;

        emit Deposited(modelId, msg.sender, amount, proposal.totalCommitted);
    }

    /**
     * @dev Withdraw USDC commitment before graduation
     * @param modelId String model identifier
     *
     * Requirements:
     * - Proposal must be registered
     * - Not graduated
     * - User has non-zero commitment
     */
    function withdraw(string memory modelId) external nonReentrant {
        ValidationLib.requireNonEmptyString(modelId, "model ID");

        Proposal storage proposal = proposals[modelId];
        require(proposal.tokenAddress != address(0), "Proposal not registered");
        require(!proposal.graduated, "Already graduated");
        require(!proposal.graduationAnnounced, "Graduation announced");

        uint256 userCommitment = commitments[modelId][msg.sender];
        ValidationLib.requirePositiveAmount(userCommitment, "commitment");

        // Zero out commitment before transfer (CEI pattern)
        commitments[modelId][msg.sender] = 0;
        proposal.totalCommitted -= userCommitment;

        // Transfer USDC back to user
        require(
            usdc.transfer(msg.sender, userCommitment),
            "USDC transfer failed"
        );

        emit Withdrawn(modelId, msg.sender, userCommitment);
    }

    // ============================================================
    // GRADUATION
    // ============================================================

    /**
     * @dev Announce graduation and freeze commitments for token distribution
     * @param modelId String model identifier
     *
     * This function:
     * 1. Freezes new deposits and withdrawals
     * 2. Snapshots each depositor's commitment
     * 3. Stores the total committed amount used for graduation claims
     *
     * Requirements:
     * - Caller must have GRADUATOR_ROLE
     * - Proposal must be registered
     * - Not already announced or graduated
     * - Has committed funds
     */
    function announceGraduation(string memory modelId)
        external
        onlyRole(GRADUATOR_ROLE)
    {
        ValidationLib.requireNonEmptyString(modelId, "model ID");

        Proposal storage proposal = proposals[modelId];
        require(proposal.tokenAddress != address(0), "Proposal not registered");
        require(!proposal.graduated, "Already graduated");
        require(!proposal.graduationAnnounced, "Graduation already announced");
        ValidationLib.requirePositiveAmount(proposal.totalCommitted, "total committed");
        require(modelRegistry.isStringActive(modelId), "Model is deactivated");

        address[] storage proposalDepositors = depositors[modelId];
        uint256 depositorCount = proposalDepositors.length;
        uint256 claimableCount = 0;

        for (uint256 i = 0; i < depositorCount; i++) {
            address depositor = proposalDepositors[i];
            uint256 commitment = commitments[modelId][depositor];
            snapshottedCommitments[modelId][depositor] = commitment;

            if (commitment > 0) {
                claimableCount += 1;
            }
        }

        proposal.graduationAnnounced = true;
        proposal.snapshotTotalCommitted = proposal.totalCommitted;
        claimableAccounts[modelId] = claimableCount;

        emit GraduationAnnounced(modelId, proposal.snapshotTotalCommitted, depositorCount);
    }

    /**
     * @dev Graduate a proposal to AMM pool
     * @param modelId String model identifier
     *
     * This function:
     * 1. Creates AMM pool via HokusaiAMMFactory
     * 2. Transfers totalCommitted USDC to the pool (via initial buy)
     * 3. Sets graduated = true (one-way flag)
     * 4. Stores pool address
     *
     * Requirements:
     * - Caller must have GRADUATOR_ROLE
     * - Proposal must be registered
     * - Not already graduated
     * - Has committed funds
     */
    function graduate(string memory modelId)
        external
        onlyRole(GRADUATOR_ROLE)
        nonReentrant
    {
        ValidationLib.requireNonEmptyString(modelId, "model ID");

        Proposal storage proposal = proposals[modelId];
        require(proposal.tokenAddress != address(0), "Proposal not registered");
        require(!proposal.graduated, "Already graduated");
        require(proposal.graduationAnnounced, "Graduation not announced");
        ValidationLib.requirePositiveAmount(proposal.snapshotTotalCommitted, "total committed");
        require(modelRegistry.isStringActive(modelId), "Model is deactivated");

        // Create AMM pool via factory
        address poolAddress = ammFactory.createPool(
            modelId,
            proposal.tokenAddress
        );

        modelRegistry.registerPool(modelId, poolAddress);

        // Authorize pool to mint tokens (grant MINTER_ROLE)
        bytes32 MINTER_ROLE = tokenManager.MINTER_ROLE();
        tokenManager.grantRole(MINTER_ROLE, poolAddress);

        // Approve pool to spend USDC
        require(
            usdc.approve(poolAddress, proposal.snapshotTotalCommitted),
            "USDC approval failed"
        );

        // Check vault's token balance before buy
        IERC20 token = IERC20(proposal.tokenAddress);
        uint256 balanceBefore = token.balanceOf(address(this));

        // Make initial buy to seed pool with committed funds
        // The pool will handle the buy and mint tokens to this contract
        // Those tokens will be distributed via claim()
        HokusaiAMM pool = HokusaiAMM(poolAddress);
        pool.buy(
            proposal.snapshotTotalCommitted,
            1, // minTokensOut = 1 (we accept any price for seeding)
            address(this), // tokens go to this vault
            block.timestamp + 300 // 5 minute deadline
        );

        // Calculate tokens received
        uint256 balanceAfter = token.balanceOf(address(this));
        uint256 tokensReceived = balanceAfter - balanceBefore;

        // Update state
        proposal.graduated = true;
        proposal.poolAddress = poolAddress;
        proposal.totalTokens = tokensReceived;

        emit Graduated(modelId, poolAddress, proposal.snapshotTotalCommitted);
    }

    // ============================================================
    // TOKEN CLAIMING
    // ============================================================

    /**
     * @dev Claim tokens after graduation
     * @param modelId String model identifier
     *
     * Batch claim pattern: Each depositor calls individually rather than
     * distributing to all in the graduation tx (avoids gas limits).
     *
     * Token amount = (userCommitment / totalCommitted) * tokens held by vault
     *
     * Requirements:
     * - Proposal must be graduated
     * - User has non-zero commitment
     * - User has not already claimed
     */
    function claim(string memory modelId) external nonReentrant {
        ValidationLib.requireNonEmptyString(modelId, "model ID");

        Proposal storage proposal = proposals[modelId];
        require(proposal.graduated, "Not graduated yet");
        require(!claimed[modelId][msg.sender], "Already claimed");

        uint256 userCommitment = snapshottedCommitments[modelId][msg.sender];
        ValidationLib.requirePositiveAmount(userCommitment, "commitment");

        // Mark as claimed before transfer (CEI pattern)
        claimed[modelId][msg.sender] = true;
        claimedAccounts[modelId] += 1;

        // Calculate proportional share of tokens
        // The vault received tokens from the pool during graduation
        // Users claim their proportional share based on their commitment
        uint256 tokenAmount =
            (userCommitment * proposal.totalTokens) / proposal.snapshotTotalCommitted;

        IERC20 token = IERC20(proposal.tokenAddress);

        // Transfer tokens to user
        require(token.transfer(msg.sender, tokenAmount), "Token transfer failed");

        emit Claimed(modelId, msg.sender, tokenAmount);
    }

    /**
     * @dev Sweep post-claim rounding dust to a recipient once all claimants are done
     * @param modelId String model identifier
     * @param recipient Recipient of the remaining token dust
     *
     * Requirements:
     * - Caller must have DEFAULT_ADMIN_ROLE
     * - Proposal must be registered and graduated
     * - All claimable accounts must have already claimed
     * - Recipient must be non-zero
     */
    function sweepDust(string memory modelId, address recipient)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
        nonReentrant
    {
        ValidationLib.requireNonEmptyString(modelId, "model ID");
        ValidationLib.requireNonZeroAddress(recipient, "recipient");

        Proposal storage proposal = proposals[modelId];
        require(proposal.tokenAddress != address(0), "Proposal not registered");
        require(proposal.graduated, "Not graduated yet");
        require(claimedAccounts[modelId] == claimableAccounts[modelId], "Claims still pending");

        IERC20 token = IERC20(proposal.tokenAddress);
        uint256 dust = token.balanceOf(address(this));

        if (dust == 0) {
            return;
        }

        require(token.transfer(recipient, dust), "Token transfer failed");

        emit DustSwept(modelId, recipient, dust);
    }

    // ============================================================
    // VIEW FUNCTIONS
    // ============================================================

    /**
     * @dev Get proposal details
     * @param modelId String model identifier
     */
    function getProposal(string memory modelId)
        external
        view
        returns (
            address tokenAddress,
            uint256 deadline,
            uint256 totalCommitted,
            uint256 snapshotTotalCommitted,
            bool graduated,
            bool graduationAnnounced,
            address poolAddress,
            uint256 totalTokens
        )
    {
        Proposal memory proposal = proposals[modelId];
        return (
            proposal.tokenAddress,
            proposal.deadline,
            proposal.totalCommitted,
            proposal.snapshotTotalCommitted,
            proposal.graduated,
            proposal.graduationAnnounced,
            proposal.poolAddress,
            proposal.totalTokens
        );
    }

    /**
     * @dev Get user commitment for a proposal
     * @param modelId String model identifier
     * @param user User address
     */
    function getCommitment(string memory modelId, address user)
        external
        view
        returns (uint256)
    {
        return commitments[modelId][user];
    }

    /**
     * @dev Check if user has claimed tokens
     * @param modelId String model identifier
     * @param user User address
     */
    function hasClaimed(string memory modelId, address user)
        external
        view
        returns (bool)
    {
        return claimed[modelId][user];
    }

    /**
     * @dev Get frozen commitment amount used for post-graduation claims
     * @param modelId String model identifier
     * @param user User address
     */
    function getSnapshottedCommitment(string memory modelId, address user)
        external
        view
        returns (uint256)
    {
        return snapshottedCommitments[modelId][user];
    }
}
