const fs = require("fs");
const path = require("path");

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const resolved = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return walk(resolved);
    }

    return resolved.endsWith(".json") ? [resolved] : [];
  });
}

function main() {
  const artifactsDir = path.join(__dirname, "..", "artifacts", "contracts");
  const rows = walk(artifactsDir)
    .map((artifactPath) => {
      const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
      if (!artifact.deployedBytecode || artifact.deployedBytecode === "0x") {
        return null;
      }

      return {
        contract: artifact.contractName,
        runtimeBytes: (artifact.deployedBytecode.length - 2) / 2,
      };
    })
    .filter(Boolean)
    .sort((left, right) => right.runtimeBytes - left.runtimeBytes);

  if (rows.length === 0) {
    throw new Error("No compiled contract artifacts with deployed bytecode were found");
  }

  const contractWidth = Math.max(...rows.map((row) => row.contract.length), "Contract".length);
  const sizeWidth = Math.max(...rows.map((row) => String(row.runtimeBytes).length), "Runtime Bytes".length);

  console.log(`${"Contract".padEnd(contractWidth)}  ${"Runtime Bytes".padStart(sizeWidth)}`);
  console.log(`${"-".repeat(contractWidth)}  ${"-".repeat(sizeWidth)}`);

  for (const row of rows) {
    console.log(`${row.contract.padEnd(contractWidth)}  ${String(row.runtimeBytes).padStart(sizeWidth)}`);
  }
}

main();
