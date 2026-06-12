const { ethers } = require("hardhat");

function flipBytes32(value) {
  const suffix = value.endsWith("0") ? "1" : "0";
  return `${value.slice(0, -1)}${suffix}`;
}

function mutateString(value, suffix) {
  return `${value}${suffix}`;
}

function clonePayload(payload) {
  return {
    ...payload,
    anchors: {
      ...payload.anchors,
    },
  };
}

function cloneContributors(contributors) {
  return contributors.map((contributor) => ({ ...contributor }));
}

const MUTATIONS = [
  {
    name: "modelId",
    mutate({ modelId, payload, contributors }) {
      return { modelId: modelId + 1n, payload: clonePayload(payload), contributors: cloneContributors(contributors) };
    },
  },
  {
    name: "payload.pipelineRunId",
    mutate({ modelId, payload, contributors }) {
      return {
        modelId,
        payload: { ...clonePayload(payload), pipelineRunId: mutateString(payload.pipelineRunId, "-mutated") },
        contributors: cloneContributors(contributors),
      };
    },
  },
  {
    name: "payload.baselineScoreBps",
    mutate({ modelId, payload, contributors }) {
      return {
        modelId,
        payload: { ...clonePayload(payload), baselineScoreBps: payload.baselineScoreBps + 1 },
        contributors: cloneContributors(contributors),
      };
    },
  },
  {
    name: "payload.candidateScoreBps",
    mutate({ modelId, payload, contributors }) {
      return {
        modelId,
        payload: { ...clonePayload(payload), candidateScoreBps: payload.candidateScoreBps + 1 },
        contributors: cloneContributors(contributors),
      };
    },
  },
  {
    name: "payload.maxCostUsdMicro",
    mutate({ modelId, payload, contributors }) {
      return {
        modelId,
        payload: { ...clonePayload(payload), maxCostUsdMicro: payload.maxCostUsdMicro + 1 },
        contributors: cloneContributors(contributors),
      };
    },
  },
  {
    name: "payload.actualCostUsdMicro",
    mutate({ modelId, payload, contributors }) {
      return {
        modelId,
        payload: { ...clonePayload(payload), actualCostUsdMicro: payload.actualCostUsdMicro + 1 },
        contributors: cloneContributors(contributors),
      };
    },
  },
  {
    name: "payload.totalSamples",
    mutate({ modelId, payload, contributors }) {
      return {
        modelId,
        payload: { ...clonePayload(payload), totalSamples: payload.totalSamples + 1 },
        contributors: cloneContributors(contributors),
      };
    },
  },
  {
    name: "payload.baselineCommitment",
    mutate({ modelId, payload, contributors }) {
      return {
        modelId,
        payload: { ...clonePayload(payload), baselineCommitment: flipBytes32(payload.baselineCommitment) },
        contributors: cloneContributors(contributors),
      };
    },
  },
  {
    name: "payload.candidateCommitment",
    mutate({ modelId, payload, contributors }) {
      return {
        modelId,
        payload: { ...clonePayload(payload), candidateCommitment: flipBytes32(payload.candidateCommitment) },
        contributors: cloneContributors(contributors),
      };
    },
  },
  {
    name: "payload.anchors.benchmarkSpecHash",
    mutate({ modelId, payload, contributors }) {
      const nextPayload = clonePayload(payload);
      nextPayload.anchors.benchmarkSpecHash = flipBytes32(payload.anchors.benchmarkSpecHash);
      return { modelId, payload: nextPayload, contributors: cloneContributors(contributors) };
    },
  },
  {
    name: "payload.anchors.datasetHash",
    mutate({ modelId, payload, contributors }) {
      const nextPayload = clonePayload(payload);
      nextPayload.anchors.datasetHash = flipBytes32(payload.anchors.datasetHash);
      return { modelId, payload: nextPayload, contributors: cloneContributors(contributors) };
    },
  },
  {
    name: "payload.anchors.attestationHash",
    mutate({ modelId, payload, contributors }) {
      const nextPayload = clonePayload(payload);
      nextPayload.anchors.attestationHash = flipBytes32(payload.anchors.attestationHash);
      return { modelId, payload: nextPayload, contributors: cloneContributors(contributors) };
    },
  },
  {
    name: "payload.anchors.idempotencyKey",
    mutate({ modelId, payload, contributors }) {
      const nextPayload = clonePayload(payload);
      nextPayload.anchors.idempotencyKey = flipBytes32(payload.anchors.idempotencyKey);
      return { modelId, payload: nextPayload, contributors: cloneContributors(contributors) };
    },
  },
  {
    name: "payload.anchors.metricName",
    mutate({ modelId, payload, contributors }) {
      const nextPayload = clonePayload(payload);
      nextPayload.anchors.metricName = mutateString(payload.anchors.metricName, "-mutated");
      return { modelId, payload: nextPayload, contributors: cloneContributors(contributors) };
    },
  },
  {
    name: "payload.anchors.metricFamily",
    mutate({ modelId, payload, contributors }) {
      const nextPayload = clonePayload(payload);
      nextPayload.anchors.metricFamily = mutateString(payload.anchors.metricFamily, "-mutated");
      return { modelId, payload: nextPayload, contributors: cloneContributors(contributors) };
    },
  },
  {
    name: "contributors[0].walletAddress",
    mutate({ modelId, payload, contributors }) {
      const nextContributors = cloneContributors(contributors);
      nextContributors[0].walletAddress = "0x1111111111111111111111111111111111111111";
      return { modelId, payload: clonePayload(payload), contributors: nextContributors };
    },
  },
  {
    name: "contributors[0].weight",
    mutate({ modelId, payload, contributors }) {
      if (contributors.length < 2) throw new Error("contributors[0].weight mutation requires ≥2 contributors in golden fixture");
      const nextContributors = cloneContributors(contributors);
      // Keep the 10000 bps invariant intact so signature verification is the failing seam.
      nextContributors[0].weight -= 1;
      nextContributors[1].weight += 1;
      return { modelId, payload: clonePayload(payload), contributors: nextContributors };
    },
  },
  {
    name: "contributors[1].walletAddress",
    mutate({ modelId, payload, contributors }) {
      if (contributors.length < 2) throw new Error("contributors[1].walletAddress mutation requires ≥2 contributors in golden fixture");
      const nextContributors = cloneContributors(contributors);
      nextContributors[1].walletAddress = "0x2222222222222222222222222222222222222222";
      return { modelId, payload: clonePayload(payload), contributors: nextContributors };
    },
  },
  {
    name: "contributors[1].weight",
    mutate({ modelId, payload, contributors }) {
      if (contributors.length < 2) throw new Error("contributors[1].weight mutation requires ≥2 contributors in golden fixture");
      const nextContributors = cloneContributors(contributors);
      // Keep the 10000 bps invariant intact so signature verification is the failing seam.
      nextContributors[1].weight -= 1;
      nextContributors[0].weight += 1;
      return { modelId, payload: clonePayload(payload), contributors: nextContributors };
    },
  },
];

module.exports = {
  MUTATIONS,
};
