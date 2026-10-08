Implemented frame delegation, bounded source retries, and proven startup-cleanup release. [Report](docs/plans/public-beta/codex/phase-4/fix-native-recording-report.md).

- iOS evidence: 5/5; recording on/off both exit 1 with matching verdicts.
- Units: 210/210; final typechecks pass.
- All flows reach expected application verdicts. Desk videos remain blocked by Wispr coverage; withheld state pixels remain unverified.
- Historical ownership timeout did not reproduce.
- All 18 owned simulators and recorded processes are gone.