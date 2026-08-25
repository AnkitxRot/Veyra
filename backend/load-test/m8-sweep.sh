#!/usr/bin/env bash
# M8 measurement-only sweep driver. Not part of the harness proper —
# a disposable runner script for this milestone's data collection.
set -uo pipefail
cd "$(dirname "$0")/.."

LOG=load-test/results/m8-sweep.log
: > "$LOG"

run_one() {
  local level="$1"; shift
  echo "[m8-sweep] $(date -u +%H:%M:%S) starting level=$level args: $*" | tee -a "$LOG"
  npx tsx load-test/run.ts --level "$level" --collab-only --relax-auth-rate-limit \
    --ramp 15 --steady 45 --rampdown 10 "$@" >> "$LOG" 2>&1
  local status=$?
  echo "[m8-sweep] $(date -u +%H:%M:%S) finished level=$level exit=$status" | tee -a "$LOG"
  return $status
}

FAILED=()

# Baseline: current production default (25ms), across room sizes.
for u in 1 2 3 5 10 25 50; do
  run_one "m8-baseline-$u" --users "$u" || FAILED+=("baseline:$u")
done

# Window sweep: 0/5/10/50ms (25ms already covered by baseline) across
# representative room sizes.
for w in 0 5 10 50; do
  for u in 2 5 10 25 50; do
    run_one "m8-sweep-${w}ms-$u" --users "$u" --yjs-coalesce-ms "$w" || FAILED+=("sweep:${w}ms:$u")
  done
done

if [ ${#FAILED[@]} -gt 0 ]; then
  echo "[m8-sweep] retrying ${#FAILED[@]} failed run(s) once: ${FAILED[*]}" | tee -a "$LOG"
  for f in "${FAILED[@]}"; do
    if [[ "$f" == baseline:* ]]; then
      u="${f#baseline:}"
      run_one "m8-baseline-$u-retry" --users "$u"
    else
      w="${f#sweep:}"; w="${w%%:*}"; u="${f##*:}"
      run_one "m8-sweep-${w}-$u-retry" --users "$u" --yjs-coalesce-ms "${w%ms}"
    fi
  done
fi

echo "[m8-sweep] ALL DONE" | tee -a "$LOG"
