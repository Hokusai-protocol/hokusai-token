// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "./libraries/ValidationLib.sol";

/**
 * @title FundingVault
 * @dev Manages proposal funding and token vesting for model proposals
 * This contract tracks proposals with deadlines and enables investors to commit funds
 * before the proposal graduates to an AMM pool.
 */
contract FundingVault is Ownable {
    struct Proposal {
        address tokenAddress;
        uint256 deadline;
        bool registered;
        bool graduated;
        uint256 totalDeposits;
    }

    // modelId => Proposal
    mapping(string => Proposal) public proposals;

    // modelId => investor => amount deposited
    mapping(string => mapping(address => uint256)) public deposits;

    event ProposalRegistered(
        string indexed modelId,
        address indexed tokenAddress,
        uint256 deadline
    );
    event DepositMade(
        string indexed modelId,
        address indexed investor,
        uint256 amount
    );
    event ProposalGraduated(string indexed modelId);

    constructor() Ownable() {}

    /**
     * @dev Registers a new proposal with its token and funding deadline
     * @param modelId The unique identifier for the model
     * @param tokenAddress The address of the deployed token
     * @param deadline The Unix timestamp when funding period ends
     */
    function registerProposal(
        string memory modelId,
        address tokenAddress,
        uint256 deadline
    ) external onlyOwner {
        ValidationLib.requireNonEmptyString(modelId, "model ID");
        ValidationLib.requireNonZeroAddress(tokenAddress, "token address");
        require(deadline > block.timestamp, "Deadline must be in the future");
        require(!proposals[modelId].registered, "Proposal already registered");

        proposals[modelId] = Proposal({
            tokenAddress: tokenAddress,
            deadline: deadline,
            registered: true,
            graduated: false,
            totalDeposits: 0
        });

        emit ProposalRegistered(modelId, tokenAddress, deadline);
    }

    /**
     * @dev Allows investors to deposit funds for a proposal
     * @param modelId The model identifier
     * @param amount The amount to deposit (in USDC or other stablecoin)
     */
    function deposit(string memory modelId, uint256 amount) external {
        ValidationLib.requireNonEmptyString(modelId, "model ID");
        ValidationLib.requirePositiveAmount(amount, "deposit amount");

        Proposal storage proposal = proposals[modelId];
        require(proposal.registered, "Proposal not registered");
        require(block.timestamp < proposal.deadline, "Funding period ended");
        require(!proposal.graduated, "Proposal already graduated");

        // Note: In full implementation, this would transfer stablecoin from investor
        // For now, just track the commitment
        deposits[modelId][msg.sender] += amount;
        proposal.totalDeposits += amount;

        emit DepositMade(modelId, msg.sender, amount);
    }

    /**
     * @dev Marks a proposal as graduated (AMM pool created)
     * @param modelId The model identifier
     */
    function markGraduated(string memory modelId) external onlyOwner {
        ValidationLib.requireNonEmptyString(modelId, "model ID");

        Proposal storage proposal = proposals[modelId];
        require(proposal.registered, "Proposal not registered");
        require(!proposal.graduated, "Already graduated");

        proposal.graduated = true;
        emit ProposalGraduated(modelId);
    }

    /**
     * @dev Gets proposal information
     * @param modelId The model identifier
     * @return Proposal struct with all details
     */
    function getProposal(string memory modelId)
        external
        view
        returns (Proposal memory)
    {
        return proposals[modelId];
    }

    /**
     * @dev Gets deposit amount for an investor
     * @param modelId The model identifier
     * @param investor The investor address
     * @return The amount deposited
     */
    function getDeposit(string memory modelId, address investor)
        external
        view
        returns (uint256)
    {
        return deposits[modelId][investor];
    }

    /**
     * @dev Checks if a proposal is registered
     * @param modelId The model identifier
     * @return True if registered
     */
    function isRegistered(string memory modelId) external view returns (bool) {
        return proposals[modelId].registered;
    }

    /**
     * @dev Checks if funding period is active
     * @param modelId The model identifier
     * @return True if still accepting deposits
     */
    function isFundingActive(string memory modelId) external view returns (bool) {
        Proposal memory proposal = proposals[modelId];
        return proposal.registered &&
               !proposal.graduated &&
               block.timestamp < proposal.deadline;
    }
}
