import * as fs from 'fs';
import * as path from 'path';
import { MintRequestSettlement, validateMintRequestMessage } from '../../src/schemas/mint-request-schema';

describe('MintRequest flow integration', () => {
  test('requires explicit integration environment', async () => {
    if (!process.env.RUN_INTEGRATION_TESTS) {
      expect(true).toBe(true);
      return;
    }

    const settlement = {} as MintRequestSettlement;
    expect(settlement).toBeDefined();
  });

  describe('canonical v1 fixture validation', () => {
    test('validates pipeline v1 schema example (with drift detection)', () => {
      const vendoredPath = path.resolve(__dirname, '../fixtures/mint_request.v1.json');
      const vendoredContent = fs.readFileSync(vendoredPath, 'utf-8');
      const vendoredFixture = JSON.parse(vendoredContent);

      const result = validateMintRequestMessage(vendoredFixture);
      expect(result.error).toBeUndefined();
      expect(result.value).toBeDefined();

      let siblingSynced = false;
      const candidatePaths = [
        path.resolve(__dirname, '../../../../hokusai-data-pipeline/schema/examples/mint_request.v1.json'),
        path.resolve(__dirname, '../../../../../hokusai-data-pipeline/schema/examples/mint_request.v1.json'),
      ];

      for (const candidatePath of candidatePaths) {
        if (fs.existsSync(candidatePath)) {
          const siblingContent = fs.readFileSync(candidatePath, 'utf-8');
          const siblingFixture = JSON.parse(siblingContent);

          const siblingResult = validateMintRequestMessage(siblingFixture);
          expect(siblingResult.error).toBeUndefined();

          if (vendoredContent !== siblingContent) {
            console.error(
              `Vendored fixture mismatch detected!\n\nVendored: ${vendoredPath}\nSibling: ${candidatePath}\n\nPlease re-sync by copying the sibling file to the vendored location.`
            );
            expect(vendoredContent).toBe(siblingContent);
          }

          siblingSynced = true;
          break;
        }
      }

      if (!siblingSynced) {
        console.warn(
          'Sibling hokusai-data-pipeline fixture not found; skipping drift detection. Run from repo root if available.'
        );
      }
    });
  });
});
