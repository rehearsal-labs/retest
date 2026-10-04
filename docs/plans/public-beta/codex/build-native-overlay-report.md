Changes by file:

- `src/native/macos-app.ts`: retained the existing exact system executable matcher and full-screen owner exclusion; limited that exclusion to an open runner session. Pointer, smaller overlay windows and other owners still cover the app.
- `src/native/png.ts`: replaced the earlier colour-window claim with the measured TaskDesk region, capture methods and limits.
- `tests/unit/native-macos-app.test.ts`: added a fake-window test that allows the system owner, refuses another app named AutomationModeUI at the same layer, and refuses capture after disposal.
- `tests/unit/native-fake-tools.ts`: added an owned fake window process to the existing process and window lists.
- `tests/integration/native-macos-lifecycle.test.ts`: launches at `20,60,700,480`, asserts that frame and records the overlay's presence and capture outcome.
- `docs/plans/public-beta/proofs/native.md`: updated only the native sessions section with the measurements, gates and remaining blocker.
- This report records the same findings. No runtime package was added.

Commands and results:

| Command | Result | Log |
| --- | --- | --- |
| `node --conditions=retest-source --test tests/unit/native-macos-app.test.ts` | 27 passed, no skips | `/tmp/retest-native-overlay/unit-macos-app.log` |
| `node --conditions=retest-source --test tests/unit/native-*.test.ts` | 202 passed, no skips; exit-listener warning | `/tmp/retest-native-overlay/native-unit.log` |
| `lockf -t 0 /tmp/retest-heavy-gate.lock node --conditions=retest-source --test tests/integration/native-macos-lifecycle.test.ts` | 7 passed, no skips; covering window refused | `/tmp/retest-native-overlay/macos-integration.log` |
| `lockf -t 0 /tmp/retest-heavy-gate.lock node --conditions=retest-source proofs/native/lifecycle.ts --only macos` | 10 steps passed; covering window refused | `/tmp/retest-native-overlay/macos-proof.log` |
| `lockf -t 0 /tmp/retest-heavy-gate.lock npm run typecheck` | Exit 2, 18 errors outside the changed files; second compiler and examples not reached | `/tmp/retest-native-overlay/typecheck.log` |
| `lockf -t 0 /tmp/retest-heavy-gate.lock node --conditions=retest-source /tmp/retest-native-overlay/compare.ts` and native tool captures | Comparison completed; first two attempts stopped at the foreign-window check | `/tmp/retest-native-overlay/comparison-final.log`, `comparison-run.log`, `comparison-retry.log` in the same folder |
| Pixel comparison of saved clear regions | 0 differing pixels | `/tmp/retest-native-overlay/pixel-comparison.log`, `/tmp/retest-native-overlay/native-tool-comparison.json` |

`pgrep -f benchmarks/run.ts` found no benchmark runtime before each test or proof. Other command lines mentioned the path in their task instructions and were left alone. All integration tests, proofs and comparisons held the lock. The fixture service used `node --conditions=retest-source fixtures/cross-platform/service/server.ts --port 0`; its process record and log are in the comparison folder. The existing TaskDesk build was reused. TaskDesk, service and runner cleanup was verified in `/tmp/retest-native-overlay/owned-process-cleanup.log` and the lifecycle checks. Selecting the native screenshot tool initially launched TaskDesk without arguments outside the lock; that launch was recorded in `/tmp/retest-native-overlay-ui-launch.json` and closed before the comparison. No prompt appeared.

The full production capture still refuses on this Mac. Wispr Flow's separate window at layer 1000, frame `608,445,512,614`, overlaps TaskDesk. It was left alone. AutomationModeUI was present during the runner capture and absent after the runner closed, while the same TaskDesk process remained. The runner PNG and the independent baseline matched all 208,000 RGB pixels at window points `20,220,520,100`, scale 2; alpha was opaque in both. The baseline was the native tool's JPEG decoded to RGBA. A larger region also matched all 624,000 decoded pixels between that tool's captures with and without the runner. Only clear TaskDesk regions were saved; full display and window crops stayed in memory.

Unverified: an uncovered full production window capture, pixels outside the compared regions, lossless baseline detail at text edges, another Mac, and a clean whole-project typecheck. The shell PNG path could not create an image and its permission preflight was false; logs are `/tmp/retest-native-overlay/shell-capture-with-runner.log` and `/tmp/retest-native-overlay/screen-capture-preflight.log`. No permission was requested. The type errors are in browser, doctor, protocol, runner and test support files outside this task's edit scope.

Every repository file changed by this work:

- `src/native/macos-app.ts`
- `src/native/png.ts`
- `tests/unit/native-macos-app.test.ts`
- `tests/unit/native-fake-tools.ts`
- `tests/integration/native-macos-lifecycle.test.ts`
- `docs/plans/public-beta/proofs/native.md`
- `docs/plans/public-beta/codex/build-native-overlay-report.md`
