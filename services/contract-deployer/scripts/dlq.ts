import { createClient } from 'redis';
import { ethers } from 'ethers';
import { DeltaVerifierClient } from '../src/blockchain/delta-verifier-client';
import {
  parseDlqEntry,
  rewardAmountFromMessage,
  stripRetryScratch,
  summarizeId,
} from '../src/dlq/dlq-entry';
import { DlqEntryAmbiguousError, DlqEntryNotFoundError, DlqStore } from '../src/dlq/dlq-store';
import { decideReplay, OnChainMintStatus, ReplayDecision } from '../src/dlq/replay-guard';
import { validateMintRequestSignatures } from '../src/dlq/signature-guard';
import { MintRequestMessage, validateMintRequestMessage } from '../src/schemas/mint-request-schema';

const DEFAULT_INBOUND_QUEUE = 'hokusai:mint_requests';
const DEFAULT_DLQ_QUEUE = 'hokusai:mint_requests:dlq';
const DEFAULT_ARCHIVE_QUEUE = 'hokusai:mint_requests:dlq:archive';
const MAX_LIST_LIMIT = 500;
const VALUE_FLAGS = new Set(['limit', 'queue', 'reason']);

interface ParsedArgs {
  command?: string;
  positional: string[];
  flags: Map<string, string | boolean>;
}

interface CliConfig {
  redisUrl: string;
  rpcUrl: string;
  deltaVerifierAddress?: string;
  modelRegistryAddress?: string;
  inboundQueue: string;
  dlqQueue: string;
  archiveQueue: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  const flags = new Map<string, string | boolean>();
  const positional: string[] = [];
  let command: string | undefined;

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg.startsWith('--')) {
      const [rawKey, rawValue] = arg.slice(2).split('=', 2);
      const nextArg = argv[index + 1];
      if (
        rawValue === undefined &&
        VALUE_FLAGS.has(rawKey) &&
        nextArg &&
        !nextArg.startsWith('--')
      ) {
        flags.set(rawKey, nextArg);
        index++;
        continue;
      }
      flags.set(rawKey, rawValue ?? true);
      continue;
    }

    if (command === undefined) {
      command = arg;
    } else {
      positional.push(arg);
    }
  }

  return { command, positional, flags };
}

function readFlag(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags.get(name);
  if (value === undefined || value === true) {
    return undefined;
  }

  return value;
}

function hasFlag(args: ParsedArgs, name: string): boolean {
  return args.flags.get(name) === true || typeof args.flags.get(name) === 'string';
}

function configFromEnv(args: ParsedArgs): CliConfig {
  const dlqQueue =
    readFlag(args, 'queue') ??
    process.env.DLQ_QUEUE ??
    process.env.MINT_REQUEST_DLQ ??
    DEFAULT_DLQ_QUEUE;
  return {
    redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
    rpcUrl: process.env.RPC_URL ?? 'http://localhost:8545',
    deltaVerifierAddress: process.env.DELTA_VERIFIER_ADDRESS,
    modelRegistryAddress: process.env.MODEL_REGISTRY_ADDRESS,
    inboundQueue:
      process.env.INBOUND_QUEUE ?? process.env.MINT_REQUEST_QUEUE ?? DEFAULT_INBOUND_QUEUE,
    dlqQueue,
    archiveQueue: process.env.DLQ_ARCHIVE_QUEUE ?? `${dlqQueue}:archive`,
  };
}

function printUsage(): void {
  process.stdout.write(`Usage:
  npm run dlq -- list [--queue=name] [--limit=50] [--json]
  npm run dlq -- inspect <id> [--queue=name] [--json]
  npm run dlq -- replay <id> [--queue=name] [--execute]
  npm run dlq -- discard <id> --reason=<text> [--queue=name] [--execute]

Environment:
  REDIS_URL, RPC_URL, DELTA_VERIFIER_ADDRESS, MODEL_REGISTRY_ADDRESS
  MINT_REQUEST_QUEUE, MINT_REQUEST_DLQ, DLQ_ARCHIVE_QUEUE
`);
}

function stringifyJson(value: unknown): string {
  return JSON.stringify(
    value,
    (_key, innerValue) => (typeof innerValue === 'bigint' ? innerValue.toString() : innerValue),
    2,
  );
}

function ageFromTimestamp(timestamp: string | undefined): string {
  if (!timestamp) {
    return '-';
  }

  const elapsedMs = Date.now() - Date.parse(timestamp);
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) {
    return '-';
  }

  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes < 60) {
    return `${minutes}m`;
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 48) {
    return `${hours}h${minutes % 60}m`;
  }

  return `${Math.floor(hours / 24)}d${hours % 24}h`;
}

function formatTable(rows: string[][]): string {
  const widths = rows[0].map((_cell, column) =>
    Math.max(...rows.map((row) => row[column]?.length ?? 0)),
  );

  return rows
    .map((row) =>
      row
        .map((cell, index) => cell.padEnd(widths[index]))
        .join('  ')
        .trimEnd(),
    )
    .join('\n');
}

function requireOnChainConfig(config: CliConfig): asserts config is CliConfig & {
  deltaVerifierAddress: string;
  modelRegistryAddress: string;
} {
  if (!config.deltaVerifierAddress || !config.modelRegistryAddress) {
    throw new Error(
      'DELTA_VERIFIER_ADDRESS and MODEL_REGISTRY_ADDRESS are required for inspect/replay',
    );
  }
}

function buildOnChainReaders(config: CliConfig): {
  client: DeltaVerifierClient;
  provider: ethers.JsonRpcProvider;
  deltaVerifierAddress: string;
} {
  requireOnChainConfig(config);
  const provider = new ethers.JsonRpcProvider(config.rpcUrl);
  const signer = new ethers.VoidSigner(ethers.ZeroAddress, provider);
  return {
    provider,
    deltaVerifierAddress: config.deltaVerifierAddress,
    client: new DeltaVerifierClient({
      provider,
      signer,
      deltaVerifierAddress: config.deltaVerifierAddress,
      modelRegistryAddress: config.modelRegistryAddress,
      confirmations: 1,
      gasMultiplier: 1,
      maxGasPrice: process.env.MAX_GAS_PRICE_WEI ?? '100000000000',
    }),
  };
}

async function readOnChainStatus(
  client: DeltaVerifierClient,
  provider: ethers.JsonRpcProvider,
  deltaVerifierAddress: string,
  message: MintRequestMessage,
): Promise<OnChainMintStatus> {
  const modelId = BigInt(message.model_id_uint);
  const [processed, mintBudgetRemaining, modelWeightHead, network] = await Promise.all([
    client.isIdempotencyKeyProcessed(message.idempotency_key),
    client.mintBudgetRemaining(modelId),
    client.currentModelHead(modelId),
    provider.getNetwork(),
  ]);
  const signatureValidation = await validateMintRequestSignatures(message, client, {
    chainId: network.chainId,
    verifyingContract: deltaVerifierAddress,
  });

  return {
    processed,
    mintBudgetRemaining,
    modelWeightHead,
    signaturesValid: signatureValidation.valid,
    signatureError: signatureValidation.error,
  };
}

function renderDecision(decision: ReplayDecision): string {
  if (decision.allowed) {
    const warnings =
      decision.warnings.length > 0 ? ` warnings=${decision.warnings.join('; ')}` : '';
    return `ALLOWED estimated_reward=${decision.rewardAmount.toString()}${warnings}`;
  }

  return `REFUSED ${decision.reason}: ${decision.message}`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.command || args.command === 'help' || hasFlag(args, 'help')) {
    printUsage();
    return;
  }

  const config = configFromEnv(args);
  const redis = createClient({ url: config.redisUrl });
  const store = new DlqStore({
    redis,
    dlqQueue: config.dlqQueue,
    inboundQueue: config.inboundQueue,
    archiveQueue: config.archiveQueue,
  });

  await redis.connect();
  try {
    if (args.command === 'list') {
      const requestedLimit = Number(readFlag(args, 'limit') ?? '50');
      const limit = Math.max(
        1,
        Math.min(MAX_LIST_LIMIT, Number.isFinite(requestedLimit) ? requestedLimit : 50),
      );
      const entries = await store.list(limit);
      if (hasFlag(args, 'json')) {
        process.stdout.write(stringifyJson(entries) + '\n');
        return;
      }

      if (entries.length === 0) {
        process.stdout.write('DLQ is empty\n');
        return;
      }

      const rows = [
        ['ID', 'CLASS', 'MODEL_ID', 'REWARD', 'AGE', 'IDEMPOTENCY_KEY'],
        ...entries.map((entry) => [
          entry.id,
          entry.reasonClass,
          entry.message?.model_id_uint ?? '-',
          entry.message ? rewardAmountFromMessage(entry.message).toString() : '-',
          ageFromTimestamp(entry.timestamp),
          summarizeId(entry.message?.idempotency_key),
        ]),
      ];
      process.stdout.write(formatTable(rows) + '\n');
      return;
    }

    if (args.command === 'inspect') {
      const id = args.positional[0];
      if (!id) {
        throw new Error('inspect requires an id');
      }

      const entry = await store.getById(id);
      let onChain: OnChainMintStatus | null = null;
      let validation = entry.message ? validateMintRequestMessage(entry.message) : null;
      let decision: ReplayDecision | null = null;

      if (validation !== null && validation.error === undefined) {
        const readers = buildOnChainReaders(config);
        onChain = await readOnChainStatus(
          readers.client,
          readers.provider,
          readers.deltaVerifierAddress,
          validation.value,
        );
        decision = decideReplay(parseDlqEntry(entry.raw), onChain);
      }

      const output = {
        entry,
        validation: validation
          ? { valid: validation.error === undefined, error: validation.error?.message }
          : { valid: false, error: entry.parseError ?? 'originalMessage is not an object' },
        onChain,
        replayDecision: decision,
      };

      if (hasFlag(args, 'json')) {
        process.stdout.write(stringifyJson(output) + '\n');
        return;
      }

      process.stdout.write(stringifyJson(output) + '\n');
      if (decision) {
        process.stdout.write(renderDecision(decision) + '\n');
      }
      return;
    }

    if (args.command === 'replay') {
      const id = args.positional[0];
      if (!id) {
        throw new Error('replay requires an id');
      }

      const entry = await store.getById(id);
      if (!entry.message) {
        throw new Error('REFUSED unparseable: originalMessage is not a MintRequest object');
      }

      const validation = validateMintRequestMessage(entry.message);
      if (validation.error) {
        throw new Error(`REFUSED schema_invalid: ${validation.error.message}`);
      }

      const readers = buildOnChainReaders(config);
      const onChain = await readOnChainStatus(
        readers.client,
        readers.provider,
        readers.deltaVerifierAddress,
        validation.value,
      );
      const decision = decideReplay(entry, onChain);
      process.stdout.write(renderDecision(decision) + '\n');
      if (!decision.allowed) {
        process.exitCode = 2;
        return;
      }

      if (!hasFlag(args, 'execute')) {
        process.stdout.write(
          'DRY-RUN: would LPUSH to inbound and LREM exact DLQ entry. Use --execute to act.\n',
        );
        return;
      }

      const replayMessage = stripRetryScratch(validation.value);
      const result = await store.replay(entry, replayMessage);
      process.stdout.write(
        `EXECUTED: inboundDepth=${result.inboundDepth} removedFromDlq=${result.removedCount}\n`,
      );
      if (result.removedCount === 0) {
        process.exitCode = 3;
      }
      return;
    }

    if (args.command === 'discard') {
      const id = args.positional[0];
      const reason = readFlag(args, 'reason');
      if (!id) {
        throw new Error('discard requires an id');
      }
      if (!reason || reason.trim() === '') {
        throw new Error('discard requires --reason=<text>');
      }

      const entry = await store.getById(id);
      if (!hasFlag(args, 'execute')) {
        process.stdout.write(
          `DRY-RUN: would archive ${entry.id} to ${config.archiveQueue} and remove it from ${config.dlqQueue}. Use --execute to act.\n`,
        );
        return;
      }

      const result = await store.discard(entry, reason, process.env.USER ?? 'unknown');
      process.stdout.write(
        `EXECUTED: archiveDepth=${result.archiveDepth} removedFromDlq=${result.removedCount}\n`,
      );
      if (result.removedCount === 0) {
        process.exitCode = 3;
      }
      return;
    }

    throw new Error(`Unknown command ${args.command}`);
  } finally {
    await redis.quit();
  }
}

main().catch((error: unknown) => {
  if (error instanceof DlqEntryNotFoundError || error instanceof DlqEntryAmbiguousError) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }

  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
