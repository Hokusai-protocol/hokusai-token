import fs from 'fs';
import path from 'path';
import { Interface } from 'ethers';
import serviceArtifact from '../../../contracts/DeltaVerifier.json';

// Deadline-aware selector (HOK-2170). Update in lockstep with any submitMintRequest signature
// change AND re-sync contracts/DeltaVerifier.json. A stale vendored ABI shipped once (missing
// `deadline`) precisely because the old pin matched the stale copy and the artifact comparison
// silently skipped in CI — both are now hardened below.
const SUBMIT_MINT_REQUEST_SELECTOR = '0xaf829f8e';
const HARDHAT_ARTIFACT_PATH = path.resolve(
  __dirname,
  '../../../../..',
  'artifacts/contracts/DeltaVerifier.sol/DeltaVerifier.json',
);

describe('DeltaVerifier ABI sync guard', () => {
  test('service ABI exposes submitMintRequest with the pinned selector', () => {
    const iface = new Interface(serviceArtifact.abi);
    const fn = iface.getFunction('submitMintRequest');
    expect(fn).not.toBeNull();
    expect(fn!.selector).toBe(SUBMIT_MINT_REQUEST_SELECTOR);
  });

  test('service ABI submitMintRequest tuple includes totalSamples uint256', () => {
    const fragment = serviceArtifact.abi.find(
      (f: any) => f.type === 'function' && f.name === 'submitMintRequest',
    );
    expect(fragment).toBeDefined();

    const payloadInput = (fragment as any).inputs.find(
      (i: any) => i.type === 'tuple' && i.name === 'payload',
    );
    expect(payloadInput).toBeDefined();

    const totalSamplesComponent = payloadInput.components.find(
      (c: any) => c.name === 'totalSamples',
    );
    expect(totalSamplesComponent).toBeDefined();
    expect(totalSamplesComponent.type).toBe('uint256');
  });

  // HOK-2170: always-on guard (no compiled artifact needed) that directly catches the
  // missing-deadline regression. The vendored ABI must carry the signed deadline field.
  test('service ABI submitMintRequest tuple includes deadline uint256', () => {
    const fragment = serviceArtifact.abi.find(
      (f: any) => f.type === 'function' && f.name === 'submitMintRequest',
    );
    const payloadInput = (fragment as any).inputs.find(
      (i: any) => i.type === 'tuple' && i.name === 'payload',
    );
    const deadline = payloadInput.components.find((c: any) => c.name === 'deadline');
    expect(deadline).toBeDefined();
    expect(deadline.type).toBe('uint256');
  });

  test('service ABI matches the compiled Hardhat artifact (strict, no skip)', () => {
    // Previously this silently returned when the artifact was absent, so the structural
    // comparison NEVER ran in CI and a stale vendored ABI shipped. It now fails loudly:
    // CI compiles contracts before this job (see .github/workflows/ci.yml), and locally you
    // must `npx hardhat compile` from the repo root first.
    if (!fs.existsSync(HARDHAT_ARTIFACT_PATH)) {
      throw new Error(
        `Hardhat artifact missing at ${HARDHAT_ARTIFACT_PATH}. Run \`npx hardhat compile\` from the repo root, then re-run (CI compiles automatically).`,
      );
    }

    const hardhatArtifact = JSON.parse(fs.readFileSync(HARDHAT_ARTIFACT_PATH, 'utf-8'));

    const serviceFragment = serviceArtifact.abi.find(
      (f: any) => f.type === 'function' && f.name === 'submitMintRequest',
    );
    const hardhatFragment = hardhatArtifact.abi.find(
      (f: any) => f.type === 'function' && f.name === 'submitMintRequest',
    );

    expect(hardhatFragment).toBeDefined();

    const normalizeInputs = (inputs: any[]): any[] =>
      inputs.map((input: any) => ({
        name: input.name,
        type: input.type,
        ...(input.components ? { components: normalizeInputs(input.components) } : {}),
      }));

    expect(normalizeInputs((serviceFragment as any).inputs)).toEqual(
      normalizeInputs(hardhatFragment!.inputs),
    );

    const hardhatIface = new Interface(hardhatArtifact.abi);
    const hardhatFn = hardhatIface.getFunction('submitMintRequest');
    expect(hardhatFn!.selector).toBe(SUBMIT_MINT_REQUEST_SELECTOR);
  });
});
