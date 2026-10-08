Refreshed both pins using the recorded generator. Release settings, dependencies, Cargo.lock and the Rust minimum remain unchanged.

All 22 unit tests and all 4 packaged install tests passed. The packaged gate ran under the shared lock; nothing was skipped.

Read-only Mac cache inspections exited 0 and reported media missing. No real installation became damaged. The new regression confirms that an intact older-source installation intentionally reports `damaged`: a rebuilt crate is a new build.

Exact commands, counts and logs are in [the report](/Users/dragon/Documents/Projects/Gruvi/Products/retest/docs/plans/public-beta/codex/phase-4/media-pins-refresh-report.md). No owned process remains running.