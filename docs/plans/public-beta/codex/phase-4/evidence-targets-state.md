# Evidence targets state

Closed: verification completed with failing and unverified capabilities. No heavy gate, target or retry is queued. This lane changed tests and records only, plus the authorized Step 0 unit correction. It did not validate Phase 4 on all five targets.

Most important remaining findings:

- Native CLI recording has no delegated frame source; native movies, cadence, clocks and secret-pixel video evidence are unverified.
- No recorded browser variant has all three app videos or complete final-state evidence. WebKit broken-sync reached the intended desktop assertion failure, but recorded stale desktop pixels are unavailable.
- macOS recorded target was not exercised: a layer-1000 window covered TaskDesk. Wispr Flow was left untouched; exact refusal is retained.
- WebKit target's unchanged safe-green video witness fails; colour conversion/preservation needs review. iOS off run's third setup failed with cleanup_failed, so native on/off equality is unverified.
- Human reconstruction of a killed runner omits the exact recording-gap message. Additional image-route tests have two over-specified expectations; those failures are not proven product defects.

| Completed check | Pass / total | Exit | Record under .retest/evidence-targets/ |
| --- | ---: | ---: | --- |
| Step 0 focused / full file | 1/1; 48/48 | 0 | logs/step-0.log; logs/unit-native-processes.log |
| Step 0 removed-read / blocking-read mutations | 0/1 each, intended failures | 1 | logs/step-0-{remove,blocking}.log |
| Chrome release | 2/2 | 0 | chrome-release/; logs/chrome-release.log |
| Firefox release, launch-services | 2/2 | 0 | firefox-release/; logs/firefox-release.log |
| WebKit release | 0/2 | 1 | webkit-release/; logs/webkit-release.log |
| iOS simulator | 0/4 | 1 | ios/; logs/ios.log |
| macOS, not exercised | 0/1 | 1 | macos/macos-refusal.json; logs/macos.log |
| Chrome / Firefox / WebKit flows | 2/10 each | 1 each | flow-chrome-release/; flow-firefox/; flow-webkit/ |
| Failure / shutdown / next-run cleanup | 17/21 | 1 | failures-independent/; logs/failures-independent.log |
| Diagnostics and judge image bytes | 1/1 | 0 | diagnostics-hashes/; logs/diagnostics-hashes.log |
| Queue saturation / off verdict | 1/1 | 0 | queue-final/; logs/queue-final.log |
| Per-app timelines | 6/25 | 1 | timelines/; logs/timelines.log |
| Independent flow movie readback | six runs / six videos | 0 | video-readback/; logs/video-readback.log |
| Extra image routes, each engine | 1/4 each | 1 each | pixels-{chrome-final,firefox,webkit}/ |
| TS 6 project, TS 7 project, example | all three completed | 0 | logs/types-final-complete.log |
| Final native audit | 13 owned devices absent; TaskDesk zero | 0 | native-audit/final-result.json |
| Final process audit | 569 recorded identities; none present | 0 | process-audit.json; logs/process-audit.log |

Every test gate above had zero skips and cancellations. Counts include independent children and failed parents. Application verdicts are recorded separately; a failing evidence gate is never relabelled as a passing target.

Exact commands, chronological failures, source findings and artifact paths are in [the report](evidence-targets-report.md). The final capability record is [proofs/evidence.md](../../proofs/evidence.md). All real target work used the shared heavy lock, with one gate submitted at a time and a benchmark guard. No benchmark, download, commit, stash, reset, revert, publication or covering-window workaround was performed. No cleanup audit sent a signal or touched a foreign process or device.
