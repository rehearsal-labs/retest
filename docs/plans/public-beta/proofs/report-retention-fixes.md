# Report source and retention corrections

The current report and retention corrections are recorded finding by finding in [the fix report](../codex/phase-4/fix-report-retention-report.md), with failing-first commands and logs. This record supplements the historical HTML and artifacts lane records.

HTML source display requires a selected test file named in its recorded execution bundle, a bounded regular-file read and the live run redactor. Files with links, changed identities, non-file entries or excessive bytes are refused. Without the live redactor, a report keeps the location and withholds source. Diagnostics links depend on the safe read's success. Frames and selected diagnostics have distinct rendering and retain their partial/missing-data reasons, criterion judge verdicts and parent rules.

Retention records `artifact.removal_requested` before deletion, and then `artifact.removed` after a successful unlink or `artifact.removal_failed` when unlink is refused or fails. `EventLog.emitPersisted` must return true before deletion starts. A failed event-store append keeps the file. A request without a completion preserves its artifact reference. Reconstructed recording results use optional `removalPending: true`, displayed as "Present, removal not confirmed". Shared thumbnail ownership protects a retained recording's thumbnail.

Run-folder schemaVersion stays 1. The request event and optional recording field are additive schema fields, validated on read. A reader built before the request event was introduced refuses these new event streams as an unknown event type. Historical folders containing only the former intent-style `artifact.removed` cannot independently establish the unlink boundary; the old record should not be used as fresh proof of a completed operation.

Run commands and current results are in the fix report. Real media capture, provider quality, Linux behavior and clean-host packaging are outside this correction's verification. No benchmark was run.


Verification completed: the fix report records 199 passing selected unit tests, scoped TypeScript 6.0.3 and 7.0.2 with no diagnostics, and the unchanged `tests/integration/report-html.test.ts` passing through the shared gate on Chrome 154.0.8037.98. The retained report, run folder, collector records and two browser screenshots are under `/tmp/retest-fix-report-retention/chrome-proof/`. The run intentionally failed an application check with exit 1, and the report kept that outcome. The two failures from an extra run of the untouched recording fixture are documented in the fix report and were left unresolved here. The recorded run/browser groups and all retry processes ended; no benchmark was run.
