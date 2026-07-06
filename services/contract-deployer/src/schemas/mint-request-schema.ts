import Joi from 'joi';

const HASH_REGEX = /^0x[0-9a-f]{64}$/;
const ADDRESS_REGEX = /^0x[a-fA-F0-9]{40}$/;
const EOA_SIGNATURE_REGEX = /^0x[0-9a-fA-F]{130}$/;

export interface MintRequestContributor {
  wallet_address: string;
  weight_bps: number;
  recipientKind?: 'wallet' | 'escrow' | null;
  // Optional provenance fields emitted by the pipeline's MintRequestContributor
  // (serialized via model_dump_json(by_alias=True) with no exclude_none, so they arrive
  // camelCased and are ALWAYS present — null when unset). The contract only consumes
  // wallet_address + weight_bps; these are accepted and ignored. See HOK-2099.
  submissionId?: string | null;
  contributionBatchId?: string | null;
  contributorId?: string | null;
}

// Single source of truth for the contributor keys the consumer accepts. Used by the
// cross-repo conformance test to catch any future drift in the pipeline contributor object.
export const ACCEPTED_CONTRIBUTOR_KEYS = [
  'wallet_address',
  'weight_bps',
  'recipientKind',
  'submissionId',
  'contributionBatchId',
  'contributorId',
] as const;

export interface MintRequestEvaluation {
  metric_name: string;
  metric_family: string;
  baseline_score_bps: number;
  new_score_bps: number;
  max_cost_usd_micro: number;
  actual_cost_usd_micro: number;
  sample_size_baseline?: number | null;
  sample_size_candidate?: number | null;
  ci_low_bps?: number | null;
  ci_high_bps?: number | null;
  p_value?: number | null;
  effect_size_bps?: number | null;
  statistical_method?: string | null;
  statistical_reason?: string | null;
}

export interface MintRequestMessage {
  message_type: 'mint_request';
  schema_version: '1.0';
  message_id: string;
  timestamp: string;
  model_id: string;
  model_id_uint: string;
  eval_id: string;
  benchmark_spec_id: string;
  dataset_hash: string;
  attestation_hash: string;
  idempotency_key: string;
  baseline_commitment: string;
  candidate_commitment: string;
  attester_signatures: string[];
  totalSamples: number;
  // HOK-2170: unix timestamp past which the attester signature is no longer submittable.
  deadline: number;
  evaluation: MintRequestEvaluation;
  contributors: MintRequestContributor[];
  _retryCount?: number;
}

export interface MintRequestSettlement {
  event_type: 'mint_request_settled';
  message_version: '1.0';
  idempotency_key: string;
  attestation_hash: string;
  model_id: string;
  model_id_uint: string;
  eval_id: string;
  tx_hash?: string;
  block_number?: number;
  // budget_exceeded_retry is record-only and must never be published to the settlements queue.
  status: 'minted' | 'budget_blocked' | 'budget_exceeded_retry' | 'no_delta' | 'replay' | 'error';
  reward_amount: string;
  gas_used?: string;
  error?: string;
  settled_at: string;
}

const contributorSchema = Joi.object<MintRequestContributor>({
  wallet_address: Joi.string().pattern(ADDRESS_REGEX).required(),
  weight_bps: Joi.number().integer().min(1).max(10000).required(),
  recipientKind: Joi.string().valid('wallet', 'escrow').allow(null).optional(),
  // Accept-and-ignore the pipeline's per-contributor provenance fields so a real published
  // MintRequest is not rejected at the consumer boundary (HOK-2099). They may be a non-empty
  // string or null (the publisher does not exclude None values).
  submissionId: Joi.string().min(1).allow(null).optional(),
  contributionBatchId: Joi.string().min(1).allow(null).optional(),
  contributorId: Joi.string().min(1).allow(null).optional(),
});

export function deriveTotalSamples(evaluation: MintRequestEvaluation): number | null {
  const sampleSizes = [evaluation.sample_size_candidate, evaluation.sample_size_baseline];

  for (const sampleSize of sampleSizes) {
    if (typeof sampleSize === 'number' && Number.isInteger(sampleSize) && sampleSize > 0) {
      return sampleSize;
    }
  }

  return null;
}

const evaluationSchema = Joi.object<MintRequestEvaluation>({
  metric_name: Joi.string().min(1).required(),
  metric_family: Joi.string().min(1).required(),
  baseline_score_bps: Joi.number().integer().min(0).max(10000).required(),
  new_score_bps: Joi.number().integer().min(0).max(10000).required(),
  max_cost_usd_micro: Joi.number().integer().min(0).required(),
  actual_cost_usd_micro: Joi.number().integer().min(0).required(),
  sample_size_baseline: Joi.number().integer().min(0).allow(null).optional(),
  sample_size_candidate: Joi.number().integer().min(0).allow(null).optional(),
  ci_low_bps: Joi.number().integer().min(0).max(10000).allow(null).optional(),
  ci_high_bps: Joi.number().integer().min(0).max(10000).allow(null).optional(),
  p_value: Joi.number().min(0).max(1).allow(null).optional(),
  effect_size_bps: Joi.number().integer().min(0).max(10000).allow(null).optional(),
  statistical_method: Joi.string().max(128).allow(null).optional(),
  statistical_reason: Joi.string().max(1024).allow(null).optional(),
})
  .custom((value: MintRequestEvaluation, helpers) => {
    if (deriveTotalSamples(value) !== null) {
      return value;
    }

    return helpers.error('any.custom', {
      message:
        '"evaluation" must include a positive integer sample_size_candidate or sample_size_baseline to derive totalSamples',
    });
  }, 'totalSamples derivation validation')
  .messages({
    'any.custom': '{{#message}}',
  });

const mintRequestSchema = Joi.object<MintRequestMessage>({
  message_type: Joi.string().valid('mint_request').required(),
  schema_version: Joi.string().valid('1.0').required(),
  message_id: Joi.string().required(),
  timestamp: Joi.string().isoDate().required(),
  model_id: Joi.string().required(),
  model_id_uint: Joi.string()
    .pattern(/^[1-9]\d*$/)
    .required(),
  eval_id: Joi.string().min(1).required(),
  benchmark_spec_id: Joi.string().min(1).required(),
  dataset_hash: Joi.string().pattern(HASH_REGEX).required(),
  attestation_hash: Joi.string().pattern(HASH_REGEX).required(),
  idempotency_key: Joi.string().pattern(HASH_REGEX).required(),
  baseline_commitment: Joi.string().pattern(HASH_REGEX).required(),
  candidate_commitment: Joi.string().pattern(HASH_REGEX).required(),
  attester_signatures: Joi.array()
    .items(Joi.string().pattern(EOA_SIGNATURE_REGEX))
    .min(1)
    .max(8)
    .required(),
  totalSamples: Joi.number().integer().min(1).required(),
  deadline: Joi.number().integer().min(1).required(),
  evaluation: evaluationSchema.required(),
  contributors: Joi.array()
    .items(contributorSchema)
    .min(1)
    .max(100)
    .required()
    .custom((value: MintRequestContributor[], helpers) => {
      const totalWeight = value.reduce((sum, contributor) => sum + contributor.weight_bps, 0);
      if (totalWeight !== 10000) {
        return helpers.error('any.invalid');
      }
      return value;
    }, 'contributors total weight validation'),
  _retryCount: Joi.number().integer().min(0).optional(),
})
  .custom((value: MintRequestMessage, helpers) => {
    const candidate = value.evaluation?.sample_size_candidate;
    if (
      typeof candidate === 'number' &&
      Number.isInteger(candidate) &&
      candidate > 0 &&
      candidate !== value.totalSamples
    ) {
      return helpers.error('any.custom', {
        message: `"totalSamples" (${value.totalSamples}) does not match evaluation.sample_size_candidate (${candidate})`,
      });
    }
    return value;
  }, 'totalSamples cross-field validation')
  .messages({ 'any.custom': '{{#message}}' })
  .options({ abortEarly: false });

export function validateMintRequestMessage(
  message: unknown,
): Joi.ValidationResult<MintRequestMessage> {
  return mintRequestSchema.validate(message);
}

export function createMintRequestSettlement(
  settlement: Omit<MintRequestSettlement, 'event_type' | 'message_version' | 'settled_at'>,
): MintRequestSettlement {
  return {
    event_type: 'mint_request_settled',
    message_version: '1.0',
    settled_at: new Date().toISOString(),
    ...settlement,
  };
}
