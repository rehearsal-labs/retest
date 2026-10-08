Fixed historical-PID cleanup cost while preserving fresh identity checks before every signal.

- 60 unit tests passed.
- TypeScript 6, TypeScript 7 and examples checks passed.
- Five consecutive Chrome runs matched declared exits: no `cleanup_failed`, retained profiles or owned processes.

[Report with evidence, timings and other-caller follow-ups](/Users/dragon/Documents/Projects/Gruvi/Products/retest/docs/plans/public-beta/reviews/fix-reports/ownership-cost-report.md).

No commits; nothing started by this lane remains running.