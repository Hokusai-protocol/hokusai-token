const fs = require("fs");
const path = require("path");

const {
  WEIGHT_COMMITMENT_VERSION,
  computeWeightCommitment,
} = require("./lib/weight-commitment");

function parseArgs(argv) {
  const parsed = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      parsed._.push(arg);
      continue;
    }

    const [key, inlineValue] = arg.slice(2).split("=");
    if (inlineValue !== undefined) {
      parsed[key] = inlineValue;
      continue;
    }

    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      parsed[key] = next;
      index += 1;
      continue;
    }

    parsed[key] = true;
  }

  return parsed;
}

function loadFixture(fixturePath) {
  const resolvedPath = path.resolve(process.cwd(), fixturePath);
  const fixture = JSON.parse(fs.readFileSync(resolvedPath, "utf8"));
  if (fixture.version !== WEIGHT_COMMITMENT_VERSION) {
    throw new Error(
      `Unexpected fixture version ${fixture.version}; expected ${WEIGHT_COMMITMENT_VERSION}`
    );
  }

  return fixture;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const fixturePath = args.fixture || args._[0];
  if (!fixturePath) {
    throw new Error("Usage: node scripts/compute-weight-genesis.js --fixture <path> [--check <0x...>]");
  }

  const fixture = loadFixture(fixturePath);
  const commitment = computeWeightCommitment(
    fixture.files.map((entry) => ({
      path: entry.path,
      bytes: Buffer.from(entry.hex.replace(/^0x/, ""), "hex"),
    }))
  );

  if (args.check) {
    if (commitment.root.toLowerCase() !== String(args.check).toLowerCase()) {
      throw new Error(
        `Weight commitment mismatch: expected ${args.check}, got ${commitment.root}`
      );
    }
  }

  process.stdout.write(
    `${JSON.stringify({
      modelId: fixture.modelId,
      commitmentHex: commitment.root,
      version: commitment.version,
    }, null, 2)}\n`
  );
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.message || error);
    process.exitCode = 1;
  }
}
