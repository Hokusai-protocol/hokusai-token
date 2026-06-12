import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { ethers } from 'ethers';
import DeltaVerifierArtifact from '../../../contracts/DeltaVerifier.json';
import {
  MintRequestMessage,
  validateMintRequestMessage,
} from '../../../src/schemas/mint-request-schema';
import { MintRequestProcessor } from '../../../src/services/mint-request-processor';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const sharedEip712 = require('../../../../../shared/mint-request-eip712');
const { MINT_REQUEST_EIP712_TYPES, EIP712_DOMAIN } = sharedEip712;

const VENDORED_FIXTURE_PATH = path.resolve(__dirname, '../../fixtures/mint_request.v1.json');
const GOLDEN_FIXTURE_PATH = path.resolve(
  __dirname,
  '../../../../../test/fixtures/deltaverifier-mint-request.golden.json',
);
const KNOWN_ANSWER_PATH = path.resolve(
  __dirname,
  '../../../../../test/fixtures/deltaverifier-mint-request.known-answer.json',
);
// Repo root is 5 levels up; the pipeline checkout sits NEXT TO the repo root (6 levels up),
// matching the scheduled cross-repo workflow's checkout layout.
const PIPELINE_SIBLING_PATH = path.resolve(
  __dirname,
  '../../../../../../hokusai-data-pipeline/schema/examples/mint_request.v1.json',
);

interface KnownAnswer {
  structHash: string;
  domain: {
    name: string;
    version: string;
    chainId: number;
    verifyingContract: string;
  };
  typedDataDigest: string;
  submitCalldata: string;
  signatures: string[];
  signerAddresses: string[];
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

// The PRODUCTION fixture→contract mapping. Tests below hash and ABI-encode exactly what
// MintRequestProcessor would submit, so any drift in its mapping breaks the known answer.
const processor = new MintRequestProcessor({ submitMintRequest: jest.fn() } as never);

function buildEip712ValueFromMessage(message: MintRequestMessage) {
  return {
    modelId: BigInt(message.model_id_uint),
    payload: processor.buildPayload(message),
    contributors: processor.buildContributors(message),
  };
}

function sha256File(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath, 'utf8')).digest('hex');
}

describe('MintRequest golden fixture parity', () => {
  const fixture = JSON.parse(fs.readFileSync(VENDORED_FIXTURE_PATH, 'utf8')) as MintRequestMessage;
  const golden = JSON.parse(fs.readFileSync(GOLDEN_FIXTURE_PATH, 'utf8'));
  const knownAnswer: KnownAnswer = JSON.parse(fs.readFileSync(KNOWN_ANSWER_PATH, 'utf8'));

  test('vendored fixture validates against Joi schema', () => {
    const validation = validateMintRequestMessage(fixture);
    expect(validation.error).toBeUndefined();
  });

  test('vendored fixture canonical subset matches the contract-side golden fixture', () => {
    expect(canonicalSubset(fixture)).toEqual(golden);
  });

  describe('assertion A — digest parity (consumer side)', () => {
    test('production buildPayload + pinned domain produces the committed structHash', () => {
      const value = buildEip712ValueFromMessage(fixture);
      const structHash = ethers.TypedDataEncoder.hashStruct(
        'MintRequest',
        MINT_REQUEST_EIP712_TYPES,
        value,
      );
      expect(structHash).toBe(knownAnswer.structHash);
    });

    test('production buildPayload + pinned domain produces the committed typedDataDigest', () => {
      const value = buildEip712ValueFromMessage(fixture);
      const typedDataDigest = ethers.TypedDataEncoder.hash(
        knownAnswer.domain,
        MINT_REQUEST_EIP712_TYPES,
        value,
      );
      expect(typedDataDigest).toBe(knownAnswer.typedDataDigest);
    });

    test('production processor mapping produces the committed submitMintRequest calldata, byte-equal', () => {
      const calldata = new ethers.Interface(DeltaVerifierArtifact.abi).encodeFunctionData(
        'submitMintRequest',
        [
          BigInt(fixture.model_id_uint),
          processor.buildPayload(fixture),
          processor.buildContributors(fixture),
          knownAnswer.signatures,
        ],
      );
      expect(calldata).toBe(knownAnswer.submitCalldata);
    });
  });

  describe('assertion B — wire parity', () => {
    test('vendored fixture is byte-identical (SHA256) to sibling pipeline copy', () => {
      const strict = process.env['STRICT_CROSS_REPO'] === '1';
      if (!fs.existsSync(PIPELINE_SIBLING_PATH)) {
        if (strict) {
          throw new Error(
            `STRICT_CROSS_REPO=1 but sibling pipeline fixture not found at ${PIPELINE_SIBLING_PATH}. ` +
              'The cross-repo workflow must check out hokusai-data-pipeline next to this repo.',
          );
        }
        console.log(
          `SKIP: sibling pipeline fixture not found at ${PIPELINE_SIBLING_PATH}. ` +
            'This check runs in the scheduled cross-repo CI job.',
        );
        return;
      }
      const vendoredHash = sha256File(VENDORED_FIXTURE_PATH);
      const siblingHash = sha256File(PIPELINE_SIBLING_PATH);
      if (strict) {
        expect(vendoredHash).toBe(siblingHash);
      } else if (vendoredHash !== siblingHash) {
        console.warn(
          'WARN: vendored fixture differs from sibling pipeline copy. ' +
            'This is expected if the pipeline mirror PR has not landed yet. ' +
            'Set STRICT_CROSS_REPO=1 to enforce strict byte parity.',
        );
      }
    });
  });

  describe('EIP-712 types structural parity', () => {
    test('shared JS module exposes the expected EIP-712 type structure', () => {
      expect(MINT_REQUEST_EIP712_TYPES).toHaveProperty('MintRequest');
      expect(MINT_REQUEST_EIP712_TYPES).toHaveProperty('MintRequestPayload');
      expect(MINT_REQUEST_EIP712_TYPES).toHaveProperty('BenchmarkAnchors');
      expect(MINT_REQUEST_EIP712_TYPES).toHaveProperty('Contributor');
      expect(EIP712_DOMAIN.name).toBe('HokusaiDeltaVerifier');
      expect(EIP712_DOMAIN.version).toBe('1');
    });
  });
});
