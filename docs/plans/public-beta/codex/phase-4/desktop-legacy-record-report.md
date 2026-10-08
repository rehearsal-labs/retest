# Desktop legacy-record recovery

Implemented recovery for absent recorded PIDs across the desktop, native-folder, Firefox, WebKit, media and install readers. A start mismatch does not free a record. Present legacy PIDs remain refused with the exact record file and safe removal condition. This Mac's legacy desktop record, holder PID 31017, was copied for evidence and then replaced by Retest during the first real desk API run; it was never removed or edited by hand.

Read the repository instructions, README, architecture, common rules, release invariants and Phase 2 decisions, timezone switch report, previous macOS proofs report, native proof record and native lifecycle lock description. Applied the unslop writing skill. Existing work is preserved, including the unit-test and HTML/install workers' changes. No benchmark or download ran. Every desktop or simulator check and every heavy gate used `/usr/bin/lockf -t 0 /tmp/retest-heavy-gate.lock`, with a benchmark guard inside the lock.

Evidence root is `.retest/macos-proofs-2/`. Original source copies are in `source-before/src/`; replay copies with redirected imports are in `before/src/`; initial workspace state is in `initial-status.txt`; `desktop-record-before.json` preserves the legacy desktop record. This report records failing-first reader checks, source causes, exact commands, counts, logs, artifacts and cleanup. All eight requested macOS gates executed once.

The intended rule is presence before start comparison. A successfully read whole process table with no recorded PID establishes absence for legacy and current records. A present legacy PID is unconfirmed and receives the exact record path and safe manual-removal condition. A start mismatch alone must not free a record or authorize a signal. Fresh pre-signal identity and reuse guards remain required.

## Failing-first reader checks

Exact command, output to `.retest/macos-proofs-2/logs/readers-before.log`:

```sh
/usr/bin/lockf -t 0 /tmp/retest-heavy-gate.lock env RETEST_MACOS_GATE=readers-before python3 .retest/macos-proofs-2/inside.py node --conditions=retest-source --test --test-concurrency=1 tests/unit/desktop-legacy-record.test.ts
```

Exit 1, 17 tests, 3 passed, 14 failed, zero cancelled or skipped. The new cases use their own recorded sleep processes, end them through verified PID/start/command identities, and read real whole tables. Absent legacy desktop, Firefox, WebKit, native folder, media and local install records fail to recover. Live-record refusals fail to name the exact file and safe removal condition. A current desktop record with a present holder and mismatched start is incorrectly replaced. The existing present legacy runner and present legacy media cases pass before the change. No runner or application was launched, and this Mac's desktop record is unchanged.

Source causes before the change: `src/native/desktop-lock.ts:181`, `src/browser/firefox/orphans.ts:104`, `src/browser/webkit/sweep.ts:70`, `src/native/temporary-folders.ts:64`, and `src/runner/media-leftovers.ts:65` guard the marker before presence. `src/cli/install/lock.ts:140` refuses its unreadable legacy generation without a presence reading. Desktop holder start comparison at `src/native/desktop-lock.ts:304` calls a mismatch gone.

The first after-change reader command, with `RETEST_MACOS_GATE=readers-after` and the same test argv, exits 0: 17/17, zero failed, cancelled or skipped, `logs/readers-after.log`. A separate failing-first replay of five current-record mismatch cases against the saved old readers exits 1, 0/5, zero cancelled or skipped, `logs/mismatch-before.log`. Only their imports are redirected to absolute local source paths; live source was never replaced.

Exact replay command:

```sh
/usr/bin/lockf -t 0 /tmp/retest-heavy-gate.lock env RETEST_MACOS_GATE=mismatch-before python3 .retest/macos-proofs-2/inside.py node --conditions=retest-source --test --test-concurrency=1 --test-name-pattern='current .* record with a present PID' .retest/macos-proofs-2/before/record-readers.test.ts
```

One earlier submission found the lock busy, exit 75, and started nothing. The successful submission is the only executed replay. All five old readers free a present mismatched PID's record or call it gone. Their new cases require the record to stay and dispatch no fixture signal.

The first typecheck ran through the lock and benchmark guard, exit 0 for TypeScript 6, TypeScript 7 and the example project, `logs/typecheck.log`. It preceded the last mismatch cases and media refusal wording; the final checks below cover those changes.

## Readers changed

- `src/shared/process-ownership.ts` exposes the existing validated whole-table reader, synchronously and asynchronously. The asynchronous table read keeps a handle alive until its answer. Parsing, table bounds, per-signal identity checks and `sameProcessIdentity` are unchanged.
- `src/native/desktop-lock.ts` reads a whole table after taking the kernel lock. A legacy or unknown-zone record is replaced only when the holder and all recorded runner PIDs are absent and its recorded xcodebuild group is absent. A present legacy PID refuses with the exact JSON file and "Remove <file> once no runner is running." A current holder with a mismatched start is refused, and current runner recovery retains different identities and confirms final whole-table absence. Clean current records still permit repeated sessions by the same live holder after confirmed cleanup.
- `src/native/temporary-folders.ts` deletes a recorded folder only when its maker PID is absent from the whole table. Legacy and current start mismatches do not delete it. A live legacy owner names `retest-owner.json` and the safe removal condition.
- `src/browser/firefox/orphans.ts` frees a legacy launch record only when both launcher and Firefox PIDs are absent and no process uses its profile. A live legacy record names its JSON file. A present current launcher with a different start keeps the record and sends no signal.
- `src/browser/webkit/sweep.ts` uses a whole table on the host. Legacy launcher and recorded process PIDs must all be absent, with no process using the home, before it is removed. Present legacy records name their JSON file; current launcher or recorded-process mismatches retain the home without signals.
- `src/runner/media-leftovers.ts` reads a whole table before the zone marker. An absent legacy owner is gone; a present unknown-zone or mismatched owner stays unconfirmed. `src/runner/run-media.ts` names the events file carrying an unconfirmed owner and when it is safe to remove it.
- `src/cli/install/lock.ts` can read a version 1 local-time generation envelope without comparing that clock. A tagged legacy record requires this exact machine/boot namespace; a pre-tag local generation retains its local-cache interpretation. Both require an absent PID in a whole table. Explicitly foreign, malformed and unreadable generations remain refused. A current mismatch no longer grants a new generation. A live legacy refusal names the numbered generation file and says removal is safe once no install of that build runs. Version 2 and its explicit clock remain the current format.

Intermediate focused reader and reuse command, output to `logs/readers-final.log`:

```sh
/usr/bin/lockf -t 0 /tmp/retest-heavy-gate.lock env RETEST_MACOS_GATE=readers-final python3 .retest/macos-proofs-2/inside.py node --conditions=retest-source --test --test-concurrency=1 tests/unit/desktop-legacy-record.test.ts tests/unit/process-ownership.test.ts
```

Exit 0, 52/52 tests, zero failed, cancelled or skipped. All 22 new reader cases pass. The 30 existing ownership tests pass unchanged, including immediate identity reads, unreadable tables, asynchronous budgets and reuse after a table reading. No signal-reuse assertion was altered. No real native runner was started by these unit checks.

## macOS check 1, desk public API and product recovery

Exact command, output to `logs/native-api-desk.log`:

```sh
/usr/bin/lockf -t 0 /tmp/retest-heavy-gate.lock env RETEST_MACOS_GATE=native-api-desk python3 .retest/macos-proofs-2/inside.py node --conditions=retest-source --test --test-concurrency=1 tests/integration/native-api-desk.test.ts
```

Exit 1, 2 tests, 1 passed, 1 failed, zero cancelled or skipped. Retest recovered the real stale desktop record through the product startup path. `native-api-desk-desktop-record.json` retains the new `startTimeVersion: 1` record with holder PID 97982 and the launched xcodebuild/runner identities. The source's absence branch was exercised; the old record was never edited or removed by hand. Both native application tests reached their required task-state outcomes, and the desk/web lease test passed.

The API screenshot requirement at `tests/integration/native-api-desk.test.ts:62` failed. Its exact diagnostic is:

> Retest withheld this capture of desk by policy: the secret "password" was typed into a field Retest could not read, and the field had not been seen to stop showing it.

This is not a covering-window failure. The missing native masked-field observation has its cause at `src/runner/run-session.ts:1481`, outside the authorized repair files, as detailed below. The screenshot requirement remains unchanged. Retained artifacts are `/Users/dragon/Library/Caches/retest-proofs/artifacts/wiring-desk/run-pvmcrp/` and `/Users/dragon/Library/Caches/retest-proofs/artifacts/wiring-desk-web/run-Q6bP16/`, with `events.jsonl` and `result.json`. The checks confirmed TaskDesk ended; the locked supervisor records descendant and desktop runner identities in `observed-processes.jsonl` without issuing signals.

## macOS check 2, capture source

Exact command, output to `logs/capture-macos.log`:

```sh
/usr/bin/lockf -t 0 /tmp/retest-heavy-gate.lock env RETEST_MACOS_GATE=capture-macos RETEST_CAPTURE_PROOF_OUT=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/macos-proofs-2/capture-macos python3 .retest/macos-proofs-2/inside.py node --conditions=retest-source --test --test-concurrency=1 tests/integration/capture-macos.test.ts
```

Exit 1, 1 test, 0 passed, 1 failed, zero cancelled or skipped. The owned 1400x960 window passed coverage, and the frame source started in `screenshot-loop` mode. Four measured frames were delivered while input ran. The media recording delivered/sent/received/shown 3/3/3/3, with zero drops, gaps, withheld frames, identity refusals or resizes. H.264 decoded to 49 frames. Runtime and app cleanup completed.

The unchanged strict check at `tests/integration/capture-macos.test.ts:158` failed with:

> video frame 0 is closer to frame 1 (0) than to any other frame that differs (0)

This is a native sequence whose distinguishable raw pixels do not distinguish its encoded comparisons. `tests/integration/capture-proof.ts:267` treats any raw-pixel difference as a different source frame, while its score at `:265` and `:269` counts only brightness differences above 48. The retained frame-map margins show 48 tied comparisons and one strict match. The run had one recorded fill across three source frames. No threshold or strict assertion was changed. Exact raw-source differences cannot be reconstructed because this test retains its movie and margins, but not the input PNGs. The test now retains raw PNGs on subsequent executions without changing its passing requirements; this new diagnostic path was not exercised by the already-completed gate.

Artifacts are `.retest/macos-proofs-2/capture-macos/macos-window-crop.mp4`, `macos-window-crop-report.json`, `decoder-processes.jsonl`, and `macos-runtime-logs/macos-runner-99524-54010.log`. This proves actual macOS pixels, input during capture, complete video finalization and decode. It does not prove strict input-image-to-video matching or a native paint clock.

The desk API privacy cause is confirmed at `src/runner/run-session.ts:1481`: the runner always supplies `kind: 'unread'` for a secret entry. The native `SecureTextField` observation never reaches this policy. That caller is outside the authorized repair files. Adding a native field fact alone cannot change that caller, and changing a test to avoid its required secret input or later screenshot would weaken its outcome. The refusal is retained; no policy was relaxed.

The capture test now saves all input PNGs and their identities/timestamps through an after hook when `RETEST_CAPTURE_PROOF_OUT` is set, including strict-comparison failures. This adds diagnostic evidence and changes no comparison or assertion. The requested capture gate was already executed once; that failed result is retained, and the new raw-retention path is not claimed exercised.

## macOS check 3, evidence target

Exact command, output to `logs/evidence-macos.log`:

```sh
/usr/bin/lockf -t 0 /tmp/retest-heavy-gate.lock env RETEST_MACOS_GATE=evidence-macos RETEST_EVIDENCE_NATIVE=macos RETEST_TEST_MEDIA_BINARY=/Users/dragon/Documents/Projects/Gruvi/Products/retest/media/target/release/retest-media RETEST_EVIDENCE_OUT=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/macos-proofs-2/evidence-macos python3 .retest/macos-proofs-2/inside.py node --conditions=retest-source --test --test-concurrency=1 tests/integration/evidence-native.test.ts
```

Exit 0, 5/5 tests including the parent, zero failed, cancelled or skipped. The normal pass and intended assertion failure have independently decoded screenshots. Recording identity, screenshots and every video independently decode. The unmasked secret stretch has no forwarded frame or image artifact. Recording off starts no media and preserves all three application verdicts. On and off each produce `passed`, `failed/check_failed`, `passed`, CLI 1, as required. The TaskDesk and simulator-inventory cleanup assertions pass.

Retained roots are `.retest/macos-proofs-2/evidence-macos/macos-on/`, `macos-off/`, and `macos-observations/`. They hold events, result, HTML and terminal reconstructions, approved image/frame observations and CLI outcomes; `decoder-processes.jsonl` records the decoder launches. No covering-window failure occurred. This is successful real macOS evidence, distinct from the API's masked-password-policy limitation and the capture gate's strict source-frame ties.

The macOS evidence movies have 93 normal, 161 intended-failure and 69 pre-secret output frames, all independently decoded. The input frames delivered/sent/received/shown are 6/6/6/6, 10/10/10/10 and 2/2/2/2, with zero media drops. Exact retained movie references within `evidence-macos/macos-on/` are `artifacts/2xq89hnrq3/desk-2iu00qlonnyfs/recording-1.mp4`, `artifacts/z98grovdv1/desk-2iu00qlonnyfs/recording-1.mp4` and `artifacts/9c2necs60d/desk-2iu00qlonnyfs/recording-1.mp4`.

Normal evaluation PNG is `artifacts/evidence-retest-ts-ready-03oqe5jhheg07-2xq89hnrq3-3axmo8eisj70n-desk-2iu00qlonnyfs-evaluation-1-1uf881zup08n9.png`. Intended-failure PNG is `artifacts/evidence-retest-ts-wrong-2cgyan838d2xx-z98grovdv1-desk-2iu00qlonnyfs-failure.png`. These paths are relative to `evidence-macos/macos-on/`; approved observation records and independent decoder checks link them to their exact attempts.

One Chromium flow submission acquired no heavy lock, exit 75, `logs/flow-chromium-lock-busy-1.log` and `.exit`. It started no test, app or simulator. The later submission acquired the lock and is the single executed Chromium flow gate.

## macOS check 4, recorded Chromium flows

Exact executed command, output to `logs/flow-chromium.log`:

```sh
/usr/bin/lockf -t 0 /tmp/retest-heavy-gate.lock env RETEST_MACOS_GATE=flow-chromium RETEST_TEST_ENGINE=chromium RETEST_TEST_MEDIA_BINARY=/Users/dragon/Documents/Projects/Gruvi/Products/retest/media/target/release/retest-media RETEST_EVIDENCE_OUT=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/macos-proofs-2/flow-chromium python3 .retest/macos-proofs-2/inside.py node --conditions=retest-source --test --test-concurrency=1 tests/integration/evidence-flows.test.ts
```

Exit 1, 10 tests including nested children and parents, 6 passed, 4 failed, zero cancelled or skipped. Both scenarios ran once. Normal application result is `passed`, CLI 0. Broken-sync is `failed/check_failed`, CLI 1, at the intended final desk task-state check. Both preserve every text/state assertion, exact task identity, service-network checks, complete lease before launches, event reconstruction and no expired lease. Simulator deletion and disappearance of owned simulator processes, TaskDesk, runner, xcodebuild and Chrome passed for both scenarios.

All six phone/web/desk movie children passed independent decode and identity verification. Output frames are phone/web/desk 358/370/340 normal and 512/524/499 broken-sync. Each desk movie contains three forwarded source frames from before secret entry and is partial. The normal and broken evidence parents both fail at `tests/integration/evidence-flows.test.ts:224`, with exact text:

> the final desk state must have pixel evidence; withholding cannot establish it

The source cause is the same unimplemented field reporting at `src/runner/run-session.ts:1481`. Its unread fact leaves the desk password stretch open over the final assertion. This is outside authorized repair scope; no final-state check, secret input or privacy condition was weakened. No covering window was reported.

Saved roots are `.retest/macos-proofs-2/flow-chromium/chromium-recorded/`, `chromium-broken-sync-recorded/` and the matching approved-observation folders. Cache copies with service-network records are `/Users/dragon/Library/Caches/retest-proofs/artifacts/evidence-flow-engines/chromium/run-23gnAT/` and `chromium-broken-sync/run-Uf16TO/`. The desk movie references within the saved roots are `artifacts/lft7i5vhab/desk-2iu00qlonnyfs/recording-1.mp4` and `artifacts/ri3aej0wkx/desk-2iu00qlonnyfs/recording-1.mp4`. Final correct/stale desktop pixels remain unverified.

## macOS check 5, recorded Firefox flows

Exact command, output to `logs/flow-firefox.log`:

```sh
/usr/bin/lockf -t 0 /tmp/retest-heavy-gate.lock env RETEST_MACOS_GATE=flow-firefox RETEST_TEST_ENGINE=firefox RETEST_FIREFOX_ROUTE=launch-services RETEST_TEST_MEDIA_BINARY=/Users/dragon/Documents/Projects/Gruvi/Products/retest/media/target/release/retest-media RETEST_EVIDENCE_OUT=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/macos-proofs-2/flow-firefox python3 .retest/macos-proofs-2/inside.py node --conditions=retest-source --test --test-concurrency=1 tests/integration/evidence-flows.test.ts
```

Exit 1, 10 tests, 6 passed, 4 failed, zero cancelled or skipped. Each scenario ran once. Firefox 133.0.3, build 20241209150345, used the recorded `launch-services` route. Both application outcomes are intended: normal passed, CLI 0; broken-sync failed at the required desk state assertion with `check_failed`, CLI 1. Original task identity, input, state, service, lease and event-reconstruction checks ran. All six phone/web/desk decode and identity children passed. Output frames are 361/371/346 normal and 515/525/500 broken-sync. Desk movies are partial and contain three pre-secret source frames each.

Both evidence parents reject the final withheld desk state at `tests/integration/evidence-flows.test.ts:224`, exactly "the final desk state must have pixel evidence; withholding cannot establish it". Source cause remains `src/runner/run-session.ts:1481`, outside permitted repair scope. No covering-window refusal occurred. No assertion, input or policy changed. Simulator, owned simulator processes, TaskDesk, runner, xcodebuild and Firefox disappearance checks all passed; no cleanup failure or lease expiry was recorded.

Saved roots are `.retest/macos-proofs-2/flow-firefox/firefox-recorded/`, `firefox-broken-sync-recorded/` and matching approved-observation folders. Cache/network copies are `/Users/dragon/Library/Caches/retest-proofs/artifacts/evidence-flow-engines/firefox/run-2KXdbj/` and `firefox-broken-sync/run-LNsIcV/`. Desk movie references within the saved roots are `artifacts/opyu5igkc1/desk-2iu00qlonnyfs/recording-1.mp4` and `artifacts/jh99zq45xe/desk-2iu00qlonnyfs/recording-1.mp4`. Correct/stale final desk pixels remain unverified.

## macOS check 6, recorded WebKit flows

Exact command, output to `logs/flow-webkit.log`:

```sh
/usr/bin/lockf -t 0 /tmp/retest-heavy-gate.lock env RETEST_MACOS_GATE=flow-webkit RETEST_TEST_ENGINE=webkit RETEST_FIREFOX_ROUTE=launch-services RETEST_TEST_MEDIA_BINARY=/Users/dragon/Documents/Projects/Gruvi/Products/retest/media/target/release/retest-media RETEST_EVIDENCE_OUT=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/macos-proofs-2/flow-webkit python3 .retest/macos-proofs-2/inside.py node --conditions=retest-source --test --test-concurrency=1 tests/integration/evidence-flows.test.ts
```

Exit 1, 10 tests, 6 passed, 4 failed, zero cancelled or skipped. Each scenario ran once on WebKit 626.1.6+, build 2359. Both intended application outcomes and all six phone/web/desk movie decode/identity children pass. Both evidence parents fail at `tests/integration/evidence-flows.test.ts:224`, exactly "the final desk state must have pixel evidence; withholding cannot establish it". The source cause remains `src/runner/run-session.ts:1481`, outside permitted repair scope. No covering-window refusal was reported, and no requirement or policy was altered. All simulator, native process and WebKit disappearance checks passed, with no cleanup failure or expired lease.

Saved roots are `.retest/macos-proofs-2/flow-webkit/webkit-recorded/`, `webkit-broken-sync-recorded/`, and the matching approved-observation folders. The retained frame counts, movie references and cache/network copies follow. Final correct/stale desk pixels remain unverified despite the decoded pre-secret desk movies.

WebKit output frames are phone/web/desk 434/444/422 normal and 599/610/586 broken-sync. Desk movie references within the saved roots are `artifacts/qs0ioei1d8/desk-2iu00qlonnyfs/recording-1.mp4` and `artifacts/luufhabaqa/desk-2iu00qlonnyfs/recording-1.mp4`. Cache/network copies are `/Users/dragon/Library/Caches/retest-proofs/artifacts/evidence-flow-engines/webkit/run-2b8Wtu/` and `webkit-broken-sync/run-7xId0A/`. Each desk movie has three forwarded pre-secret images, and all six native/browser movies remain partial with explicit withholding.

## macOS check 7, lifecycle proof

Exact command, output to `logs/proof-lifecycle-macos.log`:

```sh
/usr/bin/lockf -t 0 /tmp/retest-heavy-gate.lock env RETEST_MACOS_GATE=proof-lifecycle-macos python3 .retest/macos-proofs-2/inside.py node --conditions=retest-source proofs/native/lifecycle.ts --only macos
```

Exit 0, 10/10 proof steps, executed once. The local pinned/adopted runner was reused. Real host reports macOS 27.0.1, build 26A434. TaskDesk launched, activated, read foreground, and its selected window was captured as `window-crop` at 1640x1120 with 1,969 colours. The scoped tree has 14 elements. Terminate and dispose succeed; runner close reports zero runner or TaskDesk processes left. No covering-window refusal or permission prompt occurred.

Artifacts are `/Users/dragon/Library/Caches/retest-proofs/artifacts/lifecycle/2026-10-06T12-17-05Z/proof-desk-launch1-o2-window-crop.png`, `taskdesk-window.xml` and `report.json` in that folder. The window-server coverage check ran unchanged and accepted the full owned window.

## macOS check 8, interaction proof

Exact command, output to `logs/proof-interaction-macos.log`:

```sh
/usr/bin/lockf -t 0 /tmp/retest-heavy-gate.lock env RETEST_MACOS_GATE=proof-interaction-macos python3 .retest/macos-proofs-2/inside.py node --conditions=retest-source proofs/native/interaction.ts --only macos
```

Exit 0, 10/10 proof steps, executed once. TaskDesk's window at 20,60,700,480 passes unchanged coverage before input and after task lookup, producing 1400x960 PNGs with 1,867 and 1,872 colours. Account and secure-field fills, sign-in click, task-ID fill and Enter each send input once. The task reads `seed-ada-1`, Open. The deliberate wrong-state check fails naming the element and is preserved as the required proof outcome. Session disposal and runner close report zero runner or TaskDesk processes left. No covering-window refusal or permission prompt occurred.

Artifacts are `/Users/dragon/Library/Caches/retest-proofs/artifacts/interaction/2026-10-06T12-19-03Z/proof-desk-launch1-o2-before-clicks-window-crop.png`, `proof-desk-launch1-o23-found-window-crop.png` and `report.json` in that folder. This direct native proof does not establish the runner's secret-entry policy reporting; that separate API/flow limitation stays failed.

All eight requested test/proof commands executed once. The only busy submission was the recorded Chromium lock refusal. No requested gate is queued for a rerun. Final reader tests, typechecks and read-only cleanup verification completed below; no benchmark ran.


## Final verification and cleanup

Exact final commands:

```sh
/usr/bin/lockf -t 0 /tmp/retest-heavy-gate.lock env RETEST_MACOS_GATE=readers-verified python3 .retest/macos-proofs-2/inside.py node --conditions=retest-source --test --test-concurrency=1 tests/unit/desktop-legacy-record.test.ts tests/unit/process-ownership.test.ts
/usr/bin/lockf -t 0 /tmp/retest-heavy-gate.lock env RETEST_MACOS_GATE=typecheck-final python3 .retest/macos-proofs-2/inside.py npm run typecheck
/usr/bin/lockf -t 0 /tmp/retest-heavy-gate.lock env RETEST_MACOS_GATE=typecheck-proofs-final python3 .retest/macos-proofs-2/inside.py npm run typecheck:proofs
/usr/bin/lockf -t 0 /tmp/retest-heavy-gate.lock env RETEST_MACOS_GATE=native-audit python3 .retest/macos-proofs-2/inside.py node --conditions=retest-source .retest/macos-proofs-2/native-audit.ts
python3 .retest/macos-proofs-2/process-audit.py
```

| Check | Result | Log under `.retest/macos-proofs-2/logs/` |
| --- | --- | --- |
| Final reader and unchanged reuse tests | Exit 0, 56/56, zero failed, cancelled or skipped: 26 reader/refusal cases and 30 existing ownership cases. Includes pre-machine-tag install generations, foreign namespace refusal and the media consumer's exact events-file refusal. | `readers-verified.log` |
| Main typecheck | Exit 0, TypeScript 6.0.3, TypeScript 7.0.2 and the example project. | `typecheck-final.log` |
| Proof typechecks | Exit 0, both TypeScript versions for Firefox, WebKit, native and media proof projects. | `typecheck-proofs-final.log` |
| Native inventory audit | Exit 0, all six recorded flow simulators deleted, no device-owned processes, no TaskDesk or native runner. | `native-audit.log` |
| Whole-table process audit | Exit 0, all 1,391 recorded readings absent, 1,356 unique recorded PIDs, no present/unconfirmed PID, all 25 recorded xcodebuild groups empty. | `process-audit.log` |

The process audit uses one fresh, nonempty, fully parsed C-locale UTC0 whole table. It includes gate roots and observed descendants, browser/media started events, media owners, and independent ffmpeg/ffprobe decoder records. A present PID would remain unconfirmed even with a different start; the audit does not count a mismatch as absence. It sends no signal. `process-audit.json` and `native-audit.json` retain the facts. `desktop-record-after.json` records the current marker, absent holder PID 38447, empty runner and untied arrays, and no xcodebuild. The global desktop record was read, not manually changed. No app, runner, owned simulator, browser, media or decoder process from this task remains.

Every entered gate's benchmark guard returned no PID, `benchmark-checks.jsonl`. Gate roots and descendants were recorded before final absence checks; `processes.jsonl` and `observed-processes.jsonl` retain the identities. The observer produced no error log. No foreign app or process was moved, closed or signaled. Unit fixtures verified their own PID/start/command before ending their recorded sleep processes; native, browser and media teardown remained in the product cleanup paths. No covering-window refusal occurred in these eight checks, and no coverage condition was bypassed. No permission prompt, commit, stash, reset, revert, download, benchmark or remote publication occurred.

## Remaining unverified

- Desk API's required post-password screenshot and the six flows' final correct/stale desktop pixels. The runner's unconditional unread field fact at `src/runner/run-session.ts:1481` is outside permitted repair scope. Direct native interaction and decoded pre-secret desk movies do not establish those withheld pixels.
- Strict macOS input-image-to-video matching and a native paint clock. The unchanged strict comparison rejects 48 ties. Exact raw pixel differences from that execution cannot be reconstructed. The raw-PNG after hook is added and typechecked, but was not exercised in another real capture run because each requested gate was to run once.
- The complete unit tree and whole integration suite were not run by this worker. The unit worker owns that concurrent work. No compiled-package/release check, physical iOS device or another host platform was exercised. Passing source gates do not establish those capabilities.

`proofs/evidence.md` and `capture-sources-report.md` now distinguish the current successful macOS evidence and direct proofs from the retained API, flow-final-pixel and strict-frame failures. Assertions, inputs, privacy rules and coverage checks remain intact. Final source hashes are in `.retest/macos-proofs-2/source-hashes-final.json`. `python3 .retest/macos-proofs-2/verify-results.py` exited 0 and wrote `final-verification.json`: 16 log/count/exit checks, ten complete retained CLI results, 22 nonempty retained movies, both 10-step proof reports and their artifact files, all eight requested gates executed once, empty benchmark guards, no observer error and no trailing whitespace in this task's files. The targeted `git diff --check` also exited 0. These checks confirm the recorded pass/fail evidence; they do not promote a failed gate to passing.
