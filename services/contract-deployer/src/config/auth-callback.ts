import type { Config } from './env.validation';

export interface AuthSettlementCallbackStatus {
  enabled: boolean;
  targetHost: string | null;
  reason?: string;
}

export interface AuthSettlementCallbackConfig extends AuthSettlementCallbackStatus {
  authServiceUrl?: string;
  internalToken?: string;
  timeoutMs: number;
}

const PRODUCTION_AUTH_HOST = 'auth.hokus.ai';

export function buildAuthSettlementCallbackConfig(
  config: Pick<
    Config,
    | 'HOKUSAI_AUTH_SERVICE_URL'
    | 'HOKUSAI_AUTH_INTERNAL_TOKEN'
    | 'HOKUSAI_AUTH_SETTLEMENT_TIMEOUT_MS'
    | 'NETWORK_NAME'
    | 'CHAIN_ID'
    | 'NODE_ENV'
    | 'DEPLOY_ENV'
  >,
): AuthSettlementCallbackConfig {
  const authServiceUrl = config.HOKUSAI_AUTH_SERVICE_URL.trim();
  const internalToken = config.HOKUSAI_AUTH_INTERNAL_TOKEN.trim();
  const targetHost = getUrlHost(authServiceUrl);

  if (!authServiceUrl && !internalToken) {
    return {
      enabled: false,
      targetHost: null,
      reason: 'HOKUSAI_AUTH_SERVICE_URL and HOKUSAI_AUTH_INTERNAL_TOKEN are not configured',
      timeoutMs: config.HOKUSAI_AUTH_SETTLEMENT_TIMEOUT_MS,
    };
  }

  if (!authServiceUrl) {
    return {
      enabled: false,
      targetHost: null,
      reason: 'HOKUSAI_AUTH_SERVICE_URL is not configured',
      timeoutMs: config.HOKUSAI_AUTH_SETTLEMENT_TIMEOUT_MS,
    };
  }

  if (!internalToken) {
    return {
      enabled: false,
      targetHost,
      reason: 'HOKUSAI_AUTH_INTERNAL_TOKEN is not configured',
      timeoutMs: config.HOKUSAI_AUTH_SETTLEMENT_TIMEOUT_MS,
    };
  }

  return {
    enabled: true,
    targetHost,
    authServiceUrl,
    internalToken,
    timeoutMs: config.HOKUSAI_AUTH_SETTLEMENT_TIMEOUT_MS,
  };
}

export function assertAuthSettlementTargetMatchesEnvironment(
  config: Pick<
    Config,
    'HOKUSAI_AUTH_SERVICE_URL' | 'NETWORK_NAME' | 'CHAIN_ID' | 'NODE_ENV' | 'DEPLOY_ENV'
  >,
): void {
  const authServiceUrl = config.HOKUSAI_AUTH_SERVICE_URL.trim();
  if (!authServiceUrl) {
    return;
  }

  const targetHost = getUrlHost(authServiceUrl);
  const mainnet = isMainnetEnvironment(config);
  if (mainnet && targetHost !== PRODUCTION_AUTH_HOST) {
    throw new Error(
      `Auth settlement callback for mainnet/prod must target ${PRODUCTION_AUTH_HOST}; got ${targetHost ?? '<invalid>'}`,
    );
  }

  if (!mainnet && targetHost === PRODUCTION_AUTH_HOST) {
    throw new Error(
      `Auth settlement callback for non-mainnet environments must not target ${PRODUCTION_AUTH_HOST}`,
    );
  }
}

function isMainnetEnvironment(
  config: Pick<Config, 'NETWORK_NAME' | 'CHAIN_ID' | 'NODE_ENV' | 'DEPLOY_ENV'>,
): boolean {
  const networkName = config.NETWORK_NAME.toLowerCase();
  const deployEnv = (config.DEPLOY_ENV ?? '').toLowerCase();
  return (
    config.CHAIN_ID === 1 ||
    networkName === 'mainnet' ||
    networkName === 'ethereum-mainnet' ||
    deployEnv === 'mainnet' ||
    deployEnv === 'production'
  );
}

function getUrlHost(value: string): string | null {
  if (!value) {
    return null;
  }

  try {
    return new URL(value).host;
  } catch {
    return null;
  }
}
