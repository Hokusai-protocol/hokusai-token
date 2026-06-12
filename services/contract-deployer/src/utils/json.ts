export function parseJson<T>(raw: string, validate?: (value: unknown) => value is T): T {
  const parsed: unknown = JSON.parse(raw);

  if (validate && !validate(parsed)) {
    throw new Error('Parsed JSON did not match the expected shape');
  }

  return parsed as T;
}
