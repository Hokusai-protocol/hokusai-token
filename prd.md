# Product Requirements Document: Token Burning Test via AuctionBurner

## Objectives

Create comprehensive test coverage for the AuctionBurner contract to verify that tokens are properly burned from a contributor's balance when the burn() function is called. The tests should confirm that balances update correctly, total supply decreases appropriately, and all relevant events are emitted.

## Personas

**Developer**: Software engineer implementing and maintaining the smart contract test suite. Needs clear, reliable tests that validate the burn mechanism works correctly and catches potential edge cases.

**QA Engineer**: Quality assurance professional who needs to verify that the token burning functionality meets specifications and handles error cases appropriately.

## Success Criteria

1. Complete test coverage for all AuctionBurner functions including burn(), setToken(), and constructor
2. Verification that token balances decrease correctly after burning
3. Confirmation that total token supply decreases by the burned amount
4. Validation that appropriate events are emitted with correct parameters
5. Testing of edge cases including zero amounts, insufficient balances, and missing approvals
6. Integration tests confirming interaction between AuctionBurner, HokusaiToken, and TokenManager
7. All tests pass successfully in the Hardhat test environment

## Tasks

### Test Setup and Configuration
- Create test file `test/auctionburner.test.js` following existing test patterns
- Import necessary dependencies (ethers, expect from chai)
- Define test fixtures for deploying contracts (HokusaiToken, TokenManager, ModelRegistry, AuctionBurner)
- Setup beforeEach hook to deploy fresh contract instances and establish relationships

### Core Burn Functionality Tests
- Test successful token burning with valid amount and sufficient balance
- Verify user balance decreases by exact burn amount
- Confirm total supply decreases by burned amount
- Check that both TokensBurned and Burned events are emitted with correct parameters
- Test burning different amounts (small, large, maximum balance)

### Access Control and Permissions Tests
- Verify only owner can call setToken() function
- Test that non-owners are reverted when attempting setToken()
- Confirm token contract reference can be updated successfully by owner
- Validate TokenContractUpdated event emission on token update

### Error Handling and Edge Cases
- Test burn() reverts when amount is zero
- Verify revert when user has insufficient token balance
- Confirm revert when user hasn't approved AuctionBurner to spend tokens
- Test behavior when token address is set to zero address (should revert)
- Validate partial approvals (approve less than burn amount)

### Integration Tests
- Test complete flow: mint tokens via TokenManager, approve AuctionBurner, burn tokens
- Verify multiple users can burn tokens independently
- Test sequential burns from same user
- Confirm AuctionBurner can interact with different HokusaiToken instances

### Event Verification Tests
- Validate TokensBurned event contains correct user address and amount
- Verify HokusaiToken's Burned event shows AuctionBurner as the burner
- Test event emission order and parameters for complex scenarios
- Confirm no unexpected events are emitted

### Gas Optimization Tests
- Measure gas usage for burn operations
- Compare gas costs for different burn amounts
- Ensure operations are within reasonable gas limits