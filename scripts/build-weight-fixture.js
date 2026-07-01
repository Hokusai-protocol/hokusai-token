const fs = require("fs");
const path = require("path");

const { WEIGHT_COMMITMENT_VERSION } = require("./lib/weight-commitment");

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

function toPosix(value) {
  return value.split(path.sep).join("/");
}

function shouldExclude(relPath) {
  return (
    relPath === "MLmodel" ||
    relPath.startsWith("metadata/") ||
    relPath.includes("registered_model_meta")
  );
}

function comparePathsUtf8(a, b) {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

function collectFiles(rootDir) {
  const records = [];
  const excluded = [];

  function walk(currentDir) {
    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      const fullPath = path.join(currentDir, entry.name);
      const relPath = toPosix(path.relative(rootDir, fullPath));

      if (entry.isSymbolicLink()) {
        excluded.push(relPath);
        continue;
      }
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }
      if (!entry.isFile()) {
        excluded.push(relPath);
        continue;
      }
      if (shouldExclude(relPath)) {
        excluded.push(relPath);
        continue;
      }

      records.push({
        path: relPath,
        hex: `0x${fs.readFileSync(fullPath).toString("hex")}`,
      });
    }
  }

  walk(rootDir);
  records.sort((a, b) => comparePathsUtf8(a.path, b.path));
  excluded.sort(comparePathsUtf8);
  return { records, excluded };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const artifactDir = args["artifact-dir"] || args._[0];
  const modelId = Number(args["model-id"]);
  const outPath = args.out;

  if (!artifactDir || !Number.isInteger(modelId) || !outPath) {
    throw new Error(
      "Usage: node scripts/build-weight-fixture.js --artifact-dir <dir> --model-id <uint> --out <fixture.json>"
    );
  }

  const rootDir = path.resolve(process.cwd(), artifactDir);
  const stat = fs.statSync(rootDir);
  if (!stat.isDirectory()) {
    throw new Error(`Artifact path is not a directory: ${rootDir}`);
  }

  const { records, excluded } = collectFiles(rootDir);
  if (records.length === 0) {
    throw new Error(`No includable files under ${rootDir}`);
  }

  const fixture = {
    version: WEIGHT_COMMITMENT_VERSION,
    modelId,
    artifactDir: rootDir,
    excluded,
    files: records,
  };

  fs.mkdirSync(path.dirname(path.resolve(process.cwd(), outPath)), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(fixture, null, 2)}\n`);
  process.stdout.write(
    `${JSON.stringify({
      modelId,
      out: outPath,
      includedFileCount: records.length,
      excludedFileCount: excluded.length,
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
