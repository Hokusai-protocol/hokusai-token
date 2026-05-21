#!/usr/bin/env node
/**
 * Reconciles slither-baseline.json after contract fixes.
 *
 * Reconciliation procedure:
 * 1. Load before/after Slither snapshots
 * 2. Remove fixed findings (arbitrary-send-eth, reentrancy-eth, etc.)
 * 3. Update IDs for findings that shifted due to line number changes
 * 4. Update justifications for false positives (incorrect-equality)
 * 5. Remove reentrancy-benign/reentrancy-events entries silenced by nonReentrant
 */

const fs = require('fs');
const path = require('path');

// IDs to remove (fixed findings)
const FIXED_IDS = new Set([
  // arbitrary-send-eth (3 findings - fixed)
  '592c5ac66704ed19c724570e62a354fe5da55f0be4c507c6ee81d0bdfdf078c9',
  'a96346bc89c59c3b9d6c3d0ecc155752bb52f667bf73fdb9e5e4e3b6c228547d',
  'f8d7265982600f56868a6589fb61d9db5016a41844830d28de72f40768de5e85',
  // reentrancy-eth (4 findings - fixed)
  '029b94c058635ed2c1b1027d85686e789ae6b17ebca22cd6769a9edf48a8dd04',
  '8b58d46d9c52eb4b540f63a633a3704485eb61f230ae6054511d5d44315b33b4',
  '8c0b6504901802b544d0fc1b06753ea0b9b6b8d4b5daf187b19031f80d4acb38',
  '96507ecd7df58cbc02f6232d42164da7814f388f7ce6c27b72cf04e81427d6f2',
  // unchecked-transfer (1 finding - fixed)
  '08ac6719945b922bd9e0a39f6bfbdb64ef7123b3fff5ebb69e1323c93536cd01',
  // divide-before-multiply (1 finding - fixed)
  'c522bc5759587057c9a1eb01443a5f14abf9e9d2ee40f05b6f9d626b521eec0b',
]);

// incorrect-equality IDs to keep (false positives - update justifications)
const FALSE_POSITIVE_IDS = new Set([
  '1d7ad28cad4e8097946a98348cad9ba5573af5b8c2c21093f73f9662a88325cf', // DataContributionRegistry:286
  '54c03dd4f85503f880bcfa5ea5f85a3e978a2136cc8e132d821c2fd2a0b26d33', // DataContributionRegistry:465
  'cf423f4f3f1e53f424529d59215cc1e00d0459a2bffe0a6eb6b93caff99950ae', // FundingVault:488
]);

const FALSE_POSITIVE_JUSTIFICATIONS = {
  '1d7ad28cad4e8097946a98348cad9ba5573af5b8c2c21093f73f9662a88325cf':
    'False positive: enum equality comparison (DataContributionRegistry:286, contributions[id].status == ContributionStatus.Verified). Enum values have a fixed finite domain and cannot be manipulated; strict equality is the only correct way to test state-machine status.',
  '54c03dd4f85503f880bcfa5ea5f85a3e978a2136cc8e132d821c2fd2a0b26d33':
    'False positive: string equality via keccak256 (DataContributionRegistry:465, keccak256(bytes(seenModels[j])) == keccak256(bytes(modelId))). This is the canonical Solidity idiom for string comparison; keccak256 hashes must be compared with ==.',
  'cf423f4f3f1e53f424529d59215cc1e00d0459a2bffe0a6eb6b93caff99950ae':
    'False positive: benign admin-only balance guard (FundingVault:488, dust == 0 where dust = token.balanceOf(this)). Function is onlyRole(DEFAULT_ADMIN_ROLE) + nonReentrant; the equality check is a harmless early-return optimization with no exploitable impact.',
};

// reentrancy-benign findings on TokenManager/DeployableTokenManager deploy functions
// These will be silenced by nonReentrant modifier
const SILENCED_BENIGN_IDS = new Set([
  'c90c34ddcafe43ce19c1598dbd7c2b9e3fbc94d71b098f9806eaaad8428a6888', // TokenManager deployTokenWithParams
  'e82575ad092fc4daf772d1f1bdfbc3e91d9ee11582e2daa960cda9e2f9d57835', // TokenManager deployTokenWithAllocations
  '73b9c295fe68a88081f1c6623faee5bcbb24556be81f2bdb83184ec66caf960f', // DeployableTokenManager deployTokenWithAllocations
  '9ed15b97569b4effd0825cd81b353ef0187716710e15e658685b65392c55037f', // DeployableTokenManager deployTokenWithParams
]);

// reentrancy-events findings on TokenManager/DeployableTokenManager deploy functions
const SILENCED_EVENTS_IDS = new Set([
  '4bba14856350f092c0f96f88c265555d7dd32243521d49603aa6509ebe42af31', // TokenManager deployTokenWithParams
  'd30c9593ef667fd3bf66651ebc752f8773053400609de51115f03afd7b1cd5cf', // TokenManager deployTokenWithAllocations
  '833d2a239d14d2a4f6986c9ff67ab5c6589f7fc740b5146c6d6bdac4fd452545', // DeployableTokenManager deployTokenWithParams
  '6cb1297bb7142dae4a6e0874a05808bb5db3c04f0b4abca7441a9b8d79f935fc', // DeployableTokenManager deployTokenWithAllocations
]);

function main() {
  const beforePath = '/tmp/slither-before.json';
  const afterPath = '/tmp/slither-after.json';
  const baselinePath = path.join(__dirname, '..', 'slither-baseline.json');

  // Load snapshots
  const before = JSON.parse(fs.readFileSync(beforePath, 'utf8'));
  const after = JSON.parse(fs.readFileSync(afterPath, 'utf8'));
  const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));

  console.log('Loaded snapshots:');
  console.log(`  Before: ${before.results.detectors.length} detectors`);
  console.log(`  After: ${after.results.detectors.length} detectors`);
  console.log(`  Baseline: ${baseline.accepted.length} entries`);

  // Create ID maps for before and after findings
  const beforeMap = new Map();
  const afterMap = new Map();

  for (const finding of before.results.detectors) {
    beforeMap.set(finding.id, finding);
  }

  for (const finding of after.results.detectors) {
    afterMap.set(finding.id, finding);
  }

  // Process baseline entries
  const newAccepted = [];
  let removedCount = 0;
  let updatedCount = 0;
  let keptCount = 0;

  for (const entry of baseline.accepted) {
    // Remove fixed findings
    if (FIXED_IDS.has(entry.id)) {
      console.log(`Removing fixed: ${entry.check} ${entry.id.slice(0, 8)}...`);
      removedCount++;
      continue;
    }

    // Remove silenced reentrancy-benign/reentrancy-events
    if (SILENCED_BENIGN_IDS.has(entry.id) || SILENCED_EVENTS_IDS.has(entry.id)) {
      console.log(`Removing silenced: ${entry.check} ${entry.id.slice(0, 8)}...`);
      removedCount++;
      continue;
    }

    // Update false positive justifications
    if (FALSE_POSITIVE_IDS.has(entry.id)) {
      entry.justification = FALSE_POSITIVE_JUSTIFICATIONS[entry.id];
      console.log(`Updated false positive: ${entry.check} ${entry.id.slice(0, 8)}...`);
      updatedCount++;
      newAccepted.push(entry);
      continue;
    }

    // Check if finding still exists in after snapshot
    if (afterMap.has(entry.id)) {
      // ID unchanged - keep as is
      keptCount++;
      newAccepted.push(entry);
    } else {
      // ID changed due to line shift - try to match by fingerprint
      const beforeFinding = beforeMap.get(entry.id);
      if (!beforeFinding) {
        console.warn(`Warning: baseline entry ${entry.id.slice(0, 8)}... not found in before snapshot`);
        // Keep it anyway to be safe
        newAccepted.push(entry);
        continue;
      }

      // Try to find matching finding in after by check + contract + function
      const matches = Array.from(afterMap.values()).filter(f =>
        f.check === beforeFinding.check &&
        JSON.stringify(f.elements) === JSON.stringify(beforeFinding.elements)
      );

      if (matches.length === 1) {
        // Found unique match - update ID
        console.log(`Updating shifted ID: ${entry.check} ${entry.id.slice(0, 8)}... -> ${matches[0].id.slice(0, 8)}...`);
        entry.id = matches[0].id;
        updatedCount++;
        newAccepted.push(entry);
      } else if (matches.length === 0) {
        console.log(`Removing resolved: ${entry.check} ${entry.id.slice(0, 8)}... (no match in after)`);
        removedCount++;
      } else {
        console.warn(`Warning: multiple matches for ${entry.check} ${entry.id.slice(0, 8)}..., keeping original`);
        newAccepted.push(entry);
      }
    }
  }

  // Update baseline
  baseline.accepted = newAccepted;

  // Write updated baseline
  fs.writeFileSync(
    baselinePath,
    JSON.stringify(baseline, null, 2) + '\n',
    'utf8'
  );

  console.log('\nReconciliation complete:');
  console.log(`  Removed: ${removedCount}`);
  console.log(`  Updated: ${updatedCount}`);
  console.log(`  Kept: ${keptCount}`);
  console.log(`  Total: ${newAccepted.length}`);
}

main();
