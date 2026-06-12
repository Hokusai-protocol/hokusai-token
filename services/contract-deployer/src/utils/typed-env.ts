import { Config, validateEnv } from '../config/env.validation';

let validatedEnvPromise: Promise<Config> | null = null;

export function getValidatedEnv(): Promise<Config> {
  if (!validatedEnvPromise) {
    validatedEnvPromise = validateEnv();
  }

  return validatedEnvPromise;
}

export function resetValidatedEnvForTests(): void {
  validatedEnvPromise = null;
}
