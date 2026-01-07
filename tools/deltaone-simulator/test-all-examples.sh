#!/bin/bash

# Test script for all DeltaOne simulator examples

echo "╔══════════════════════════════════════════════════════════╗"
echo "║     DeltaOne Simulator - Test All Examples              ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""

EXAMPLES=(
  "sample-evaluation.json"
  "high-improvement.json"
  "low-improvement.json"
  "edge-case-no-improvement.json"
  "edge-case-partial-improvement.json"
  "multi-contributor-scenario.json"
)

PASS=0
FAIL=0

for example in "${EXAMPLES[@]}"; do
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "Testing: $example"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

  if npm run simulate -- examples/$example test-model 2>&1 | grep -q "status"; then
    echo "✅ PASS: $example"
    PASS=$((PASS + 1))
  else
    echo "❌ FAIL: $example"
    FAIL=$((FAIL + 1))
  fi

  echo ""
done

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Test Summary"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Passed: $PASS"
echo "Failed: $FAIL"
echo "Total:  $((PASS + FAIL))"
echo ""

if [ $FAIL -eq 0 ]; then
  echo "✅ All tests passed!"
  exit 0
else
  echo "❌ Some tests failed"
  exit 1
fi
