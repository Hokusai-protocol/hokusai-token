const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const DEFAULT_SCRIPT_PATHS = [
  path.resolve(__dirname, "..", "deploy-mainnet.js"),
  path.resolve(__dirname, "..", "deploy-sepolia.js"),
  path.resolve(__dirname, "deploy-stack.js"),
  path.resolve(__dirname, "deployment-artifact.js"),
];

function toSerializable(value) {
  if (typeof value === "bigint") {
    return value.toString();
  }

  if (Array.isArray(value)) {
    return value.map((entry) => toSerializable(entry));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, toSerializable(entry)])
    );
  }

  return value;
}

function getGitSha() {
  try {
    const sha = execSync("git rev-parse HEAD", {
      cwd: path.resolve(__dirname, "..", ".."),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const dirty = execSync("git status --porcelain", {
      cwd: path.resolve(__dirname, "..", ".."),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim().length > 0;

    return { sha, dirty };
  } catch (error) {
    return { sha: "unknown", dirty: false };
  }
}

function getScriptSha(filePaths = DEFAULT_SCRIPT_PATHS) {
  const hash = crypto.createHash("sha256");
  const resolved = filePaths.map((filepath) => path.resolve(filepath)).sort();

  for (const filepath of resolved) {
    hash.update(filepath);
    hash.update("\n");
    hash.update(fs.readFileSync(filepath));
    hash.update("\n");
  }

  return hash.digest("hex");
}

function buildArtifact({
  deploymentResult,
  network,
  dryRun,
  chainId,
  deployer,
  treasury,
  backendService,
  timestamp = new Date().toISOString(),
  scriptPaths,
}) {
  const artifact = {
    network,
    chainId: chainId.toString(),
    dryRun,
    timestamp,
    git: getGitSha(),
    scriptSha: getScriptSha(scriptPaths),
    deployer,
    treasury,
    backendService: backendService || null,
    contracts: deploymentResult.contracts,
    roles: deploymentResult.roles,
    config: deploymentResult.config,
    gasUsed: deploymentResult.gasUsed,
    notes: deploymentResult.notes,
  };

  return toSerializable(artifact);
}

function resolveArtifactPaths({ network, timestamp, dryRun, baseDir }) {
  const targetDir = baseDir || path.resolve(__dirname, "..", "..", "deployments");
  const safeTimestamp = timestamp.replace(/[:.]/g, "-");
  const datedName = dryRun
    ? `${network}-dryrun-${safeTimestamp}.json`
    : `${network}-${safeTimestamp}.json`;

  return {
    datedPath: path.join(targetDir, datedName),
    latestPath: path.join(targetDir, `${network}-latest.json`),
  };
}

function writeArtifactFiles(artifact, options = {}) {
  const { datedPath, latestPath } = resolveArtifactPaths({
    network: artifact.network,
    timestamp: artifact.timestamp,
    dryRun: artifact.dryRun,
    baseDir: options.baseDir,
  });

  fs.mkdirSync(path.dirname(datedPath), { recursive: true });
  const serialized = `${JSON.stringify(artifact, null, 2)}\n`;
  fs.writeFileSync(datedPath, serialized);

  if (!artifact.dryRun) {
    fs.writeFileSync(latestPath, serialized);
  }

  return { datedPath, latestPath };
}

module.exports = {
  DEFAULT_SCRIPT_PATHS,
  buildArtifact,
  getGitSha,
  getScriptSha,
  resolveArtifactPaths,
  toSerializable,
  writeArtifactFiles,
};
