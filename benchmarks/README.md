# Benchmarks

The harness behind Retest's speed measurements. It runs the same generated tests through Retest and Playwright, against the same fixture app and the same Chrome, and writes per-phase medians. Every speed number the project publishes comes from here, with the command that produced it.

```sh
npm run bench                      # the whole matrix, five runs per cell
npm run bench -- --sizes 1,20 --runs 3 --fixtures task-app
```

## What it does

1. Builds Retest, packs it with `npm pack`, and installs the tarball offline into a project outside the repository.
2. Installs `@playwright/test` into a second project outside the repository. `latest` is asked of the registry on every run, and the project is reinstalled whenever its version is not the one asked for, or on `--reinstall`. Playwright is never a dependency of this package, and its browsers are never downloaded: both tools run the Chrome you point them at.
3. Starts a fixture app from this checkout, writes both tools' configs for its address, generates the test files, and runs each cell `--runs` times, interleaving the runners so no tool gets a cold machine or a warm one alone.
4. Writes `results.json` and `results.md` under `.retest/benchmarks/<time>/`, with every run's own output beside them under `runs/`. The results name the commit the package was packed from, whether the working tree was clean, and whether dist was rebuilt, so a number can always be tied to the code it measured. The output folder must not hold files yet, because Retest never writes over a run.

A run that passes `--run-timeout-ms` is ended with every process it started, browsers included, and its cell says `timed out`. The fixture servers are ended whenever the harness exits, Ctrl+C included. `node benchmarks/run.ts --help` lists every flag.

## Fixtures

| Fixture | Stands for |
| --- | --- |
| `task-app` | Runner-dominated. The page answers at once, so the runner's own time is most of a test |
| `search-app` | App-dominated. A 150 ms API and a 300 ms debounce, so the app's waiting is most of a test |

## Phases

Both tools are read the same way: Retest from its `events.jsonl`, Playwright from its JSON reporter.

| Phase | From | To |
| --- | --- | --- |
| Wall | spawning the process | the process exiting |
| Startup | spawning the process | the first test starting |
| Tests | the first test starting | the last test ending |
| Teardown | the last test ending | the process exiting |
| Per test | the median of what the tool reports for one test | |

A run is valid only when every expected test passed and the process exited 0. Medians read valid runs alone, and the table says how many of the runs were valid. A cell with no valid run prints the reasons instead of numbers; nothing is dropped quietly.

## Rules

From the plan's methodology section.

- Both fixtures are always published together.
- Both tools run on their defaults. A Playwright row with one worker is the like-for-like comparison for a single file, and the default-workers row is what a user gets.
- The row "Retest, on Playwright's own spec files" runs the Playwright project's files unchanged through `retest run --playwright`, so the two tools are compared on the very same files.
- The rows where Retest is slower stay in.
- Never compared to Vitest. It is a unit runner.

<a id="recording-measurements"></a>
## Recording measurements

`recording.ts` adds a macOS resource scenario beside the original harness. It runs the same generated one-test file with recording off and on on Chrome, Firefox and WebKit, on both fixture apps. It also compares Chrome with Playwright, recording off, with explicit matched settings. Before any sample it compiles its read-only observer with clang into the path supplied by `--observer`. This scenario records measurements and makes no speed claim. `npm run bench` remains the tool for repository speed claims.

Prepare an external workspace with the original harness. The session script runs `npm run bench` for both fixtures, one and twenty tests, five repetitions, then the three-engine recording matrix, then the matched recording-off Chrome comparison. Playwright 1.63.0 must already be installed in `<workspace>/playwright-project`; the session sets npm offline and never downloads a browser. The original default-setting rows are labelled separately from the new matched rows. The standalone scenario accepts `--no-comparison` for the recording matrix and `--engines chromium --comparison-only` for the matched rows.

```sh
clang -O2 -Wall -Wextra -Werror benchmarks/recording-resource.c -o /tmp/retest-recording-resource
lockf -t 0 /tmp/retest-heavy-gate.lock sh benchmarks/recording-session.sh \
  "$PWD/.retest/benchmarks/<fresh-session>" /tmp/retest-measurements-workspace
```

The lock stays held for the entire script. Run no tests during the session, including unit tests. Preflight refuses an active test, automation browser, simulator, media process or benchmark. The founder-authorized idle test child 36744 is recorded and left untouched. It must remain at 0% CPU. Preflight stores process names and resource summaries, without unrelated command arguments. A personal browser or development service contributes host load and is named in the session report.

Cold means a new empty `NODE_COMPILE_CACHE` for each sample. Warm means one successful uncounted priming run with the same cache, followed by the measured run. Both launch a fresh CLI, browser and isolated context. Neither clears OS filesystem caches or keeps a browser alive. Servers are started before the CLI timer. Off/on order alternates between repetitions. Five measured repetitions per cell are required; report median, min/max and quartiles. JSON also holds nearest-rank p95, which equals the observed maximum with five samples and is not a reliable population tail estimate.

The recording settings are 10 fps, 1280×720, all videos retained, required complete evidence, a headless browser, viewport 1280×720 and one worker/browser. Diagnostic capture stays on for the off/on recording cells. The matched Chrome cells turn diagnostics off for Retest and use no diagnostic capture in Playwright; video, trace and screenshots are off, including failure screenshots. Both use the same Chrome executable, fixture/address and test body, one worker, scale 1, a fresh context per test, no retries, a 30 s test/navigation budget and 5 s action/assertion budgets. The imports and each tool's implementation, browser launch flags, bookkeeping and cleanup differ. Navigation waits retain each tool's implementation.

`results.json` and `results.md` follow the original output shape, with raw output under `runs/`. Each run also has `launch.json`, `runner-resource.json`, `resources.json`, observer stderr and the Retest run folder or Playwright JSON output. Warm priming results are retained separately. Valid medians require every expected test, exit 0, a CLI resource reading and, when recording is on, one complete recording with independent ffprobe facts and a successful whole decode. Invalid runs remain in the results. Decode/probe work runs after timing and before the next sample. It never overlaps a measured CLI.

Complete-run wall time covers CLI spawn through close, including media readiness, capture, encoding finalization and runner cleanup. The CLI's `process.resourceUsage()` supplies own CPU and maximum RSS at its exit hook; later exit hooks may still do work. The read-only C observer uses macOS `proc_pid_rusage` to sample launched descendants every 5 ms and converts Mach CPU ticks with `mach_timebase_info`. It records native start identity and the latest readable executable path, own CPU, kernel lifetime peak physical footprint and sampled RSS. Native runner and media CPU exclude children and are lower bounds at the last sample. The footprint high-water mark is also read at the last sample; late peaks and short-lived children may be missed. Actual sampling gaps are reported. Runner RSS and media footprint are distinct measures. ffmpeg samples include readiness probes and encoding, with their CPU and maximum single-process footprint summarized separately. Neither process reading represents the whole browser/process tree.

Before measuring, `recording-observer.test.ts` checks CPU units against Node's independent resource reading and requires discovery of a launched child. Compile the observer, check that no benchmark is running, and run it alongside `recording-checks.test.ts` before the measurement session. Never run either check during measurements. The native API details are checked against Apple's [libproc implementation](https://github.com/apple-oss-distributions/xnu/blob/main/libsyscall/wrappers/libproc/libproc.c) and [resource accounting](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/kern_resource.c). No upstream implementation was copied.

Artifact size sums regular files under `run/artifacts`. A second size includes the complete run folder. Neither includes compile caches, priming runs, project installations, benchmark logs or resource files. No product source changes are needed. The observer needs macOS SDK headers and clang; ffmpeg, ffprobe and the three browser builds are explicit installed host prerequisites. The CLI accepts their paths and refuses unavailable work rather than substituting an engine. No npm runtime package is added.

Keep durable copies of every result pair under `benchmarks/results/<session>/`, and name the raw `.retest/benchmarks/<session>/` outputs in its README. Include the source commit, dirty state, tool/binary versions and hashes, exact commands, load, invalid samples and cleanup findings. Historical baseline rows are comparable only to their stated scenario and settings. These one-host numbers do not establish a speed advantage, suite throughput, native performance or complete process-tree resource use.

