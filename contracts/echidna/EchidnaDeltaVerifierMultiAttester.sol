// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./EchidnaDeltaVerifier.sol";

/**
 * @dev 2-of-3 m-of-n variant of the DeltaVerifier Echidna harness (HOK-2171, item 7).
 *
 * Registers three attesters (keys 1/2/3) at threshold 2 and signs each canonical request with the two
 * lowest-addressed keys, in the strictly ascending signer-address order submitMintRequest requires:
 *   key2 0x2B5AD5... < key3 0x6813Eb... < key1 0x7E5F45...
 * so a 2-of-3 request signs with {key2, key3}.
 *
 * Inherits the full base body (all fuzzers + all properties), so budget, no-mint-without-valid-signature,
 * lineage-monotonic and every HOK-2171 invariant are re-checked under multi-attester. This keeps both the
 * 1-of-1 and 2-of-3 shapes in the fuzzing corpus.
 */
contract EchidnaDeltaVerifierMultiAttester is EchidnaDeltaVerifier {
    function _configureAttesters() internal override {
        deltaVerifier.addAttester(ATTESTER_ADDR_1);
        deltaVerifier.addAttester(ATTESTER_ADDR_2);
        deltaVerifier.addAttester(ATTESTER_ADDR_3);
        deltaVerifier.setAttesterThreshold(2);
    }

    /// @dev Pool ordered by ascending signer address: key2 (0x2B) < key3 (0x68) < key1 (0x7E).
    function _attesterKeys() internal pure override returns (uint256[] memory keys) {
        keys = new uint256[](3);
        keys[0] = ATTESTER_KEY_2;
        keys[1] = ATTESTER_KEY_3;
        keys[2] = ATTESTER_KEY_1;
    }

    function _currentThreshold() internal pure override returns (uint256) {
        return 2;
    }
}
