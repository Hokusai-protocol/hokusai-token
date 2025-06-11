# PRD: Protect Internal _mint()/_burn() Functions

## Objectives

Enhance the security and access control of the HokusaiToken contract by encapsulating mint and burn operations behind controller-protected functions. This prevents unauthorized token issuance or destruction while maintaining proper separation of concerns between the token contract and management logic.

## Background

Currently, the HokusaiToken contract may expose mint/burn functionality that could be called by unauthorized parties. To ensure proper token economics and prevent exploitation, these functions must be restricted to only authorized controllers (specifically the TokenManager contract).

## Success Criteria

- Only the designated controller can mint new tokens
- Only the designated controller can burn tokens from user accounts
- Unauthorized attempts to mint/burn tokens are rejected with clear error messages
- Existing functionality for token holders to burn their own tokens remains intact
- All access control changes are thoroughly tested

## Target Personas

**Smart Contract Developer**: Needs clear separation between public token operations and controller-only operations

**Token Holder**: Can still burn their own tokens directly but cannot mint new tokens

**System Administrator**: Can set and update the controller address as needed

## Technical Requirements

### Access Control Implementation
- Implement `onlyController` modifier to restrict sensitive functions
- Add `setController()` function for administrative control updates
- Protect internal `_mint()` and `_burn()` functions with proper access controls

### Function Specifications
- `mint(address recipient, uint256 amount)` - Only callable by controller
- `burn(uint256 amount)` - Callable by token holders to burn their own tokens
- `burnFrom(address account, uint256 amount)` - Only callable by controller with proper allowance
- `setController(address newController)` - Only callable by contract owner/admin

### Security Considerations
- Prevent unauthorized token creation that could inflate supply
- Prevent unauthorized token destruction that could affect user balances
- Maintain compatibility with standard ERC20 expectations
- Ensure proper event emission for all mint/burn operations

## Tasks

1. **Review Current HokusaiToken Implementation**
   - Analyze existing mint/burn function access patterns
   - Identify which functions need controller protection
   - Document current access control mechanisms

2. **Implement Controller Access Control**
   - Add `controller` state variable and `onlyController` modifier
   - Update mint functions to use `onlyController` protection
   - Update administrative burn functions to use `onlyController`
   - Preserve user's ability to burn their own tokens

3. **Add Controller Management Functions**
   - Implement `setController()` function with appropriate admin protection
   - Add events for controller changes
   - Include zero-address validation for controller updates

4. **Update Contract Documentation**
   - Add clear comments explaining access control design
   - Document which functions are controller-only vs public
   - Update any existing inline documentation

5. **Comprehensive Testing**
   - Test that only controller can mint tokens
   - Test that only controller can burn tokens from other accounts
   - Test that users can still burn their own tokens
   - Test controller update functionality
   - Test unauthorized access rejection scenarios
   - Verify proper event emission

## Implementation Notes

The implementation should maintain backward compatibility with existing TokenManager integration while strengthening security boundaries. The controller pattern allows for future upgrades to token management logic without requiring token contract changes.