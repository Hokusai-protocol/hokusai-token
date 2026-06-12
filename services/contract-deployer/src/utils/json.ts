import * as Joi from 'joi';

export function parseTrusted<T>(s: string): T {
  // Assumes the input is from a trusted source (e.g., own-written redis state, deployment artifact)
  // and can be safely cast to the desired type.
  return JSON.parse(s) as T;
}

export function parseValidated<T>(s: string, schema: Joi.Schema): T {
  // Validates the JSON against a Joi schema before returning the typed result.
  const parsed = JSON.parse(s);
  const { error, value } = schema.validate(parsed);
  if (error) {
    throw new Error(`JSON validation failed: ${error.message}`);
  }
  return value as T;
}
