import Joi from 'joi';

const HASH_REGEX = /^0x[0-9a-f]{64}$/;
const ADDRESS_REGEX = /^0x[a-fA-F0-9]{40}$/;

export interface MintRequestContributor {
  wallet_address: string;
  weight_bps: number;
}

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
  attestation_hash: string;
  idempotency_key: string;
  benchmark_spec_id?: string;
  dataset_hash?: string;
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
  status: 'minted' | 'budget_blocked' | 'no_delta' | 'replay' | 'error';
  reward_amount: string;
  gas_used?: string;
  error?: string;
  settled_at: string;
}

const contributorSchema = Joi.object<MintRequestContributor>({
  wallet_address: Joi.string().pattern(ADDRESS_REGEX).required(),
  weight_bps: Joi.number().integer().min(1).max(10000).required(),
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
  attestation_hash: Joi.string().pattern(HASH_REGEX).required(),
  idempotency_key: Joi.string().pattern(HASH_REGEX).required(),
  benchmark_spec_id: Joi.string().optional(),
  dataset_hash: Joi.string().pattern(HASH_REGEX).optional(),
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
}).options({ abortEarly: false });

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
