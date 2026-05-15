// Source of truth for regenerating the bundled DeltaVerifier ABI — invoked by `npm run sync:abi`.
import fs from 'fs';
import path from 'path';

const SCRIPT_DIR = __dirname;
const SOURCE_PATH = path.resolve(SCRIPT_DIR, '../../..', 'artifacts/contracts/DeltaVerifier.sol/DeltaVerifier.json');
const TARGET_PATH = path.resolve(SCRIPT_DIR, '../contracts/DeltaVerifier.json');

const checkMode = process.argv.includes('--check');

function main(): void {
  if (!fs.existsSync(SOURCE_PATH)) {
    process.stderr.write(
      `Hardhat artifact not found at ${SOURCE_PATH}; run \`npx hardhat compile\` from the repo root.\n`,
    );
    process.exit(1);
  }

  const sourceRaw = fs.readFileSync(SOURCE_PATH, 'utf-8');
  const sourceObj = JSON.parse(sourceRaw);
  const regenerated = JSON.stringify(sourceObj, null, 2) + '\n';

  if (checkMode) {
    if (!fs.existsSync(TARGET_PATH)) {
      process.stderr.write('Bundled service ABI missing — run `npm run sync:abi`.\n');
      process.exit(1);
    }

    const targetRaw = fs.readFileSync(TARGET_PATH, 'utf-8');
    if (targetRaw === regenerated) {
      process.stdout.write('in-sync\n');
      process.exit(0);
    }

    process.stderr.write(
      'DeltaVerifier ABI drift detected: bundled service artifact differs from Hardhat artifact.\n' +
        'Run `npm run sync:abi` to regenerate.\n',
    );
    process.exit(1);
  }

  const targetRaw = fs.existsSync(TARGET_PATH) ? fs.readFileSync(TARGET_PATH, 'utf-8') : null;
  if (targetRaw === regenerated) {
    process.stdout.write('already in-sync, no write needed\n');
    process.exit(0);
  }

  fs.writeFileSync(TARGET_PATH, regenerated);
  process.stdout.write('synced\n');
}

main();
