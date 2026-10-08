# Native leftovers

Four product regression families are reproduced with failing-first tests and fixed at their causes. `PolicedSource` discards the native screenshot read span and keeps suppressing fresh desktop frames after browser privacy ends. Native capture gives a queued command the entire response-watchdog allocation, losing a confirmed timeout reply. Native network exclusion lives in a run-specific temporary directory and omits the declared client, causing both ineffective cross-run exclusion and incorrect exclusion of distinct clients. A rounded native tree timeout also returns before the observation's exact deadline. The fixes preserve refusals, unknown outcomes, cancellation, strict pixel witnesses and cleanup. Compiler and type checks now pass; isolated corrected native files and the full-list validation remain pending. The starting run is 96 tests, 83 passed, 13 failed and zero skipped: `.retest/clean-run/integration-native.log`, from the 19 files in `.retest/clean-run/integration-native.list`. Its thirteen failures include four failed parent tests and nine failing leaves across six files.

The orchestrator held `/tmp/retest-heavy-gate.lock` for its final compiler, type, unit and browser sequence. It released the gate after its final browser run; this lane then began its isolated native queue. Each file will run alone through `lockf -t 0`, with one pending locked command at a time and a benchmark check before dispatch. No simulator or desktop test starts outside that lock.

Starting copies and command/process evidence are under `.retest/native-leftovers/`. Existing shared work is preserved. The media binary for real runs is `media/target/release/retest-media`, rebuilt by the orchestrator before the starting run. No benchmark, download, commit, stash, reset, revert or foreign-window intervention is authorized.

## Starting failures

| File and failing test | Starting evidence | Verdict |
| --- | --- | --- |
| `capture-ios.test.ts`: executor-screen, through the session's lane | Capture ended with `The executor-screen capture did not answer within 5000 ms; no further capture is requested.` | b, product regression; same watchdog failure in isolated real run and failing-first fixture |
| `capture-ios.test.ts`: route-measurement parent | Its executor-screen child failed | b, same child cause |
| `evidence-flows.test.ts`: normal flow native pixel-policy child | No shown filled-field frame met the selected native pixel-policy witness | Pending isolated run |
| `evidence-flows.test.ts`: normal flow parent | Its native pixel-policy child failed | Pending same cause |
| `evidence-flows.test.ts`: broken-sync native pixel-policy child | Same missing shown filled-field witness | Pending isolated run |
| `evidence-flows.test.ts`: broken-sync flow parent | Its native pixel-policy child failed | Pending same cause |
| `evidence-native.test.ts`: secret stretch has no forwarded frame or image artifact | Expected `partial`, received `complete` | Pending isolated run; inspect documented default policy |
| `evidence-native.test.ts`: recorded-evidence parent | Its secret-stretch child failed | Pending same cause |
| `install-media.test.ts`: packed offline installation | Current `encoder.rs` hash differs from the shipped pin | a, stale pin; isolated run reproduces the current-source hash refusal |
| `install-media.test.ts`: pinned localhost prebuilt | Prior failed build left the required binary absent | a, stale-pin consequence; baseline build produces no binary |
| `install-media.test.ts`: lock/tool/encoder refusals | Source-pin refusal precedes the intended missing-Cargo refusal | a, stale pin; baseline preserves this exact earlier refusal |
| `native-diagnostics-wired.test.ts`: declared diagnostics through CLI | Temporary network metadata lock remained at cleanup | Pending isolated run |
| `native-evaluation.test.ts`: TaskDesk pixels and retained failure | `Reading the app's tree: The app has no window in its tree.` | Pending isolated run |

The capture suite also has a failed summary, outside Node's 13-test failed count. The thirteen rows above account for that count, including four failed parents.

## Rules read

The README, architecture, project instructions, common rules and binding native phase decisions apply. Tonight's native default rule keeps pixels unless withholding is explicitly enabled. Secure fields still require exact masked `length_matched` read-back. Explicit opt-in retains plain-field withholding and guarded resume. Browser withholding remains unchanged. Criterion kinds use declared `state`, `seen` and `never` semantics; partial capture cannot prove a pass. The installer requires hashes computed from the shipped source allowlist. Tests will pin these rules without weakening required outcomes.

The prior native-withhold finish passed iOS 5/5, desktop 1/2 and Chrome evidence 4/12. Desktop pixels were refused by a covering window. Any fresh coverage refusal will be recorded verbatim; no covering window will be moved or ended.

## Commands and results

Isolated results, exact commands, counts and log paths are appended as each run completes. The required complete native-list rerun remains pending.

`env RETEST_MACOS_GATE=unit-pins-before python3 .retest/native-leftovers/inside.py node --conditions=retest-source --test --test-concurrency=1 tests/unit/media-install.test.ts tests/unit/media-locate.test.ts`

Exit 1, 22 tests, 17 passed, 5 failed, zero cancelled or skipped. Log `.retest/native-leftovers/logs/unit-pins-before.log`. All five failures are reached before the intended installer operation because shipped `encoder.rs` differs from its stale pin. This supports the source-pin diagnosis; the unchanged integration file is still queued before applying the refresh.

`python3 .retest/native-leftovers/refresh-pins.py > .retest/native-leftovers/logs/pins-prepared.log 2>&1`

Exit 0. The recorded generator ran in a disposable copy, with cached licences and no download. Its exact SHA-256 matches the earlier refresh report. Independently recomputed allowlist hashes match the generator; notices and allowlist are unchanged. Prepared output is `.retest/native-leftovers/refreshed-media-pins.ts`; `.retest/native-leftovers/pins-review.json` records every old/new hash. Product pins have not been edited yet.

`env RETEST_MACOS_GATE=policy-regression-before python3 .retest/native-leftovers/inside.py node --conditions=retest-source --test .retest/native-leftovers/policed-source-regression.test.ts`

Exit 1, 1 test, zero passed, 1 failed, zero cancelled or skipped. Log `.retest/native-leftovers/logs/policy-regression-before.log`. The regression retains three refusal controls, an open foreign stretch, a late screenshot overlapping the ended stretch and a source without a read-start stamp. It fails only when a screenshot wholly after the ended stretch must be retained. The fixture is `tests/integration/native-pixel-policy-fixture.ts` and starts no native app.

Read-only analysis of the starting Chrome evidence is retained in `.retest/native-leftovers/original-filled-witness-findings.json`. Phone frames reach the media process during both filled-state windows. Desk read spans continue after browser `capture.resumed`, but zero desk frames reach media during either filled-state window. The normal desk has a whole-read witness that policy suppresses; broken sync also needs fixture capture synchronization because its first post-fill desktop read arrives after sign-in starts. No source, image or original recording was changed by this analysis.

`env RETEST_MACOS_GATE=network-regression-before python3 .retest/native-leftovers/inside.py node --conditions=retest-source --test .retest/native-leftovers/network-lock-regression.test.ts`

Exit 1, 1 test, zero passed, 1 failed, zero cancelled or skipped. Log `.retest/native-leftovers/logs/network-regression-before.log`. Real `lockf` refuses a second reader using the same temporary directory, then incorrectly lets a reader using another temporary directory reach the fixture interaction. No app or executor is launched. The fixture also requires no lock in either run temporary directory, unchanged lock inode after release, and reacquisition after confirmed release. The common kernel lock's inode retention is preserved; deleting that inode would weaken exclusion.

`env RETEST_MACOS_GATE=capture-deadline-before python3 .retest/native-leftovers/inside.py node --conditions=retest-source --test .retest/native-leftovers/capture-deadline-regression.test.ts`

Exit 1, 1 test, zero passed, 1 failed, zero cancelled or skipped. Log `.retest/native-leftovers/logs/capture-deadline-before.log`. The source receives one initial image. Its next queued read reaches the capture command deadline, then supplies a confirmed timeout before any dispatch, with a separate reply-turn delay. The source prematurely ends instead of recording the known failed observation and continuing. Its failure is the same exact watchdog text as the starting real iOS failure. The fixture requires the failed observation to remain counted and named, recovery to produce another frame, and no early source ending. It launches no app or simulator.

`python3 .retest/native-leftovers/process-audit.py before-native-wait`

Exit 0. Audit `.retest/native-leftovers/before-native-wait-process-audit.json` found zero running identities among the three recorded unit children. No signal was sent. The orchestrator still holds the heavy gate; the native queue has started no target.

Prepared fixture corrections are `.retest/native-leftovers/prepared-test-fixes.patch`. The native-secret evidence case explicitly selects `nativeWithholding:true` and retains every exclusion check; it additionally requires the plain-field withheld branch and no masking claim. The flow fixture waits for a wholly fresh post-fill native read before sign-in, replacing its fixed pause. Existing independent media, whole-read and shown-frame witnesses remain unchanged. The capture regression also includes an unanswered-read control: bounded ending, abort, no next request and no late frame. Native integration files and product source remain unchanged pending their isolated baseline runs.

Capture correction design: reserve a reply margin inside the original 5,000 ms capture watchdog, rather than extending that watchdog. A queued command receives a smaller remaining allocation; a confirmed timeout remains a dropped observation. The unanswered-read control requires the exact original watchdog bound and still forbids any next request or late frame. This preparation changes no dispatched integration baseline.

`/usr/bin/lockf -t 0 /tmp/retest-heavy-gate.lock env -u RETEST_NATIVE_WITHHOLDING RETEST_MACOS_GATE=before-install-media RETEST_FIREFOX_ROUTE=launch-services RETEST_TEST_MEDIA_BINARY=/Users/dragon/Documents/Projects/Gruvi/Products/retest/media/target/release/retest-media RETEST_MEDIA_BINARY=/Users/dragon/Documents/Projects/Gruvi/Products/retest/media/target/release/retest-media RETEST_EVIDENCE_OUT=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/native-leftovers/before-install-media-artifacts RETEST_CAPTURE_PROOF_OUT=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/native-leftovers/before-install-media-artifacts RETEST_NATIVE_DIAGNOSTICS_OUT=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/native-leftovers/before-install-media-artifacts npm_config_offline=true python3 .retest/native-leftovers/inside.py node --conditions=retest-source --test --test-concurrency=1 tests/integration/install-media.test.ts`

Exit 1. Counts {"tests": 4, "suites": 0, "pass": 1, "fail": 3, "cancelled": 0, "skipped": 0, "todo": 0}. Log `.retest/native-leftovers/logs/before-install-media.log`. Lock attempts 41.

`python3 .retest/native-leftovers/refresh-pins.py --apply > .retest/native-leftovers/logs/pins-applied.log 2>&1`

Exit 0. Five source hashes and the aggregate digest were refreshed in `src/cli/install/media-pins.ts`; manifest, lock, allowlist and notices remain unchanged. The aggregate is `3e967ac7cf0a0b9faaa40fbe9e761476103fddae3e8bfdb4606b32b9eaaf270b`. The generator and independent hashing agree, as recorded in `pins-review.json`. The locked baseline was 4 tests, 1 passed, 3 failed, no cancelled or skipped tests. Its three failures match the starting run. The integration test itself is unchanged; its real offline build rerun remains pending.

`env RETEST_MACOS_GATE=unit-pins-after python3 .retest/native-leftovers/inside.py node --conditions=retest-source --test --test-concurrency=1 tests/unit/media-install.test.ts tests/unit/media-locate.test.ts > .retest/native-leftovers/logs/unit-pins-after.log 2>&1`

Exit 0, 22/22 passed, zero failed, cancelled or skipped. This reruns the unchanged installer/locator unit files after the refresh. Log `.retest/native-leftovers/logs/unit-pins-after.log`.

`/usr/bin/lockf -t 0 /tmp/retest-heavy-gate.lock env -u RETEST_NATIVE_WITHHOLDING RETEST_MACOS_GATE=before-capture-ios RETEST_FIREFOX_ROUTE=launch-services RETEST_TEST_MEDIA_BINARY=/Users/dragon/Documents/Projects/Gruvi/Products/retest/media/target/release/retest-media RETEST_MEDIA_BINARY=/Users/dragon/Documents/Projects/Gruvi/Products/retest/media/target/release/retest-media RETEST_EVIDENCE_OUT=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/native-leftovers/before-capture-ios-artifacts RETEST_CAPTURE_PROOF_OUT=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/native-leftovers/before-capture-ios-artifacts RETEST_NATIVE_DIAGNOSTICS_OUT=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/native-leftovers/before-capture-ios-artifacts npm_config_offline=true python3 .retest/native-leftovers/inside.py node --conditions=retest-source --test --test-concurrency=1 tests/integration/capture-ios.test.ts`

Exit 1. Counts {"tests": 9, "suites": 1, "pass": 7, "fail": 2, "cancelled": 0, "skipped": 0, "todo": 0}. Log `.retest/native-leftovers/logs/before-capture-ios.log`. Lock attempts 1.

The locked iOS baseline finishes with 9 tests, 7 passed, 2 failed, zero cancelled or skipped; its suite also fails from that child. The executor-screen failure is the exact starting watchdog message. Other routes, strict source/video mapping checks and cleanup run to completion. Runtime and source evidence are retained under `.retest/native-leftovers/before-capture-ios-artifacts/`.

`python3 .retest/native-leftovers/apply-prepared.py capture-ios > .retest/native-leftovers/logs/capture-fix-applied.log 2>&1`

Exit 0. `src/native/capture.ts` reserves 500 ms of the original 5,000 ms watchdog budget for the command reply, allocating at most 4,500 ms to the queued command. The watchdog itself remains 5,000 ms. Known capture failures remain dropped observations with their exact problems; unanswered capture still ends, aborts and requests nothing more. The existing real-target assertions are unchanged. `capture-ios.test.ts` additionally invokes the failing-first fixture. Source hashes are recorded in `capture-ios-applied.json`.

`env RETEST_MACOS_GATE=capture-after-units python3 .retest/native-leftovers/inside.py node --conditions=retest-source --test --test-concurrency=1 .retest/native-leftovers/capture-deadline-regression.test.ts tests/unit/native-capture.test.ts tests/unit/screenshot-loop-capture.test.ts tests/unit/capture-withhold.test.ts > .retest/native-leftovers/logs/capture-after-units.log 2>&1`

Exit 0, 57/57 passed, 6 suites, zero failed, cancelled or skipped. Log `.retest/native-leftovers/logs/capture-after-units.log`. The actual iOS rerun remains pending; passing unit fixtures alone are not a platform claim.

`/usr/bin/lockf -t 0 /tmp/retest-heavy-gate.lock env -u RETEST_NATIVE_WITHHOLDING RETEST_MACOS_GATE=before-evidence-flows RETEST_FIREFOX_ROUTE=launch-services RETEST_TEST_MEDIA_BINARY=/Users/dragon/Documents/Projects/Gruvi/Products/retest/media/target/release/retest-media RETEST_MEDIA_BINARY=/Users/dragon/Documents/Projects/Gruvi/Products/retest/media/target/release/retest-media RETEST_EVIDENCE_OUT=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/native-leftovers/before-evidence-flows-artifacts RETEST_CAPTURE_PROOF_OUT=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/native-leftovers/before-evidence-flows-artifacts RETEST_NATIVE_DIAGNOSTICS_OUT=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/native-leftovers/before-evidence-flows-artifacts npm_config_offline=true python3 .retest/native-leftovers/inside.py node --conditions=retest-source --test --test-concurrency=1 tests/integration/evidence-flows.test.ts`

Exit 1. Counts {"tests": 12, "suites": 0, "pass": 8, "fail": 4, "cancelled": 0, "skipped": 0, "todo": 0}. Log `.retest/native-leftovers/logs/before-evidence-flows.log`. Lock attempts 1.

`/usr/bin/lockf -t 0 /tmp/retest-heavy-gate.lock env -u RETEST_NATIVE_WITHHOLDING RETEST_MACOS_GATE=before-evidence-native RETEST_FIREFOX_ROUTE=launch-services RETEST_TEST_MEDIA_BINARY=/Users/dragon/Documents/Projects/Gruvi/Products/retest/media/target/release/retest-media RETEST_MEDIA_BINARY=/Users/dragon/Documents/Projects/Gruvi/Products/retest/media/target/release/retest-media RETEST_EVIDENCE_OUT=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/native-leftovers/before-evidence-native-artifacts RETEST_CAPTURE_PROOF_OUT=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/native-leftovers/before-evidence-native-artifacts RETEST_NATIVE_DIAGNOSTICS_OUT=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/native-leftovers/before-evidence-native-artifacts npm_config_offline=true python3 .retest/native-leftovers/inside.py node --conditions=retest-source --test --test-concurrency=1 tests/integration/evidence-native.test.ts`

Exit 1. Counts {"tests": 5, "suites": 0, "pass": 0, "fail": 5, "cancelled": 0, "skipped": 0, "todo": 0}. Log `.retest/native-leftovers/logs/before-evidence-native.log`. Lock attempts 1.

`/usr/bin/lockf -t 0 /tmp/retest-heavy-gate.lock env -u RETEST_NATIVE_WITHHOLDING RETEST_MACOS_GATE=before-native-diagnostics-wired RETEST_FIREFOX_ROUTE=launch-services RETEST_TEST_MEDIA_BINARY=/Users/dragon/Documents/Projects/Gruvi/Products/retest/media/target/release/retest-media RETEST_MEDIA_BINARY=/Users/dragon/Documents/Projects/Gruvi/Products/retest/media/target/release/retest-media RETEST_EVIDENCE_OUT=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/native-leftovers/before-native-diagnostics-wired-artifacts RETEST_CAPTURE_PROOF_OUT=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/native-leftovers/before-native-diagnostics-wired-artifacts RETEST_NATIVE_DIAGNOSTICS_OUT=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/native-leftovers/before-native-diagnostics-wired-artifacts npm_config_offline=true python3 .retest/native-leftovers/inside.py node --conditions=retest-source --test --test-concurrency=1 tests/integration/native-diagnostics-wired.test.ts`

Exit 1. Counts {"tests": 1, "suites": 0, "pass": 0, "fail": 1, "cancelled": 0, "skipped": 0, "todo": 0}. Log `.retest/native-leftovers/logs/before-native-diagnostics-wired.log`. Lock attempts 1.

`/usr/bin/lockf -t 0 /tmp/retest-heavy-gate.lock env -u RETEST_NATIVE_WITHHOLDING RETEST_MACOS_GATE=before-native-evaluation RETEST_FIREFOX_ROUTE=launch-services RETEST_TEST_MEDIA_BINARY=/Users/dragon/Documents/Projects/Gruvi/Products/retest/media/target/release/retest-media RETEST_MEDIA_BINARY=/Users/dragon/Documents/Projects/Gruvi/Products/retest/media/target/release/retest-media RETEST_EVIDENCE_OUT=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/native-leftovers/before-native-evaluation-artifacts RETEST_CAPTURE_PROOF_OUT=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/native-leftovers/before-native-evaluation-artifacts RETEST_NATIVE_DIAGNOSTICS_OUT=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/native-leftovers/before-native-evaluation-artifacts npm_config_offline=true python3 .retest/native-leftovers/inside.py node --conditions=retest-source --test --test-concurrency=1 tests/integration/native-evaluation.test.ts`

Exit 0. Counts {"tests": 3, "suites": 0, "pass": 3, "fail": 0, "cancelled": 0, "skipped": 0, "todo": 0}. Log `.retest/native-leftovers/logs/before-native-evaluation.log`. Lock attempts 1.

## Applied fixes and additional isolated evidence

The screenshot-span, capture-allocation, shared network lock and rounded observation deadline fixes are now applied. The network lock includes the declared client so two clients in one file can read their distinct records while the same client remains excluded across runs and temporary directories. A timed-out observation keeps its original failure to its existing deadline; cancellation stops that wait, preserves the earlier failure and sends no further read or input.

The isolated evidence-native baseline also exposed a different failure from the original run: recording On returned `timeout` for the deliberately wrong text check while Off returned `check_failed`. Its preserved result reports a tree request with no answer within 25 ms. The failing-first observation fixture reproduces a rounded request returning at 119.35 ms before the caller's 120 ms budget. This product regression was fixed at `NativeInteractionSession.observe`, without changing the required wrong-check outcome.

The isolated wired-diagnostics baseline reproduces the retained lock inode in the run temporary directory. The initial lock fixture proves another temporary directory bypasses that exclusion. A second failing-first control proves distinct declared clients were incorrectly excluded from one shared metadata file. The lock now lives in the user's shared cache and retains its inode after release.

The unchanged Mac evaluation baseline passes all three tests, with zero skips. Its original missing-window refusal therefore has not reproduced. A locked Foundation argument-domain probe is queued to inspect the documented desktop launch ambiguity before any setup change.

`env RETEST_MACOS_GATE=network-clients-before python3 .retest/native-leftovers/inside.py node --conditions=retest-source --test .retest/native-leftovers/network-lock-regression.test.ts > .retest/native-leftovers/logs/network-clients-before.log 2>&1`

Exit 1. Counts {"tests": 1, "suites": 0, "pass": 0, "fail": 1, "cancelled": 0, "skipped": 0, "todo": 0}. Log `.retest/native-leftovers/logs/network-clients-before.log`.

`env RETEST_MACOS_GATE=observation-deadline-before python3 .retest/native-leftovers/inside.py node --conditions=retest-source --test .retest/native-leftovers/observation-deadline-regression.test.ts > .retest/native-leftovers/logs/observation-deadline-before.log 2>&1`

Exit 1. Counts {"tests": 1, "suites": 0, "pass": 0, "fail": 1, "cancelled": 0, "skipped": 0, "todo": 0}. Log `.retest/native-leftovers/logs/observation-deadline-before.log`.

`env RETEST_MACOS_GATE=policy-after-units python3 .retest/native-leftovers/inside.py node --conditions=retest-source --test --test-concurrency=1 .retest/native-leftovers/policed-source-regression.test.ts tests/unit/runner-policed-source.test.ts tests/unit/media-policy.test.ts > .retest/native-leftovers/logs/policy-after-units.log 2>&1`

Exit 0. Counts {"tests": 24, "suites": 5, "pass": 24, "fail": 0, "cancelled": 0, "skipped": 0, "todo": 0}. Log `.retest/native-leftovers/logs/policy-after-units.log`.

`env RETEST_MACOS_GATE=network-after-units python3 .retest/native-leftovers/inside.py node --conditions=retest-source --test --test-concurrency=1 .retest/native-leftovers/network-lock-regression.test.ts tests/unit/runner-native-run-end.test.ts tests/unit/runner-native-diagnostics.test.ts > .retest/native-leftovers/logs/network-after-units.log 2>&1`

Exit 0. Counts {"tests": 30, "suites": 14, "pass": 30, "fail": 0, "cancelled": 0, "skipped": 0, "todo": 0}. Log `.retest/native-leftovers/logs/network-after-units.log`.

`env RETEST_MACOS_GATE=observation-after-units python3 .retest/native-leftovers/inside.py node --conditions=retest-source --test --test-concurrency=1 .retest/native-leftovers/observation-deadline-regression.test.ts tests/unit/native-source-retry.test.ts tests/unit/native-assertions.test.ts > .retest/native-leftovers/logs/observation-after-units.log 2>&1`

Exit 0. Counts {"tests": 25, "suites": 0, "pass": 25, "fail": 0, "cancelled": 0, "skipped": 0, "todo": 0}. Log `.retest/native-leftovers/logs/observation-after-units.log`.

`env RETEST_MACOS_GATE=observation-cancellation-units python3 .retest/native-leftovers/inside.py node --conditions=retest-source --test .retest/native-leftovers/observation-deadline-regression.test.ts > .retest/native-leftovers/logs/observation-cancellation-units.log 2>&1`

Exit 0. Counts {"tests": 1, "suites": 0, "pass": 1, "fail": 0, "cancelled": 0, "skipped": 0, "todo": 0}. Log `.retest/native-leftovers/logs/observation-cancellation-units.log`.

`python3 .retest/native-leftovers/process-audit.py isolated-baselines`

Exit 0. Read-only audit `.retest/native-leftovers/isolated-baselines-process-audit.json` found zero running identities among 1,505 recorded descendants from this lane. No signal was sent.

`env RETEST_MACOS_GATE=unit-suite-after python3 .retest/native-leftovers/inside.py npm run test:unit > .retest/native-leftovers/logs/unit-suite-after.log 2>&1`

Started with a clear benchmark guard. The full unit suite verifies the runner and deadline changes beyond the focused fixtures while the one heavy-gate job remains queued. Its result will be recorded after it completes.

## Failure verdicts established so far

The four regression families have failing-first evidence: native screenshot spans, queued capture replies, network exclusion, and rounded native observation deadlines. Each fixes the product at its cause. The new observation deadline issue is additional to the starting nine leaf failures; the baseline exposes it without dropping any original check.

- Capture executor-screen and its route parent: **b**. The locked baseline repeats the exact 5,000 ms watchdog loss; the unit fixture reproduces a confirmed queued timeout losing the capture source. The correction reserves reply time inside the existing watchdog and retains unanswered-source cancellation and late-frame refusal.
- Normal and broken-sync native-policy children and both parents: **b**, with a setup correction. The actual read-to-arrival span was discarded by the shared-display policy. Fresh spans after a completed web privacy stretch stay blocked. The failing-first fixture proves this independently while retaining refusal controls. The flow setup also waits for an actual fresh forwarded native read after each fill rather than relying on a fixed pause; every actual secure-field read-back and shown-frame witness remains required.
- Native secret child and its recorded-evidence parent: **a**. Tonight's documented native default intentionally retains pixels. The old test expects withholding without opting in. It now explicitly selects `nativeWithholding:true`, retains every no-frame/no-artifact requirement and adds the actual plain-field withholding branch. No criterion assertion was removed or relaxed. The additional wrong-check timeout is **b**, with its own failing-first deadline fixture.
- Three install-media leaves: **a**. A generated source hash became stale after the recorded crate changes. The generator and an independent allowlist digest agree on the refreshed pins. The integration file and all build, protocol, prebuilt integrity and refusal assertions are unchanged.
- Wired diagnostics: **b**. The isolated baseline reproduces a retained lock inode in a run-specific temporary directory. The failing-first fixtures additionally prove cross-directory exclusion was ineffective and distinct declared clients were over-excluded. A shared cache lock keyed by canonical source path and client fixes both; inode retention and strict temporary-folder cleanup remain required.
- TaskDesk evaluation: original missing-window refusal remains under investigation. The unchanged isolated file is 3/3 passed. No window, app default or assertion has been changed on the strength of that pass alone.

Full unit suite completed: exit 0, 4,255 tests, 648 suites, 4,255 passed, zero failed, cancelled, skipped or todo. Log `.retest/native-leftovers/logs/unit-suite-after.log`. All 21 refreshed source hashes still match the current allowlist; read-only check `.retest/native-leftovers/current-pin-check.json`.

`python3 .retest/native-leftovers/process-audit.py units-complete`

Exit 0. Audit `.retest/native-leftovers/units-complete-process-audit.json` finds zero running identities among 3,233 recorded descendants. No signal was sent. The launch probe remains the single queued locked command.

`/usr/bin/lockf -t 0 /tmp/retest-heavy-gate.lock env RETEST_MACOS_GATE=mac-arguments-before npm_config_offline=true python3 .retest/native-leftovers/inside.py xcrun swift .retest/native-leftovers/argument-domain.swift -reset -serviceURL http://127.0.0.1:7 -windowFrame 20,60,640,480`

Exit 0. Counts {}. Log `.retest/native-leftovers/logs/mac-arguments-before.log`. Lock attempts 12.

`/usr/bin/lockf -t 0 /tmp/retest-heavy-gate.lock env RETEST_MACOS_GATE=mac-arguments-paired npm_config_offline=true python3 .retest/native-leftovers/inside.py xcrun swift .retest/native-leftovers/argument-domain.swift -NSTreatUnknownArgumentsAsOpen NO -reset YES -serviceURL http://127.0.0.1:7 -windowFrame 20,60,640,480`

Exit 0. Counts {}. Log `.retest/native-leftovers/logs/mac-arguments-paired.log`. Lock attempts 1.

`/usr/bin/lockf -t 0 /tmp/retest-heavy-gate.lock env RETEST_MACOS_GATE=typecheck-after npm_config_offline=true python3 .retest/native-leftovers/inside.py npm run typecheck`

Exit 2. Counts {}. Log `.retest/native-leftovers/logs/typecheck-after.log`. Lock attempts 1.

`/usr/bin/lockf -t 0 /tmp/retest-heavy-gate.lock env RETEST_MACOS_GATE=types-after npm_config_offline=true python3 .retest/native-leftovers/inside.py npm run test:types`

Exit 1. Counts {}. Log `.retest/native-leftovers/logs/types-after.log`. Lock attempts 1.

## Compiler correction and Mac launch evidence

The locked compiler run exits 2 and names three errors in this lane's additions. Failure details admit scalars and truncated text, not an embedded failure object. The preserved prior read failure is now serialized as a JSON string, with the cancellation test requiring that exact original failure and details. The network fixture now declares its client as `ios | macos` and supplies the required empty launch arguments/environment. No ignored errors or widened protocol types were added. The type-test run also exits 1 from that product detail shape. Both are rerun through the lock before native validation.

The locked Foundation probes both exit 0. The old launch argument domain has `serviceURL` and `windowFrame`, but has neither `reset` nor `NSTreatUnknownArgumentsAsOpen`. The paired version has all four with exact intended values. Foundation does not show the URL being orphaned, so this probe does not prove AppKit's separate launch parsing behavior. The original runner log `/tmp/retest-native-diagnostics-build/evaluation-macos-6wW7p3/macos-runner-32318-56732.log` does prove the app launched, repeatedly answered with no window throughout the exact text-check budget, and was terminated by its owned session. The unchanged isolated file passes 3/3 with zero skips.

Verdict **c** for the Mac setup: the fixture documentation and `TaskDeskApp.init` describe the open-URL launch hazard and register its guard only in memory during SwiftUI initialization. The test now supplies paired desktop flags and `-NSTreatUnknownArgumentsAsOpen NO` at process launch, so the guard is present before scene creation. Attribution of the original transient refusal to that documented startup hazard remains an inference; it did not reproduce in isolation. Every tree, actual-pixel, visible-defect, retained-parent-failure and cleanup assertion is unchanged. The setup does not retry a failed app launch, add time or move a window. Real validation remains pending.

`/usr/bin/lockf -t 0 /tmp/retest-heavy-gate.lock env RETEST_MACOS_GATE=typecheck-corrected npm_config_offline=true python3 .retest/native-leftovers/inside.py npm run typecheck`

Exit 0. Counts {}. Log `.retest/native-leftovers/logs/typecheck-corrected.log`. Lock attempts 1.

`/usr/bin/lockf -t 0 /tmp/retest-heavy-gate.lock env RETEST_MACOS_GATE=types-corrected npm_config_offline=true python3 .retest/native-leftovers/inside.py npm run test:types`

Exit 0. Counts {}. Log `.retest/native-leftovers/logs/types-corrected.log`. Lock attempts 1.

`env RETEST_MACOS_GATE=corrected-fixture-units python3 .retest/native-leftovers/inside.py node --conditions=retest-source --test --test-concurrency=1 .retest/native-leftovers/observation-deadline-regression.test.ts .retest/native-leftovers/network-lock-regression.test.ts tests/unit/native-source-retry.test.ts tests/unit/native-assertions.test.ts tests/unit/runner-native-run-end.test.ts tests/unit/runner-native-diagnostics.test.ts > .retest/native-leftovers/logs/corrected-fixture-units.log 2>&1`

Exit 0, 55 tests, 14 suites, 55 passed and zero failed, cancelled, skipped or todo after the strict type corrections. Log `.retest/native-leftovers/logs/corrected-fixture-units.log`. Corrected compiler/type-test logs are `.retest/native-leftovers/logs/typecheck-corrected.log` and `.retest/native-leftovers/logs/types-corrected.log`, both exit 0.

`/usr/bin/lockf -t 0 /tmp/retest-heavy-gate.lock env -u RETEST_NATIVE_WITHHOLDING RETEST_MACOS_GATE=after-install-media RETEST_FIREFOX_ROUTE=launch-services RETEST_TEST_MEDIA_BINARY=/Users/dragon/Documents/Projects/Gruvi/Products/retest/media/target/release/retest-media RETEST_MEDIA_BINARY=/Users/dragon/Documents/Projects/Gruvi/Products/retest/media/target/release/retest-media RETEST_EVIDENCE_OUT=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/native-leftovers/after-install-media-artifacts RETEST_CAPTURE_PROOF_OUT=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/native-leftovers/after-install-media-artifacts RETEST_NATIVE_DIAGNOSTICS_OUT=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/native-leftovers/after-install-media-artifacts npm_config_offline=true python3 .retest/native-leftovers/inside.py node --conditions=retest-source --test --test-concurrency=1 tests/integration/install-media.test.ts`

Exit 0. Counts {"tests": 4, "suites": 0, "pass": 4, "fail": 0, "cancelled": 0, "skipped": 0, "todo": 0}. Log `.retest/native-leftovers/logs/after-install-media.log`. Lock attempts 1.

`/usr/bin/lockf -t 0 /tmp/retest-heavy-gate.lock env -u RETEST_NATIVE_WITHHOLDING RETEST_MACOS_GATE=after-capture-ios RETEST_FIREFOX_ROUTE=launch-services RETEST_TEST_MEDIA_BINARY=/Users/dragon/Documents/Projects/Gruvi/Products/retest/media/target/release/retest-media RETEST_MEDIA_BINARY=/Users/dragon/Documents/Projects/Gruvi/Products/retest/media/target/release/retest-media RETEST_EVIDENCE_OUT=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/native-leftovers/after-capture-ios-artifacts RETEST_CAPTURE_PROOF_OUT=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/native-leftovers/after-capture-ios-artifacts RETEST_NATIVE_DIAGNOSTICS_OUT=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/native-leftovers/after-capture-ios-artifacts npm_config_offline=true python3 .retest/native-leftovers/inside.py node --conditions=retest-source --test --test-concurrency=1 tests/integration/capture-ios.test.ts`

Exit 0. Counts {"tests": 10, "suites": 1, "pass": 10, "fail": 0, "cancelled": 0, "skipped": 0, "todo": 0}. Log `.retest/native-leftovers/logs/after-capture-ios.log`. Lock attempts 1.

The corrected install-media file is 4/4 passed, zero failed, cancelled or skipped. Its unchanged packed-copy test performs the offline source build and verifies protocol 2, the refreshed source digest and released generation lock. The localhost prebuilt and every named refusal case also pass.

The corrected iOS capture file is 10/10 passed, 1 suite, zero failed, cancelled or skipped. Its real executor route now records one dropped observation with the exact problem `The request waited 4500 ms for the one before it and did not go.`, retains two delivered captures and ends with no source-ending problem. The capture reply maximum in that route is 4501.9 ms, inside the unchanged 5000 ms watchdog. Strict frame/video mapping and both real app/session close checks pass. Evidence is `.retest/native-leftovers/after-capture-ios-artifacts/ios-routes-report.json`; log `.retest/native-leftovers/logs/after-capture-ios.log`.

The corrected type tests match 246 expected errors against 246 markers in 11 projects under both TypeScript 6.0.3 and 7.0.2, exit 0. Compiler log `.retest/native-leftovers/logs/typecheck-corrected.log`; type-test log `.retest/native-leftovers/logs/types-corrected.log`.

The normal Chrome/iOS/Mac recorded flow passes its original native pixel-policy child, the independently decoded phone/web/desk recordings and its parent. The broken-sync case is still running. Log `.retest/native-leftovers/logs/after-evidence-flows.log`; actual recording and observation folders `.retest/native-leftovers/after-evidence-flows-artifacts/chromium-recorded` and `chromium-observations`.

`/usr/bin/lockf -t 0 /tmp/retest-heavy-gate.lock env -u RETEST_NATIVE_WITHHOLDING RETEST_MACOS_GATE=after-evidence-flows RETEST_FIREFOX_ROUTE=launch-services RETEST_TEST_MEDIA_BINARY=/Users/dragon/Documents/Projects/Gruvi/Products/retest/media/target/release/retest-media RETEST_MEDIA_BINARY=/Users/dragon/Documents/Projects/Gruvi/Products/retest/media/target/release/retest-media RETEST_EVIDENCE_OUT=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/native-leftovers/after-evidence-flows-artifacts RETEST_CAPTURE_PROOF_OUT=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/native-leftovers/after-evidence-flows-artifacts RETEST_NATIVE_DIAGNOSTICS_OUT=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/native-leftovers/after-evidence-flows-artifacts npm_config_offline=true python3 .retest/native-leftovers/inside.py node --conditions=retest-source --test --test-concurrency=1 tests/integration/evidence-flows.test.ts`

Exit 0. Counts {"tests": 13, "suites": 0, "pass": 13, "fail": 0, "cancelled": 0, "skipped": 0, "todo": 0}. Log `.retest/native-leftovers/logs/after-evidence-flows.log`. Lock attempts 1.

The corrected evidence-flows file is 13/13 passed with zero failed, cancelled or skipped tests. Both original native pixel-policy children and both parents pass. Each flow independently decodes phone, web and desk recordings. The broken-sync flow retains its required desk-state failure and stops at that check. Its actual filled-state native frames remain required by the original sent/shown whole-read witnesses. Log `.retest/native-leftovers/logs/after-evidence-flows.log`; recordings and observation data `.retest/native-leftovers/after-evidence-flows-artifacts/`.

`/usr/bin/lockf -t 0 /tmp/retest-heavy-gate.lock env -u RETEST_NATIVE_WITHHOLDING RETEST_MACOS_GATE=after-evidence-native RETEST_FIREFOX_ROUTE=launch-services RETEST_TEST_MEDIA_BINARY=/Users/dragon/Documents/Projects/Gruvi/Products/retest/media/target/release/retest-media RETEST_MEDIA_BINARY=/Users/dragon/Documents/Projects/Gruvi/Products/retest/media/target/release/retest-media RETEST_EVIDENCE_OUT=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/native-leftovers/after-evidence-native-artifacts RETEST_CAPTURE_PROOF_OUT=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/native-leftovers/after-evidence-native-artifacts RETEST_NATIVE_DIAGNOSTICS_OUT=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/native-leftovers/after-evidence-native-artifacts npm_config_offline=true python3 .retest/native-leftovers/inside.py node --conditions=retest-source --test --test-concurrency=1 tests/integration/evidence-native.test.ts`

Exit 1. Counts {"tests": 6, "suites": 0, "pass": 2, "fail": 4, "cancelled": 0, "skipped": 0, "todo": 0}. Log `.retest/native-leftovers/logs/after-evidence-native.log`. Lock attempts 1.

## Preserved first corrected native-evidence run

The first corrected native-evidence file still fails, from a newly exposed environment refusal. The deliberately wrong text check now correctly fails as `check_failed`, and the explicit plain-field withholding child passes every exclusion check. The ready case instead has no completed observation during its final five-second status assertion: it ends at 5001 ms with `Reading the app's tree: GET /session/F0704694-DA4A-4E66-8287-351E06C24289/source: no answer within 974 ms.` Recording Off returns the required passed/check_failed/passed outcomes. These failed comparisons are retained in `.retest/native-leftovers/logs/after-evidence-native.log` and the preserved On/Off report folders.

Verdict **c** for this additional failure. Its runner repeatedly names `com.apple.springboard` during the failed observation, and the preserved failure screenshot visibly shows the connected TaskPhone account field and its open native keyboard. The source scope refuses the foreign trees rather than accepting them. Evidence index `.retest/native-leftovers/ready-source-environment.json` records the exact log and screenshot paths. The fixture now dismisses the iOS keyboard after the unchanged nonsecret field-value assertion, before the unchanged pause and five-second final status assertion. No assertion, budget, source-scope refusal or secret-stretch behavior was weakened. The focused secret remains focused; no field containing the random secret is inspected by this diagnosis.

`/usr/bin/lockf -t 0 /tmp/retest-heavy-gate.lock env -u RETEST_NATIVE_WITHHOLDING RETEST_MACOS_GATE=after-native-diagnostics-wired RETEST_FIREFOX_ROUTE=launch-services RETEST_TEST_MEDIA_BINARY=/Users/dragon/Documents/Projects/Gruvi/Products/retest/media/target/release/retest-media RETEST_MEDIA_BINARY=/Users/dragon/Documents/Projects/Gruvi/Products/retest/media/target/release/retest-media RETEST_EVIDENCE_OUT=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/native-leftovers/after-native-diagnostics-wired-artifacts RETEST_CAPTURE_PROOF_OUT=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/native-leftovers/after-native-diagnostics-wired-artifacts RETEST_NATIVE_DIAGNOSTICS_OUT=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/native-leftovers/after-native-diagnostics-wired-artifacts npm_config_offline=true python3 .retest/native-leftovers/inside.py node --conditions=retest-source --test --test-concurrency=1 tests/integration/native-diagnostics-wired.test.ts`

Exit 0. Counts {"tests": 2, "suites": 0, "pass": 2, "fail": 0, "cancelled": 0, "skipped": 0, "todo": 0}. Log `.retest/native-leftovers/logs/after-native-diagnostics-wired.log`. Lock attempts 1.

The corrected wired-diagnostics file is 2/2 passed, zero failed, cancelled or skipped. The real CLI scenarios exercise the desktop, desktop/web and phone diagnostics paths while preserving strict temporary-folder and owned-process cleanup. The added real-kernel fixture keeps cross-temporary-directory exclusion, distinct-client concurrency, stable inode retention and reacquisition after confirmed release. Log `.retest/native-leftovers/logs/after-native-diagnostics-wired.log`; artifacts `.retest/native-leftovers/after-native-diagnostics-wired-artifacts/`.

`/usr/bin/lockf -t 0 /tmp/retest-heavy-gate.lock env -u RETEST_NATIVE_WITHHOLDING RETEST_MACOS_GATE=after-native-evaluation RETEST_FIREFOX_ROUTE=launch-services RETEST_TEST_MEDIA_BINARY=/Users/dragon/Documents/Projects/Gruvi/Products/retest/media/target/release/retest-media RETEST_MEDIA_BINARY=/Users/dragon/Documents/Projects/Gruvi/Products/retest/media/target/release/retest-media RETEST_EVIDENCE_OUT=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/native-leftovers/after-native-evaluation-artifacts RETEST_CAPTURE_PROOF_OUT=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/native-leftovers/after-native-evaluation-artifacts RETEST_NATIVE_DIAGNOSTICS_OUT=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/native-leftovers/after-native-evaluation-artifacts npm_config_offline=true python3 .retest/native-leftovers/inside.py node --conditions=retest-source --test --test-concurrency=1 tests/integration/native-evaluation.test.ts`

Exit 0. Counts {"tests": 3, "suites": 0, "pass": 3, "fail": 0, "cancelled": 0, "skipped": 0, "todo": 0}. Log `.retest/native-leftovers/logs/after-native-evaluation.log`. Lock attempts 1.

The corrected native-evaluation file is 3/3 passed, zero failed, cancelled or skipped. TaskPhone, TaskDesk and paired-app checks exercise actual pixels, a deliberately visible defect, parent failure retention and cleanup. The desktop argument setup passes without adding a retry or changing a required criterion. Log `.retest/native-leftovers/logs/after-native-evaluation.log`; artifacts `.retest/native-leftovers/after-native-evaluation-artifacts/`. The original no-window cause remains inferred as noted above; the unchanged isolated baseline also passed 3/3.

`/usr/bin/lockf -t 0 /tmp/retest-heavy-gate.lock env RETEST_MACOS_GATE=typecheck-final npm_config_offline=true python3 .retest/native-leftovers/inside.py npm run typecheck`

Exit 0. Counts {}. Log `.retest/native-leftovers/logs/typecheck-final.log`. Lock attempts 1.

The keyboard-corrected native-evidence recording-On run now returns the unchanged required outcomes: ready passed, wrong failed with `check_failed`, secret fill passed. Its three original screenshot, video/identity and plain-secret exclusion children all pass. Recording-Off comparison remains pending. On evidence `.retest/native-leftovers/after-evidence-native-keyboard-artifacts/ios-simulator-on/result.json`; current log `.retest/native-leftovers/logs/after-evidence-native-keyboard.log`.

`/usr/bin/lockf -t 0 /tmp/retest-heavy-gate.lock env -u RETEST_NATIVE_WITHHOLDING RETEST_MACOS_GATE=after-evidence-native-keyboard RETEST_FIREFOX_ROUTE=launch-services RETEST_TEST_MEDIA_BINARY=/Users/dragon/Documents/Projects/Gruvi/Products/retest/media/target/release/retest-media RETEST_MEDIA_BINARY=/Users/dragon/Documents/Projects/Gruvi/Products/retest/media/target/release/retest-media RETEST_EVIDENCE_OUT=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/native-leftovers/after-evidence-native-keyboard-artifacts RETEST_CAPTURE_PROOF_OUT=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/native-leftovers/after-evidence-native-keyboard-artifacts RETEST_NATIVE_DIAGNOSTICS_OUT=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/native-leftovers/after-evidence-native-keyboard-artifacts npm_config_offline=true python3 .retest/native-leftovers/inside.py node --conditions=retest-source --test --test-concurrency=1 tests/integration/evidence-native.test.ts`

Exit 0. Counts {"tests": 6, "suites": 0, "pass": 6, "fail": 0, "cancelled": 0, "skipped": 0, "todo": 0}. Log `.retest/native-leftovers/logs/after-evidence-native-keyboard.log`. Lock attempts 1.

The keyboard-corrected native-evidence file is 6/6 passed, zero failed, cancelled or skipped. The unchanged On/Off verdict comparison passes, and recording Off starts no media. All six affected files now have a passing isolated locked rerun. Log `.retest/native-leftovers/logs/after-evidence-native-keyboard.log`; On/Off and secrecy evidence `.retest/native-leftovers/after-evidence-native-keyboard-artifacts/`. The required complete 19-file native-list run is next.

The complete native list acquired the gate and dispatched before a proposed final unit prerequisite was installed. The guard detected its recorded native PID and rejected the helper edit before writing it; the running job is unchanged. No unit workload was started alongside it. A final current-source full unit check will follow native completion. Dispatch source hashes are `.retest/native-leftovers/final-dispatch-code-hashes.json`.

Complete native-list progress: the real iOS and Mac capture parents pass, followed by the cross-platform service and real Chrome checks. No covering-window refusal or failure marker has appeared. Final suite counts remain pending. Current log `.retest/native-leftovers/logs/native-list-final.log`.

## First complete-list run: checked-window reply regression

The first complete native-list run reports four normal-flow failure markers. It remains running and no live source or permanent fixture was changed during it. The flow's primary retained failure is `Error: No fresh native filled-state frame arrived for desk.` Its desktop recording is unavailable because the very first checked window capture ends as `The window-crop capture's target ended: The window-crop capture did not answer within 5000 ms; no further capture is requested.` It has one attempted capture, 5049.5 ms, and zero delivered frames. Both phone and web recordings independently decode; the desktop recording and required pixel witnesses correctly fail. No covering-window refusal appears.

Verdict **b**, another route of the capture-reply regression. The earlier fix reserved response time for `sessionFrameSource`; the production checked-window route is `nativeFrameSource`, whose shared target/image/target-check budget still consumes the full response watchdog. A pure failing-first checked-window fixture reproduces the exact watchdog loss on a confirmed timeout reply, without starting an app or simulator. The prepared correction reserves response time inside this route's original 5000 ms watchdog as well. Prepared diff `.retest/native-leftovers/prepared-window-reply.patch`. It will be applied only after the current complete run finishes, preserving that run's source state and evidence.

Actual flow report `.retest/evidence-targets/artifacts-GdJ9pv/chromium-recorded/result.json`; observations `chromium-observations` beside it. Current full-list log `.retest/native-leftovers/logs/native-list-final.log` is retained, and cannot be described as clean.

`env RETEST_MACOS_GATE=window-deadline-before python3 .retest/native-leftovers/inside.py node --conditions=retest-source --test .retest/native-leftovers/window-capture-deadline-regression.test.ts > .retest/native-leftovers/logs/window-deadline-before.log 2>&1`

Exit 1, 1 test, zero passed, 1 failed, zero cancelled or skipped. It reports the exact production checked-window watchdog loss. The permanent regression fixture is prepared with both recovery and an unanswered-window/late-frame control; it has not been applied during the running complete list.

The first complete native-list run proves the later ready-check refusal is a simulator banner, not an undismissed keyboard. The ready failure image `.retest/evidence-targets/artifacts-Bqi3IL/ios-simulator-on/artifacts/evidence-retest-ts-ready-03oqe5jhheg07-2k1fat589v-phone-0rd604o397f5b-failure.png` shows the keyboard already hidden and the Settings banner **“Ready for Apple Intelligence” / “Time to experience the new personal intelligence system.”** Source scope correctly refuses the SpringBoard tree. The earlier keyboard-only attribution was incomplete. The final status predicate and its 5000 ms budget remain unchanged; an owned-app setup barrier is under investigation.

Additional failing-first pure check: `RETEST_MACOS_GATE=window-startup-before python3 .retest/native-leftovers/inside.py node --conditions=retest-source --test .retest/native-leftovers/window-startup-deadline-regression.test.ts > .retest/native-leftovers/logs/window-startup-before.log 2>&1` exits 1: 1 test, 0 passed, 1 failed, 0 skips. A completed first-window read timeout returns unavailable despite startup budget remaining. The prepared correction retries only completed window-read timeouts within the existing startup budget, retains the failed-read gap/problem/drop, and succeeds only after an actual image. Live source remains unchanged until the complete native-list job finishes.

The complete-list paired evaluation additionally fails with verdict **c**: `1 window(s) of other processes lie over the app's window (layer 23), so a capture would hold their pixels. Retest captures the window only when nothing lies over it.` Its required multi-app pixel verdict remains inconclusive and the original pass assertion correctly fails; the individual phone and desk evaluation cases pass. Evidence `.retest/native-leftovers/native-list-final-artifacts/evaluation-XTad8V/run/evaluation-records.json`; refusal record `.retest/native-leftovers/full-list-covering-window.json`. No covering window was moved or ended. This fresh refusal is layer 23; the earlier reported Wispr refusal was layer 1000. Their identity cannot be equated from the layer alone.

The Mac interaction setup reports a second exact refusal, before any click: `1 window(s) of other processes lie over the app's window (layer 21), so a capture would hold their pixels. Retest captures the window only when nothing lies over it.` Current log `.retest/native-leftovers/logs/native-list-final.log`; text index `.retest/native-leftovers/full-list-refusal-texts.json`. No covering window was moved or ended. The test remains running, so this diagnostic alone is not a verdict.

`/usr/bin/lockf -t 0 /tmp/retest-heavy-gate.lock env -u RETEST_NATIVE_WITHHOLDING -u RETEST_EVIDENCE_OUT RETEST_MACOS_GATE=native-list-final npm_config_offline=true RETEST_CAPTURE_PROOF_OUT=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/native-leftovers/native-list-final-artifacts RETEST_NATIVE_DIAGNOSTICS_OUT=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/native-leftovers/native-list-final-artifacts python3 .retest/native-leftovers/inside.py /bin/zsh -c 'env RETEST_FIREFOX_ROUTE=launch-services RETEST_TEST_MEDIA_BINARY=$PWD/media/target/release/retest-media RETEST_MEDIA_BINARY=$PWD/media/target/release/retest-media node --conditions=retest-source --test --test-concurrency=1 $(cat .retest/clean-run/integration-native.list)'`

Exit 1. Counts {"tests": 100, "suites": 7, "pass": 87, "fail": 13, "cancelled": 0, "skipped": 0, "todo": 0}. Log `.retest/native-leftovers/logs/native-list-final.log`. Lock attempts 2.

The first complete native list is **100 tests, 87 passed, 13 failed, 7 suites, zero cancelled, skipped or todo**. All sixteen dispatch source hashes remain unchanged (`first-full-source-verification.json`). Complete failure details are `.retest/native-leftovers/first-full-failures.json`. Four Mac interaction failures are **c**: the first three explicitly refuse input/lookup because `the app is not in front with nothing over it: 1 window(s) of other processes lie over it (layer 21).`; the typing-cancellation case returns `not_sent` instead of the required `unknown` because it never reaches the dispatched typing scenario. Those assertions remain unchanged.

`python3 .retest/native-leftovers/process-audit.py first-full-complete` exits 0. Audit `.retest/native-leftovers/first-full-complete-process-audit.json` finds zero running owned identities among 8,115 recorded identities, with no signal sent. No window was moved or ended. The full list was not clean; its failures are preserved before applying additional corrections.

`python3 .retest/native-leftovers/apply-additional.py` exits 0 after the first full list completes. Snapshot guards pass. Applied: checked native reply margin; bounded retries only for completed startup window-read timeouts; permanent privacy/unknown/deadline/stop controls; an owned-app keyboard re-read at the final assertion boundary. Required predicates and budgets remain unchanged. Record `.retest/native-leftovers/additional-applied.json`.

`env RETEST_MACOS_GATE=window-deadline-after python3 .retest/native-leftovers/inside.py node --conditions=retest-source --test .retest/native-leftovers/window-capture-deadline-regression.test.ts > .retest/native-leftovers/logs/window-deadline-after.log 2>&1`

Exit 0; counts {"tests": 1, "suites": 0, "pass": 1, "fail": 0, "cancelled": 0, "skipped": 0, "todo": 0}; log `.retest/native-leftovers/logs/window-deadline-after.log`. Pure unit checks; no simulator or desktop started.

`env RETEST_MACOS_GATE=window-startup-after python3 .retest/native-leftovers/inside.py node --conditions=retest-source --test .retest/native-leftovers/window-startup-deadline-regression.test.ts > .retest/native-leftovers/logs/window-startup-after.log 2>&1`

Exit 0; counts {"tests": 1, "suites": 0, "pass": 1, "fail": 0, "cancelled": 0, "skipped": 0, "todo": 0}; log `.retest/native-leftovers/logs/window-startup-after.log`. Pure unit checks; no simulator or desktop started.

`env RETEST_MACOS_GATE=capture-window-controls-after python3 .retest/native-leftovers/inside.py node --conditions=retest-source --test .retest/native-leftovers/capture-window-controls.test.ts > .retest/native-leftovers/logs/capture-window-controls-after.log 2>&1`

Exit 0; counts {"tests": 1, "suites": 0, "pass": 1, "fail": 0, "cancelled": 0, "skipped": 0, "todo": 0}; log `.retest/native-leftovers/logs/capture-window-controls-after.log`. Pure unit checks; no simulator or desktop started.

`env RETEST_MACOS_GATE=capture-window-unit-after python3 .retest/native-leftovers/inside.py node --conditions=retest-source --test tests/unit/native-capture.test.ts tests/unit/screenshot-loop-capture.test.ts tests/unit/media-capture.test.ts tests/unit/capture-withhold.test.ts tests/unit/runner-recording.test.ts tests/unit/native-keyboard-alerts.test.ts > .retest/native-leftovers/logs/capture-window-unit-after.log 2>&1`

Exit 0; counts {"tests": 145, "suites": 20, "pass": 145, "fail": 0, "cancelled": 0, "skipped": 0, "todo": 0}; log `.retest/native-leftovers/logs/capture-window-unit-after.log`. Pure unit checks; no simulator or desktop started.

The final current-source unit suite starts with the first native job fully completed and audited. `env RETEST_MACOS_GATE=unit-suite-final npm_config_offline=true python3 .retest/native-leftovers/inside.py npm run test:unit > .retest/native-leftovers/logs/unit-suite-final.log 2>&1`; pure units need no lock. The metadata/compiler/type preflight is the sole pending locked job; no native rerun is dispatched alongside this unit suite. Source hashes `.retest/native-leftovers/additional-check-source-hashes.json`. Counts will be recorded at completion.

The current-source default-concurrency full unit run is retained as failed: {"command": "env RETEST_MACOS_GATE=unit-suite-final npm_config_offline=true python3 .retest/native-leftovers/inside.py npm run test:unit > .retest/native-leftovers/logs/unit-suite-final.log 2>&1", "exit": 1, "counts": {"tests": 4255, "suites": 648, "pass": 4251, "fail": 4, "cancelled": 0, "skipped": 0, "todo": 0}, "log": ".retest/native-leftovers/logs/unit-suite-final.log"} . Four failures: macOS focus-made-secure fill returns before the entry hook after its 4000 ms allocation; simulator-leftover close spends its 1000 ms allocation before fake simctl/ps can supply the required ownership refusal; two runner lifecycle elapsed-time assertions exceed their original bounds. The earlier full unit run passed 4255/4255. No assertion, fake setup or time budget is changed. A full unchanged-source one-file-worker run will distinguish scheduling contention from a reproducible regression. Its result is pending.

`/usr/bin/lockf -t 0 /tmp/retest-heavy-gate.lock env RETEST_MACOS_GATE=window-inventory npm_config_offline=true python3 .retest/native-leftovers/inside.py xcrun swift .retest/native-leftovers/window-inventory.swift`

Exit 0. Counts {}. Log `.retest/native-leftovers/logs/window-inventory.log`. Lock attempts 12.

`/usr/bin/lockf -t 0 /tmp/retest-heavy-gate.lock env RETEST_MACOS_GATE=typecheck-window npm_config_offline=true python3 .retest/native-leftovers/inside.py npm run typecheck`

Exit 0. Counts {}. Log `.retest/native-leftovers/logs/typecheck-window.log`. Lock attempts 1.

`/usr/bin/lockf -t 0 /tmp/retest-heavy-gate.lock env RETEST_MACOS_GATE=types-window npm_config_offline=true python3 .retest/native-leftovers/inside.py npm run test:types`

Exit 0. Counts {}. Log `.retest/native-leftovers/logs/types-window.log`. Lock attempts 1.

The additional locked preflight exits 0 for metadata, typecheck and type tests. Metadata reads only layer/PID/bounds, with no names, titles, pixels or window operation (`.retest/native-leftovers/logs/window-inventory.log`). Typecheck log `.retest/native-leftovers/logs/typecheck-window.log`; both type-test compilers again match 246 expected errors to 246 markers in 11 projects (`types-window.log`). The unchanged serialized suite now passes the previously failing macOS secure-focus case and simulator-leftover ownership refusal; runner lifecycle outcomes and final counts remain pending.

The final current-source one-file-worker unit suite exits 0: **4255/4255 tests passed, 648 suites, zero failed, cancelled, skipped or todo**. Exact command: `env RETEST_MACOS_GATE=unit-suite-clean npm_config_offline=true python3 .retest/native-leftovers/inside.py node --conditions=retest-source --test --test-concurrency=1 'tests/unit/**/*.test.ts' > .retest/native-leftovers/logs/unit-suite-clean.log 2>&1`. Log `.retest/native-leftovers/logs/unit-suite-clean.log`; record `unit-suite-clean-result.json`. All seventeen scoped dispatch hashes remain unchanged. All four failed default-concurrency cases pass without a source, assertion, fixture or time-budget change by this lane. Scheduling contention is the supported inference; no failing run is erased. The unit log retains an existing MaxListenersExceededWarning from the fake desktop fixture; no warning suppression or listener-limit change was added.
