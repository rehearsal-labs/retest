Implemented native clearance with `RETEST_NATIVE_WITHHOLD_RESUME=off` and the timestamp tie-break. Pixel threshold remains 48.

Passed: 130 unit checks, both typechecks, real desk resume, macOS capture, iOS capture and macOS evidence.

Still failing: desk API 1/2; each engine’s flows 8/12. Sign-in removes the field while its window remains, so the specified rule keeps withholding. The literal event reason needs the out-of-scope schema change.

Cleanup audits passed. Details, commands and artifacts are in the [report](/Users/dragon/Documents/Projects/Gruvi/Products/retest/docs/plans/public-beta/codex/phase-4/native-withhold-resume-report.md).