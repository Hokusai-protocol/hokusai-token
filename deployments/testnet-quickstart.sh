#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MONITORING_SCRIPT="$ROOT_DIR/services/contract-deployer/scripts/deploy-monitoring.sh"

echo "Hokusai Sepolia operational quickstart"
echo "======================================"
echo
echo "This helper no longer performs a full bespoke AWS/ECS setup."
echo "The supported flow is:"
echo
echo "  1. Deploy or refresh Sepolia contracts:"
echo "     npm run deploy:sepolia"
echo
echo "  2. Complete custody rehearsal:"
echo "     docs/mainnet-custody-runbook.md"
echo
echo "  3. Deploy monitoring with the service-local script:"
echo "     services/contract-deployer/scripts/deploy-monitoring.sh"
echo

if [[ ! -f "$MONITORING_SCRIPT" ]]; then
  echo "ERROR: monitoring deploy script not found: $MONITORING_SCRIPT" >&2
  exit 1
fi

echo "Preflight checks"
echo "----------------"

if ! command -v npm >/dev/null 2>&1; then
  echo "ERROR: npm is required" >&2
  exit 1
fi

if ! command -v npx >/dev/null 2>&1; then
  echo "ERROR: npx is required" >&2
  exit 1
fi

if ! command -v aws >/dev/null 2>&1; then
  echo "ERROR: aws CLI is required for monitoring deployment" >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "ERROR: Docker is required for monitoring deployment" >&2
  exit 1
fi

if [[ ! -f "$ROOT_DIR/deployments/sepolia-latest.json" ]]; then
  echo "ERROR: deployments/sepolia-latest.json not found. Run npm run deploy:sepolia first." >&2
  exit 1
fi

echo "Found required tools and deployments/sepolia-latest.json."
echo

read -r -p "Run compile and tests now? [y/N] " RUN_TESTS
if [[ "$RUN_TESTS" =~ ^[Yy]$ ]]; then
  (cd "$ROOT_DIR" && npx hardhat compile && npm test)
fi

read -r -p "Run monitoring deployment script now? [y/N] " RUN_MONITORING
if [[ "$RUN_MONITORING" =~ ^[Yy]$ ]]; then
  (cd "$ROOT_DIR/services/contract-deployer" && ./scripts/deploy-monitoring.sh)
else
  echo "Skipped monitoring deployment."
fi

echo
echo "Next required operator steps:"
echo "- Complete deployments/TESTNET-CHECKLIST.md"
echo "- Complete docs/mainnet-custody-runbook.md"
echo "- Verify pool pause/unpause path before mainnet"
