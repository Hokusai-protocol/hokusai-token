import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

interface MintRequestContributor {
  wallet_address: string;
  weight_bps: number;
}

interface MintRequestFixture {
  model_id_uint: number;
  eval_id: string;
  attestation_hash: string;
  baseline_score_bps: number;
  new_score_bps: number;
  cost: {
    max_cost_usd: number;
    actual_cost_usd: number;
  };
  contributors: MintRequestContributor[];
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../../..");
const require = createRequire(import.meta.url);
const { Interface, getAddress } = require("ethers") as typeof import("ethers");

const abiArtifact = JSON.parse(
  readFileSync(
    path.join(repoRoot, "tools/deltaone-simulator/abis/DeltaVerifier.json"),
    "utf8"
  )
) as { abi: unknown[] };

const fixture = JSON.parse(
  readFileSync(
    path.join(__dirname, "../fixtures/wavemill-sample.json"),
    "utf8"
  )
) as MintRequestFixture;

function fail(message: string): never {
  throw new Error(`Invalid MintRequest fixture: ${message}`);
}

function assertIntegerInRange(
  value: unknown,
  label: string,
  min: number,
  max?: number
): number {
  if (!Number.isInteger(value)) {
    fail(`${label} must be an integer`);
  }

  const parsed = Number(value);
  if (parsed < min) {
    fail(`${label} must be >= ${min}`);
  }

  if (max !== undefined && parsed > max) {
    fail(`${label} must be <= ${max}`);
  }

  return parsed;
}

function assertBytes32Hex(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    fail(`${label} must be a 0x-prefixed 32-byte hex string`);
  }

  return value;
}

function assertNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(`${label} must be a non-empty string`);
  }

  return value;
}

function buildArgs(input: MintRequestFixture) {
  const modelId = assertIntegerInRange(input.model_id_uint, "model_id_uint", 0);
  const evalId = assertNonEmptyString(input.eval_id, "eval_id");

  // The v1 relayer path keeps attestation_hash off-chain, but the fixture still validates it.
  assertBytes32Hex(input.attestation_hash, "attestation_hash");

  const baselineScore = assertIntegerInRange(
    input.baseline_score_bps,
    "baseline_score_bps",
    0,
    10000
  );
  const newScore = assertIntegerInRange(
    input.new_score_bps,
    "new_score_bps",
    0,
    10000
  );
  const maxCostUsd = assertIntegerInRange(
    input.cost?.max_cost_usd,
    "cost.max_cost_usd",
    0
  );
  const actualCostUsd = assertIntegerInRange(
    input.cost?.actual_cost_usd,
    "cost.actual_cost_usd",
    0
  );

  if (!Array.isArray(input.contributors) || input.contributors.length === 0) {
    fail("contributors must contain at least one entry");
  }

  if (input.contributors.length > 100) {
    fail("contributors must contain at most 100 entries");
  }

  const seenAddresses = new Set<string>();
  const contributors = input.contributors.map((contributor, index) => {
    const walletAddress = getAddress(
      assertNonEmptyString(
        contributor.wallet_address,
        `contributors[${index}].wallet_address`
      )
    );
    const normalizedKey = walletAddress.toLowerCase();

    if (normalizedKey === "0x0000000000000000000000000000000000000000") {
      fail(`contributors[${index}].wallet_address must not be the zero address`);
    }

    if (seenAddresses.has(normalizedKey)) {
      fail(`contributors[${index}].wallet_address must be unique`);
    }
    seenAddresses.add(normalizedKey);

    const weight = assertIntegerInRange(
      contributor.weight_bps,
      `contributors[${index}].weight_bps`,
      1,
      10000
    );

    return {
      walletAddress,
      weight
    };
  });

  const totalWeight = contributors.reduce(
    (sum, contributor) => sum + contributor.weight,
    0
  );
  if (totalWeight !== 10000) {
    fail(`contributors weight sum must equal 10000, received ${totalWeight}`);
  }

  return [
    modelId,
    {
      pipelineRunId: evalId,
      baselineMetrics: {
        accuracy: baselineScore,
        precision: 0,
        recall: 0,
        f1: 0,
        auroc: 0
      },
      newMetrics: {
        accuracy: newScore,
        precision: 0,
        recall: 0,
        f1: 0,
        auroc: 0
      },
      maxCostUsd,
      actualCostUsd
    },
    contributors
  ] as const;
}

function normalizeMetrics(metrics: {
  accuracy: bigint;
  precision: bigint;
  recall: bigint;
  f1: bigint;
  auroc: bigint;
}) {
  return {
    accuracy: metrics.accuracy,
    precision: metrics.precision,
    recall: metrics.recall,
    f1: metrics.f1,
    auroc: metrics.auroc
  };
}

const iface = new Interface(abiArtifact.abi);
const functionName = "submitEvaluationWithMultipleContributors";
const args = buildArgs(fixture);
const calldata = iface.encodeFunctionData(functionName, args);
const decoded = iface.decodeFunctionData(functionName, calldata).toObject();

assert.equal(decoded.modelId, BigInt(args[0]));
assert.deepEqual(
  {
    pipelineRunId: decoded.data.pipelineRunId,
    baselineMetrics: normalizeMetrics(decoded.data.baselineMetrics.toObject()),
    newMetrics: normalizeMetrics(decoded.data.newMetrics.toObject()),
    maxCostUsd: decoded.data.maxCostUsd,
    actualCostUsd: decoded.data.actualCostUsd
  },
  {
  pipelineRunId: args[1].pipelineRunId,
  baselineMetrics: {
    accuracy: BigInt(args[1].baselineMetrics.accuracy),
    precision: 0n,
    recall: 0n,
    f1: 0n,
    auroc: 0n
  },
  newMetrics: {
    accuracy: BigInt(args[1].newMetrics.accuracy),
    precision: 0n,
    recall: 0n,
    f1: 0n,
    auroc: 0n
  },
  maxCostUsd: BigInt(args[1].maxCostUsd),
  actualCostUsd: BigInt(args[1].actualCostUsd)
});
assert.deepEqual(normalizeMetrics(decoded.data.baselineMetrics.toObject()), {
  accuracy: BigInt(args[1].baselineMetrics.accuracy),
  precision: 0n,
  recall: 0n,
  f1: 0n,
  auroc: 0n
});
assert.deepEqual(normalizeMetrics(decoded.data.newMetrics.toObject()), {
  accuracy: BigInt(args[1].newMetrics.accuracy),
  precision: 0n,
  recall: 0n,
  f1: 0n,
  auroc: 0n
});
assert.deepEqual(
  decoded.contributors.map((contributor: { toObject(): { walletAddress: string; weight: bigint } }) =>
    contributor.toObject()
  ),
  args[2].map((contributor) => ({
    walletAddress: contributor.walletAddress,
    weight: BigInt(contributor.weight)
  }))
);

const output = {
  fixture,
  contractCall: {
    function: functionName,
    modelId: args[0],
    data: args[1],
    contributors: args[2]
  },
  calldata
};

console.log(JSON.stringify(output, null, 2));
