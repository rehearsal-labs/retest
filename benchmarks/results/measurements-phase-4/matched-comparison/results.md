# Recording measurements

2026-10-06T14:37:43.317Z. Apple M4 Max, 14 cores, 36 GiB, darwin 27.0.0 arm64, Node v24.12.0.

Source b59eed5d6b4ffc6e903198fdbabdd0356946aa41, dirty true, built true. Versions: {"retest":"0.0.0","playwright":"1.63.0","chromium":"Chrome 154.0.8037.98 @b859317bf11f6be47f9b7799ec690a0a42a1fb33"}.

Five or more samples per cell, 5 requested. Every run starts a fresh CLI and browser. Cold means an empty dedicated Node compile cache; warm means the measured run follows its own uncounted priming run with the same cache and settings. Neither means an OS cold boot or a kept browser. Fixture servers are already running.

Tables show median [min, max]. Full quartiles and nearest-rank p95 are in results.json summaries. With five samples p95 equals the maximum; it does not establish a population tail.

Wall covers CLI spawn through CLI close, including media readiness, video finalization and runner cleanup. Artifact bytes sum regular files under run/artifacts; run-folder bytes also include events, result and logs. Harness logs, resource readings and prime runs are excluded.

Runner exit-hook CPU and peak RSS come from process.resourceUsage at the CLI exit hook; later exit hooks may still do work. Native runner and media CPU are their own cumulative CPU at the last native sample, excluding children, and are lower bounds. Both runner CPU readings are shown. Media peak physical footprint is the kernel lifetime high-water mark at the last sample; RSS is a sampled maximum. A peak or CPU after that sample may be missed. The observer requests 5 ms sampling and records actual largest gaps. These are different memory measures and are not summed.

Both fixtures are published. Retest recording cells retain default diagnostic capture. Matched Chrome comparison cells disable diagnostics, video, trace and screenshots on both tools; use one worker, one active browser, fresh context per test, the same Chrome binary, viewport 1280x720 at scale 1, same fixture/address and test body, no retries, 30 s test and 5 s action/assertion budgets. Each file has one test. Imports, runner bookkeeping, browser launch flags, locator implementations and cleanup are tool-specific. Navigation waits retain each tool's implementation.

These measurements make no speed claim. They do not establish suite throughput, native-platform performance, full-machine CPU or peak memory, clean-host installation, another machine or OS, failure/cancellation cost, or equivalence of browser engines.

| Fixture | Engine | Tool | Diagnostics | Recording | Cache | Valid | Wall ms | Runner exit-hook CPU ms | Runner native CPU ms lower bound | Runner peak RSS MiB | Media CPU ms lower bound | Media peak footprint MiB | Media sampled RSS MiB | Artifact KiB | Run folder KiB |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| task-app | chromium | retest | off | off | cold | 5/5 | 1285.87 [1186.67, 1670.03] | 344.81 [325.50, 347.15] | 398.85 [381.39, 402.93] | 144.72 [141.59, 145.56] | not started | not started | not started | 0.00 [0.00, 0.00] | 17.01 [16.74, 17.01] |
| task-app | chromium | retest | off | off | warm | 5/5 | 1127.85 [1074.94, 1142.79] | 310.04 [305.71, 314.12] | 310.72 [306.61, 315.13] | 140.78 [138.52, 144.95] | not started | not started | not started | 0.00 [0.00, 0.00] | 17.00 [17.00, 17.00] |
| task-app | chromium | playwright | off | off | cold | 5/5 | 3749.93 [3603.33, 3966.87] | 363.23 [340.09, 391.44] | 369.14 [344.44, 397.57] | 194.98 [193.03, 204.81] | not started | not started | not started | 0.04 [0.04, 0.04] | 0.04 [0.04, 0.04] |
| task-app | chromium | playwright | off | off | warm | 5/5 | 3492.90 [3395.64, 3683.17] | 246.89 [241.06, 254.73] | 247.69 [241.80, 254.76] | 166.66 [164.66, 168.45] | not started | not started | not started | 0.04 [0.04, 0.04] | 0.04 [0.04, 0.04] |
| search-app | chromium | retest | off | off | cold | 5/5 | 1572.00 [1537.05, 1648.27] | 339.91 [322.61, 345.28] | 392.52 [376.80, 399.34] | 143.50 [140.06, 146.44] | not started | not started | not started | 0.00 [0.00, 0.00] | 18.71 [18.71, 18.71] |
| search-app | chromium | retest | off | off | warm | 5/5 | 1533.11 [1489.82, 1797.39] | 317.96 [298.45, 356.30] | 319.44 [299.03, 356.02] | 141.75 [127.91, 142.84] | not started | not started | not started | 0.00 [0.00, 0.00] | 18.71 [18.44, 18.71] |
| search-app | chromium | playwright | off | off | cold | 5/5 | 4408.24 [4361.80, 4545.53] | 356.99 [351.32, 398.55] | 363.71 [356.93, 404.82] | 196.00 [193.94, 204.95] | not started | not started | not started | 0.04 [0.04, 0.04] | 0.04 [0.04, 0.04] |
| search-app | chromium | playwright | off | off | warm | 5/5 | 4204.74 [4142.75, 4403.59] | 248.82 [244.28, 255.65] | 248.90 [242.04, 256.42] | 166.17 [165.36, 168.05] | not started | not started | not started | 0.04 [0.04, 0.04] | 0.04 [0.04, 0.04] |

Actual command, cwd, load before/after, individual resource samples, recording mode and capture counts are retained per run. Priming results are retained and must also pass; they do not enter measured medians.
