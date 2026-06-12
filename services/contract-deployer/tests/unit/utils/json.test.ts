import { parseJson } from '../../../src/utils/json';

describe('parseJson', () => {
  test('parses trusted payloads with an explicit generic', () => {
    const parsed = parseJson<{ value: number }>('{"value":42}');

    expect(parsed).toEqual({ value: 42 });
  });

  test('rejects malformed json', () => {
    expect(() => parseJson('{')).toThrow(SyntaxError);
  });

  test('supports runtime validators', () => {
    const isPayload = (value: unknown): value is { status: string } =>
      typeof value === 'object' &&
      value !== null &&
      'status' in value &&
      typeof value.status === 'string';

    expect(parseJson('{"status":"ok"}', isPayload)).toEqual({ status: 'ok' });
    expect(() => parseJson('{"status":1}', isPayload)).toThrow(
      'Parsed JSON did not match the expected shape',
    );
  });
});
