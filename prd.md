# DeltaVerifier Product Requirements Document

## Objectives

Create a DeltaVerifier contract that processes off-chain ML model performance metrics in JSON format and calculates token rewards for data contributors based on performance improvements (DeltaOne scores).

## Personas

### Data Contributors
- ML engineers and data scientists who contribute datasets to improve model performance
- Need transparent reward calculation based on their contribution's impact
- Require verifiable proof that rewards match performance improvements

### Protocol Administrators
- Manage the DeltaVerifier contract and verify metric submissions
- Configure reward parameters and thresholds
- Monitor system for fraudulent or invalid submissions

### TokenManager Integration
- The TokenManager contract that will call DeltaVerifier to determine reward amounts
- Needs reliable calculation of token rewards based on verified metrics

## Success Criteria

1. DeltaVerifier successfully parses and validates JSON evaluation data
2. Correctly calculates DeltaOne scores from baseline and new model metrics
3. Determines appropriate token rewards based on performance improvements
4. Validates all required fields and rejects malformed or suspicious data
5. Integrates seamlessly with TokenManager for automated reward distribution
6. Provides clear event logs for all reward calculations

## Tasks

### Contract Development

1. **Create DeltaVerifier.sol contract**
   - Define contract structure with owner/admin access control
   - Import necessary dependencies (ModelRegistry interface, math libraries)
   - Define storage for configuration parameters (reward rates, thresholds)

2. **Implement JSON data structure validation**
   - Define struct for evaluation data matching the JSON schema
   - Create validation functions for required fields
   - Implement checks for data integrity and reasonable values

3. **Build DeltaOne calculation logic**
   - Implement weighted average delta calculation from metrics
   - Support configurable metrics (accuracy, auroc, f1, precision, recall)
   - Calculate improvement percentage with basis points precision

4. **Create reward calculation mechanism**
   - Define reward formula based on DeltaOne score
   - Support contributor weights for fractional rewards
   - Implement minimum threshold checks (e.g., minimum 1% improvement)

5. **Add verification functions**
   - `submitEvaluation()` - Main entry point accepting evaluation data
   - `calculateDeltaOne()` - Pure function for delta calculation
   - `calculateReward()` - Determine token reward amount
   - `validateEvaluationData()` - Ensure data integrity

6. **Implement security measures**
   - Add reentrancy guards
   - Validate caller permissions
   - Add pause mechanism for emergency stops
   - Implement rate limiting for submissions

### Testing Requirements

1. **Unit tests for DeltaOne calculations**
   - Test with sample JSON data from specification
   - Verify correct handling of metric improvements
   - Test edge cases (0% improvement, negative deltas)

2. **Integration tests with TokenManager**
   - Mock TokenManager calls to DeltaVerifier
   - Verify correct reward amounts returned
   - Test rejection of invalid submissions

3. **Validation tests**
   - Test with malformed JSON data
   - Test with missing required fields
   - Test with unrealistic metric values

4. **Security tests**
   - Test access control restrictions
   - Test pause functionality
   - Test against common attack vectors

### Deployment Tasks

1. **Deploy DeltaVerifier contract**
   - Set initial configuration parameters
   - Configure admin addresses
   - Link to ModelRegistry if needed

2. **Configure reward parameters**
   - Set base reward rate
   - Configure minimum improvement threshold
   - Set maximum reward caps if needed

3. **Integration with TokenManager**
   - Update TokenManager to call DeltaVerifier
   - Test end-to-end flow from evaluation to token minting

## Technical Specifications

### Key Functions

```solidity
function submitEvaluation(
    uint256 modelId,
    EvaluationData calldata data
) external returns (uint256 rewardAmount)

function calculateDeltaOne(
    Metrics memory baseline,
    Metrics memory newMetrics
) public pure returns (uint256 deltaInBps)

function calculateReward(
    uint256 deltaInBps,
    uint256 contributorWeight,
    uint256 contributedSamples
) public view returns (uint256)
```

### Data Structures

```solidity
struct Metrics {
    uint256 accuracy;
    uint256 precision;
    uint256 recall;
    uint256 f1;
    uint256 auroc;
}

struct EvaluationData {
    string pipelineRunId;
    Metrics baselineMetrics;
    Metrics newMetrics;
    address contributor;
    uint256 contributorWeight;
    uint256 contributedSamples;
    uint256 totalSamples;
}
```

### Events

```solidity
event EvaluationSubmitted(
    uint256 indexed modelId,
    address indexed contributor,
    uint256 deltaOneScore,
    uint256 rewardAmount
)

event RewardCalculated(
    address indexed contributor,
    uint256 deltaInBps,
    uint256 rewardAmount
)
```

## Dependencies

- ModelRegistry contract for model validation
- TokenManager contract for reward distribution
- OpenZeppelin contracts for security patterns
- Math libraries for precise calculations

## Future Considerations

- Integration with zkProof/attestation for verified submissions
- Support for batch evaluation submissions
- Historical tracking of model improvements
- More sophisticated reward curves based on model maturity