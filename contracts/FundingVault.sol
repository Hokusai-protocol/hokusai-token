// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "./libraries/AccessControlBase.sol";
import "./libraries/ValidationLib.sol";
import "./HokusaiAMMFactory.sol";
import "./TokenManager.sol";

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

    bytes32 public constant GRADUATOR_ROLE = keccak256("GRADUATOR_ROLE");

    // Proposal state
    struct Proposal {
        address tokenAddress;
        uint256 deadline;
        uint256 totalCommitted;
        bool graduated;
        address poolAddress;
        uint256 totalTokens; // Total tokens received from pool during graduation
        uint256 snapshotTimestamp; // When snapshot was taken (0 = not taken)
        uint256 snapshotTotalCommitted; // Total committed at snapshot time
    }

    // modelId => Proposal
    mapping(string => Proposal) public proposals;

    // modelId => user => commitment amount
    mapping(string => mapping(address => uint256)) public commitments;

    // modelId => user => commitment amount at snapshot time
    mapping(string => mapping(address => uint256)) public snapshotCommitments;

    // modelId => user => claimed
    mapping(string => mapping(address => bool)) public claimed;

    // ============================================================
    // EVENTS
    // ============================================================

    event ProposalRegistered(
        string indexed modelId,
        address indexed tokenAddress,
        uint256 deadline
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
        uint256 snapshotTimestamp,
        uint256 snapshotTotalCommitted
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

    // ============================================================
    // CONSTRUCTOR
    // ============================================================

    /**
     * @dev Initialize FundingVault with core dependencies
     * @param _usdc USDC token address
     * @param _ammFactory HokusaiAMMFactory address
     * @param _tokenManager TokenManager address
     * @param _admin Admin address for access control
     */
    constructor(
        address _usdc,
        address _ammFactory,
        address _tokenManager,
        address _admin
    ) AccessControlBase(_admin) {
        ValidationLib.requireNonZeroAddress(_usdc, "USDC");
        ValidationLib.requireNonZeroAddress(_ammFactory, "AMM factory");
        ValidationLib.requireNonZeroAddress(_tokenManager, "token manager");

        usdc = IERC20(_usdc);
        ammFactory = HokusaiAMMFactory(_ammFactory);
        tokenManager = TokenManager(_tokenManager);

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
     * @param deadline Timestamp after which proposal expires (refunds enabled)
     *
     * Requirements:
     * - Caller must have DEFAULT_ADMIN_ROLE
     * - Model must not already be registered
     * - Token address must be valid
     * - Deadline must be in the future
     */
    function registerProposal(
        string memory modelId,
        address tokenAddr,
        uint256 deadline
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        ValidationLib.requireNonEmptyString(modelId, "model ID");
        ValidationLib.requireNonZeroAddress(tokenAddr, "token address");
        require(deadline > block.timestamp, "Deadline must be in future");
        require(proposals[modelId].tokenAddress == address(0), "Proposal already registered");

        proposals[modelId] = Proposal({
            tokenAddress: tokenAddr,
            deadline: deadline,
            totalCommitted: 0,
            graduated: false,
            poolAddress: address(0),
            totalTokens: 0,
            snapshotTimestamp: 0,
            snapshotTotalCommitted: 0
        });

        emit ProposalRegistered(modelId, tokenAddr, deadline);
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
     * - Not past deadline
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
        require(proposal.snapshotTimestamp == 0, "Graduation announced, deposits locked");
        require(block.timestamp <= proposal.deadline, "Deadline passed");

        // Transfer USDC from caller to vault
        require(
            usdc.transferFrom(msg.sender, address(this), amount),
            "USDC transfer failed"
        );

        // Update state
        commitments[modelId][msg.sender] += amount;
        proposal.totalCommitted += amount;

        emit Deposited(modelId, msg.sender, amount, proposal.totalCommitted);
    }

    /**
     * @dev Withdraw USDC commitment before graduation announcement
     * @param modelId String model identifier
     *
     * Requirements:
     * - Proposal must be registered
     * - Not graduated and snapshot not taken
     * - User has non-zero commitment
     */
    function withdraw(string memory modelId) external nonReentrant {
        ValidationLib.requireNonEmptyString(modelId, "model ID");

        Proposal storage proposal = proposals[modelId];
        require(proposal.tokenAddress != address(0), "Proposal not registered");
        require(!proposal.graduated, "Already graduated");
        require(proposal.snapshotTimestamp == 0, "Graduation announced, withdrawals locked");

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
     * @dev Announce graduation and take snapshot of commitments
     * @param modelId String model identifier
     * @param investors Array of investor addresses to snapshot
     *
     * This function prevents front-running by:
     * 1. Taking a snapshot of all current commitments
     * 2. Locking further deposits and withdrawals
     * 3. Creating a time window before actual graduation
     *
     * Requirements:
     * - Caller must have GRADUATOR_ROLE
     * - Proposal must be registered
     * - Not already announced or graduated
     * - Has committed funds
     */
    function announceGraduation(string memory modelId, address[] calldata investors)
        external
        onlyRole(GRADUATOR_ROLE)
        nonReentrant
    {
        ValidationLib.requireNonEmptyString(modelId, "model ID");

        Proposal storage proposal = proposals[modelId];
        require(proposal.tokenAddress != address(0), "Proposal not registered");
        require(!proposal.graduated, "Already graduated");
        require(proposal.snapshotTimestamp == 0, "Graduation already announced");
        ValidationLib.requirePositiveAmount(proposal.totalCommitted, "total committed");

        // Take snapshot of current state
        proposal.snapshotTimestamp = block.timestamp;
        proposal.snapshotTotalCommitted = proposal.totalCommitted;

        // Snapshot each investor's commitment and validate total
        uint256 snapshotSum = 0;
        for (uint256 i = 0; i < investors.length; i++) {
            address investor = investors[i];
            uint256 commitment = commitments[modelId][investor];
            if (commitment > 0) {
                snapshotCommitments[modelId][investor] = commitment;
                snapshotSum += commitment;
            }
        }

        // Validate that all investors were included
        require(
            snapshotSum == proposal.totalCommitted,
            "Snapshot total mismatch - missing investors"
        );

        emit GraduationAnnounced(modelId, block.timestamp, proposal.totalCommitted);
    }

    /**
     * @dev Graduate a proposal to AMM pool
     * @param modelId String model identifier
     *
     * This function:
     * 1. Creates AMM pool via HokusaiAMMFactory
     * 2. Transfers snapshotTotalCommitted USDC to the pool (via initial buy)
     * 3. Sets graduated = true (one-way flag)
     * 4. Stores pool address
     *
     * Requirements:
     * - Caller must have GRADUATOR_ROLE
     * - Proposal must be registered
     * - Not already graduated
     * - Graduation must be announced (snapshot taken)
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
        require(proposal.snapshotTimestamp > 0, "Graduation not announced yet");
        ValidationLib.requirePositiveAmount(proposal.snapshotTotalCommitted, "snapshot total committed");

        // Create AMM pool via factory
        address poolAddress = ammFactory.createPool(
            modelId,
            proposal.tokenAddress
        );

        // Authorize pool to mint tokens (grant MINTER_ROLE)
        bytes32 MINTER_ROLE = tokenManager.MINTER_ROLE();
        tokenManager.grantRole(MINTER_ROLE, poolAddress);

        // Approve pool to spend USDC (use snapshot amount)
        require(
            usdc.approve(poolAddress, proposal.snapshotTotalCommitted),
            "USDC approval failed"
        );

        // Check vault's token balance before buy
        IERC20 token = IERC20(proposal.tokenAddress);
        uint256 balanceBefore = token.balanceOf(address(this));

        // Make initial buy to seed pool with snapshot committed funds
        // The pool will handle the buy and mint tokens to this contract
        // Those tokens will be distributed via claim() based on snapshot commitments
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
     * Token amount = (snapshotCommitment / snapshotTotalCommitted) * tokens held by vault
     *
     * Requirements:
     * - Proposal must be graduated
     * - User has non-zero snapshot commitment
     * - User has not already claimed
     */
    function claim(string memory modelId) external nonReentrant {
        ValidationLib.requireNonEmptyString(modelId, "model ID");

        Proposal storage proposal = proposals[modelId];
        require(proposal.graduated, "Not graduated yet");
        require(!claimed[modelId][msg.sender], "Already claimed");

        uint256 userSnapshotCommitment = snapshotCommitments[modelId][msg.sender];
        ValidationLib.requirePositiveAmount(userSnapshotCommitment, "snapshot commitment");

        // Mark as claimed before transfer (CEI pattern)
        claimed[modelId][msg.sender] = true;

        // Calculate proportional share of tokens based on snapshot values
        // The vault received tokens from the pool during graduation
        // Users claim their proportional share based on their snapshot commitment
        uint256 tokenAmount = (userSnapshotCommitment * proposal.totalTokens) / proposal.snapshotTotalCommitted;

        IERC20 token = IERC20(proposal.tokenAddress);

        // Transfer tokens to user
        require(token.transfer(msg.sender, tokenAmount), "Token transfer failed");

        emit Claimed(modelId, msg.sender, tokenAmount);
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
            bool graduated,
            address poolAddress,
            uint256 totalTokens,
            uint256 snapshotTimestamp,
            uint256 snapshotTotalCommitted
        )
    {
        Proposal memory proposal = proposals[modelId];
        return (
            proposal.tokenAddress,
            proposal.deadline,
            proposal.totalCommitted,
            proposal.graduated,
            proposal.poolAddress,
            proposal.totalTokens,
            proposal.snapshotTimestamp,
            proposal.snapshotTotalCommitted
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
     * @dev Get user snapshot commitment for a proposal
     * @param modelId String model identifier
     * @param user User address
     */
    function getSnapshotCommitment(string memory modelId, address user)
        external
        view
        returns (uint256)
    {
        return snapshotCommitments[modelId][user];
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
}
