#!/usr/bin/env node

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const isReportMode = process.argv.includes("--report");
const repoRoot = path.resolve(__dirname, "..");
const baselinePath = path.join(repoRoot, "slither-baseline.json");
const configPath = path.join(repoRoot, "slither.config.json");
const slitherBinary = process.env.SLITHER_BIN || "slither";

const CATEGORY_DETECTORS = {
  "reentrancy risks": new Set([
    "reentrancy-balance",
    "reentrancy-eth",
    "reentrancy-no-eth",
    "reentrancy-benign",
    "reentrancy-events",
    "reentrancy-unlimited-gas"
  ]),
  "unsafe delegatecalls": new Set([
    "controlled-delegatecall",
    "delegatecall-loop"
  ]),
  "uninitialized storage": new Set([
    "uninitialized-state",
    "uninitialized-storage",
    "uninitialized-local"
  ]),
  "tx.origin misuse": new Set([
    "tx-origin"
  ]),
  "shadowing issues": new Set([
    "shadowing-state",
    "shadowing-abstract",
    "shadowing-local",
    "shadowing-builtin"
  ]),
  "upgradeability hazards": new Set([
    "unprotected-upgrade",
    "function-init-state"
  ]),
  "access control problems": new Set([
    "suicidal",
    "arbitrary-send-eth",
    "arbitrary-send-erc20",
    "arbitrary-send-erc20-permit",
    "incorrect-modifier"
  ])
};

const CATEGORY_ORDER = Object.keys(CATEGORY_DETECTORS);
const GATING_IMPACTS = new Set(["High", "Medium"]);

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`Failed to parse ${label} at ${filePath}: ${error.message}`);
  }
}

function buildAcceptedFindingIds(baseline) {
  const accepted = new Set();
  for (const entry of baseline.accepted || []) {
    if (typeof entry.id === "string" && entry.id.trim() !== "") {
      accepted.add(entry.id);
    }
  }
  return accepted;
}

function getDetectorName(finding) {
  return finding.check || finding.detector || finding.argument || "unknown";
}

function getImpact(finding) {
  return finding.impact || finding.severity || "Unknown";
}

function getCategory(detector) {
  for (const [category, detectors] of Object.entries(CATEGORY_DETECTORS)) {
    if (detectors.has(detector)) {
      return category;
    }
  }
  return null;
}

function isRelevantFinding(finding) {
  return finding && typeof finding === "object" && (finding.check || finding.detector);
}

function isIgnoredFinding(finding) {
  const firstElement = Array.isArray(finding.elements) ? finding.elements[0] : null;
  const sourceMapping = firstElement?.source_mapping;
  const filename =
    sourceMapping?.filename_relative ||
    sourceMapping?.filename_short ||
    sourceMapping?.filename_absolute ||
    "";

  return Boolean(
    sourceMapping?.is_dependency ||
    filename.startsWith("node_modules/") ||
    filename.includes("/node_modules/") ||
    filename.startsWith("contracts/mocks/") ||
    filename.includes("/contracts/mocks/")
  );
}

function getFindings(slitherJson) {
  const results = slitherJson?.results?.detectors;
  if (Array.isArray(results)) {
    return results.filter((finding) => isRelevantFinding(finding) && !isIgnoredFinding(finding));
  }
  return [];
}

function formatLocation(finding) {
  const firstElement = Array.isArray(finding.elements) ? finding.elements[0] : null;
  const sourceMapping = firstElement?.source_mapping;
  const filename =
    sourceMapping?.filename_relative ||
    sourceMapping?.filename_short ||
    sourceMapping?.filename_absolute ||
    "unknown";
  const lines = sourceMapping?.lines;
  if (Array.isArray(lines) && lines.length > 0) {
    const firstLine = lines[0];
    const lastLine = lines[lines.length - 1];
    return firstLine === lastLine ? `${filename}:${firstLine}` : `${filename}:${firstLine}-${lastLine}`;
  }
  return filename;
}

function summarizeFinding(finding) {
  const detector = getDetectorName(finding);
  const impact = getImpact(finding);
  const category = getCategory(detector);
  return {
    id: finding.id || `${detector}:${formatLocation(finding)}`,
    detector,
    impact,
    category,
    description: finding.description || finding.markdown || detector,
    location: formatLocation(finding)
  };
}

function isCompileFailure(runResult, jsonPath) {
  if (runResult.status === 0 || runResult.status === 255) {
    return false;
  }
  if (!fs.existsSync(jsonPath)) {
    return true;
  }
  return fs.statSync(jsonPath).size === 0;
}

function runSlither() {
  const outputPath = path.join(
    os.tmpdir(),
    `slither-report-${process.pid}-${Date.now()}.json`
  );
  const result = spawnSync(
    slitherBinary,
    [".", "--config-file", configPath, "--json", outputPath, "--disable-color"],
    {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 50
    }
  );

  if (isCompileFailure(result, outputPath)) {
    const stderr = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(
      `Slither failed before producing JSON output.\n${stderr || "No compiler output was captured."}`
    );
  }

  const parsed = readJson(outputPath, "Slither JSON report");
  fs.unlinkSync(outputPath);
  return { parsed, result };
}

function printSummary(summaryRows) {
  const maxCategoryLength = Math.max(...summaryRows.map((row) => row.category.length));
  console.log("Category Summary");
  for (const row of summaryRows) {
    console.log(
      `${row.category.padEnd(maxCategoryLength)}  gating=${String(row.gating).padStart(2)}  accepted=${String(row.accepted).padStart(2)}  total=${String(row.total).padStart(2)}`
    );
  }
}

function printFindings(title, findings) {
  if (findings.length === 0) {
    return;
  }
  console.log(`\n${title}`);
  for (const finding of findings) {
    const category = finding.category ? ` [${finding.category}]` : "";
    console.log(
      `- ${finding.detector} (${finding.impact})${category} at ${finding.location} [id=${finding.id}]`
    );
  }
}

function main() {
  const baseline = readJson(baselinePath, "Slither baseline");
  const acceptedIds = buildAcceptedFindingIds(baseline);
  const { parsed } = runSlither();
  const findings = getFindings(parsed).map(summarizeFinding);

  const acceptedFindings = [];
  const gatingFindings = [];
  const warningFindings = [];
  const summary = new Map(
    CATEGORY_ORDER.map((category) => [category, { category, gating: 0, accepted: 0, total: 0 }])
  );

  for (const finding of findings) {
    const category = finding.category;
    if (category) {
      summary.get(category).total += 1;
    }

    if (acceptedIds.has(finding.id)) {
      acceptedFindings.push(finding);
      if (category) {
        summary.get(category).accepted += 1;
      }
      continue;
    }

    const shouldGate = Boolean(category) || GATING_IMPACTS.has(finding.impact);
    if (shouldGate) {
      gatingFindings.push(finding);
      if (category) {
        summary.get(category).gating += 1;
      }
    } else {
      warningFindings.push(finding);
    }
  }

  printSummary(CATEGORY_ORDER.map((category) => summary.get(category)));
  printFindings("Gating Findings", gatingFindings);
  printFindings("Accepted Findings", acceptedFindings);
  printFindings("Non-gating Warnings", warningFindings);

  if (isReportMode) {
    console.log("\nReport mode enabled; exiting 0 regardless of findings.");
    process.exit(0);
  }

  if (gatingFindings.length > 0) {
    console.error(`\nSlither gate failed with ${gatingFindings.length} gating finding(s).`);
    process.exit(1);
  }

  console.log("\nSlither gate passed.");
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
