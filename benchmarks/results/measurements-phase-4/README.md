# Phase 4 host measurements

Final numbers come from the completed measurements-phase-4-verified session, with one continuous heavy-gate lock. Five measured repetitions per cell, both fixtures. No speed claim.

- [Original default-setting comparison](default-comparison/results.md), with [spread data](default-comparison/spreads.json).
- [Recording off/on, three engines, cold/warm](recording/results.md).
- [Matched recording-off Chrome comparison](matched-comparison/results.md).
- [Machine and binary/source hashes](environment.json).
- [Cleanup](cleanup.json).
- [Full report](../../../docs/plans/public-beta/codex/phase-4/measurements-report.md).

Each result has its JSON partner. Logs and preflights sit beside them. Resource JSON names raw per-run readings under .retest/benchmarks/measurements-phase-4-verified/. Those include launch commands, output, events, videos and warm primes. The inputs folder holds generated tests and final configs as .ts.txt snapshots, outside TypeScript compilation. Recording project configs reflect the last cell, recording on; the program rewrites only the recording toggle for off cells. Earlier attempts remain under their distinct raw output roots and are excluded from these tables.

Tables give median [min,max]; resource JSON also has quartiles and nearest-rank p95. Five samples make p95 the maximum, not a population tail. Native CPU and media peak readings have the sampling limits stated in the report. Personal applications and development services remained active. Process-name snapshots retain that load without unrelated arguments.
