import { parseDlqEntry } from '../../../src/dlq/dlq-entry';
import { decideReplay, OnChainMintStatus } from '../../../src/dlq/replay-guard';
import { buildDlqEntry, validMintRequest } from './test-helpers';

const currentState: OnChainMintStatus = {
  processed: false,
  mintBudgetRemaining: 1_000_000n,
  modelWeightHead: validMintRequest.baseline_commitment,
  signaturesValid: true,
};

describe('replay guard', () => {
  test('allows budget-exhausted messages after top-up when idempotency key is unburned', () => {
    const entry = parseDlqEntry(buildDlqEntry());

    expect(decideReplay(entry, currentState)).toMatchObject({
      allowed: true,
      warnings: [],
      rewardAmount: 350000n,
    });
  });

  test('allows unresolved unknown-outcome entries only when the key is not minted', () => {
    const entry = parseDlqEntry(
      buildDlqEntry({
        reason: 'permanent: MintRequest transaction outcome unknown after submit: ECONNRESET',
        failureClass: 'permanent',
      }),
    );

    expect(decideReplay(entry, currentState).allowed).toBe(true);
    expect(decideReplay(entry, { ...currentState, processed: true })).toMatchObject({
      allowed: false,
      reason: 'already_processed',
    });
  });

  test.each([
    ['security triage for signer failures', 'permanent: SignerNotAttester', 'security_triage'],
    ['model admin failures', 'permanent: Model not registered', 'not_replayable'],
    ['other permanent failures', 'permanent: execution reverted', 'not_replayable'],
  ])('refuses %s', (_label, reason, expectedReason) => {
    const entry = parseDlqEntry(buildDlqEntry({ reason, failureClass: 'permanent' }));

    expect(decideReplay(entry, currentState)).toMatchObject({
      allowed: false,
      reason: expectedReason,
    });
  });

  test('refuses schema-invalid tampered messages before on-chain replay', () => {
    const entry = parseDlqEntry(
      buildDlqEntry({
        originalMessage: {
          ...validMintRequest,
          idempotency_key: 'tampered',
        },
      }),
    );

    expect(decideReplay(entry, currentState)).toMatchObject({
      allowed: false,
      reason: 'schema_invalid',
    });
  });

  test('refuses lineage-stale messages with the current head in the explanation', () => {
    const currentHead = '0x3333333333333333333333333333333333333333333333333333333333333333';
    const entry = parseDlqEntry(buildDlqEntry());

    expect(decideReplay(entry, { ...currentState, modelWeightHead: currentHead })).toMatchObject({
      allowed: false,
      reason: 'lineage_stale',
      message: expect.stringContaining(currentHead),
    });
  });

  test('refuses schema-valid messages whose attester signatures no longer authorize the payload', () => {
    const entry = parseDlqEntry(buildDlqEntry());

    expect(
      decideReplay(entry, {
        ...currentState,
        signaturesValid: false,
        signatureError: 'authorized attester signatures 0 below threshold 1',
      }),
    ).toMatchObject({
      allowed: false,
      reason: 'signature_invalid',
      message: expect.stringContaining('authorized attester signatures 0 below threshold 1'),
    });
  });

  test('refuses zero budget and warns on low nonzero budget for budget-exhausted entries', () => {
    const entry = parseDlqEntry(buildDlqEntry());

    expect(decideReplay(entry, { ...currentState, mintBudgetRemaining: 0n })).toMatchObject({
      allowed: false,
      reason: 'budget_empty',
    });

    const lowBudgetDecision = decideReplay(entry, { ...currentState, mintBudgetRemaining: 1n });
    expect(lowBudgetDecision.allowed).toBe(true);
    expect(lowBudgetDecision.warnings).toHaveLength(1);
  });
});
