# Native withholding and capture matching

The narrow native clearance rule and timestamp tie-break are implemented. Real macOS focus-loss clearance, macOS capture, iOS capture and the macOS evidence target passed. The original sign-in screenshot and six final desk pixel checks still fail because those secure fields disappear in windows that remain. The literal text event reason needs the schema owner, as recorded below.

Evidence is kept under `.retest/macos-proofs-3/`. The initial dirty tree is preserved. HTML and install source files were not touched. No benchmark, download, commit, stash, reset or revert ran.

## Implemented rule

Native secret entry remains withheld until the same secure field is read as unfocused and masked or empty, or its owned window is confirmed gone. Failed, missing or uncertain readings keep the stretch open. A successful fill alone does not close it. Browser new-document behavior stays as it is. The runner setting `RETEST_NATIVE_WITHHOLD_RESUME=off` restores session-end-only native withholding.

`capture.resumed` currently records `endedBy`, with no text reason. A schema addition would need `src/protocol/events.ts`, outside the named file list. A question about that single-file extension is pending.

The old capture matcher counted brightness differences above 48 but excluded twins only when their raw pixels were identical. The correction preserves 48 and the strict margin for distinguishable sources. Indistinguishable ties must obey source timestamp order.

## Evidence so far

Read README, architecture, repository instructions, common rules, phase handoffs, desktop legacy report, native recording handoff, artifact policy report, native interaction proof and guide pixel policy. Saved original authorized source files under `source-before/`. The prior desktop report retains the real API and six final-state withholding failures and the 48 strict capture ties. These are historical evidence, not fresh results from this worker.

The entries below retain the checks as they completed. The requested real targets were started only through the shared gate.

## Failing-first and focused checks

Each unit command below ran after the benchmark guard in `inside.py`; no desktop or simulator was started. The supervisor's `insideLock` field is only a copied label for these unit commands, not a claim they acquired the lock.

```sh
RETEST_MACOS_GATE=failing-first-corrected python3 .retest/macos-proofs-3/inside.py node --conditions=retest-source --test --test-concurrency=1 tests/unit/runner-native-withhold-resume.test.ts tests/unit/capture-proof-matcher.test.ts
RETEST_MACOS_GATE=old-hooks python3 .retest/macos-proofs-3/inside.py node --import ./.retest/macos-proofs-3/old-hooks.mjs --conditions=retest-source --test --test-concurrency=1 tests/unit/runner-native-withhold-resume.test.ts tests/unit/capture-proof-matcher.test.ts
RETEST_MACOS_GATE=focused-final python3 .retest/macos-proofs-3/inside.py node --conditions=retest-source --test --test-concurrency=1 tests/unit/runner-native-withhold-resume.test.ts tests/unit/capture-proof-matcher.test.ts
/usr/bin/lockf -t 0 /tmp/retest-heavy-gate.lock env RETEST_MACOS_GATE=typecheck python3 .retest/macos-proofs-3/inside.py npm run typecheck
```

Logs are `logs/<gate>.log`. The corrected old runner and matcher run failed 5 of 12, exit 1. The first draft of the new fixture used the stand-in's request-list method instead of its button reaction; that first log is retained as `logs/failing-first.log` and is superseded. The corrected fixture retained a wrong window shape on iOS, so the final failing-first replay also includes the corrected no-window shape. `old-hooks.mjs` removes only the new runner native hook and loads the saved old matcher in memory; product files were never replaced. It failed the same 5 of 12, exit 1. Failures require early masked, empty and gone-window resumes, timestamp ordering of identical images and ordering of threshold-indistinguishable ties. Focus, unmasked values, failed reads, field-only disappearance and the off setting remain withheld.

Final focused check passed 12 of 12, exit 0, zero failed, cancelled or skipped. Its tests preserve the application failure and actual exit 1 while distinguishing screenshot availability. Distinguishable ties and closer competing frames still fail the existing strict margin. The first implementation check failed from a missing `keyboardOf` import; its log is retained as `logs/native-debug.log`. The import was added. No failure or assertion was removed.

Locked main typecheck passed, exit 0, TypeScript 6, TypeScript 7 and the example project, `logs/typecheck.log`.

## Real desk API, first check

```sh
/usr/bin/lockf -t 0 /tmp/retest-heavy-gate.lock env RETEST_MACOS_GATE=native-api-desk python3 .retest/macos-proofs-3/inside.py node --conditions=retest-source --test --test-concurrency=1 tests/integration/native-api-desk.test.ts
```

Exit 1, 1 of 2 passed, zero cancelled or skipped, `logs/native-api-desk.log`. Both application flows reached their original outcomes; the API's required failure screenshot still refuses the password stretch. The desk/web lease test passes. Retained cache runs are `/Users/dragon/Library/Caches/retest-proofs/artifacts/wiring-desk/run-mRRC0Z/` and `wiring-desk-web/run-ajGmrI/`, copied under this evidence root as `wiring-desk/` and `wiring-desk-web/`. Application, runner and browser teardown remains in the unchanged product paths.

The secure sign-in field disappears while the owned window remains. The specified rule has no clearance from field-only disappearance, so the implementation preserves withholding. A clarification about adding proved secure-field disappearance is pending; that change has not been assumed. No existing required screenshot check changed. The later status-only diagnostic confirms stale reads below.

Related unit command passed 127 of 127, exit 0, zero cancelled or skipped, `logs/related-units.log`:

```sh
RETEST_MACOS_GATE=related-units python3 .retest/macos-proofs-3/inside.py node --conditions=retest-source --test --test-concurrency=1 tests/unit/native-input.test.ts tests/unit/native-source-retry.test.ts tests/unit/runner-native-wiring.test.ts tests/unit/runner-native-run-end.test.ts tests/unit/media-policy.test.ts tests/unit/capture-withhold.test.ts tests/unit/runner-recording-lifecycle.test.ts tests/unit/runner-native-withhold-resume.test.ts tests/unit/capture-proof-matcher.test.ts
```

These use stand-ins. Mac window/process tools in their native stand-in tests are local scripts returning fixture data; they do not drive the desktop.

## macOS capture matching

```sh
/usr/bin/lockf -t 0 /tmp/retest-heavy-gate.lock env RETEST_MACOS_GATE=capture-macos RETEST_CAPTURE_PROOF_OUT=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/macos-proofs-3/capture-macos python3 .retest/macos-proofs-3/inside.py node --conditions=retest-source --test --test-concurrency=1 tests/integration/capture-macos.test.ts
```

Executed once, exit 0, 1 of 1 passed, zero cancelled or skipped, `logs/capture-macos.log`. The actual owned window crop was 1400 by 960. Three input frames were delivered, sent, received and shown, with zero drops, withheld frames, identity refusals or resizes. All 45 output frames independently decoded and satisfied the frame map and strict comparison. Capture was the declared screenshot loop, not a native paint stream.

Artifacts are `capture-macos/macos-window-crop.mp4`, `macos-window-crop-report.json`, `raw/1.png` through `raw/3.png`, `raw/frames.json`, runtime logs and `decoder-processes.jsonl`. Raw source capture and arrival timestamps are retained. The brightness threshold remains 48. A competitor is excluded only when it ties the mapped source's output score and the source images themselves have zero differing pixels at 48. Timestamp order then has to select the mapped source, including later-source supersession on one video tick. A closer competing source is still counted, even when the sources are indistinguishable at 48. Distinguishable ties still fail the strict margin.

The iOS capture file also ran once, with `RETEST_CAPTURE_PROOF_OUT` at this evidence root's `capture-ios/`, as recorded below.

## iOS capture and real native clearance

```sh
/usr/bin/lockf -t 0 /tmp/retest-heavy-gate.lock env RETEST_MACOS_GATE=capture-ios RETEST_CAPTURE_PROOF_OUT=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/macos-proofs-3/capture-ios python3 .retest/macos-proofs-3/inside.py node --conditions=retest-source --test --test-concurrency=1 tests/integration/capture-ios.test.ts
/usr/bin/lockf -t 0 /tmp/retest-heavy-gate.lock env RETEST_MACOS_GATE=native-resume RETEST_EVIDENCE_OUT=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/macos-proofs-3/native-resume NODE_OPTIONS=--import=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/macos-proofs-3/clearance-hooks.mjs python3 .retest/macos-proofs-3/inside.py node --conditions=retest-source --test --test-concurrency=1 tests/integration/native-withhold-resume.test.ts
```

The iOS capture file executed once and passed 9 of 9, exit 0, zero cancelled or skipped, `logs/capture-ios.log`. The session-hook route independently decoded and matched 39 video frames from four approved source frames. The direct PNG candidate independently decoded and matched 108 video frames from 45 source frames. Both preserved all source/frame map, identity, order, no-resize and strict comparison assertions, with no drops or withheld frames. The simulator-native recorder produced its own video and remains outside the advertised capture modes because it has no frame times on the run clock.

Artifacts include `capture-ios/ios-simulator-display.mp4`, `ios-simulator-candidate.mp4`, their reports and raw source folders, the separate simulator-native movie, runtime logs and decoder process records. A native paint clock remains unverified. These are independent decodes of this host's actual simulator pixels.

The new real desk privacy check passed 1 of 1, exit 0, zero cancelled or skipped, `logs/native-resume.log`. It fills a declared synthetic secret in the actual secure field and then fills another field. This leaves the same secure field present, unfocused and reading back masked, which exercises exactly the specified rule. It does not change the existing sign-in flows. The application still deliberately fails its required wrong-state assertion, CLI 1, `failed/check_failed`; its failure screenshot and both evaluation screenshots independently decode. The actual recording resumes and remains partial with its original named withheld gap.

`native-resume/native-resume-recorded/` holds the events, result, screenshots, movie, HTML and terminal report. `native-resume/native-resume-observations/secrecy.json` records `field_masked`, zero approved images or video-map source entries from fill through resume, four approved source frames after resume, and a complete independent video decode. All source entries are checked, not a sample used to claim absence. The proof establishes no forwarded capture from the withheld interval. It cannot infer that an app never displayed something between captures.

The status-only loader was separately verified on one stand-in secure-fill test, 1 of 1, exit 0, `logs/clearance-loader-unit.log`. Those fixture readings are `clearance-stand-in.jsonl`. The privacy test's own observation loader replaces `NODE_OPTIONS` for its CLI child, so the status-only loader did not instrument that real CLI; its privacy and resume results come from actual persisted events and media-input interception. The filtered original API diagnostic below changes no test, action or result.

Expanded unit checks passed 14 of 14, exit 0, `logs/focused-expanded.log`, including unchanged 48-versus-49 boundary and same-tick later-source ordering. The corresponding old-code replay failed 7 of 14, exit 1, `logs/old-hooks-expanded.log`. That added failing-first coverage is retained. Deadline and cancellation are checked before each subsequent clearance request, so an expired read budget cannot authorize another query or resume.

## Original sign-in refusal confirmed

```sh
/usr/bin/lockf -t 0 /tmp/retest-heavy-gate.lock env RETEST_MACOS_GATE=native-api-desk-diagnostic NODE_OPTIONS=--import=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/macos-proofs-3/clearance-hooks.mjs python3 .retest/macos-proofs-3/inside.py node --conditions=retest-source --test --test-concurrency=1 --test-name-pattern='TaskDesk public API' tests/integration/native-api-desk.test.ts
```

Exit 1, 0 of 1 outer tests passed, zero cancelled or skipped, `logs/native-api-desk-diagnostic.log`. The unchanged passing application case and deliberately wrong-state case reached their expected outcomes, but the required screenshot remained withheld. Cache artifacts are `/Users/dragon/Library/Caches/retest-proofs/artifacts/wiring-desk/run-wOCAB3/`, copied as `wiring-desk-diagnostic/`.

The local hook records only element IDs, attribute names, status classifications and a boolean saying a refusal was stale. No raw value, app text or failure message is logged. `clearance-readback.jsonl` and `clearance-status-summary.json` retain 70 readings, including 15 stale focus reads of the filled secure field, and no later masked or empty value reading. The read fails before value clearance can occur. In the fixture, sign-in removes that field while retaining the owned window. That is distinct from the passing privacy check, where the same field stays present and focus moves to another field.

The narrower rule remains implemented. Proved field-only disappearance has not been added without a new decision. The literal text `reason` field also remains unapplied pending permission for the strict event schema file; `protocol-reason.patch` contains the two-line proposed extension. The existing `endedBy: field_masked` wire reason is documented in `src/media/policy.ts` as "the field reads back masked".

The last focused unit command passed 15 of 15, exit 0, `logs/focused-secure-unmasked.log`. It adds a secure field that returns unmasked text without changing its reported type, which keeps withholding and preserves the required application failure.

The recorded flows add all-source secret-interval assertions and keep their original final desktop evidence assertion unchanged.

## Chromium recorded flows

```sh
/usr/bin/lockf -t 0 /tmp/retest-heavy-gate.lock env RETEST_MACOS_GATE=flow-chromium RETEST_TEST_ENGINE=chromium RETEST_FIREFOX_ROUTE=launch-services RETEST_TEST_MEDIA_BINARY=/Users/dragon/Documents/Projects/Gruvi/Products/retest/media/target/release/retest-media RETEST_EVIDENCE_OUT=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/macos-proofs-3/flow-chromium python3 .retest/macos-proofs-3/inside.py node --conditions=retest-source --test --test-concurrency=1 tests/integration/evidence-flows.test.ts
```

Exit 1, 8 of 12 passed, 4 failed, zero cancelled or skipped, `logs/flow-chromium.log`. The normal CLI passed and the broken-sync CLI failed at the original desk state check, with no further test step. Both whole-source privacy checks passed, and all six app movies independently decoded. The two existing final desk pixel assertions failed, with their parent checks also counted as failures. The same-window sign-in field disappears and neither native stretch obtains clearance before session end. This failure remains visible.

Artifacts are `flow-chromium/chromium-recorded/`, `chromium-broken-sync-recorded/`, their respective observation folders and `secrecy.json` files. Cache runs are `/Users/dragon/Library/Caches/retest-proofs/artifacts/evidence-flow-engines/chromium/run-UIilL3/` and `chromium-broken-sync/run-gH86cH/`. The actual engine identified itself as Chrome 154.0.8037.98, build `@b859317bf11f6be47f9b7799ec690a0a42a1fb33`.

The final related unit run passed 130 of 130, exit 0, zero cancelled or skipped, `logs/related-units-final.log`. Its command is the related-unit command above with `RETEST_MACOS_GATE=related-units-final`. It includes the existing native cancellation checks, all nine fake-runner clearance states and all six matcher cases.

## Firefox recorded flows

```sh
/usr/bin/lockf -t 0 /tmp/retest-heavy-gate.lock env RETEST_MACOS_GATE=flow-firefox RETEST_TEST_ENGINE=firefox RETEST_FIREFOX_ROUTE=launch-services RETEST_TEST_MEDIA_BINARY=/Users/dragon/Documents/Projects/Gruvi/Products/retest/media/target/release/retest-media RETEST_EVIDENCE_OUT=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/macos-proofs-3/flow-firefox python3 .retest/macos-proofs-3/inside.py node --conditions=retest-source --test --test-concurrency=1 tests/integration/evidence-flows.test.ts
```

Exit 1, 8 of 12 passed, 4 failed, zero cancelled or skipped, `logs/flow-firefox.log`. The normal and broken-sync application outcomes remain correct. Both whole-source privacy checks and all six independent movie decodes pass. Both unchanged final desk pixel assertions fail, with two parent failures. The actual browser is Firefox 133.0.3, build `20241209150345`, launched through Launch Services.

Artifacts are `flow-firefox/firefox-recorded/`, `firefox-broken-sync-recorded/`, both observation folders and their `secrecy.json` files. Cache runs are `/Users/dragon/Library/Caches/retest-proofs/artifacts/evidence-flow-engines/firefox/run-JEQ6uC/` and `firefox-broken-sync/run-qj38yY/`.

## WebKit recorded flows

```sh
/usr/bin/lockf -t 0 /tmp/retest-heavy-gate.lock env RETEST_MACOS_GATE=flow-webkit RETEST_TEST_ENGINE=webkit RETEST_FIREFOX_ROUTE=launch-services RETEST_TEST_MEDIA_BINARY=/Users/dragon/Documents/Projects/Gruvi/Products/retest/media/target/release/retest-media RETEST_EVIDENCE_OUT=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/macos-proofs-3/flow-webkit python3 .retest/macos-proofs-3/inside.py node --conditions=retest-source --test --test-concurrency=1 tests/integration/evidence-flows.test.ts
```

Exit 1, 8 of 12 passed, 4 failed, zero cancelled or skipped, `logs/flow-webkit.log`. Normal CLI 0 and broken-sync CLI 1 retain their original application outcomes. Both privacy checks and all six independent movie decodes pass. Both unchanged final desk pixel assertions fail, with two parent failures. The actual browser is WebKit 626.1.6+, build `2359`, at `/Users/dragon/Library/Caches/ms-playwright/webkit-2359/Playwright.app/Contents/MacOS/Playwright`.

Artifacts are `flow-webkit/webkit-recorded/`, `webkit-broken-sync-recorded/`, both observation folders and their `secrecy.json` files. Cache runs are `/Users/dragon/Library/Caches/retest-proofs/artifacts/evidence-flow-engines/webkit/run-MMTYqq/` and `webkit-broken-sync/run-FwLHBl/`.

Across the three engines, six whole-source native privacy checks and 18 movie decodes passed. Each normal flow has 20 passed assertions; each broken-sync flow has 18 passed assertions and its original one failed desk check. No further test step runs after that failed check. All six final desk pixel checks remain red. Both native sign-in fields disappear while their windows remain, so their stretches persist to session end. A Mac crop also stays withheld while the phone stretch is open because the display is shared.

## macOS evidence target

```sh
/usr/bin/lockf -t 0 /tmp/retest-heavy-gate.lock env RETEST_MACOS_GATE=evidence-macos RETEST_EVIDENCE_NATIVE=macos RETEST_TEST_MEDIA_BINARY=/Users/dragon/Documents/Projects/Gruvi/Products/retest/media/target/release/retest-media RETEST_EVIDENCE_OUT=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/macos-proofs-3/evidence-macos python3 .retest/macos-proofs-3/inside.py node --conditions=retest-source --test --test-concurrency=1 tests/integration/evidence-native.test.ts
```

Exit 0, 5 of 5 passed, zero cancelled or skipped, `logs/evidence-macos.log`. The normal pass, original assertion failure and synthetic secret flow keep their verdicts. Screenshots and recordings independently decode with their full identities. The secret is entered into an ordinary text field and stays withheld through session end, with zero forwarded source images after fill. Recording off launches no media and gives the same verdicts.

Artifacts are `evidence-macos/macos-on/`, `macos-off/`, `macos-observations/` and `macos-observations/secrecy.json`. The old/new matcher replay now reads only the already-retained `capture-macos/` movie and three raw images. It starts no app, browser or simulator and no further capture.

## Retained macOS matcher replay

```sh
/usr/bin/lockf -t 0 /tmp/retest-heavy-gate.lock env RETEST_MACOS_GATE=replay-old RETEST_REPLAY_MODE=old RETEST_CAPTURE_PROOF_OUT=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/macos-proofs-3/replay-old python3 .retest/macos-proofs-3/inside.py node --import ./.retest/macos-proofs-3/old-hooks.mjs --conditions=retest-source .retest/macos-proofs-3/replay-macos-matcher.ts
/usr/bin/lockf -t 0 /tmp/retest-heavy-gate.lock env RETEST_MACOS_GATE=replay-new RETEST_REPLAY_MODE=new RETEST_CAPTURE_PROOF_OUT=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/macos-proofs-3/replay-new python3 .retest/macos-proofs-3/inside.py node --conditions=retest-source .retest/macos-proofs-3/replay-macos-matcher.ts
```

The old replay exits 1 because its proposed reproduction assertion expected at least one rejected margin, but found zero. This capture does not reproduce the historical 48 ties. The current replay exits 0 with all 45 decoded output frames mapped and zero rejected margins. Logs are `logs/replay-old.log` and `logs/replay-new.log`; summaries are `replay-old.json` and `replay-new.json`; decoder PIDs are in each replay folder.

The first source differs from the others in 158 raw pixels, 122 above 48, maximum brightness delta 68. The last two are exactly identical, which the old matcher already excludes. The prior failing capture did not retain its input PNGs, so the exact historical tie cannot be reconstructed. The unchanged-threshold and identical-frame failing-first unit cases remain direct regression proof. The separate retained iOS candidate replay below also proves the defect against its actual source sequence. The simulator capture file was not rerun.

## Remaining unit commands and draft failures

The exact additional unit invocations are below. The first direct draft used the same two-file Node invocation as `failing-first-corrected`, without the supervisor, after `pgrep -f 'benchmarks/[r]un.ts'`. Its exit was 1, 7 of 12 passed, `logs/failing-first.log`. The draft fixture errors below are retained, not counted as valid platform proof.

```sh
env RETEST_MACOS_GATE=focused-fixed python3 .retest/macos-proofs-3/inside.py node --conditions=retest-source --test --test-concurrency=1 tests/unit/runner-native-withhold-resume.test.ts tests/unit/capture-proof-matcher.test.ts > .retest/macos-proofs-3/logs/focused-fixed.log 2>&1
env RETEST_MACOS_GATE=native-debug python3 .retest/macos-proofs-3/inside.py node --conditions=retest-source --test '--test-name-pattern=native secret capture masked' tests/unit/runner-native-withhold-resume.test.ts > .retest/macos-proofs-3/logs/native-debug.log 2>&1
env RETEST_MACOS_GATE=focused-fixed-2 python3 .retest/macos-proofs-3/inside.py node --conditions=retest-source --test --test-concurrency=1 tests/unit/runner-native-withhold-resume.test.ts tests/unit/capture-proof-matcher.test.ts > .retest/macos-proofs-3/logs/focused-fixed-2.log 2>&1
env RETEST_MACOS_GATE=focused-expanded python3 .retest/macos-proofs-3/inside.py node --conditions=retest-source --test --test-concurrency=1 tests/unit/runner-native-withhold-resume.test.ts tests/unit/capture-proof-matcher.test.ts > .retest/macos-proofs-3/logs/focused-expanded.log 2>&1
env RETEST_MACOS_GATE=old-hooks-expanded python3 .retest/macos-proofs-3/inside.py node --import ./.retest/macos-proofs-3/old-hooks.mjs --conditions=retest-source --test --test-concurrency=1 tests/unit/runner-native-withhold-resume.test.ts tests/unit/capture-proof-matcher.test.ts > .retest/macos-proofs-3/logs/old-hooks-expanded.log 2>&1
env RETEST_MACOS_GATE=focused-secure-unmasked python3 .retest/macos-proofs-3/inside.py node --conditions=retest-source --test --test-concurrency=1 tests/unit/runner-native-withhold-resume.test.ts tests/unit/capture-proof-matcher.test.ts > .retest/macos-proofs-3/logs/focused-secure-unmasked.log 2>&1
env RETEST_MACOS_GATE=clearance-loader-unit python3 .retest/macos-proofs-3/inside.py node --import ./.retest/macos-proofs-3/clearance-hooks.mjs --conditions=retest-source --test '--test-name-pattern=secure field reads back' tests/unit/native-input.test.ts > .retest/macos-proofs-3/logs/clearance-loader-unit.log 2>&1
env RETEST_MACOS_GATE=related-units-final python3 .retest/macos-proofs-3/inside.py node --conditions=retest-source --test --test-concurrency=1 tests/unit/native-input.test.ts tests/unit/native-source-retry.test.ts tests/unit/runner-native-wiring.test.ts tests/unit/runner-native-run-end.test.ts tests/unit/media-policy.test.ts tests/unit/capture-withhold.test.ts tests/unit/runner-recording-lifecycle.test.ts tests/unit/runner-native-withhold-resume.test.ts tests/unit/capture-proof-matcher.test.ts > .retest/macos-proofs-3/logs/related-units-final.log 2>&1
```

| Gate | Tests | Passed | Failed | Exit | Finding |
| --- | ---: | ---: | ---: | ---: | --- |
| focused-fixed | 12 | 5 | 7 | 1 | Missing `keyboardOf` import. |
| native-debug | 1 | 0 | 1 | 1 | The same missing import in the isolated masked case. |
| focused-fixed-2 | 12 | 11 | 1 | 1 | The iOS fixture did not hide its window. |
| focused-expanded | 14 | 14 | 0 | 0 | Boundary and same-tick cases included. |
| old-hooks-expanded | 14 | 7 | 7 | 1 | Old code fails the new requirements. |
| focused-secure-unmasked | 15 | 15 | 0 | 0 | Secure type with an exposed value stays withheld. |
| clearance-loader-unit | 1 | 1 | 0 | 0 | Status-only observation loader works on a stand-in. |
| related-units-final | 130 | 130 | 0 | 0 | Final related suite. |

Every listed unit invocation has zero cancelled or skipped tests. None starts a real native target.

## Files changed in this work

| File and line | Change |
| --- | --- |
| `src/runner/run-session.ts:1476` | Arms native clearance for the specific secret entry. The off setting bypasses it. Browser entry handling is unchanged. |
| `src/native/input.ts:74` | Reuses the existing secure masking characters as a private pixel fact. Captures the exact fill target before input. Fill length verification remains unchanged. |
| `src/native/interaction-session.ts:162` and `:377` | Watches the exact executor field and launch reference. Reads clearance after later actions and observations within their existing command budget. Checks cancellation before requests and resume. On iOS it also requires no software keyboard. The gone-window route requires no owned window on screen. |
| `src/media/policy.ts:124` | Defines `field_masked` in words as "the field reads back masked". This is the only change here; no wire field is added. |
| `tests/integration/capture-proof.ts:255` | Resolves only equal-score, threshold-indistinguishable ties by source timestamp order. Threshold and other strict comparisons stay. |
| `tests/integration/capture-macos.test.ts:150` | Supplies the actual input timestamps and configured video rate to the matcher. |
| `tests/integration/capture-ios.test.ts:191` | Supplies the actual input timestamps and configured video rate to the matcher. |
| `tests/unit/capture-proof-matcher.test.ts:1` | Six regression cases, including an identical-frame wrong order that fails the old matcher. |
| `tests/unit/runner-native-withhold-resume.test.ts:1` | Nine fake-runner states preserve the required application failure and test withholding or resume. |
| `tests/unit/runner-native-stand-in.ts:128` | Accepts config fields and in-memory declared secret values for those cases. Secret values are not generated into source. |
| `tests/unit/native-interaction-fake.ts:178` | Makes the fixture's existing hidden-window state apply to iOS as well as macOS. |
| `tests/integration/evidence-flows.test.ts:208` | Adds a required whole-source privacy check for both native fills in each existing scenario. The final desk pixel assertion stays unchanged. |
| `tests/integration/native-withhold-resume.test.ts:1` | Adds the independent real desk focus-loss privacy proof and retains its deliberate application failure. |
| `docs/guide.md:1563` | Documents the native rule, setting, failed-read behavior and observed window/keyboard limits within the pixel policy section. Clarifies that masked field facts are what the policy can recognize. |
| `docs/plans/public-beta/codex/phase-4/native-withhold-resume-report.md:1` | This report. |

Source snapshots and current own diffs are under the evidence root. Scratch observation loaders, replay scripts and audit scripts also stay there. No source was copied from a sibling repository. No package, dependency, package export or CLI command was added. HTML and install source paths were not edited.

## Unverified and owner handoff

The requested 2 of 2 desk API result and final desk pixels in all six recorded scenarios are not achieved. They failed in the fresh checks above. The secure field is removed while the owned window remains, so its exact read-back is stale. The specified rule says a failed read keeps withholding. Supporting proved secure-field disappearance would require a broader rule; it has not been assumed or substituted for the requested rule. The existing final pixel assertions remain red.

The literal `capture.resumed.reason` string is not emitted. The event uses the existing `endedBy: field_masked`, and the policy documents its meaning as "the field reads back masked". Adding a text field requires the strict type and schema at `src/protocol/events.ts:561` and `:998`, outside this worker's named files. The two-line `protocol-reason.patch` is ready for that owner. The scoped policy record and runner emission would then also forward the approved reason. A reader built before that optional field is added would reject events carrying it, because its object schema is strict. Current wire events add no field and use already-allowed reasons.

Real macOS masked focus-loss clearance passed. Native empty-field and gone-window clearance, and the setting off, are covered by the fake runner. They were not separately exercised on the real desktop. Positive iOS clearance was not exercised; actual iOS capture and the negative full-flow privacy checks were. A replacement or closure of only one window while another owned window remains does not have identity proof in this path, so it stays withheld. Native paint clocks, physical devices and additional operating systems remain unverified. The full repository integration suite was not run.

The exact historical macOS 48 ties cannot be reconstructed because that run did not retain input PNGs. This worker's actual macOS capture passed its strict comparison and its old matcher also had zero rejected margins. The old/new regression is demonstrated by failing-first unit cases and the retained iOS replay recorded below.

## Retained iOS candidate matcher replay

```sh
/usr/bin/lockf -t 0 /tmp/retest-heavy-gate.lock env RETEST_MACOS_GATE=replay-ios-old RETEST_REPLAY_MODE=old RETEST_CAPTURE_PROOF_OUT=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/macos-proofs-3/replay-ios-old python3 .retest/macos-proofs-3/inside.py node --import ./.retest/macos-proofs-3/old-hooks.mjs --conditions=retest-source .retest/macos-proofs-3/replay-ios-matcher.ts
/usr/bin/lockf -t 0 /tmp/retest-heavy-gate.lock env RETEST_MACOS_GATE=replay-ios-new RETEST_REPLAY_MODE=new RETEST_CAPTURE_PROOF_OUT=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/macos-proofs-3/replay-ios-new python3 .retest/macos-proofs-3/inside.py node --conditions=retest-source .retest/macos-proofs-3/replay-ios-matcher.ts
```

Both read the exact same retained 45 PNGs and 108-frame candidate movie. The old matcher exits 1 on the unchanged strict-margin criterion, with 70 tied rejections and zero unmapped frames. The new matcher exits 0 with zero rejected margins and zero unmapped frames. The first old tied pair is source 1 against source 4, 16,408 raw pixels changed, zero pixels differing above 48 and maximum brightness delta 46. The threshold remains 48.

Logs are `logs/replay-ios-old.log` and `logs/replay-ios-new.log`; summaries are `replay-ios-old.json` and `replay-ios-new.json`. Input PNGs are `capture-ios/ios-simulator-candidate-frames/1.png` through `45.png`, with identities and capture times in `ios-simulator-candidate-raw-report.json`. Each replay folder records its decoder processes. No app or simulator started for these replays.

## Final typechecks and cleanup

```sh
/usr/bin/lockf -t 0 /tmp/retest-heavy-gate.lock env RETEST_MACOS_GATE=typecheck-final python3 .retest/macos-proofs-3/inside.py npm run typecheck
/usr/bin/lockf -t 0 /tmp/retest-heavy-gate.lock env RETEST_MACOS_GATE=typecheck-proofs-final python3 .retest/macos-proofs-3/inside.py npm run typecheck:proofs
/usr/bin/lockf -t 0 /tmp/retest-heavy-gate.lock env RETEST_MACOS_GATE=native-audit python3 .retest/macos-proofs-3/inside.py node --conditions=retest-source .retest/macos-proofs-3/native-audit.ts
/usr/bin/lockf -t 0 /tmp/retest-heavy-gate.lock python3 .retest/macos-proofs-3/process-audit.py
```

All four commands exited 0. Main typecheck checked TypeScript 6, TypeScript 7 and the example project. Proof typechecks checked Firefox, WebKit, native and media proof projects with both compilers. Logs are `logs/typecheck-final.log` and `logs/typecheck-proofs-final.log`.

`logs/native-audit.log` and `native-audit.json` confirm all seven recorded simulator device IDs are absent from a fresh readable inventory, with no process using any of those device paths. TaskDesk and both platform runner paths have no matching process. `logs/process-audit.log`, `process-audit.json` and `desktop-record-after.json` retain a fresh whole-table absence check. All 2,042 recorded PID readings, 1,982 distinct PIDs, are absent. All 26 recorded xcodebuild groups have no member. The current desktop marker has `startTimeVersion: 1`, an absent holder, empty runner and untied lists and no xcodebuild record. Neither auditor sent a signal. No manual process termination was needed; each test used its existing owned teardown.

`processes.jsonl`, `observed-processes.jsonl`, desktop records and decoder records retain the identities and command lines used by those checks. Process observation uses the C locale and UTC start times. The first direct draft unit invocation was outside that supervisor, ended normally, and started no platform or media process. The supervised gates and all later decoder launches are covered by the final audit.

The first runner-path inventory matched the macOS executable subdirectory. The final inventory broadens that read to the runner app path shared by both platforms; it keeps every previous absence assertion. Both final audit commands also exit 0:

```sh
/usr/bin/lockf -t 0 /tmp/retest-heavy-gate.lock env RETEST_MACOS_GATE=native-audit-final python3 .retest/macos-proofs-3/inside.py node --conditions=retest-source .retest/macos-proofs-3/native-audit.ts
/usr/bin/lockf -t 0 /tmp/retest-heavy-gate.lock python3 .retest/macos-proofs-3/process-audit.py
```

Their logs are `logs/native-audit-final.log` and `logs/process-audit-final.log`. The final process audit covers 2,044 readings, 1,983 distinct recorded PIDs, all absent. All 26 groups remain empty. The seven devices, their processes, TaskDesk and the runner apps remain absent. No signal was sent by the auditors.

Final source and document checks:

```sh
python3 .retest/macos-proofs-3/scoped-verification.py > .retest/macos-proofs-3/logs/scoped-verification.log 2>&1
git diff --check -- src/runner/run-session.ts src/native/input.ts src/native/interaction-session.ts src/media/policy.ts tests/integration/capture-proof.ts tests/integration/capture-macos.test.ts tests/integration/capture-ios.test.ts tests/integration/evidence-flows.test.ts tests/integration/native-withhold-resume.test.ts tests/unit/capture-proof-matcher.test.ts tests/unit/runner-native-withhold-resume.test.ts tests/unit/runner-native-stand-in.ts tests/unit/native-interaction-fake.ts docs/guide.md docs/plans/public-beta/codex/phase-4/native-withhold-resume-report.md > .retest/macos-proofs-3/logs/scoped-diff-check.log 2>&1
```

Both exit 0. The script checks all 15 scoped source, test and document files, including untracked files, for trailing whitespace. It confirms the guide's prefix and suffix outside the pixel-policy anchors are unchanged. All 30 supervised benchmark guards reported no benchmark, and there are no process-observation errors. Facts are in `scoped-verification.json`; current own diffs are retained alongside it.
