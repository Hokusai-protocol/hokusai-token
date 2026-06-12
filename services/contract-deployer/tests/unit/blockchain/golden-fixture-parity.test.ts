import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { ethers } from 'ethers';
import {
  MintRequestMessage,
  validateMintRequestMessage,
} from '../../../src/schemas/mint-request-schema';

const VENDORED_FIXTURE_PATH = path.resolve(__dirname, '../../fixtures/mint_request.v1.json');
const KNOWN_ANSWER_PATH = path.resolve(
  __dirname,
  '../../fixtures/mint_request.v1.known_answer.json',
);
const GOLDEN_FIXTURE_PATH = path.resolve(
  __dirname,
  '../../../../../test/fixtures/deltaverifier-mint-request.golden.json',
);

function sha256Hex(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function resolvePipelineRoot(): string | null {
  const override = process.env.HOKUSAI_DATA_PIPELINE_DIR;
  if (override) {
    const candidate = path.resolve(override);
    return fs.existsSync(path.join(candidate, 'schema/examples/mint_request.v1.json'))
      ? candidate
      : null;
  }

  const repoRoot = path.resolve(__dirname, '../../../../..');
  const siblingRoot = path.dirname(repoRoot);
  const preferredNames = ['hokusai-data-pipeline'];

  for (const name of preferredNames) {
    const candidate = path.join(siblingRoot, name);
    if (fs.existsSync(path.join(candidate, 'schema/examples/mint_request.v1.json'))) {
      return candidate;
    }
  }

  for (const entry of fs.readdirSync(siblingRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const candidate = path.join(siblingRoot, entry.name);
    if (fs.existsSync(path.join(candidate, 'schema/examples/mint_request.v1.json'))) {
      return candidate;
    }
  }

  return null;
}

function expectSchemaValid(schemaPath: string, fixture: MintRequestMessage) {
  const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  const valid = validate(fixture);
  expect(valid).toBe(true);
  expect(validate.errors ?? []).toEqual([]);
}

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
  test('vendored fixture validates, matches the canonical contract-side golden subset, and pins the known-answer bytes', () => {
    const fixtureRaw = fs.readFileSync(VENDORED_FIXTURE_PATH);
    const fixture = JSON.parse(fixtureRaw.toString('utf8')) as MintRequestMessage;
    const golden = JSON.parse(fs.readFileSync(GOLDEN_FIXTURE_PATH, 'utf8'));
    const knownAnswer = JSON.parse(fs.readFileSync(KNOWN_ANSWER_PATH, 'utf8')) as {
      fixture_sha256: string;
      signatures: string[];
    };

    const validation = validateMintRequestMessage(fixture);
    expect(validation.error).toBeUndefined();
    expect(sha256Hex(fixtureRaw)).toBe(knownAnswer.fixture_sha256);
    expect(fixture.attester_signatures).toEqual(knownAnswer.signatures);
    expect(canonicalSubset(fixture)).toEqual(golden);
  });

  test('vendored fixture stays byte-identical with the sibling pipeline fixture and validates against pipeline schemas when reachable', () => {
    const pipelineRoot = resolvePipelineRoot();
    const vendoredRaw = fs.readFileSync(VENDORED_FIXTURE_PATH);
    const vendoredFixture = JSON.parse(vendoredRaw.toString('utf8')) as MintRequestMessage;

    if (pipelineRoot === null) {
      console.warn(
        'hokusai-data-pipeline checkout not found; skipping sibling byte/schema parity checks',
      );
      return;
    }

    const siblingFixturePath = path.join(pipelineRoot, 'schema/examples/mint_request.v1.json');
    const siblingRaw = fs.readFileSync(siblingFixturePath);

    expect(sha256Hex(siblingRaw)).toBe(sha256Hex(vendoredRaw));
    expect(Buffer.compare(siblingRaw, vendoredRaw)).toBe(0);
    expectSchemaValid(path.join(pipelineRoot, 'schema/mint_request.v1.json'), vendoredFixture);
    expectSchemaValid(
      path.join(pipelineRoot, 'schema/mint_request.consumer.v1.json'),
      vendoredFixture,
    );
  });
});
