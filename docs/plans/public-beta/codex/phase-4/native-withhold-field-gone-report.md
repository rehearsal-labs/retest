# Native withholding when the filled field is gone

Field-gone clearance and both native event reasons are implemented. All required real-target checks pass, 44 of 44 tests, and the related unit suite passes 196 of 196. Evidence is retained under `.retest/native-withhold-field-gone/`. The initial dirty tree and source snapshots are preserved there. One worker did this work. No benchmark, download, commit, stash, reset or revert ran.

## Final rule

Every native secret fill begins withheld. After the fill completes, a fresh owned-tree read can close the stretch when the specific secure field that received the secret is absent. The reason is "the field that received the secret is gone". The existing clearance also closes it when that field is unfocused and reads masked or empty, or its owned window is gone. Masked or empty clearance records "the field reads back masked". Failed reads, a present focused field, a present unmasked field, uncertain identity and cancellation keep withholding. iOS also requires its software keyboard to be absent. The window-gone route still requires no owned window on screen. `RETEST_NATIVE_WITHHOLD_RESUME=off` keeps the old session-end-only native behavior.

The new optional event reason is additive. Run folders keep `schemaVersion` 1. A reader built before the reason field was added refuses events carrying it because its objects reject unknown fields. A current reader accepts older events without a reason. Ending withholding does not settle an unknown action outcome, remove a failure or admit a capture whose read span overlaps the stretch.

## Prior evidence

Read `README.md`, `docs/architecture.md`, `AGENTS.md`, both common briefs and the complete `native-withhold-resume-report.md`. That earlier report records desk API 1 of 2 and each engine flow 8 of 12 because sign-in removes the field while its owned window remains. Those results are historical evidence, not executions in this work. Its whole-source privacy checks and movie decodes passed while the required final desk pixel checks failed. Those assertions stay in place.

## Check results

### Failing first

```sh
env RETEST_MACOS_GATE=failing-first python3 .retest/native-withhold-field-gone/inside.py node --conditions=retest-source --test --test-concurrency=1 tests/unit/runner-native-withhold-resume.test.ts > .retest/native-withhold-field-gone/logs/failing-first.log 2>&1
```

Exit 1. 10 tests, 6 passed, 4 failed, zero cancelled or skipped. The field-gone case has no early resume. Masked, empty and gone-window cases have no literal reason. Present focused, present unmasked, failed attribute read, failed tree read and the off setting remain withheld. All cases require the original application failure and exit 1. No real target starts in this fake-runner command. The benchmark guard recorded no benchmark in `benchmark-checks.jsonl`.

### Focused checks

```sh
env RETEST_MACOS_GATE=focused python3 .retest/native-withhold-field-gone/inside.py node --conditions=retest-source --test --test-concurrency=1 tests/unit/runner-native-withhold-resume.test.ts tests/unit/protocol.test.ts tests/unit/protocol-identity.test.ts tests/unit/inspect-timeline.test.ts tests/unit/reporters-html.test.ts > .retest/native-withhold-field-gone/logs/focused.log 2>&1
env RETEST_MACOS_GATE=focused-fixed python3 .retest/native-withhold-field-gone/inside.py node --conditions=retest-source --test --test-concurrency=1 tests/unit/runner-native-withhold-resume.test.ts tests/unit/protocol.test.ts tests/unit/protocol-identity.test.ts tests/unit/inspect-timeline.test.ts tests/unit/reporters-html.test.ts > .retest/native-withhold-field-gone/logs/focused-fixed.log 2>&1
```

The first invocation exited 1, 77 tests, 73 passed, 4 failed, zero cancelled or skipped. All runner and protocol cases passed. The new presentation fixtures omitted the recorded variant identity or copied test-start-only fields into the resume event, so their events could not appear in the timeline. The fixtures now supply valid resume events with the recorded identity. The corrected invocation exited 0, 77 of 77 passed, zero failed, cancelled or skipped. Both reasons round-trip under the version 1 schema, retain exact identity coverage and appear in inspect and HTML. Unknown reasons are rejected. Existing events without a reason remain accepted.

### First typecheck

```sh
/usr/bin/lockf -t 0 /tmp/retest-heavy-gate.lock env RETEST_MACOS_GATE=typecheck python3 .retest/native-withhold-field-gone/inside.py npm run typecheck > .retest/native-withhold-field-gone/logs/typecheck.log 2>&1
```

Exit 2. TypeScript rejected explicit undefined optional variant fields in the new inspect fixture. The fixture now asserts that its known recorded variant and key exist before constructing the event. No product type was widened.

### Related unit checks and corrected typecheck

```sh
/usr/bin/lockf -t 0 /tmp/retest-heavy-gate.lock env RETEST_MACOS_GATE=typecheck-fixed python3 .retest/native-withhold-field-gone/inside.py npm run typecheck > .retest/native-withhold-field-gone/logs/typecheck-fixed.log 2>&1
env RETEST_MACOS_GATE=related-units python3 .retest/native-withhold-field-gone/inside.py node --conditions=retest-source --test --test-concurrency=1 tests/unit/native-input.test.ts tests/unit/native-source-retry.test.ts tests/unit/runner-native-wiring.test.ts tests/unit/runner-native-run-end.test.ts tests/unit/media-policy.test.ts tests/unit/capture-withhold.test.ts tests/unit/runner-recording-lifecycle.test.ts tests/unit/runner-native-withhold-resume.test.ts tests/unit/protocol.test.ts tests/unit/protocol-identity.test.ts tests/unit/inspect-timeline.test.ts tests/unit/reporters-html.test.ts > .retest/native-withhold-field-gone/logs/related-units.log 2>&1
```

The corrected typecheck exited 0 on TypeScript 6, TypeScript 7 and the examples project. The related unit invocation exited 1, 196 tests, 195 passed, 1 failed, zero cancelled or skipped. The added iOS unverified-fill fixture used a macOS-only empty-value setting, so its fill succeeded. It now uses the stand-in's accepted keys reply without entering characters, which makes the existing fill length verification fail. The subsequent disappearance still must not resume. Both platforms also require withholding when a disappeared field lacks a verified identifier. These unit cases start stand-ins only.

```sh
env RETEST_MACOS_GATE=related-units-fixed python3 .retest/native-withhold-field-gone/inside.py node --conditions=retest-source --test --test-concurrency=1 tests/unit/native-input.test.ts tests/unit/native-source-retry.test.ts tests/unit/runner-native-wiring.test.ts tests/unit/runner-native-run-end.test.ts tests/unit/media-policy.test.ts tests/unit/capture-withhold.test.ts tests/unit/runner-recording-lifecycle.test.ts tests/unit/runner-native-withhold-resume.test.ts tests/unit/protocol.test.ts tests/unit/protocol-identity.test.ts tests/unit/inspect-timeline.test.ts tests/unit/reporters-html.test.ts > .retest/native-withhold-field-gone/logs/related-units-fixed.log 2>&1
```

Exit 0, 196 of 196 passed, zero failed, cancelled or skipped. Original failure and unknown-input handling, cancellation, overlapping capture spans and the off switch all retain their required outcomes. These tests use fake native targets.

### Real desk API

Executed once through the lock with the following command.

```sh
/usr/bin/lockf -t 0 /tmp/retest-heavy-gate.lock env RETEST_MACOS_GATE=native-api-desk python3 .retest/native-withhold-field-gone/inside.py node --conditions=retest-source --test --test-concurrency=1 tests/integration/native-api-desk.test.ts > .retest/native-withhold-field-gone/logs/native-api-desk.log 2>&1
```

Exit 0, 2 of 2 passed, zero failed, cancelled or skipped. The original passing application cases pass; the required wrong-state case still fails `check_failed`, CLI exit 1, with its required screenshot. The paired desk/web case exits 0. The secure field disappears while the owned window remains and records `field_gone` with "the field that received the secret is gone". Original verdict and lease assertions remain unchanged.

Artifacts are `/Users/dragon/Library/Caches/retest-proofs/artifacts/wiring-desk/run-H1vuNb/` and `/Users/dragon/Library/Caches/retest-proofs/artifacts/wiring-desk-web/run-SYqtBg/`, copied to this evidence root's `wiring-desk/` and `wiring-desk-web/`. `native-api-desk-summary.json` records verdicts, screenshot counts and resume reasons without field values.

### Real native focus-loss privacy

Executed once through the lock.

```sh
/usr/bin/lockf -t 0 /tmp/retest-heavy-gate.lock env RETEST_MACOS_GATE=native-resume RETEST_TEST_MEDIA_BINARY=/Users/dragon/Documents/Projects/Gruvi/Products/retest/media/target/release/retest-media RETEST_EVIDENCE_OUT=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/native-withhold-field-gone/native-resume python3 .retest/native-withhold-field-gone/inside.py node --conditions=retest-source --test --test-concurrency=1 tests/integration/native-withhold-resume.test.ts > .retest/native-withhold-field-gone/logs/native-resume.log 2>&1
```

Exit 0, 1 of 1 passed, zero failed, cancelled or skipped. The still-present secure field loses focus and reads back masked or empty. Its event carries "the field reads back masked". The deliberate application failure remains `failed/check_failed`, CLI exit 1. The failure screenshot, both evaluation screenshots and the whole movie independently decode. The recording stays partial with its named withheld gap.

Artifacts are `native-resume/native-resume-recorded/` and `native-resume/native-resume-observations/` under the evidence root. `secrecy.json` confirms zero forwarded images and zero whole-video-map sources in the secret stretch, with captures after resume. `native-resume-summary.json` retains the reason and those counts.

### Chrome recorded flows

Executed once through the lock.

```sh
/usr/bin/lockf -t 0 /tmp/retest-heavy-gate.lock env RETEST_MACOS_GATE=flow-chromium RETEST_TEST_ENGINE=chromium RETEST_FIREFOX_ROUTE=launch-services RETEST_TEST_MEDIA_BINARY=/Users/dragon/Documents/Projects/Gruvi/Products/retest/media/target/release/retest-media RETEST_EVIDENCE_OUT=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/native-withhold-field-gone/flow-chromium python3 .retest/native-withhold-field-gone/inside.py node --conditions=retest-source --test --test-concurrency=1 tests/integration/evidence-flows.test.ts > .retest/native-withhold-field-gone/logs/flow-chromium.log 2>&1
```

The normal Chrome scenario has completed. Its original 20 assertions pass and CLI exits 0. Its whole-source native privacy check, all three independent movie decodes and unchanged final desk pixel gate pass. Normal artifacts are `flow-chromium/chromium-recorded/` and `chromium-observations/`, including `secrecy.json`; cache copy `/Users/dragon/Library/Caches/retest-proofs/artifacts/evidence-flow-engines/chromium/run-jcmbxD/`.

Chrome exit 0, 12 of 12 passed, zero failed, cancelled or skipped. Both unchanged final desk pixel gates pass. Both whole-source native privacy checks pass, covering four secret stretches, and all six movies independently decode. Normal CLI exit 0 has 20 passed assertions. Broken-sync CLI exit 1 has 18 passed assertions and its original one failed desk state check; nothing runs after it. Both native fields resume as `field_gone` with the literal field-gone reason.

Artifacts are `flow-chromium/chromium-recorded/`, `chromium-broken-sync-recorded/`, both observation folders and their `secrecy.json` files. The second cache copy is `/Users/dragon/Library/Caches/retest-proofs/artifacts/evidence-flow-engines/chromium-broken-sync/run-f8Ysor/`. `flow-chromium-summary.json` records counts, browser identity, native resumes and final desk withholding status. The actual browser is Chrome 154.0.8037.98, build `@b859317bf11f6be47f9b7799ec690a0a42a1fb33`.

```sh
python3 .retest/native-withhold-field-gone/summarize-flow.py chromium > .retest/native-withhold-field-gone/logs/flow-chromium-summary.log 2>&1
```

The read-only summary exits 0. Its first direct draft stopped with a Python string-escape syntax error before reading any artifact; the scratch script was corrected. No product file or assertion changed.

### Firefox recorded flows

Executed once through the lock with Launch Services.

```sh
/usr/bin/lockf -t 0 /tmp/retest-heavy-gate.lock env RETEST_MACOS_GATE=flow-firefox RETEST_TEST_ENGINE=firefox RETEST_FIREFOX_ROUTE=launch-services RETEST_TEST_MEDIA_BINARY=/Users/dragon/Documents/Projects/Gruvi/Products/retest/media/target/release/retest-media RETEST_EVIDENCE_OUT=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/native-withhold-field-gone/flow-firefox python3 .retest/native-withhold-field-gone/inside.py node --conditions=retest-source --test --test-concurrency=1 tests/integration/evidence-flows.test.ts > .retest/native-withhold-field-gone/logs/flow-firefox.log 2>&1
```

The normal Firefox scenario has completed. Original CLI exit 0 and all 20 assertions pass. The whole-source native privacy check, all three movie decodes and unchanged final desk pixel gate pass. The log confirms `Firefox launch route: launch-services`. Normal artifacts are `flow-firefox/firefox-recorded/` and `firefox-observations/`; cache copy `/Users/dragon/Library/Caches/retest-proofs/artifacts/evidence-flow-engines/firefox/run-2qpEDa/`.

Firefox exit 0, 12 of 12 passed, zero failed, cancelled or skipped. Both unchanged final desk pixel gates pass. Both whole-source native privacy checks pass, covering four stretches, and all six movies independently decode. Normal CLI exit 0 has 20 passed assertions. Broken-sync CLI exit 1 keeps 18 passed assertions and its original failed desk state check, with no later action. Both native fields resume as `field_gone` with the literal reason. The actual browser is Firefox 133.0.3, build `20241209150345`, launched through Launch Services.

Artifacts are `flow-firefox/firefox-recorded/`, `firefox-broken-sync-recorded/`, both observation folders and their `secrecy.json` files. Broken-sync cache copy `/Users/dragon/Library/Caches/retest-proofs/artifacts/evidence-flow-engines/firefox-broken-sync/run-3F7udj/`. Counts, full browser identity, native reasons and final desk withholding checks are in `flow-firefox-summary.json`.

```sh
python3 .retest/native-withhold-field-gone/summarize-flow.py firefox > .retest/native-withhold-field-gone/logs/flow-firefox-summary.log 2>&1
```

The read-only summary exits 0.

### WebKit recorded flows

Executed once through the lock.

```sh
/usr/bin/lockf -t 0 /tmp/retest-heavy-gate.lock env RETEST_MACOS_GATE=flow-webkit RETEST_TEST_ENGINE=webkit RETEST_FIREFOX_ROUTE=launch-services RETEST_TEST_MEDIA_BINARY=/Users/dragon/Documents/Projects/Gruvi/Products/retest/media/target/release/retest-media RETEST_EVIDENCE_OUT=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/native-withhold-field-gone/flow-webkit python3 .retest/native-withhold-field-gone/inside.py node --conditions=retest-source --test --test-concurrency=1 tests/integration/evidence-flows.test.ts > .retest/native-withhold-field-gone/logs/flow-webkit.log 2>&1
```

The normal WebKit scenario has completed. Original CLI exit 0 and all 20 assertions pass. Its whole-source native privacy check, three movie decodes and unchanged final desk pixel gate pass. Artifacts are `flow-webkit/webkit-recorded/` and `webkit-observations/`; cache copy `/Users/dragon/Library/Caches/retest-proofs/artifacts/evidence-flow-engines/webkit/run-Gf5BWd/`.

WebKit exit 0, 12 of 12 passed, zero failed, cancelled or skipped. Both unchanged final desk pixel gates pass. Both whole-source native privacy checks pass, covering four stretches, and all six movies independently decode. Normal CLI exit 0 has 20 passed assertions. Broken-sync CLI exit 1 has 18 passed assertions and the original failed desk state check, with no later action. Both native fields resume as `field_gone` with the literal reason. The actual browser is WebKit 626.1.6+, build `2359`, at `/Users/dragon/Library/Caches/ms-playwright/webkit-2359/Playwright.app/Contents/MacOS/Playwright`.

Artifacts are `flow-webkit/webkit-recorded/`, `webkit-broken-sync-recorded/`, both observation folders and their `secrecy.json` files. Broken-sync cache copy `/Users/dragon/Library/Caches/retest-proofs/artifacts/evidence-flow-engines/webkit-broken-sync/run-mYmp5J/`. Counts, browser identity, native reasons and final desk withholding checks are in `flow-webkit-summary.json`.

```sh
python3 .retest/native-withhold-field-gone/summarize-flow.py webkit > .retest/native-withhold-field-gone/logs/flow-webkit-summary.log 2>&1
```

The read-only summary exits 0. Across all three engines, six final desk pixel gates, six whole-source native privacy checks covering twelve stretches and eighteen independent movie decodes pass. Application outcomes remain normal pass or the original broken-sync failure.

### macOS evidence target

Executed once through the lock.

```sh
/usr/bin/lockf -t 0 /tmp/retest-heavy-gate.lock env RETEST_MACOS_GATE=evidence-macos RETEST_EVIDENCE_NATIVE=macos RETEST_TEST_MEDIA_BINARY=/Users/dragon/Documents/Projects/Gruvi/Products/retest/media/target/release/retest-media RETEST_EVIDENCE_OUT=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/native-withhold-field-gone/evidence-macos python3 .retest/native-withhold-field-gone/inside.py node --conditions=retest-source --test --test-concurrency=1 tests/integration/evidence-native.test.ts > .retest/native-withhold-field-gone/logs/evidence-macos.log 2>&1
```

macOS evidence exit 0, 5 of 5 passed, zero failed, cancelled or skipped. The original normal pass, assertion failure and synthetic ordinary-text secret case keep their verdicts. Screenshots and all three recordings independently decode with their identities. The ordinary text field remains withheld through session end with zero forwarded source images after fill. Recording off starts no media and keeps the same outcomes.

Artifacts are `evidence-macos/macos-on/`, `macos-off/`, `macos-observations/` and its `secrecy.json` under the evidence root. `evidence-macos-summary.json` records the on verdicts and privacy facts without values. All six required real-target invocations executed once and passed, 44 of 44 tests in total, zero failed, cancelled or skipped.

## Final checks and cleanup

The required real gates, final typechecks and cleanup audits have completed.

```sh
/usr/bin/lockf -t 0 /tmp/retest-heavy-gate.lock env RETEST_MACOS_GATE=typecheck-final python3 .retest/native-withhold-field-gone/inside.py npm run typecheck > .retest/native-withhold-field-gone/logs/typecheck-final.log 2>&1
```

Final main typecheck exits 0 on TypeScript 6, TypeScript 7 and the examples project.

```sh
/usr/bin/lockf -t 0 /tmp/retest-heavy-gate.lock env RETEST_MACOS_GATE=typecheck-proofs-final python3 .retest/native-withhold-field-gone/inside.py npm run typecheck:proofs > .retest/native-withhold-field-gone/logs/typecheck-proofs-final.log 2>&1
```

Proof typechecks exit 0 for Firefox, WebKit, native and media projects on both compilers.

```sh
/usr/bin/lockf -t 0 /tmp/retest-heavy-gate.lock env RETEST_MACOS_GATE=native-audit-final python3 .retest/native-withhold-field-gone/inside.py node --conditions=retest-source .retest/native-withhold-field-gone/native-audit.ts > .retest/native-withhold-field-gone/logs/native-audit-final.log 2>&1
/usr/bin/lockf -t 0 /tmp/retest-heavy-gate.lock python3 .retest/native-withhold-field-gone/process-audit.py > .retest/native-withhold-field-gone/logs/process-audit-final.log 2>&1
```

Both audits exit 0. `native-audit.json` confirms all six recorded simulator device IDs are absent from a fresh readable inventory, no process uses their device paths, and TaskDesk and both runner app paths have no process. `process-audit.json` confirms all 2,231 recorded PID readings, 2,189 distinct PIDs, are absent from a fresh readable whole table. All 23 recorded xcodebuild groups have no member. `desktop-record-after.json` has `startTimeVersion: 1`, an absent holder, no runner apps, no untied processes and no xcodebuild record. The auditors sent no signal. Existing owned teardown ended each run's resources; no manual termination was needed. No owned app, runner, simulator, browser, media process or ffmpeg remains.

`processes.jsonl`, `observed-processes.jsonl`, per-gate desktop records and the decoder records in each target folder retain PIDs, command lines and start identities. Observation uses the C locale and UTC process start times. No process-observation error was recorded.

```sh
python3 .retest/native-withhold-field-gone/scoped-verification.py > .retest/native-withhold-field-gone/logs/scoped-verification-draft.log 2>&1
```

The earlier scoped draft check exited 0, with no trailing whitespace, no observation errors and no benchmark in its ten guards. It confirmed that the guide's prefix and suffix outside the pixel-policy anchors were unchanged. The final scoped check below refreshes these facts after every completed gate and report edit.

```sh
python3 .retest/native-withhold-field-gone/scoped-verification.py > .retest/native-withhold-field-gone/logs/scoped-verification.log 2>&1
git diff --check -- src/runner/run-session.ts src/native/input.ts src/native/interaction-session.ts src/protocol/events.ts src/cli/inspect/test-timeline.ts src/reporters/html/timeline-view.ts tests/unit/native-input.test.ts tests/unit/runner-native-withhold-resume.test.ts tests/unit/protocol.test.ts tests/unit/protocol-identity.test.ts tests/unit/inspect-timeline.test.ts tests/unit/reporters-html.test.ts docs/guide.md docs/plans/public-beta/codex/phase-4/native-withhold-field-gone-report.md > .retest/native-withhold-field-gone/logs/scoped-diff-check.log 2>&1
```

Both final scoped checks exit 0. The script covers all 14 assigned source, test and report files in its snapshot/check set, including untracked files. Twelve existing files changed and this report was added; `src/native/input.ts` is unchanged. No trailing whitespace is present. The guide's text outside the anchored pixel-policy edit is unchanged. All 16 supervised benchmark guards saw no benchmark, and no process-observation error exists. `scoped-verification.json` lists the files and facts; `own-diffs/` retains each change against its starting snapshot.

| Final required check | Passed | Failed | Cancelled | Skipped | Exit |
| --- | ---: | ---: | ---: | ---: | ---: |
| Related unit suite | 196 | 0 | 0 | 0 | 0 |
| Desk API | 2 | 0 | 0 | 0 | 0 |
| Real native focus-loss privacy | 1 | 0 | 0 | 0 | 0 |
| Chrome flows | 12 | 0 | 0 | 0 | 0 |
| Firefox flows through Launch Services | 12 | 0 | 0 | 0 | 0 |
| WebKit flows | 12 | 0 | 0 | 0 | 0 |
| macOS evidence target | 5 | 0 | 0 | 0 | 0 |

No required verification remains unfinished. The limits below identify what these checks do not establish.

## Implementation and scope

| File | What changed |
| --- | --- |
| `src/native/interaction-session.ts:97` and `:231` | Keep whether the tracked fill passed its existing read-back verification. No input is repeated. |
| `src/native/interaction-session.ts:382` | Read a fresh owned tree in the existing command budget. A completed secure fill with a verified unique identifier can resume when no element with that identifier remains, regardless of current type or label. Failed tree or window reads keep withholding. Existing focus, secure type, private value and second focus reads remain required for present-field clearance. |
| `src/runner/run-session.ts:301`, `:1468` and `:1490` | Attach the native observation's literal reason to the policy's synchronous close event, restricted to its session and secret. The off setting bypasses native clearance. |
| `src/protocol/events.ts:561` and `:998` | Add the optional two-literal reason to the version 1 event type and strict runtime/JSON schema. |
| `src/cli/inspect/test-timeline.ts:175` | One anchored line shows the optional literal reason, preserving the old fallback. |
| `src/reporters/html/timeline-view.ts:185` | One anchored line shows the literal reason in HTML, preserving its old wording for older events. |
| `tests/unit/runner-native-withhold-resume.test.ts:7` | Field gone resumes; fields present and unmasked, failed reads and the off switch with the field gone keep withholding. Every case retains the required application failure. |
| `tests/unit/native-input.test.ts:369` | Both platforms keep withholding after unverified fill or field disappearance without a verified identifier. Synthetic values are generated in memory and redacted. |
| `tests/unit/protocol.test.ts:567` and `:617` | Samples cover both reasons, exact JSON enum coverage, optional compatibility and rejection of unknown reasons. |
| `tests/unit/protocol-identity.test.ts:214` | Both reasons retain the exact event identity keys and reject an observation id. |
| `tests/unit/inspect-timeline.test.ts:185` | Both reason names appear in inspect. |
| `tests/unit/reporters-html.test.ts:297` | Both reason names appear in HTML. |
| `docs/guide.md:1563` | Anchored pixel-policy wording includes field absence, both reasons, the off setting and reader compatibility. |
| `docs/plans/public-beta/codex/phase-4/native-withhold-field-gone-report.md` | This report, updated after each completed check. |

`src/native/input.ts` is unchanged in this work. Its existing fill verification and masking-character helper are reused. All real integration files, their privacy checks and their required screenshot/final desk assertions are unchanged. No package, dependency, export or CLI command was added. The package remains private. Source snapshots and own diffs are retained under `source-before/` and `own-diffs/`.

The unit invocations acquire no desktop or simulator. The copied supervisor's `insideLock` field is a label, not proof of lock acquisition for those invocations. Each real target command above explicitly runs through `lockf -t 0 /tmp/retest-heavy-gate.lock`. Each supervised test checks for `benchmarks/run.ts` before it starts. `benchmark-checks.jsonl` retains those guards. No benchmark ran here.

## Verification limits

The full repository unit and integration suites have not run. No physical device, additional operating system, native paint clock, multi-window identity change or application echo of a secret is claimed. Real window-gone, `RETEST_NATIVE_WITHHOLD_RESUME=off` on a real target and a deliberately failed real tree read are not separately exercised; their restrictive cases are covered by the fake runner and related units. Reader refusal before the new reason field is reasoned from the closed schema; an older packaged reader was not executed.

Whole-movie decoding covers every frame. Existing image similarity comparisons use first, middle and last shown source references. The privacy claim uses every forwarded native source and every whole-video-map entry from each withheld interval, with no sampled absence inference. It does not claim that a fixture never displayed something between captures or that text redaction protects pixels.
