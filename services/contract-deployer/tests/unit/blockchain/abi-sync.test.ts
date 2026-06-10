import fs from 'fs';
import path from 'path';
import { Interface } from 'ethers';
import serviceArtifact from '../../../contracts/DeltaVerifier.json';

const SUBMIT_MINT_REQUEST_SELECTOR = '0x5d3e811b';
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

  test('service ABI matches Hardhat artifact when present', () => {
    if (!fs.existsSync(HARDHAT_ARTIFACT_PATH)) {
      console.warn(
        `Hardhat artifact not found at ${HARDHAT_ARTIFACT_PATH}; run \`npx hardhat compile\` from the repo root to enable strict comparison`,
      );
      return;
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
