#!/usr/bin/env node
/*
 * Mainnet launch conductor (G-1/G-2 — "bake the launch sequence into one gated process").
 *
 * WHY A CONDUCTOR AND NOT A ONE-SHOT DEPLOY:
 * Mainnet privileged actions are intentionally Safe/timelock-mediated. `init-launch-posture`
 * BLOCKS `--execute` on mainnet and instead emits a Safe Transaction Builder JSON that the
 * 2-of-3 admin Safe submits; the governance handoff to the 48h timelock is irreversible. So a
 * fully-automated "deploy + configure + hand off" script would either hit those guards or
 * bypass the very controls the security review hardened. This conductor therefore:
 *   - RUNS the deployer-key phases (contract deploy, timelock deploy, pool creation) and the
 *     read-only verification GATES,
 *   - GENERATES the Safe bundle for the mint-posture config (disableLegacyMints + attester +
 *     budget + weight-genesis) and STOPS for the operator to submit it via the Safe,
 *   - GATES the irreversible deployer->timelock handoff behind a DRY_RUN preview + explicit
 *     confirmation, and re-verifies posture/governance afterward.
 * Any failing GATE aborts the whole run. Phases are resumable with `--from <phase>`.
 *
 * USAGE
 *   node scripts/launch-mainnet.js --plan                 # print the ordered plan, run nothing
 *   node scripts/launch-mainnet.js                        # run, pausing at every STOP/GATE
 *   node scripts/launch-mainnet.js --from create-pools    # resume from a phase
 *   node scripts/launch-mainnet.js --network sepolia      # REHEARSE the whole flow on Sepolia first
 *   node scripts/launch-mainnet.js --yes                  # don't pause for interactive confirms (CI/rehearsal)
 *
 * This conductor only sequences/gates the existing, proven scripts — it never re-implements
 * their logic. Rehearse end-to-end on Sepolia (`--network sepolia`) before any mainnet run.
 */
const { spawnSync } = require("child_process");
const readline = require("readline");

function parseArgs(argv) {
  const args = { network: "mainnet", plan: false, yes: false, from: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--plan") args.plan = true;
    else if (a === "--yes") args.yes = true;
    else if (a === "--from") args.from = argv[++i];
    else if (a === "--network") args.network = argv[++i];
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const NET = args.network;
const SAFE_BUNDLE = `deployments/${NET}-launch-posture-safe.json`;
const TOKEN_KEYS = "hmess,hlead,hrout";

// kind: deployer = run with the deployer KMS key | gate = read-only verifier (must pass)
//       safe-bundle = generate a Safe-tx JSON then STOP for Safe submission
//       confirm = explicit human go/no-go before an irreversible step
const PHASES = [
  {
    name: "deploy-contracts",
    kind: "deployer",
    desc: "Deploy core contracts (registry, token manager, factory, reserve, oracle, router, DeltaVerifier).",
    cmd: `npx hardhat run scripts/deploy-mainnet.js --network ${NET}`,
  },
  {
    name: "deploy-timelock",
    kind: "deployer",
    desc: "Deploy the 48h HokusaiTimelockController (proposer/executor/canceller = admin Safe). Handoff target, not yet active.",
    cmd: `npx hardhat run scripts/governance/deploy-timelock.js --network ${NET}`,
  },
  {
    name: "create-pools",
    kind: "deployer",
    desc: "Deploy the launch tokens + AMM pools and distribute supplier/investor allocations.",
    cmd: `LAUNCH_TOKEN_KEYS=${TOKEN_KEYS} npx hardhat run scripts/create-mainnet-pools.js --network ${NET}`,
  },
  {
    name: "posture-safe-bundle",
    kind: "safe-bundle",
    desc: "Generate the Safe bundle for mint posture: disableLegacyMints (G-2) + attester registry + per-model mint budget + weight-genesis. Submit via the admin Safe.",
    cmd: `node scripts/init-launch-posture.js --network ${NET} --safe-txs ${SAFE_BUNDLE}`,
    stop: `Submit ${SAFE_BUNDLE} via the admin Safe (Transaction Builder), wait for execution, THEN resume:\n      node scripts/launch-mainnet.js --network ${NET} --from verify-posture-pre`,
  },
  {
    name: "verify-posture-pre",
    kind: "gate",
    desc: "GATE: mint posture green (legacyMintsDisabled, attesters, budgets, genesis) before handoff.",
    cmd: `npx hardhat run scripts/verify-launch-posture.js --network ${NET}`,
  },
  {
    name: "confirm-handoff",
    kind: "confirm",
    desc: "IRREVERSIBLE NEXT: transfer ownership/admin from the deployer to the 48h timelock. After this, every privileged change is 48h-delayed. Confirm the deploy + posture are correct.",
  },
  {
    name: "handoff-dry-run",
    kind: "deployer",
    desc: "Preview the governance handoff (no state change).",
    cmd: `DRY_RUN=true npx hardhat run scripts/governance/transfer-governance.js --network ${NET}`,
  },
  {
    name: "handoff",
    kind: "deployer",
    desc: "IRREVERSIBLE: transfer ownership/DEFAULT_ADMIN to the timelock and revoke the deployer (DeltaVerifier + DataContributionRegistry admin stay at the Safe per policy).",
    cmd: `npx hardhat run scripts/governance/transfer-governance.js --network ${NET}`,
  },
  {
    name: "verify-governance",
    kind: "gate",
    desc: "GATE: every policy contract owned/administered by the timelock (or Safe where specified); deployer revoked everywhere.",
    cmd: `npx hardhat run scripts/governance/verify-governance.js --network ${NET}`,
  },
  {
    name: "verify-posture-post",
    kind: "gate",
    desc: "GATE: composite posture verify post-handoff (mint posture + ownershipAudit). This is the final go-live gate.",
    cmd: `npx hardhat run scripts/verify-launch-posture.js --network ${NET}`,
  },
];

function ask(question) {
  if (args.yes) return Promise.resolve("yes");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(a.trim()); }));
}

function run(cmd) {
  console.log(`\n$ ${cmd}`);
  const res = spawnSync(cmd, { stdio: "inherit", shell: true });
  return res.status === 0;
}

function printPlan() {
  console.log(`\nMainnet launch conductor — plan (--network ${NET})\n`);
  PHASES.forEach((p, i) => {
    console.log(`${String(i + 1).padStart(2)}. [${p.kind}] ${p.name}`);
    console.log(`     ${p.desc}`);
    if (p.cmd) console.log(`     cmd: ${p.cmd}`);
    if (p.stop) console.log(`     STOP: ${p.stop.split("\n")[0]}`);
  });
  console.log(`\nGATEs abort on failure. safe-bundle/confirm phases pause for human action.`);
  if (NET === "mainnet") console.log(`\n⚠️  Rehearse end-to-end on Sepolia first: node scripts/launch-mainnet.js --network sepolia`);
}

async function main() {
  if (args.plan) { printPlan(); return; }

  let started = !args.from;
  for (const p of PHASES) {
    if (!started) {
      if (p.name === args.from) started = true;
      else { console.log(`(skip ${p.name} — resuming from ${args.from})`); continue; }
    }

    console.log(`\n=== ${p.name} [${p.kind}] ===\n${p.desc}`);

    if (p.kind === "confirm") {
      const a = await ask(`\nType "HANDOFF" to proceed with the irreversible governance transfer, anything else to abort: `);
      if (a !== "HANDOFF") { console.log("Aborted before handoff."); process.exit(1); }
      continue;
    }

    const ok = run(p.cmd);

    if (p.kind === "gate" && !ok) {
      console.error(`\n❌ GATE FAILED: ${p.name}. Aborting launch. Fix and re-run with --from ${p.name}.`);
      process.exit(1);
    }
    if (p.kind !== "gate" && !ok) {
      console.error(`\n❌ Phase ${p.name} failed (exit != 0). Aborting. Re-run with --from ${p.name} after fixing.`);
      process.exit(1);
    }
    if (p.kind === "safe-bundle") {
      console.log(`\n⏸  STOP: ${p.stop}`);
      return; // hand control to the operator's Safe step
    }
  }
  console.log(`\n✅ Conductor complete through final gate. Record the verifier outputs as launch artifacts and tag the release.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
