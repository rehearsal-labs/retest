#!/bin/sh
# Run this through lockf. Every child runs sequentially under that same lock.
set -eu
if [ "$#" -ne 2 ]; then
  echo 'usage: lockf -t 0 /tmp/retest-heavy-gate.lock sh benchmarks/recording-session.sh <fresh-output> <prepared-workspace>' >&2
  exit 2
fi
task_output=$1
task_workspace=$2
mkdir -p "$task_output"
node benchmarks/recording-preflight.ts "$task_output/preflight.json"
printf '%s\n' "session pid $$, parent $PPID" > "$task_output/lock-holder.txt"
ps -p "$PPID" -o pid=,ppid=,comm= >> "$task_output/lock-holder.txt"
# The named Playwright is preinstalled offline. The harness must never ask the registry.
export npm_config_offline=true
export npm_config_update_notifier=false
export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
echo 'running the original benchmark with recording off' >&2
npm run bench -- --sizes 1,20 --runs 5 --runners retest,retest-playwright,playwright-1-worker --playwright-version 1.63.0 --workspace "$task_workspace" --output "$task_output/default-comparison" > "$task_output/default-comparison.log" 2>&1
node benchmarks/recording-preflight.ts "$task_output/between-scenarios.json"
echo 'running the three-engine recording matrix' >&2
node benchmarks/recording.ts --runs 5 --no-comparison --workspace "$task_workspace" --observer /tmp/retest-recording-resource --output "$task_output/recording" > "$task_output/recording.log" 2>&1
node benchmarks/recording-preflight.ts "$task_output/after.json"
echo 'recording matrix finished' >&2
echo 'running the matched recording-off comparison' >&2
node benchmarks/recording.ts --runs 5 --engines chromium --comparison-only --workspace "$task_workspace" --observer /tmp/retest-recording-resource --output "$task_output/matched-comparison" > "$task_output/matched-comparison.log" 2>&1
node benchmarks/recording-preflight.ts "$task_output/after-matched.json"
echo 'measurement session finished' >&2
