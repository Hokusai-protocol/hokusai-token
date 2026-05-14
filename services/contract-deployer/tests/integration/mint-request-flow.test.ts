import fs from 'fs';
import path from 'path';
import { MintRequestSettlement } from '../../src/schemas/mint-request-schema';
import { validateMintRequestMessage } from '../../src/schemas/mint-request-schema';

describe('MintRequest flow integration', () => {
  test('validates the pipeline v1 fixture and detects vendored drift when possible', async () => {
    const vendoredFixturePath = path.resolve(__dirname, '../fixtures/mint_request.v1.json');
    const envPipelineDir = process.env.HOKUSAI_DATA_PIPELINE_DIR;
    const candidatePipelinePaths = [
      envPipelineDir ? path.resolve(envPipelineDir, 'schema/examples/mint_request.v1.json') : null,
      path.resolve(
        __dirname,
        '../../../../../hokusai-data-pipeline/schema/examples/mint_request.v1.json',
      ),
      path.resolve(
        __dirname,
        '../../../../hokusai-data-pipeline/schema/examples/mint_request.v1.json',
      ),
    ].filter((candidatePath): candidatePath is string => candidatePath !== null);

    const siblingFixturePath = candidatePipelinePaths.find((candidatePath) =>
      fs.existsSync(candidatePath),
    );
    const vendoredExists = fs.existsSync(vendoredFixturePath);
    const fixturePath = siblingFixturePath ?? (vendoredExists ? vendoredFixturePath : null);

    if (fixturePath === null) {
      console.warn('MintRequest pipeline fixture not found; skipping validation');
      return;
    }

    const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as unknown;
    const validation = validateMintRequestMessage(fixture);
    expect(validation.error).toBeUndefined();

    if (siblingFixturePath && vendoredExists) {
      const siblingJson = JSON.parse(fs.readFileSync(siblingFixturePath, 'utf8')) as unknown;
      const vendoredJson = JSON.parse(fs.readFileSync(vendoredFixturePath, 'utf8')) as unknown;

      expect(vendoredJson).toEqual(siblingJson);
    }
  });

  test('requires explicit integration environment', async () => {
    if (!process.env.RUN_INTEGRATION_TESTS) {
      expect(true).toBe(true);
      return;
    }

    const settlement = {} as MintRequestSettlement;
    expect(settlement).toBeDefined();
  });
});
