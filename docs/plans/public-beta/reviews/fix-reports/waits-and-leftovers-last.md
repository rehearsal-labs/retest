Fixed wait rounding, early-failure handling and the Chrome profile cleanup race. Pinned engine coverage and both interruption behaviors.

Validation passed: 570-test unit sweep, 15 process tests, 56 diagnostics checks and final Chrome conformance. Typecheck failed in other lanes’ files; queued compiler checks never acquired the gate. No owned processes remain.

[Report](docs/plans/public-beta/reviews/fix-reports/waits-and-leftovers-report.md) records failing-first evidence, exact commands and logs, plus handoffs for shared cleanup cost, missing runner diagnostics and other early waits.