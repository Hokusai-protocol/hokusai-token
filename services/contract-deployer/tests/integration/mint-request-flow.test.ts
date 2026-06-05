import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { ethers } from 'ethers';
import DeltaVerifierArtifact from '../../contracts/DeltaVerifier.json';
import { MintRequestMessage } from '../../src/schemas/mint-request-schema';
import { MintRequestProcessor } from '../../src/services/mint-request-processor';

const VENDORED_FIXTURE_PATH = path.resolve(__dirname, '../fixtures/mint_request.v1.json');
const SUBMIT_MINT_REQUEST_SELECTOR = '0xb6370507';
type MintRequestFixture = MintRequestMessage & {
  totalSamples: number;
  evaluation: MintRequestMessage['evaluation'] & {
    sample_size_candidate: number;
  };
};

function findSiblingPipelineFixture(): string | null {
  const workspaceRoot = path.resolve(__dirname, '../../../..');
  const siblingRoot = path.dirname(workspaceRoot);
  const preferredNames = [
    'hokusai-data-pipeline',
    'gate-2-cross-repo-mintrequest-deltaverifier-abi-conformance',
  ];

  for (const name of preferredNames) {
    const candidate = path.join(siblingRoot, name, 'schema/examples/mint_request.v1.json');
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  for (const entry of fs.readdirSync(siblingRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const candidate = path.join(siblingRoot, entry.name, 'schema/examples/mint_request.v1.json');
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function loadFixture(): { fixture: MintRequestFixture; raw: string; sourcePath: string } {
  const siblingPath = findSiblingPipelineFixture();
  const sourcePath = siblingPath ?? VENDORED_FIXTURE_PATH;
  const raw = fs.readFileSync(sourcePath, 'utf8');
  return {
    fixture: JSON.parse(raw) as MintRequestFixture,
    raw,
    sourcePath,
  };
}

describe('MintRequest flow integration', () => {
  test('fixture stays byte-identical with the vendored copy when a sibling pipeline checkout exists', () => {
    const siblingPath = findSiblingPipelineFixture();
    const vendoredRaw = fs.readFileSync(VENDORED_FIXTURE_PATH, 'utf8');

    if (!siblingPath) {
      expect(vendoredRaw.length).toBeGreaterThan(0);
      return;
    }

    const siblingRaw = fs.readFileSync(siblingPath, 'utf8');
    expect(vendoredRaw).toBe(siblingRaw);
  });

  test('maps the golden fixture into submitMintRequest calldata', () => {
    const { fixture, sourcePath } = loadFixture();
    const processor = new MintRequestProcessor({ submitMintRequest: jest.fn() } as any);
    const payload = (processor as any).buildPayload(fixture);
    const contributors = (processor as any).buildContributors(fixture);
    const modelId = BigInt(fixture.model_id_uint);
    const calldata = new ethers.Interface(DeltaVerifierArtifact.abi).encodeFunctionData(
      'submitMintRequest',
      [modelId, payload, contributors],
    );
    const bareAttestationHash = fixture.attestation_hash.slice(2);
    const expectedIdempotencyKey =
      '0x' +
      createHash('sha256')
        .update(`${fixture.model_id_uint}:${bareAttestationHash}`, 'utf8')
        .digest('hex');

    expect(sourcePath.endsWith('mint_request.v1.json')).toBe(true);
    expect(calldata.startsWith(SUBMIT_MINT_REQUEST_SELECTOR)).toBe(true);
    expect(payload.anchors.benchmarkSpecHash).toBe(
      ethers.keccak256(ethers.toUtf8Bytes(fixture.benchmark_spec_id)),
    );
    expect(payload.anchors.benchmarkSpecHash).not.toBe(ethers.ZeroHash);
    expect(payload.anchors.datasetHash).toBe(fixture.dataset_hash);
    expect(payload.anchors.datasetHash).not.toBe(ethers.ZeroHash);
    expect(payload.anchors.attestationHash).toBe(fixture.attestation_hash);
    expect(payload.anchors.attestationHash).not.toBe(ethers.ZeroHash);
    expect(payload.anchors.idempotencyKey).toBe(fixture.idempotency_key);
    expect(payload.anchors.idempotencyKey).toBe(expectedIdempotencyKey);
    expect(payload.anchors.idempotencyKey).not.toBe(ethers.ZeroHash);
    expect(payload.baselineScoreBps).toBe(fixture.evaluation.baseline_score_bps);
    expect(payload.candidateScoreBps).toBe(fixture.evaluation.new_score_bps);
    expect(payload.maxCostUsdMicro).toBe(fixture.evaluation.max_cost_usd_micro);
    expect(payload.actualCostUsdMicro).toBe(fixture.evaluation.actual_cost_usd_micro);
    expect(modelId).toBe(BigInt(fixture.model_id_uint));
    expect(fixture.totalSamples).toBe(fixture.evaluation.sample_size_candidate);
    expect(
      contributors.reduce(
        (sum: number, contributor: { weight: number }) => sum + contributor.weight,
        0,
      ),
    ).toBe(10000);
    expect(
      contributors.map((contributor: { walletAddress: string }) => contributor.walletAddress),
    ).toEqual(fixture.contributors.map((contributor) => contributor.wallet_address));
  });
});
