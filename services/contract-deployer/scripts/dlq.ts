import { ethers } from 'ethers';
import { createClient } from 'redis';
import DeltaVerifierArtifact from '../contracts/DeltaVerifier.json';
import { validateDlqCliEnvSync } from '../src/config/env.validation';
import { MintRecordStore } from '../src/queue/mint-record-store';
import {
  classifyFailure,
  DlqEntry,
  FailureTag,
  isValidIdempotencyKey,
  parseDlqEntry,
  summarizeEntry,
  validateForReplay,
} from '../src/queue/dlq-inspector';

const DEFAULT_LIMIT = 200;

interface DeltaVerifierReadContract {
  processedIdempotencyKeys(idempotencyKey: string): Promise<boolean>;
  mintBudgetRemaining(modelId: bigint): Promise<bigint>;
  modelWeightHead(modelId: bigint): Promise<string>;
}

interface CliEnv {
  REDIS_URL?: string;
  REDIS_HOST: string;
  REDIS_PORT: number;
  RPC_URL?: string;
  MODEL_REGISTRY_ADDRESS?: string;
  DELTA_VERIFIER_ADDRESS?: string;
  MINT_REQUEST_QUEUE: string;
  MINT_REQUEST_DLQ: string;
  MINT_DLQ_AUDIT_KEY: string;
}

interface RedisMultiLike {
  lPush(key: string, value: string): RedisMultiLike;
  lRem(key: string, count: number, value: string): RedisMultiLike;
  exec(): Promise<unknown[] | null>;
}

interface RedisLike {
  lRange(key: string, start: number, stop: number): Promise<string[]>;
  multi(): RedisMultiLike;
  connect(): Promise<unknown>;
  disconnect(): Promise<unknown>;
}

interface CliDeps {
  redis: RedisLike;
  deltaVerifier?: DeltaVerifierReadContract;
  recordStore: Pick<MintRecordStore, 'get'>;
  env: CliEnv;
  stdout: { write(message: string): void };
  stderr: { write(message: string): void };
  now?: () => Date;
}

interface ParsedArgs {
  subcommand?: 'list' | 'inspect' | 'replay' | 'discard';
  identifier?: string;
  execute: boolean;
  json: boolean;
  limit: number;
  classFilter?: FailureTag;
  reason?: string;
}

export interface ResolvedEntry {
  index: number;
  raw: string;
  parsed: DlqEntry | { kind: 'unparseable'; raw: string };
}

interface OnChainStatus {
  processed: boolean | null;
  weightHead: string | null;
  budgetRemaining: string | null;
  error?: string;
}

const FAILURE_TAGS: FailureTag[] = [
  'budget_exhausted',
  'outcome_unknown',
  'schema_reject',
  'permanent_revert',
  'signer_not_attester',
  'model_inactive',
  'other',
];

function writeLine(output: { write(message: string): void }, message: string): void {
  output.write(`${message}\n`);
}

export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    execute: false,
    json: false,
    limit: DEFAULT_LIMIT,
  };

  const [subcommand, maybeIdentifier, ...rest] = argv;
  if (
    subcommand === 'list' ||
    subcommand === 'inspect' ||
    subcommand === 'replay' ||
    subcommand === 'discard'
  ) {
    parsed.subcommand = subcommand;
  }
  if (maybeIdentifier && !maybeIdentifier.startsWith('--')) {
    parsed.identifier = maybeIdentifier;
  } else if (maybeIdentifier) {
    rest.unshift(maybeIdentifier);
  }

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token === '--execute') {
      parsed.execute = true;
      continue;
    }
    if (token === '--json') {
      parsed.json = true;
      continue;
    }
    if (token === '--limit') {
      const value = rest[index + 1];
      parsed.limit = Number.parseInt(value ?? '', 10);
      index += 1;
      continue;
    }
    if (token === '--class') {
      parsed.classFilter = rest[index + 1] as FailureTag;
      index += 1;
      continue;
    }
    if (token === '--reason') {
      parsed.reason = rest[index + 1];
      index += 1;
    }
  }

  return parsed;
}

function usage(): string {
  return [
    'Usage: dlq <list|inspect|replay|discard> [#index|0xidempotencyKey] [options]',
    'Options: --execute --json --limit <n> --class <tag> --reason <text>',
  ].join('\n');
}

function isFailureTag(value: string | undefined): value is FailureTag {
  return value !== undefined && FAILURE_TAGS.includes(value as FailureTag);
}

function getRedisUrl(env: CliEnv): string {
  return env.REDIS_URL ?? `redis://${env.REDIS_HOST}:${env.REDIS_PORT}`;
}

function parseIdentifierIndex(identifier: string): number | null {
  const normalized = identifier.startsWith('#') ? identifier.slice(1) : identifier;
  if (!/^\d+$/.test(normalized)) {
    return null;
  }
  return Number.parseInt(normalized, 10);
}

async function listEntries(redis: Pick<RedisLike, 'lRange'>, dlqKey: string, limit: number) {
  const upperBound = Math.max(limit - 1, 0);
  const raws = await redis.lRange(dlqKey, 0, upperBound);
  return raws.map((raw, index) => ({ index, raw, parsed: parseDlqEntry(raw) }));
}

function extractIdempotencyKey(
  entry: DlqEntry | { kind: 'unparseable'; raw: string },
): string | null {
  if ('kind' in entry) {
    return null;
  }
  const message = entry.originalMessage as { idempotency_key?: unknown };
  return typeof message?.idempotency_key === 'string' ? message.idempotency_key : null;
}

async function resolveEntry(
  redis: Pick<RedisLike, 'lRange'>,
  dlqKey: string,
  identifier: string,
  limit: number,
): Promise<{ entry?: ResolvedEntry; error?: string }> {
  const entries = await listEntries(redis, dlqKey, limit);
  const index = parseIdentifierIndex(identifier);
  if (index !== null) {
    const entry = entries.find((candidate) => candidate.index === index);
    if (!entry) {
      return { error: `No DLQ entry found at index #${index}` };
    }
    return { entry };
  }

  if (!isValidIdempotencyKey(identifier)) {
    return { error: `Invalid identifier: ${identifier}` };
  }

  const matches = entries.filter(
    (candidate) => extractIdempotencyKey(candidate.parsed) === identifier,
  );
  if (matches.length === 0) {
    return { error: `No DLQ entry found for ${identifier}` };
  }
  if (matches.length > 1) {
    const indexes = matches.map((match) => `#${match.index}`).join(', ');
    return { error: `Multiple DLQ entries found for ${identifier}: ${indexes}. Replay by index.` };
  }

  return { entry: matches[0] };
}

async function getOnChainStatus(
  entry: DlqEntry | { kind: 'unparseable'; raw: string },
  deltaVerifier?: DeltaVerifierReadContract,
): Promise<OnChainStatus> {
  if ('kind' in entry) {
    return {
      processed: null,
      weightHead: null,
      budgetRemaining: null,
      error: 'Entry is unparseable; on-chain lookup unavailable',
    };
  }

  const originalMessage = entry.originalMessage as {
    idempotency_key?: unknown;
    model_id_uint?: unknown;
  };
  if (!deltaVerifier) {
    return {
      processed: null,
      weightHead: null,
      budgetRemaining: null,
      error: 'RPC unavailable',
    };
  }
  if (
    typeof originalMessage.idempotency_key !== 'string' ||
    typeof originalMessage.model_id_uint !== 'string' ||
    !/^\d+$/.test(originalMessage.model_id_uint)
  ) {
    return {
      processed: null,
      weightHead: null,
      budgetRemaining: null,
      error: 'Entry lacks a usable idempotency_key or model_id_uint',
    };
  }

  try {
    const modelId = BigInt(originalMessage.model_id_uint);
    const [processed, weightHead, budgetRemaining] = await Promise.all([
      deltaVerifier.processedIdempotencyKeys(originalMessage.idempotency_key),
      deltaVerifier.modelWeightHead(modelId),
      deltaVerifier.mintBudgetRemaining(modelId),
    ]);

    return {
      processed,
      weightHead,
      budgetRemaining: budgetRemaining.toString(),
    };
  } catch (error) {
    return {
      processed: null,
      weightHead: null,
      budgetRemaining: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function formatSummaryRow(summary: ReturnType<typeof summarizeEntry>): string {
  const age = summary.ageHours === null ? 'unknown' : `${summary.ageHours.toFixed(1)}h`;
  const reward = summary.rewardHint ?? '-';
  const marker = summary.securitySensitive ? 'SECURITY ' : '';
  return [
    summary.id.padEnd(6),
    (summary.idempotencyKey ?? '<unknown>').padEnd(66),
    (summary.modelId ?? '<unknown>').padEnd(24),
    reward.padEnd(10),
    `${marker}${summary.failureTag}`.padEnd(24),
    age,
  ].join(' ');
}

function buildReplayAuditRecord(entry: ResolvedEntry, reason: string, now: Date): string {
  return JSON.stringify({
    action: 'replay',
    idempotency_key: extractIdempotencyKey(entry.parsed),
    operator: process.env.USER ?? 'unknown',
    reason,
    dlq_entry: entry.raw,
    at: now.toISOString(),
  });
}

function buildDiscardAuditRecord(entry: ResolvedEntry, reason: string, now: Date): string {
  return JSON.stringify({
    action: 'discard',
    idempotency_key: extractIdempotencyKey(entry.parsed),
    operator: process.env.USER ?? 'unknown',
    reason,
    dlq_entry: entry.raw,
    at: now.toISOString(),
  });
}

function requireRpc(deps: CliDeps): string | null {
  if (!deps.env.RPC_URL || !deps.env.MODEL_REGISTRY_ADDRESS || !deps.env.DELTA_VERIFIER_ADDRESS) {
    return 'RPC_URL, MODEL_REGISTRY_ADDRESS, and DELTA_VERIFIER_ADDRESS must be configured';
  }
  if (!deps.deltaVerifier) {
    return 'RPC unavailable';
  }
  return null;
}

async function handleList(args: ParsedArgs, deps: CliDeps): Promise<number> {
  const entries = await listEntries(deps.redis, deps.env.MINT_REQUEST_DLQ, args.limit);
  const now = deps.now?.() ?? new Date();
  const summaries = entries
    .map((entry) => {
      const ageMs =
        'kind' in entry.parsed || !entry.parsed.timestamp
          ? null
          : now.getTime() - new Date(entry.parsed.timestamp).getTime();
      return summarizeEntry(entry.parsed, ageMs, entry.index);
    })
    .filter((summary) => (args.classFilter ? summary.failureTag === args.classFilter : true));

  if (args.json) {
    writeLine(deps.stdout, JSON.stringify(summaries, null, 2));
    return 0;
  }

  writeLine(
    deps.stdout,
    'INDEX  IDEMPOTENCY_KEY                                                    MODEL                    REWARD     FAILURE                  AGE',
  );
  for (const summary of summaries) {
    writeLine(deps.stdout, formatSummaryRow(summary));
  }
  return 0;
}

async function handleInspect(args: ParsedArgs, deps: CliDeps): Promise<number> {
  if (!args.identifier) {
    writeLine(deps.stderr, 'inspect requires an identifier');
    return 2;
  }

  const rpcError = requireRpc(deps);
  if (rpcError) {
    writeLine(deps.stderr, rpcError);
    return 2;
  }

  const resolved = await resolveEntry(
    deps.redis,
    deps.env.MINT_REQUEST_DLQ,
    args.identifier,
    args.limit,
  );
  if (resolved.error) {
    writeLine(deps.stderr, resolved.error);
    return 1;
  }

  const onChain = await getOnChainStatus(resolved.entry!.parsed, deps.deltaVerifier);
  const idempotencyKey = extractIdempotencyKey(resolved.entry!.parsed);
  const failureTag =
    'kind' in resolved.entry!.parsed
      ? 'schema_reject'
      : classifyFailure(resolved.entry!.parsed.reason);
  const record = idempotencyKey === null ? null : await deps.recordStore.get(idempotencyKey);

  const payload = {
    index: resolved.entry!.index,
    failureTag,
    securitySensitive: failureTag === 'signer_not_attester',
    entry: 'kind' in resolved.entry!.parsed ? resolved.entry!.parsed : resolved.entry!.parsed,
    record,
    onChain,
  };

  if (args.json) {
    writeLine(deps.stdout, JSON.stringify(payload, null, 2));
    return 0;
  }

  if (failureTag === 'signer_not_attester') {
    writeLine(deps.stdout, 'SECURITY signer_not_attester: triage via the security runbook');
  }
  writeLine(deps.stdout, JSON.stringify(payload, null, 2));
  return 0;
}

async function handleReplay(args: ParsedArgs, deps: CliDeps): Promise<number> {
  if (!args.identifier) {
    writeLine(deps.stderr, 'replay requires an identifier');
    return 2;
  }

  const rpcError = requireRpc(deps);
  if (rpcError) {
    writeLine(deps.stderr, rpcError);
    return 2;
  }

  const resolved = await resolveEntry(
    deps.redis,
    deps.env.MINT_REQUEST_DLQ,
    args.identifier,
    args.limit,
  );
  if (resolved.error) {
    writeLine(deps.stderr, resolved.error);
    return 1;
  }
  const entry = resolved.entry!;
  if ('kind' in entry.parsed) {
    writeLine(deps.stdout, 'dry-run: REFUSED - entry is unparseable and cannot be replayed');
    return 1;
  }

  const failureTag = classifyFailure(entry.parsed.reason);
  if (failureTag === 'signer_not_attester') {
    const idempotencyKey = extractIdempotencyKey(entry.parsed) ?? '<unknown>';
    writeLine(
      deps.stdout,
      `REFUSED: ${idempotencyKey} classified as signer_not_attester. Forgery candidates must be triaged via the security runbook, not replayed.`,
    );
    return 1;
  }

  const onChain = await getOnChainStatus(entry.parsed, deps.deltaVerifier);
  const originalMessage = entry.parsed.originalMessage;
  const validation = validateForReplay(originalMessage, {
    processed: onChain.processed ?? undefined,
    weightHead: onChain.weightHead ?? undefined,
    budgetRemaining: onChain.budgetRemaining === null ? undefined : BigInt(onChain.budgetRemaining),
  });
  const budgetLine =
    onChain.budgetRemaining === null
      ? 'mintBudgetRemaining: unavailable'
      : `mintBudgetRemaining: ${onChain.budgetRemaining}`;

  writeLine(
    deps.stdout,
    `checks: schema=${validation.ok ? 'pass' : 'fail'} processed=${String(onChain.processed)} weightHead=${onChain.weightHead ?? 'unavailable'}`,
  );
  writeLine(deps.stdout, budgetLine);

  if (!validation.ok) {
    writeLine(deps.stdout, `dry-run: REFUSED - ${validation.reason}`);
    return 1;
  }

  const replayPayload = JSON.stringify(validation.sanitizedMessage);
  const auditPayload = buildReplayAuditRecord(
    entry,
    entry.parsed.reason,
    deps.now?.() ?? new Date(),
  );
  writeLine(deps.stdout, `would MULTI`);
  writeLine(deps.stdout, `LPUSH ${deps.env.MINT_REQUEST_QUEUE} ${replayPayload}`);
  writeLine(deps.stdout, `LREM ${deps.env.MINT_REQUEST_DLQ} 1 ${entry.raw}`);
  writeLine(deps.stdout, `LPUSH ${deps.env.MINT_DLQ_AUDIT_KEY} ${auditPayload}`);
  writeLine(deps.stdout, `EXEC`);

  if (!args.execute) {
    writeLine(deps.stdout, 'dry-run: pass --execute to apply');
    return 0;
  }

  const multi = deps.redis.multi();
  multi.lPush(deps.env.MINT_REQUEST_QUEUE, replayPayload);
  multi.lRem(deps.env.MINT_REQUEST_DLQ, 1, entry.raw);
  multi.lPush(deps.env.MINT_DLQ_AUDIT_KEY, auditPayload);
  await multi.exec();
  writeLine(deps.stdout, 'replay applied');
  return 0;
}

async function handleDiscard(args: ParsedArgs, deps: CliDeps): Promise<number> {
  if (!args.identifier) {
    writeLine(deps.stderr, 'discard requires an identifier');
    return 2;
  }
  if (!args.reason || args.reason.trim() === '') {
    writeLine(deps.stderr, 'discard requires --reason');
    return 2;
  }

  const resolved = await resolveEntry(
    deps.redis,
    deps.env.MINT_REQUEST_DLQ,
    args.identifier,
    args.limit,
  );
  if (resolved.error) {
    writeLine(deps.stderr, resolved.error);
    return 1;
  }

  const entry = resolved.entry!;
  const auditPayload = buildDiscardAuditRecord(entry, args.reason, deps.now?.() ?? new Date());
  writeLine(deps.stdout, 'would MULTI');
  writeLine(deps.stdout, `LREM ${deps.env.MINT_REQUEST_DLQ} 1 ${entry.raw}`);
  writeLine(deps.stdout, `LPUSH ${deps.env.MINT_DLQ_AUDIT_KEY} ${auditPayload}`);
  writeLine(deps.stdout, 'EXEC');

  if (!args.execute) {
    writeLine(deps.stdout, 'dry-run: pass --execute to apply');
    return 0;
  }

  const multi = deps.redis.multi();
  multi.lRem(deps.env.MINT_REQUEST_DLQ, 1, entry.raw);
  multi.lPush(deps.env.MINT_DLQ_AUDIT_KEY, auditPayload);
  await multi.exec();
  writeLine(deps.stdout, 'discard applied');
  return 0;
}

export async function runDlqCli(argv: string[], deps: CliDeps): Promise<number> {
  const args = parseArgs(argv);
  if (!args.subcommand) {
    writeLine(deps.stderr, usage());
    return 2;
  }
  if (Number.isNaN(args.limit) || args.limit < 1) {
    writeLine(deps.stderr, '--limit must be a positive integer');
    return 2;
  }
  if (args.classFilter && !isFailureTag(args.classFilter)) {
    writeLine(deps.stderr, `Unknown failure class: ${args.classFilter}`);
    return 2;
  }

  switch (args.subcommand) {
    case 'list':
      return handleList(args, deps);
    case 'inspect':
      return handleInspect(args, deps);
    case 'replay':
      return handleReplay(args, deps);
    case 'discard':
      return handleDiscard(args, deps);
    default:
      writeLine(deps.stderr, usage());
      return 2;
  }
}

async function bootstrap(): Promise<CliDeps> {
  const env = validateDlqCliEnvSync();
  const redis = createClient({ url: getRedisUrl(env) });
  await redis.connect();

  const provider = new ethers.JsonRpcProvider(env.RPC_URL);
  const deltaVerifier = new ethers.Contract(
    env.DELTA_VERIFIER_ADDRESS,
    DeltaVerifierArtifact.abi,
    provider,
  ) as unknown as DeltaVerifierReadContract;

  const recordStore = new MintRecordStore({
    redis: redis as any,
    keyPrefix: env.MINT_RECORD_KEY_PREFIX,
    ttlSeconds: env.MINT_RECORD_TTL_SECONDS,
  });

  return {
    redis: redis as RedisLike,
    deltaVerifier,
    recordStore,
    env,
    stdout: process.stdout,
    stderr: process.stderr,
  };
}

async function main(): Promise<void> {
  let deps: CliDeps | undefined;
  try {
    deps = await bootstrap();
    const exitCode = await runDlqCli(process.argv.slice(2), deps);
    process.exitCode = exitCode;
  } catch (error) {
    writeLine(process.stderr, error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  } finally {
    if (deps) {
      await deps.redis.disconnect();
    }
  }
}

if (require.main === module) {
  void main();
}
