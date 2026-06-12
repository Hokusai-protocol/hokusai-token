import { validateEnvSync } from '../../../src/config/env.validation';

const VALID_ADDRESS_1 = '0x1234567890123456789012345678901234567890';
const VALID_ADDRESS_2 = '0x0987654321098765432109876543210987654321';
const VALID_PRIVATE_KEY = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';

describe('KMS environment validation', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      NODE_ENV: 'development',
      USE_SSM: 'false',
      RPC_URL: 'https://ethereum-rpc.com',
      MODEL_REGISTRY_ADDRESS: VALID_ADDRESS_1,
      TOKEN_MANAGER_ADDRESS: VALID_ADDRESS_2,
      DEPLOYER_PRIVATE_KEY: VALID_PRIVATE_KEY,
    };
    delete process.env.KMS_BACKEND_KEY_ID;
    delete process.env.KMS_BACKEND_EXPECTED_ADDRESS;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('rejects DEPLOYER_PRIVATE_KEY and KMS_BACKEND_KEY_ID together', () => {
    process.env.KMS_BACKEND_KEY_ID = 'alias/hokusai/test/submitter';
    process.env.KMS_BACKEND_EXPECTED_ADDRESS = VALID_ADDRESS_1;

    expect(() => validateEnvSync()).toThrow(
      'DEPLOYER_PRIVATE_KEY and KMS_BACKEND_KEY_ID are mutually exclusive',
    );
  });

  it('requires expected address when KMS_BACKEND_KEY_ID is set', () => {
    delete process.env.DEPLOYER_PRIVATE_KEY;
    process.env.KMS_BACKEND_KEY_ID = 'alias/hokusai/test/submitter';

    expect(() => validateEnvSync()).toThrow(
      'KMS_BACKEND_EXPECTED_ADDRESS is required when KMS_BACKEND_KEY_ID is set',
    );
  });

  it('requires KMS in production', () => {
    process.env.NODE_ENV = 'production';

    expect(() => validateEnvSync()).toThrow('KMS_BACKEND_KEY_ID required when NODE_ENV=production');
  });

  it('accepts KMS-only production signer config', () => {
    process.env.NODE_ENV = 'production';
    process.env.MODEL_SUPPLIER_RECIPIENT = VALID_ADDRESS_1;
    process.env.GOVERNOR_ADDRESS = VALID_ADDRESS_2;
    delete process.env.DEPLOYER_PRIVATE_KEY;
    process.env.KMS_BACKEND_KEY_ID = 'alias/hokusai/test/submitter';
    process.env.KMS_BACKEND_EXPECTED_ADDRESS = VALID_ADDRESS_1;

    const config = validateEnvSync();

    expect(config.KMS_BACKEND_KEY_ID).toBe('alias/hokusai/test/submitter');
    expect(config.KMS_BACKEND_EXPECTED_ADDRESS).toBe(VALID_ADDRESS_1);
    expect(config.DEPLOYER_PRIVATE_KEY).toBeUndefined();
  });
});
