import fs from 'fs';
import path from 'path';
import { ethers } from 'ethers';
import {
  MintRequestMessage,
  validateMintRequestMessage,
} from '../../../src/schemas/mint-request-schema';

const VENDORED_FIXTURE_PATH = path.resolve(__dirname, '../../fixtures/mint_request.v1.json');
const GOLDEN_FIXTURE_PATH = path.resolve(
  __dirname,
  '../../../../../test/fixtures/deltaverifier-mint-request.golden.json',
);

function canonicalSubset(message: MintRequestMessage) {
  return {
    modelId: message.model_id_uint,
    pipelineRunId: message.eval_id,
    baselineScoreBps: message.evaluation.baseline_score_bps,
    candidateScoreBps: message.evaluation.new_score_bps,
    maxCostUsdMicro: message.evaluation.max_cost_usd_micro,
    actualCostUsdMicro: message.evaluation.actual_cost_usd_micro,
    totalSamples: message.totalSamples,
    benchmarkSpecHash: ethers.keccak256(ethers.toUtf8Bytes(message.benchmark_spec_id)),
    datasetHash: message.dataset_hash,
    attestationHash: message.attestation_hash,
    idempotencyKey: message.idempotency_key,
    metricName: message.evaluation.metric_name,
    metricFamily: message.evaluation.metric_family,
    baselineCommitment: message.baseline_commitment,
    candidateCommitment: message.candidate_commitment,
    contributors: message.contributors.map((contributor) => ({
      walletAddress: contributor.wallet_address.toLowerCase(),
      weight: contributor.weight_bps,
    })),
  };
}

describe('MintRequest golden fixture parity', () => {
  test('vendored fixture validates and matches the canonical contract-side golden subset', () => {
    const fixture = JSON.parse(
      fs.readFileSync(VENDORED_FIXTURE_PATH, 'utf8'),
    ) as MintRequestMessage;
    const golden = JSON.parse(fs.readFileSync(GOLDEN_FIXTURE_PATH, 'utf8'));

    const validation = validateMintRequestMessage(fixture);
    expect(validation.error).toBeUndefined();
    expect(canonicalSubset(fixture)).toEqual(golden);
  });
});
