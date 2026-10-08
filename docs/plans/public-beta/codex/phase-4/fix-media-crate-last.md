Fixed findings 1, 7, 8, 10 and 11 with failing-first regressions. The [report](/Users/dragon/Documents/Projects/Gruvi/Products/retest/docs/plans/public-beta/codex/phase-4/fix-media-crate-report.md) records each finding, exact commands, counts and logs.

Passed:

- Three Rust runs: 92 unit + 54 process tests each
- Locked media client: 32 tests
- Media/evaluation units: 169 tests
- All-target clippy and scoped TypeScript 6/7

Linux, minimum Rust and actual stuck/unsupported filesystems remain unverified. No process launched by this lane remains running.