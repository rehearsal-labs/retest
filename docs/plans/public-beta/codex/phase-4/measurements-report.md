# Phase 4 measurements

The completed locked session passed. Original benchmark 60/60 valid measured runs; recording 120/120; matched recording-off comparison 40/40. All 80 warm priming runs passed. All 90 videos passed independent metadata checks and whole-video decoding. These are measurements on this host with its background load. They establish no speed advantage.

## Machine, load and isolation

Apple M4 Max, 14 cores, 36 GiB, arm64, macOS 27.0.1 build 26A434, Darwin 27.0.0, Node v24.12.0. Retest was packed from b59eed5d6b4ffc6e903198fdbabdd0356946aa41 with existing uncommitted changes. The original benchmark rebuilt dist before packing. The installed package identifies itself as 0.0.0; this is work for the 0.1.0 candidate.

| Checkpoint | UTC timestamp | Processes | Load 1 min | Load 5 min | Load 15 min |
| --- | --- | --- | --- | --- | --- |
| Entry | 2026-10-06T14:24:40.180Z | 798 | 4.37 | 4.29 | 6.41 |
| After original benchmark | 2026-10-06T14:31:11.973Z | 783 | 5.00 | 5.44 | 6.29 |
| After recording | 2026-10-06T14:37:43.103Z | 790 | 7.51 | 7.38 | 6.97 |
| After matched comparison | 2026-10-06T14:40:27.731Z | 791 | 5.75 | 6.83 | 6.82 |

Preflights found no competing Retest worker process. The resource samples had one-minute load median/min/max 7.18/5.00/11.77. JSON retains each before/after reading.

Personal Chrome, the editor, WindowServer, development services and other desktop programs remained running. No unrelated process was stopped. Preflight saves process names, CPU and RSS without unrelated command arguments. These measurements include that background load. They do not establish a globally idle machine.

The founder-authorized idle diagnostics-engines test child, PID 36744, remained at 0.0% CPU and was left untouched. Preflight recorded it separately.

The completed session held `lockf -t 0 /tmp/retest-heavy-gate.lock` continuously across setup, the original benchmark, all recording runs, independent decodes and the matched comparison. Its lock holder is recorded in `lock-holder.txt`. Separate acquisition probes returned `already locked`. No test command ran during a measurement session. Verification checks ran only after the completed session exited.

## Tools and exact commands

Read README, architecture, both common briefs, the benchmark README/program/modules, the speed handoff, the Phase 4 verification bullet and the recording-runner/media-process reports. The lane request authorizes `npm run bench` and overrides the common brief's general prohibition for this measurements lane. The speed handoff stayed read-only.

| Tool | Measured version / route |
| --- | --- |
| Chrome | Chrome 154.0.8037.98 @b859317bf11f6be47f9b7799ec690a0a42a1fb33 |
| Firefox | Firefox 133.0.3 20241209150345; RETEST_FIREFOX_ROUTE=launch-services |
| WebKit | WebKit 626.1.6+, build 2359; real automation build, not Safari |
| Playwright | 1.63.0 |
| Media | 0.1.0, protocol 2, release, aarch64-apple-darwin, b59eed5d6b4ffc6e903198fdbabdd0356946aa41, dirty |
| ffmpeg / ffprobe | ffmpeg 9.0.2 / ffprobe 9.0.2 |

`environment.json` contains executable paths, resolved paths, sizes and SHA-256 hashes, installed package fingerprints and benchmark-source hashes. Hashes were collected after measurement. Browser launchers and their engine framework/XUL, and all three installed Playwright packages, are included. Dynamic OS and encoder libraries are not completely fingerprinted. Browser-start events retain the observed builds. The production media binary already existed; this lane ran no media rebuild or download.

All commands used `/Users/dragon/Documents/Projects/Gruvi/Products/retest` as cwd. Playwright came from the existing offline npm cache into a private external workspace. The exact preparation and completed session commands were:

```sh
npm install --offline --ignore-scripts --no-audit --no-fund --prefix /tmp/retest-measurements-workspace/playwright-project @playwright/test@1.63.0 > /tmp/retest-measurements-playwright-install.log 2>&1
lockf -t 0 /tmp/retest-heavy-gate.lock sh benchmarks/recording-session.sh "$PWD/.retest/benchmarks/measurements-phase-4-verified" /tmp/retest-measurements-workspace > /tmp/retest-measurements-session-verified.log 2>&1
```

The external Playwright project was created with a private ESM package manifest before the offline install. The session script sets npm offline, disables its update notifier and sets `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`. It executes these commands serially under that one lock, capturing each scenario's output:

```sh
npm run bench -- --sizes 1,20 --runs 5 --runners retest,retest-playwright,playwright-1-worker --playwright-version 1.63.0 --workspace /tmp/retest-measurements-workspace --output "$PWD/.retest/benchmarks/measurements-phase-4-verified/default-comparison"
node benchmarks/recording.ts --runs 5 --no-comparison --workspace /tmp/retest-measurements-workspace --observer /tmp/retest-recording-resource --output "$PWD/.retest/benchmarks/measurements-phase-4-verified/recording"
node benchmarks/recording.ts --runs 5 --engines chromium --comparison-only --workspace /tmp/retest-measurements-workspace --observer /tmp/retest-recording-resource --output "$PWD/.retest/benchmarks/measurements-phase-4-verified/matched-comparison"
```

The resource program compiles its observer before any sample with `clang -O2 -Wall -Wextra -Werror benchmarks/recording-resource.c -o /tmp/retest-recording-resource`. Retest CLI commands use one worker, one browser, no agent and a fresh output. Playwright uses one worker and its JSON reporter. Each CLI gets the resource preload and its own compile-cache directory. The explicit media/ffmpeg paths and `RETEST_FIREFOX_ROUTE=launch-services` are supplied by the program. Each actual command, cwd and root PID is retained in `launch.json` and results JSON.

## Method and reading the tables

Five measured repetitions per cell. Tables give median [minimum, maximum]. Resource JSON also gives Q1, Q3 and nearest-rank p95. With five samples p95 is the maximum; it is not a population tail estimate. Valid means one expected passed test, exit 0, both CLI resource readings and no evidence problem. Recorded runs also require exactly one complete video and independent codec, size, frame-count, duration and whole-decode checks. Priming must pass too.

Cold is a fresh empty Node compile-cache directory. Warm is a fresh measured CLI/browser/context after its own uncounted successful priming run with the same directory. Neither clears OS caches or retains a browser. Fixture servers are running before timing. Off/on order reverses between repetitions. The same generated one-test file runs unchanged for every off/on cell. Both fixtures are published.

Recording cells keep diagnostic capture on. They use a headless browser, viewport 1280 by 720, recording 1280 by 720 at 10 fps, keep all, required complete evidence, one worker/browser. Test/navigation timeouts are 30 s and action/assertion timeouts are 5 s. On/off changes only the record/required flags.

Complete-run wall time is CLI spawn through CLI close, including media readiness, capture, video finalization and cleanup. It excludes fixture setup, observer compilation, package installation, warm priming and independent decode/probe work. Decode/probe work runs after the timed CLI ends and before the next sample. The observer and preload themselves add measurement work.

Runner CPU and maximum RSS come from its own exit-hook `process.resourceUsage()`. Later exit hooks may still do work. Native own CPU excludes children and is a lower bound at the last readable sample. The read-only native observer samples descendants with `proc_pid_rusage` and converts Mach CPU ticks using `mach_timebase_info`. Media footprint is the kernel lifetime high-water mark read at the last sample; media RSS is a sampled maximum. Late peaks, final CPU and short-lived children may be missed. Physical footprint and RSS are different measures and must not be added.

The requested sampling interval was 5 ms. Largest gaps across measured resource runs had median 7.56 ms and range 6.42 to 16.99 ms. Events between samples can be missed.

Firefox launch-services browser descendants are outside direct CLI ancestry. No whole-browser/process-tree total is claimed.

## Recording off and on

Every cell passed 5/5 measured runs; each warm cell also passed 5/5 priming. CPU is the CLI exit-hook reading. Media own CPU is a sampled lower bound, excluding ffmpeg. Milliseconds.

| Engine | Fixture | Cache | Off wall ms | On wall ms | Off runner CPU ms | On runner CPU ms | On media CPU ms lower bound |
| --- | --- | --- | --- | --- | --- | --- | --- |
| chromium | task-app | cold | 1255.18 [1199.81, 1333.41] | 1795.42 [1738.27, 1838.47] | 343.47 [316.78, 346.87] | 374.68 [370.01, 383.45] | 14.88 [14.26, 18.32] |
| chromium | task-app | warm | 1171.38 [1091.87, 1228.34] | 1698.05 [1621.28, 1726.71] | 312.94 [302.31, 315.37] | 354.69 [343.78, 356.32] | 14.26 [13.48, 15.64] |
| chromium | search-app | cold | 1578.77 [1538.92, 1635.16] | 2141.05 [2058.92, 2153.57] | 340.92 [335.83, 356.32] | 382.41 [376.41, 385.26] | 16.57 [15.81, 18.86] |
| chromium | search-app | warm | 1479.06 [1423.97, 1520.45] | 2010.04 [2001.52, 2100.90] | 313.43 [307.68, 320.04] | 355.45 [354.02, 357.83] | 16.74 [16.29, 17.00] |
| firefox | task-app | cold | 2253.95 [2112.41, 3121.42] | 2662.90 [2602.02, 2843.07] | 390.85 [361.07, 402.23] | 390.56 [378.25, 408.53] | 16.91 [13.86, 18.52] |
| firefox | task-app | warm | 2042.40 [1938.20, 2134.14] | 2635.78 [2505.64, 2817.17] | 352.04 [329.26, 358.05] | 369.12 [355.62, 387.18] | 14.37 [13.31, 20.20] |
| firefox | search-app | cold | 2607.87 [2506.60, 2745.49] | 3131.41 [3011.56, 3227.07] | 378.66 [371.20, 392.10] | 398.90 [390.72, 415.22] | 28.62 [21.16, 36.10] |
| firefox | search-app | warm | 2472.36 [2419.68, 2606.51] | 3042.61 [2965.95, 3289.90] | 348.72 [326.99, 365.55] | 380.92 [371.04, 405.13] | 28.16 [25.13, 29.97] |
| webkit | task-app | cold | 1704.10 [1603.88, 2173.86] | 2109.92 [2088.15, 2180.19] | 305.52 [298.07, 329.32] | 321.57 [320.51, 345.30] | 12.47 [11.66, 13.12] |
| webkit | task-app | warm | 1532.61 [1495.04, 1605.56] | 2097.44 [2016.88, 2282.01] | 289.97 [271.14, 291.19] | 320.91 [307.84, 337.09] | 12.37 [11.83, 13.15] |
| webkit | search-app | cold | 1985.37 [1967.25, 2175.62] | 2606.89 [2497.22, 2724.16] | 317.43 [313.14, 358.73] | 357.03 [337.14, 360.04] | 15.62 [15.36, 20.00] |
| webkit | search-app | warm | 1919.60 [1864.39, 1995.00] | 2389.16 [2345.57, 2443.41] | 290.43 [286.05, 299.05] | 310.01 [306.43, 317.17] | 14.96 [14.84, 17.07] |

Runner maximum RSS at the exit hook, media kernel peak footprint at the last native sample, media sampled maximum RSS, and kept artifact size. MiB is 2^20 bytes; KiB is 1024 bytes. Recording-off cells started no media worker and kept zero artifact bytes. JSON retains exact bytes.

| Engine | Fixture | Cache | Off runner peak RSS MiB | On runner peak RSS MiB | On media peak footprint MiB | On media sampled RSS MiB | On artifact KiB |
| --- | --- | --- | --- | --- | --- | --- | --- |
| chromium | task-app | cold | 144.72 [140.06, 145.78] | 144.83 [144.12, 147.02] | 7.73 [7.70, 7.95] | 9.03 [8.98, 9.20] | 6.61 [6.61, 6.61] |
| chromium | task-app | warm | 144.58 [140.88, 146.38] | 145.59 [144.80, 146.06] | 7.75 [7.69, 7.78] | 9.00 [8.97, 9.08] | 6.61 [6.61, 6.61] |
| chromium | search-app | cold | 143.98 [142.05, 146.47] | 146.58 [141.77, 147.45] | 7.94 [7.84, 8.02] | 9.22 [9.12, 9.30] | 21.06 [21.06, 21.06] |
| chromium | search-app | warm | 141.72 [139.62, 144.94] | 144.33 [141.50, 145.81] | 7.91 [7.84, 8.05] | 9.17 [9.12, 9.31] | 21.07 [21.06, 21.07] |
| firefox | task-app | cold | 147.73 [130.69, 150.53] | 146.86 [145.66, 148.98] | 11.23 [11.17, 11.42] | 12.53 [12.48, 12.72] | 5.08 [5.08, 8.54] |
| firefox | task-app | warm | 147.38 [144.00, 148.02] | 146.98 [133.66, 150.98] | 11.11 [11.08, 11.39] | 12.42 [12.41, 12.70] | 5.08 [5.08, 6.29] |
| firefox | search-app | cold | 144.69 [133.44, 147.58] | 149.28 [136.83, 150.44] | 11.80 [11.53, 11.89] | 13.11 [12.84, 13.16] | 23.01 [23.01, 23.06] |
| firefox | search-app | warm | 146.05 [145.67, 147.91] | 149.16 [134.64, 150.06] | 11.81 [11.59, 11.86] | 13.05 [12.89, 13.14] | 23.01 [23.01, 23.25] |
| webkit | task-app | cold | 144.34 [129.91, 145.86] | 144.94 [144.48, 145.52] | 7.83 [7.75, 7.95] | 9.12 [9.03, 9.23] | 6.88 [6.88, 6.88] |
| webkit | task-app | warm | 144.77 [144.62, 146.27] | 145.19 [143.59, 147.25] | 7.78 [7.75, 7.86] | 9.06 [9.05, 9.16] | 6.88 [5.78, 6.88] |
| webkit | search-app | cold | 145.39 [133.98, 146.75] | 139.23 [132.16, 144.30] | 8.16 [8.02, 8.27] | 9.44 [9.30, 9.53] | 21.82 [21.79, 23.18] |
| webkit | search-app | warm | 144.95 [144.78, 145.59] | 145.47 [142.41, 146.88] | 8.11 [8.00, 8.25] | 9.39 [9.28, 9.52] | 21.82 [21.82, 22.79] |

Additional native readings show the CPU boundary and memory measure. ffmpeg CPU sums observed readiness probes and encoding processes; its footprint is the highest for any single observed ffmpeg. Short-lived probes can be missed. Independent decode is excluded. Run-folder sizes include artifacts, events, results and run logs, but exclude resource/harness files, installations and caches.

| Engine | Fixture | Cache | Off native CLI CPU ms lower bound | On native CLI CPU ms lower bound | Off CLI peak footprint MiB | On CLI peak footprint MiB | On ffmpeg CPU ms lower bound | On ffmpeg max footprint MiB | Off run folder KiB | On run folder KiB |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| chromium | task-app | cold | 396.85 [369.36, 400.50] | 428.02 [419.12, 437.23] | 103.82 [99.03, 105.03] | 104.36 [103.89, 106.59] | 128.88 [127.17, 138.59] | 42.03 [41.92, 42.13] | 23.23 [23.23, 23.23] | 35.03 [35.03, 35.03] |
| chromium | task-app | warm | 314.02 [303.52, 315.74] | 355.82 [344.99, 357.57] | 103.86 [99.90, 105.57] | 104.86 [104.07, 105.40] | 127.98 [124.01, 137.33] | 42.13 [42.03, 42.14] | 23.23 [23.23, 23.23] | 35.03 [35.03, 35.03] |
| chromium | search-app | cold | 393.63 [389.37, 412.28] | 435.97 [428.48, 438.04] | 103.04 [101.04, 105.72] | 105.86 [101.00, 106.67] | 150.24 [139.78, 151.98] | 65.99 [65.94, 66.06] | 25.88 [25.86, 25.88] | 52.13 [52.13, 52.13] |
| chromium | search-app | warm | 314.71 [306.14, 320.76] | 356.63 [355.37, 359.14] | 100.95 [98.86, 104.09] | 103.79 [99.37, 105.12] | 148.41 [138.00, 154.39] | 63.53 [62.45, 65.95] | 25.87 [25.86, 25.88] | 52.14 [52.13, 52.14] |
| firefox | task-app | cold | 443.04 [412.53, 457.06] | 443.06 [430.80, 462.19] | 106.43 [103.86, 108.82] | 104.43 [103.79, 107.31] | 121.78 [118.56, 138.37] | 43.78 [43.70, 52.50] | 21.78 [21.78, 21.78] | 32.67 [32.67, 36.14] |
| firefox | task-app | warm | 353.13 [330.32, 359.15] | 370.31 [357.09, 388.62] | 105.70 [99.50, 106.31] | 106.62 [103.03, 107.07] | 118.13 [114.50, 137.00] | 43.86 [43.78, 52.42] | 21.78 [21.78, 21.78] | 32.67 [32.67, 33.89] |
| firefox | search-app | cold | 433.98 [424.76, 444.11] | 453.09 [443.47, 468.40] | 105.18 [102.32, 106.78] | 107.75 [101.18, 109.04] | 164.50 [141.02, 166.37] | 79.08 [71.91, 79.13] | 26.30 [26.30, 26.30] | 54.72 [54.72, 54.76] |
| firefox | search-app | warm | 349.85 [327.52, 366.74] | 382.77 [372.22, 407.31] | 104.04 [103.81, 106.03] | 106.34 [105.11, 107.61] | 156.88 [148.54, 161.01] | 79.20 [72.67, 79.33] | 26.30 [26.16, 26.30] | 54.72 [54.71, 54.96] |
| webkit | task-app | cold | 359.17 [352.18, 383.89] | 374.97 [370.64, 396.82] | 105.15 [104.01, 107.03] | 104.40 [102.56, 105.18] | 108.43 [105.12, 109.14] | 42.05 [41.99, 42.17] | 21.09 [21.09, 21.09] | 33.14 [33.14, 33.14] |
| webkit | task-app | warm | 288.41 [271.92, 291.32] | 321.73 [309.03, 336.78] | 104.29 [104.04, 105.82] | 104.65 [100.97, 105.97] | 109.37 [108.48, 112.32] | 42.09 [42.06, 42.24] | 21.09 [21.09, 21.09] | 33.14 [32.05, 33.14] |
| webkit | search-app | cold | 375.39 [363.66, 417.29] | 410.58 [388.65, 413.47] | 104.89 [103.00, 106.22] | 102.61 [100.93, 103.72] | 134.22 [129.44, 147.68] | 63.55 [61.84, 65.74] | 23.70 [23.69, 23.70] | 50.69 [50.66, 52.05] |
| webkit | search-app | warm | 291.62 [287.23, 298.89] | 310.88 [305.23, 317.10] | 103.72 [102.18, 104.53] | 103.28 [101.86, 106.14] | 129.77 [122.56, 136.12] | 63.49 [61.50, 68.41] | 23.70 [23.70, 23.70] | 50.69 [50.69, 51.66] |

Chrome records identify `screencast`; Firefox and WebKit identify `screenshot-loop`. A screenshot loop does not establish that a short-lived UI state was absent. Complete evidence here means the received frames were finalized according to the record, not that every paint was captured. Decode verifies readable output and its declared facts; it is not an independent oracle for UI frame order.

## Matched Playwright comparison, recording off

Matched inputs/settings are the same Chrome executable/build, same fixture address within each fixture, same generated test body with only the library import changed, one test/file, one worker and one active browser, fresh isolated context per test, headless, viewport 1280 by 720, scale 1, no retries, 30 s test/navigation budgets and 5 s action/assertion budgets. Both disable recording/video, diagnostics/trace and screenshots, including failure screenshots. Retest declares `pixels.web.screenshots=never` and `recordings=never`; Playwright declares `video=off`, `trace=off`, `screenshot=off`. Actual configs are retained under `inputs/` as `.ts.txt` snapshots. They are text artifacts so the repository typecheck does not require Playwright.

Browser launch flags, navigation completion semantics, locators, assertion implementations, bookkeeping and cleanup remain tool-specific. CLI own CPU excludes Playwright's worker and all browser processes, so these columns cannot compare total tool CPU. These rows do not compare Playwright video with Retest video.

All eight cells passed 5/5; all four warm cells passed 5/5 priming.

| Fixture | Cache | Retest wall ms | Playwright wall ms | Retest CLI CPU ms | Playwright CLI CPU ms | Retest CLI peak RSS MiB | Playwright CLI peak RSS MiB |
| --- | --- | --- | --- | --- | --- | --- | --- |
| task-app | cold | 1285.87 [1186.67, 1670.03] | 3749.93 [3603.33, 3966.87] | 344.81 [325.50, 347.15] | 363.23 [340.09, 391.44] | 144.72 [141.59, 145.56] | 194.98 [193.03, 204.81] |
| task-app | warm | 1127.85 [1074.94, 1142.79] | 3492.90 [3395.64, 3683.17] | 310.04 [305.71, 314.12] | 246.89 [241.06, 254.73] | 140.78 [138.52, 144.95] | 166.66 [164.66, 168.45] |
| search-app | cold | 1572.00 [1537.05, 1648.27] | 4408.24 [4361.80, 4545.53] | 339.91 [322.61, 345.28] | 356.99 [351.32, 398.55] | 143.50 [140.06, 146.44] | 196.00 [193.94, 204.95] |
| search-app | warm | 1533.11 [1489.82, 1797.39] | 4204.74 [4142.75, 4403.59] | 317.96 [298.45, 356.30] | 248.82 [244.28, 255.65] | 141.75 [127.91, 142.84] | 166.17 [165.36, 168.05] |

The full matched results also retain native CLI CPU/footprint and artifact/run-folder sizes. Retest kept no artifacts; Playwright's output folder contains its `.last-run.json` bookkeeping file. The output formats have different contents.

## Original benchmark and earlier handoff

These are the original `npm run bench` rows, recording off, with the original default configs. Retest diagnostics remain at their current default. These are separate from the explicit matched-settings rows above. Retest on Playwright spec files runs the unchanged Playwright files with `--playwright`. Medians and ranges are milliseconds.

Every cell passed 5/5.

| Fixture | Tests | Files | Runner | Wall ms | Startup ms | Tests ms | Teardown ms | Per test ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| task-app | 1 | 1 | retest | 1078 [1059, 1538] | 503 [489, 887] | 274 [266, 390] | 301 [259, 343] | 275.00 [268.00, 390.00] |
| task-app | 1 | 1 | retest-playwright | 1099 [1065, 1205] | 482 [479, 512] | 279 [268, 284] | 345 [304, 409] | 280.00 [269.00, 284.00] |
| task-app | 1 | 1 | playwright-1-worker | 3629 [3433, 3679] | 397 [394, 430] | 274 [263, 288] | 2969 [2745, 3000] | 274.00 [263.00, 288.00] |
| task-app | 20 | 1 | retest | 5538 [5508, 5617] | 517 [505, 591] | 4710 [4690, 4728] | 316 [267, 327] | 232.00 [230.00, 239.00] |
| task-app | 20 | 1 | retest-playwright | 5559 [5524, 5604] | 514 [505, 520] | 4694 [4654, 4736] | 363 [316, 403] | 233.00 [231.00, 235.00] |
| task-app | 20 | 1 | playwright-1-worker | 6627 [6480, 6708] | 414 [406, 434] | 4819 [4781, 4901] | 1412 [1165, 1487] | 224.50 [223.00, 229.50] |
| search-app | 1 | 1 | retest | 1476 [1381, 1549] | 505 [503, 633] | 628 [599, 669] | 280 [260, 343] | 629.00 [599.00, 670.00] |
| search-app | 1 | 1 | retest-playwright | 1413 [1353, 1423] | 500 [483, 531] | 622 [603, 663] | 270 [251, 297] | 623.00 [604.00, 664.00] |
| search-app | 1 | 1 | playwright-1-worker | 4383 [4261, 4523] | 404 [396, 420] | 953 [941, 1039] | 3010 [2924, 3091] | 953.00 [941.00, 1039.00] |
| search-app | 20 | 1 | retest | 12836 [12734, 12916] | 609 [521, 645] | 11917 [11840, 12082] | 313 [271, 352] | 593.50 [590.00, 601.50] |
| search-app | 20 | 1 | retest-playwright | 12893 [12674, 13121] | 596 [522, 703] | 11889 [11816, 12089] | 331 [318, 407] | 592.50 [591.50, 602.00] |
| search-app | 20 | 1 | playwright-1-worker | 21095 [19272, 21671] | 427 [411, 493] | 18436 [18380, 18592] | 2273 [269, 2706] | 905.00 [903.50, 906.50] |

The handoff gives medians of three on the same named M4 Max host, Node 24.12, Chrome 154 and Playwright 1.63.0. Its full browser patch/build, prior load and all current settings/implementation were not matched. The checkout now contains diagnostics, recording-aware cleanup and other uncommitted release work. The original harness's fresh-process runs use its ordinary compile cache, rather than the dedicated empty-cache cold cells above. The table compares stated workloads and does not isolate a cause. The handoff supplies no historical spreads.

| Workload / measure | Before speed work, handoff | After speed work, handoff | This session Retest median [min,max] | Handoff Playwright | This session Playwright median [min,max] |
| --- | --- | --- | --- | --- | --- |
| One test, task-app, wall | 1276 ms | 663 ms | 1078 [1059, 1538] ms | 1478 ms | 3629 [3433, 3679] ms |
| One test, task-app, startup | 529 ms | 365 ms | 503 [489, 887] ms | 375 ms | 397 [394, 430] ms |
| One test, task-app, teardown | 457 ms | 26 ms | 301 [259, 343] ms | 823 ms | 2969 [2745, 3000] ms |
| 20 tests, search-app, one file, wall | 22.7 s | 12.2 s | 12836 [12734, 12916] ms | 19.7 s | 21095 [19272, 21671] ms |
| One task test, Playwright spec file, wall | Not measured | 652 ms | 1099 [1065, 1205] ms | 1478 ms | 3629 [3433, 3679] ms |

The handoff's 200-test/10-file scenario was not rerun and has no new after column. Neither the handoff nor the earlier media PNG-replay/startup measurements supplies a matching recording on/off baseline for this workload. The media report's first-start measurements include probe and ownership work; this complete-run timer includes that path rather than subtracting it.

## Findings and earlier attempts

No product source was changed. The Chrome task recording exposes a cadence-contract discrepancy for the capture owner.

Cold Chrome task-app delivered [3, 3, 3, 3, 3] frames per run. Source achieved fps was 19.88 [19.28, 20.65] for requested 10 fps.

Warm Chrome task-app delivered [3, 3, 3, 3, 3] frames per run. Source achieved fps was 19.29 [18.42, 20.33] for requested 10 fps.

[`src/browser/capture.ts:31`](../../../../../src/browser/capture.ts#L31) says at most one handed-over frame per 1/fps interval. [`src/media/capture.ts:81`](../../../../../src/media/capture.ts#L81) allows achieved fps above the request by only the initial frame over the capture time. With three delivered frames and a 10 fps request, that stated allowance caps achieved fps at 15. Every measured Chrome task recording exceeds it. The stop path at [`src/browser/capture.ts:168`](../../../../../src/browser/capture.ts#L168) flushes the waiting frame through line 319 without checking the due interval computed at line 292. This is the likely cause. The documentation also promises a final flush, so the owner should settle the cadence guarantee or document its stop exception without dropping required evidence. This is a code/data inference, not an isolated regression test. The videos remained valid H.264, 1280 by 720, 10 output fps, with positive frame counts and successful whole decodes.

Two earlier attempts remain outside the final tables. `.retest/benchmarks/measurements-phase-4/` contains the initial attempt. Its observer treated native CPU ticks as nanoseconds and initially divided the child-pid count as though it were bytes. It also counted a transient fork/exec helper as a second media worker. The recording attempt exited 2; no CPU figure from it is used. Calibration exposed these benchmark defects. The corrected independent pre-session check read 426.733 native CPU ms against 425.439 Node CPU ms and discovered the launched child.

`.retest/benchmarks/measurements-phase-4-final/` contains the next completed original benchmark and recording matrix. I edited the wrapper while it was executing, and its buffered shell read failed after the matrix with exit 2. A separately locked matched comparison then passed with the explicit failure-screenshot policy corrected. Those outputs are audit evidence only. The unchanged corrected wrapper was rerun into `measurements-phase-4-verified`; every final table uses that one uninterrupted locked session. Earlier attempts were not discarded or silently mixed into medians.

## Verification, cleanup and limits

The final verification ran after the completed measurement session exited. The benchmark process guard found no match. The exact locked command was:

```sh
lockf -t 0 /tmp/retest-heavy-gate.lock sh -c 'set -eu
if pgrep -f "benchmarks/[r]un.ts|benchmarks/[r]ecording.ts" > /tmp/retest-measurements-benchmark-guard.log; then exit 1; fi
sh -n benchmarks/recording-session.sh
clang -O2 -Wall -Wextra -Werror benchmarks/recording-resource.c -o /tmp/retest-recording-resource
node --conditions=retest-source --test benchmarks/recording-checks.test.ts benchmarks/recording-observer.test.ts > /tmp/retest-measurements-verification.log 2>&1
node_modules/typescript/bin/tsc -p benchmarks/tsconfig.recording.json > /tmp/retest-measurements-ts6-after.log 2>&1
node_modules/typescript-7/bin/tsc -p benchmarks/tsconfig.recording.json > /tmp/retest-measurements-ts7-after.log 2>&1
python3 /tmp/retest-measurements-manifest.py > /tmp/retest-measurements-manifest.log 2>&1
node benchmarks/recording-preflight.ts "$1/final-preflight.json"
' recording-verification "$PWD/.retest/benchmarks/measurements-phase-4-verified" > /tmp/retest-measurements-verification-session.log 2>&1
git diff --check -- benchmarks docs/plans/public-beta/codex/phase-4/measurements-report.md > /tmp/retest-measurements-diff-check.log 2>&1
```

Seven benchmark checks passed, including statistics, off/on settings, matched evidence policy and independent native CPU/descendant calibration. The final calibration read 426.103 native CPU ms against 425.482 Node CPU ms and discovered both launched processes. Scoped strict TypeScript 6.0.3 and 7.0.2 checks both exited 0 with empty diagnostics. The shell syntax check and scoped diff check exited 0.

System Python 3 formatted the report and collected the manifest. It is not required by the benchmark scenario. The manifest helper only read results, process tables, installed files and tool versions. It did not launch tests or signal processes. Its process check found 3349 recorded IDs gone, one observed build per browser engine, and one media build. Durable check logs are under `benchmarks/results/measurements-phase-4/checks/`. The pre-session calibration log is retained there too. The post-processing helpers are preserved as text under `audit-tools/`.

Cleanup checked 3349 native-observed IDs and all recorded browser/media event IDs against a fresh process table. None remained. Fixture/service and benchmark process checks were empty. The observer was read-only. Normal cleanup ended only benchmark-owned children. No unrelated process was manually killed. PID 36744 and personal/background programs remained untouched.

These numbers do not establish a speed claim, performance on another host or OS, full-suite throughput, an unloaded-machine result, OS cold-start performance, browser reuse or Playwright video overhead. Five repetitions give an observed spread, not a reliable latency tail. CLI/media own CPU and peak readings do not establish complete process-tree CPU or memory. Sampling and the exit hook can miss final work.

No native iOS/macOS/Electron target or Safari browser was measured. Failure, interruption, crash, partial-evidence cost, sustained capture rate, long recordings and concurrent suites were not verified by this scenario. No clean-host installer or missing-prerequisite behavior was exercised. No full unit, integration, native, Electron or proof suite ran in this lane. Real benchmark CLI exits and required evidence were checked independently of the benchmark self-tests.

## Files and artifacts

Existing file changed: `benchmarks/README.md`, only the anchored recording-measurements addition. New implementation files are `benchmarks/recording.ts`, `recording-options.ts`, `recording-config.ts`, `recording-program.ts`, `recording-preload.ts`, `recording-resource.c`, `recording-report.ts`, `recording-preflight.ts`, `recording-session.sh`, `recording-checks.test.ts`, `recording-observer.test.ts` and `tsconfig.recording.json`. New result files are under `benchmarks/results/measurements-phase-4/`. This report is the only new file outside benchmarks.

No product source, handoff, ownership or release metadata was edited. No commit, stash, reset, revert, registry operation or download ran. The original benchmark generated its normal ignored dist/pack/install output.

[Durable original results](../../../../../benchmarks/results/measurements-phase-4/default-comparison/results.md), [recording results](../../../../../benchmarks/results/measurements-phase-4/recording/results.md), [matched comparison](../../../../../benchmarks/results/measurements-phase-4/matched-comparison/results.md) and [environment hashes](../../../../../benchmarks/results/measurements-phase-4/environment.json). Each Markdown result has its JSON partner. The same directory retains logs, process-name preflights, lock holder and check logs.

Raw CLI output, launch records, resource readings, configs, caches, warm primes, events, results, media facts and videos remain under `.retest/benchmarks/measurements-phase-4-verified/`. Resource JSON names each raw reading with its exact command/cwd and load. Raw files are ignored by git; durable summaries preserve their locations.
