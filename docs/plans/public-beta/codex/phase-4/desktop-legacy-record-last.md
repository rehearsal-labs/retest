Implemented the reader fixes and cleared this Mac’s stale desktop record through Retest’s startup path. Mismatch and reuse guards remain intact.

- Reader/reuse tests: **56/56**; both typecheck commands passed.
- macOS evidence: **5/5**; lifecycle and interaction: **10/10 each**.
- API: **1/2**; capture: **0/1**; each browser flow: **6/10**. Failures remain: secret-field reporting outside the allowed repair scope, and strict frame-comparison ties.

All eight macOS checks ran once under the lock. Cleanup confirmed no owned processes or simulators remain. Proof records were updated.

[Full report with commands, causes, logs and artifacts](/Users/dragon/Documents/Projects/Gruvi/Products/retest/docs/plans/public-beta/codex/phase-4/desktop-legacy-record-report.md)