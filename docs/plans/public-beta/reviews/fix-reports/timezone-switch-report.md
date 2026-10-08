# Process start timezone switch

The switch is implemented. Every production calendar-string process-start reader uses C locale and `TZ=UTC0`; Linux install identity retains its kernel boot-tick clock. New stored string records carry `startTimeVersion: 1`. Legacy or unknown-zone records are unconfirmed and retained without signals or cleanup. The existing install version 2 and explicit clock remain valid.

All requested real close paths, typecheck and type tests pass. The final whole-tree unit gate has 4,081 passes and 10 failures in untouched checks, listed by file and line below. All 38 added Node timezone cases pass in that gate. The cleanup audit finds no live recorded processes, surviving recorded groups or remaining owned folders. Existing workspace changes are preserved. No benchmark, download, commit, stash, reset or revert was run.

## Reading and scope

Read the repository instructions, README, architecture, common rules, release invariants and Phase 2 decisions, the install report finding 1 after review, ownership cost report, and Phase 3 closeout report. The ownership layer already takes one table snapshot and reads each live identity immediately before its signal. Those rules and the reuse test are retained.

Initial inventory command: `rg -n 'lstart|TZ=' src media`. Additional stored-start users include native desktop records, native temporary-folder owners, WebKit homes and media run events. The install reader already uses UTC seconds on macOS and boot ticks from `/proc` on Linux. Its version 2 generation and `start.clock` already identify the clock. Earlier local-time generations are refused.

The new stored-string marker is `startTimeVersion: 1`. Version 1 means a C-locale start read under `TZ=UTC0`. Missing markers mean the recorded zone cannot be confirmed. Such records are retained without comparison, signals or folder removal. The install generation keeps its existing version 2 and explicit clock.

Evidence root: `/tmp/retest-timezone-switch/`. Pre-change source snapshots: `.retest/scratch-timezone-switch/before/`. Initial workspace status: `initial-status.txt`. `commands.jsonl` records exact argv and command PIDs; `results.jsonl` records exits. Exact completed commands, outcomes and line references follow.

Completed `lockf -t 0 /tmp/retest-heavy-gate.lock cargo test --offline --locked --manifest-path media/Cargo.toml --target-dir .retest/scratch-timezone-switch/media-target process_start_is_utc_even_for_a_child_started_in_another_zone -- --test-threads=1`, exit 101. Log: `/tmp/retest-timezone-switch/logs/rust-before.log`.

Completed `env RETEST_TIMEZONE_WORKER=file:///Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/scratch-timezone-switch/worker-before.ts node --conditions=retest-source --test tests/unit/process-zone-worker.test.ts`, exit 1. Log: `/tmp/retest-timezone-switch/logs/worker-before.log`.

## Failing-first evidence

`node --conditions=retest-source --test --test-concurrency=1 tests/unit/process-zone.test.ts`, exit 1: 26 tests, 1 pass, 25 failures, zero cancelled or skipped. `logs/readers-before.log` shows the host system-zone value differs from the explicit UTC reference for every newly switched reader. The install UTC reader passes before the change.

`node --conditions=retest-source --test --test-concurrency=1 tests/unit/process-zone-records.test.ts`, exit 1: 6 tests, 1 pass, 5 failures, zero cancelled or skipped. `logs/records-before.log` records an attempted Firefox signal against the live pre-change owner, a removed WebKit home, a removed native folder, an overwritten desktop record, and a media owner called gone. The pre-change install generation already passes because its old format is unreadable. No real signal is dispatched by the Firefox test system, and each test reaps its own live fixture.

The Rust regression fails before the environment change: 0 passed, 1 failed, 97 filtered. The snapshot returns local 15:05:00 and the UTC reference 11:05:00 for the same recorded process. `logs/rust-before.log`. The raw metadata-worker test uses a saved pre-change worker with imports resolved to the live constants; it fails before any source is restored or replaced. `logs/worker-before.log`.

The production readers now request UTC0 explicitly, and the metadata host and worker enforce it independently. Persisted string records accept the missing marker only so their readers can report uncertainty and retain them. Unknown numeric marker versions receive the same refusal. Native desktop recovery no longer parses an unzoned `lstart` with `Date.parse`. Current-format test fixtures now carry the marker and UTC reference readings; their existing signal, folder and identity assertions remain.

Completed `node --conditions=retest-source --test --test-concurrency=1 tests/unit/process-zone.test.ts tests/unit/process-zone-worker.test.ts tests/unit/process-zone-records.test.ts tests/unit/native-process-zone.test.ts`, exit 0. Log: `/tmp/retest-timezone-switch/logs/timezone-after.log`.

Completed `node --conditions=retest-source --test tests/unit/media-leftovers-zone.test.ts`, exit 1. Log: `/tmp/retest-timezone-switch/logs/media-note-before.log`.

Completed `lockf -t 0 /tmp/retest-heavy-gate.lock cargo test --offline --locked --manifest-path media/Cargo.toml --target-dir .retest/scratch-timezone-switch/media-target process_ownership::tests -- --test-threads=1`, exit 0. Log: `/tmp/retest-timezone-switch/logs/rust-after.log`.

Completed `node --conditions=retest-source --test .retest/scratch-timezone-switch/lifecycle-before.test.ts`, exit 1. Log: `/tmp/retest-timezone-switch/logs/lifecycle-before.log`.

Completed `lockf -t 0 /tmp/retest-heavy-gate.lock npm run typecheck`, exit 2. Log: `/tmp/retest-timezone-switch/logs/typecheck.log`.

Completed `node --conditions=retest-source --test tests/unit/process-zone-lifecycle.test.ts`, exit 0. Log: `/tmp/retest-timezone-switch/logs/lifecycle-after.log`.

Completed `lockf -t 0 /tmp/retest-heavy-gate.lock npm run typecheck`, exit 0. Log: `/tmp/retest-timezone-switch/logs/typecheck-final.log`.

Completed `node --conditions=retest-source --test '--test-name-pattern=a pid reused after the table was read' .retest/scratch-timezone-switch/reuse-before.test.ts`, exit 0. Log: `/tmp/retest-timezone-switch/logs/reuse-before.log`.

Completed `lockf -t 0 /tmp/retest-heavy-gate.lock npm run test:types`, exit 0. Log: `/tmp/retest-timezone-switch/logs/types.log`.

Completed `node --conditions=retest-source --test --test-concurrency=1 tests/unit/process-zone.test.ts tests/unit/process-zone-worker.test.ts tests/unit/process-zone-records.test.ts tests/unit/media-leftovers-zone.test.ts tests/unit/process-ownership.test.ts tests/unit/metadata-process.test.ts tests/unit/browser-chromium-process.test.ts tests/unit/firefox-process.test.ts tests/unit/firefox-process-table.test.ts tests/unit/firefox-orphans.test.ts tests/unit/firefox-spawn.test.ts tests/unit/firefox-executable.test.ts tests/unit/webkit-process.test.ts tests/unit/webkit-process-table.test.ts tests/unit/webkit-sweep.test.ts tests/unit/native-processes.test.ts tests/unit/native-process-zone.test.ts tests/unit/native-desktop-lock.test.ts tests/unit/media-ownership.test.ts tests/unit/runner-media-lifecycle.test.ts tests/unit/runner-recording.test.ts tests/unit/builds-process-start.test.ts tests/unit/builds-lock.test.ts`, exit 0. Log: `/tmp/retest-timezone-switch/logs/targeted.log`.

Completed `lockf -t 0 /tmp/retest-heavy-gate.lock cargo build --offline --locked --release --jobs 1 --manifest-path media/Cargo.toml --target-dir .retest/scratch-timezone-switch/media-target`, exit 0. Log: `/tmp/retest-timezone-switch/logs/build-media.log`.

## Focused results

The first fixed-zone run passes 34/34 Node cases, zero failed, cancelled or skipped, `logs/timezone-after.log`. The complete relevant consumer command passes 302/302, zero failed, cancelled or skipped, `logs/targeted.log`. Its exact command is recorded above. This includes unchanged shared reuse assertions and all native process cases. The blocking-read failure mentioned in the closeout report is not present in the supplied starting tree: its current assertion already requires the immediate asynchronous reading and zero blocking reads. This lane did not change that assertion.

The unchanged synchronous shared reuse case also passes 1/1 against the saved pre-change layer, `logs/reuse-before.log`. The native exit-reader case fails on the saved pre-change readers and passes after switching to UTC0, while the Chromium close case passes both before and after. Counts are 1 pass / 1 failure before, 2/2 after, zero skips, `logs/lifecycle-before.log` and `logs/lifecycle-after.log`. The Chromium consumer has no independent `ps` reader; its shared ownership path is the one the reader regressions exercise.

The media sweep note case fails first because there is no reported uncertainty, then passes in the 302-case command. `logs/media-note-before.log` and `logs/targeted.log`. An initial fixture import error is retained separately as `logs/media-note-import-error.log` and is not counted as defect evidence. Unconfirmed media sweeps now emit a versioned `media.leftovers` event with status `unconfirmed`, no removed files and an explicit problem. Its type and closed schema are updated at `src/protocol/events.ts:557` and :996. They do not request media cleanup.

The Rust ownership file passes 12/12, zero failures or ignored cases, `logs/rust-after.log`. The other Rust cases in that filtered command are not counted as passes.

`npm run typecheck` first exited 2 on index-signature accesses and an inferred test return type in this lane's new tests. Those were corrected without ignored errors or widening. The final exact command exits 0 for both root compilers and the example project, `logs/typecheck-final.log`. `npm run test:types` exits 0: 241 expected errors match 241 markers in 10 projects on TypeScript 6.0.3 and 7.0.2, `logs/types.log`.

The media binary was rebuilt under the heavy gate into the isolated `.retest/scratch-timezone-switch/media-target` with `--offline --locked`. There was no dependency download or mutation of the default target directory. Source hashes taken before real validation are in `validation-sources.json`.

Completed `lockf -t 0 /tmp/retest-heavy-gate.lock env TZ=Etc/GMT-14 RETEST_FIREFOX_ROUTE=launch-services RETEST_TIMEZONE_IDENTITIES=/tmp/retest-timezone-switch/identities/firefox NODE_OPTIONS=--import=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/scratch-timezone-switch/owned-identities.ts node --conditions=retest-source --test --test-concurrency=1 tests/integration/firefox-driver.test.ts`, exit 0. Log: `/tmp/retest-timezone-switch/logs/firefox-driver.log`.
Counts: tests 8, pass 8, fail 0, cancelled 0, skipped 0.

Completed `lockf -t 0 /tmp/retest-heavy-gate.lock env TZ=Etc/GMT+12 RETEST_TIMEZONE_IDENTITIES=/tmp/retest-timezone-switch/identities/webkit NODE_OPTIONS=--import=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/scratch-timezone-switch/owned-identities.ts node --conditions=retest-source --test --test-concurrency=1 tests/integration/webkit-driver.test.ts`, exit 0. Log: `/tmp/retest-timezone-switch/logs/webkit-driver.log`.
Counts: tests 11, pass 11, fail 0, cancelled 0, skipped 0.

Completed `node --conditions=retest-source --test '--test-name-pattern=the native ownership table' .retest/scratch-timezone-switch/lifecycle-native-before.test.ts`, exit 1. Log: `/tmp/retest-timezone-switch/logs/native-host-before.log`.
Counts: tests 1, pass 0, fail 1, cancelled 0, skipped 0.

Completed `node --conditions=retest-source --test tests/unit/process-zone-lifecycle.test.ts`, exit 0. Log: `/tmp/retest-timezone-switch/logs/lifecycle-final.log`.
Counts: tests 3, pass 3, fail 0, cancelled 0, skipped 0.

## Reader inventory

All line references below are in the final source under the repository root. No start string is converted by guessing the reader's or machine's local zone.

| Reader | UTC0 change or existing clock |
| --- | --- |
| Shared table, sync and async | `src/shared/process-ownership.ts:440`, used at :443 and :447 |
| Shared individual identity, sync and async | `src/shared/process-ownership.ts:454`, used at :458 and :462 |
| Metadata submission, sync and async | `src/shared/metadata-process.ts:125` overrides caller TZ before dispatch |
| Metadata worker | `src/shared/metadata-process-worker.ts:30` independently overrides TZ before spawn |
| Native ownership table and immediate identities | `src/native/processes.ts:518`, :520, :558 and :563 |
| Native whole list | `src/native/processes.ts:639` and :655 |
| Native command and own-start cache | `src/native/processes.ts:681` and :701 |
| Native synchronous exit reader | `src/native/processes.ts:832` and :833 |
| Chromium | `src/browser/chromium-process.ts:119` uses the shared owner and :127 captures it; no independent `ps` reader or source edit |
| Firefox full table, fallback identities, batches, liveness, sync and async | `src/browser/firefox/process-table.ts:8`, shared at :14, :21, :36, :37, :58, :59 and :77 |
| Firefox individual identities, sync and async | `src/browser/firefox/process-table.ts:146` and :152 inherit that fixed environment |
| Firefox main-process comparison | `src/browser/firefox/process.ts:278` compares the launch identity from shared UTC ownership with the UTC table; new record writer at :127 |
| Firefox orphan comparisons | `src/browser/firefox/orphans.ts:104` refuses unmarked/unknown starts before comparisons at :183 and :189; unreadable existing owner files are retained at :85 |
| WebKit launcher start | `src/browser/webkit/process.ts:143` |
| WebKit ownership table and individual identities, sync and async | `src/browser/webkit/process-table.ts:7`, :10 and :25 through :28 |
| Media ownership discovery and selected/individual identities, sync and async | `src/media/client.ts:122`, used by the query at :123 and host readings at :173, :177, :181 and :185 |
| Media run-owner start and liveness | `src/runner/media-leftovers.ts:86`, legacy guard at :65 |
| Rust encoder snapshot and individual identity | `media/src/process_ownership.rs:394` and :430 share `read_metadata` at :519, which fixes TZ at :525 |
| Install macOS start | `src/cli/install/process-start.ts:53` already fixes UTC0 and returns `utc-seconds`; behavior retained |
| Install Linux start | `src/cli/install/process-start.ts:39` already reads kernel boot ticks, with no calendar string or zone; behavior retained |

Other real `lstart` readers found outside production are fixed as UTC test references: `tests/unit/native-fake-tools.ts:71`, `tests/unit/native-fake-tool.ts:355`, `tests/unit/native-processes.test.ts:635`, `tests/conformance/process.ts:276` and `tests/integration/evidence-support.test.ts:65`. Intentional local-zone reads remain only in the migration fixture and conflicting metadata requests, which are the inputs the regressions test.

## Record handling

| Record | New writer / schema | Pre-change behavior |
| --- | --- | --- |
| Firefox launch | `src/browser/firefox/process.ts:127`; `profile.ts:52` and :57 | `orphans.ts:104` keeps the folder and processes and reports the unconfirmed zone |
| WebKit home | `src/browser/webkit/process.ts:217` and :389; `sweep.ts:28` | `sweep.ts:70` leaves the home and processes alone and names the reason |
| Native folder owner | `src/native/temporary-folders.ts:32`; schema :20 | Guard :64 retains it and reports uncertainty |
| Desktop lock and its saved runner identities | `src/native/desktop-lock.ts:202`; schema :47 | Guard :181 refuses recovery and preserves the record/processes even if the record lists no runner yet |
| Media owner in `media.started` | `src/runner/run-media.ts:244`; `src/protocol/recording.ts:258` and :276 | `media-leftovers.ts:65` returns unconfirmed; `run-media.ts:305` reports it without requesting leftover removal |
| Install generation | `src/cli/install/lock.ts:45`, :56 and :253 retain version 2 plus `start.clock` | Earlier local-time version 1 is unreadable, leaves the folder/process alone and reports the refusal; existing UTC/boot-tick version 2 remains comparable |

For string records, `startTimeVersion: 1` applies to every process start in that record, including both Firefox identities, the WebKit launcher and processes, and desktop holder and runners. The version is optional in the schema solely to read and retain older records; new production writers always set it. Unknown numeric versions are also unconfirmed.

Completed `node --conditions=retest-source --test '--test-name-pattern=complete pre-change Firefox record' .retest/scratch-timezone-switch/records-local-before.test.ts`, exit 1. Log: `/tmp/retest-timezone-switch/logs/firefox-local-before.log`.
Counts: tests 1, pass 0, fail 1, cancelled 0, skipped 0.

Completed `node --conditions=retest-source --test tests/unit/process-zone-records.test.ts`, exit 0. Log: `/tmp/retest-timezone-switch/logs/records-final.log`.
Counts: tests 7, pass 7, fail 0, cancelled 0, skipped 0.

Additional native-host evidence: `logs/native-host-before.log` fails 0/1 against the saved old native/metadata modules by observing a local-time start in the actual table reply. `logs/lifecycle-final.log` passes 3/3, zero skipped: the native table and immediate async identity, native exit reader, and Chromium consumer close. No fresh-read or signal-order assertion was removed.

Additional consistent Firefox local-record evidence: `logs/firefox-local-before.log` fails 0/1 on the saved readers because it calls the live recorded Firefox a different process. Both real live identities in this fixture were written in the same local zone. `logs/records-final.log` passes 7/7, zero skipped, preserving both processes and the folder and reporting the unconfirmed zone. The original adversarial record case with a local owner and a matching browser reading also remains; that is the initial attempted-signal evidence in `records-before.log`.

Real Firefox driver: 8/8, zero failed, cancelled or skipped, exit 0. Firefox 133.0.3 build 20241209150345 through Launch Services, caller TZ `Etc/GMT-14`. `logs/firefox-driver.log`. Real WebKit driver: 11/11, zero failed, cancelled or skipped, exit 0, caller TZ `Etc/GMT+12`. `logs/webkit-driver.log`. Both preserve all original close, crash, helper and orphan assertions.

Completed `lockf -t 0 /tmp/retest-heavy-gate.lock env TZ=Etc/GMT-14 RETEST_TIMEZONE_IDENTITIES=/tmp/retest-timezone-switch/identities/ios NODE_OPTIONS=--import=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/scratch-timezone-switch/owned-identities.ts node --conditions=retest-source --test --test-concurrency=1 tests/integration/native-ios-lifecycle.test.ts`, exit 0. Log: `/tmp/retest-timezone-switch/logs/ios-lifecycle.log`.
Counts: tests 9, pass 9, fail 0, cancelled 0, skipped 0.

Completed `lockf -t 0 /tmp/retest-heavy-gate.lock env TZ=Etc/GMT+12 RETEST_MEDIA_BINARY=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/scratch-timezone-switch/media-target/release/retest-media RETEST_TIMEZONE_IDENTITIES=/tmp/retest-timezone-switch/identities/media NODE_OPTIONS=--import=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/scratch-timezone-switch/owned-identities.ts node --conditions=retest-source --test --test-concurrency=1 proofs/media/client.test.ts`, exit 0. Log: `/tmp/retest-timezone-switch/logs/media-client.log`.
Counts: tests 32, pass 32, fail 0, cancelled 0, skipped 0.

Real iOS lifecycle: 9/9 across both suites, zero failed, cancelled or skipped, exit 0. The original real simulator install/launch/cancel/crash/lost-executor checks and second-runtime app-data/keychain isolation checks all pass. `logs/ios-lifecycle.log`. This is simulator evidence; no physical iPhone was tested.

Completed `lockf -t 0 /tmp/retest-heavy-gate.lock env TZ=Etc/GMT-14 RETEST_CONFORMANCE_OPT_OUT=firefox,webkit RETEST_CONFORMANCE_KEEP=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/scratch-timezone-switch/conformance RETEST_TIMEZONE_IDENTITIES=/tmp/retest-timezone-switch/identities/chrome NODE_OPTIONS=--import=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/scratch-timezone-switch/owned-identities.ts node --conditions=retest-source --test --test-concurrency=1 tests/integration/conformance.test.ts`, exit 0. Log: `/tmp/retest-timezone-switch/logs/chrome-conformance.log`.
Counts: tests 166, pass 164, fail 0, cancelled 0, skipped 2.

## Test-to-evidence map

`tests/unit/process-zone.test.ts:9` names the 26 readers separately; :27 declares one test per name. `process-zone-probe.ts:15` takes an independent UTC reference. A real child is started under `Etc/GMT+12`, and separate reader processes run under that zone and `Etc/GMT-14`.

| Added test | Before | Fixed evidence |
| --- | --- | --- |
| metadata sync, metadata async | Each fails the UTC reference | `readers-before.log`; 34-case `timezone-after.log` and complete `targeted.log` |
| shared table, shared individual, shared async table, shared async individual | Each fails the UTC reference | Same logs; asynchronous signalling also must have no ownership refusal |
| native command, native list, native table, native own | Each fails the UTC reference | Same logs |
| Firefox table, async table, liveness, individual, async individual | Each fails the UTC reference | Same logs |
| WebKit start, table, async table, individual, async individual | Each fails the UTC reference | Same logs |
| media table, async table, individual, async individual, owner start | Each fails the UTC reference | Same logs |
| install start | Passes before, since its clock was already UTC | Same logs plus the existing real holder/taker TZ test in `builds-lock.test.ts` in `targeted.log` |
| Raw worker, `process-zone-worker.test.ts:8` | 0/1 against saved worker, reply uses the requested local zone | `worker-before.log`; fixed in `timezone-after.log` and `targeted.log` |
| Native table and immediate identity, `process-zone-lifecycle.test.ts:16` | 0/1; actual reply contains local time | `native-host-before.log`; fixed 3/3 `lifecycle-final.log` |
| Native exit reader, `process-zone-lifecycle.test.ts:55` | Does not send the required verified signal for its UTC record | `lifecycle-before.log`; fixed in `lifecycle-after.log` and `lifecycle-final.log` |
| Chromium close, `process-zone-lifecycle.test.ts:75` | Passes before; existing shared caller-TZ isolation preserved | Same lifecycle logs, then the real Chrome gate |
| Firefox adversarial legacy record, `process-zone-records.test.ts:36` | Requests a signal against its live recorded pid | `records-before.log`; fixed in `timezone-after.log`, `targeted.log` and `records-final.log` |
| Firefox complete local legacy record, `process-zone-records.test.ts:54` | Calls the live Firefox another process instead of unconfirmed | `firefox-local-before.log`; fixed 7/7 `records-final.log` |
| WebKit legacy home, `process-zone-records.test.ts:73` | Removes home after an apparent absent launcher | `records-before.log`; same fixed record logs |
| Native legacy folder, `process-zone-records.test.ts:85` | Removes live owner's folder after zone mismatch | Same logs |
| Desktop legacy lock, `process-zone-records.test.ts:99` | Takes lock and overwrites old record | Same logs |
| Media legacy mark, `process-zone-records.test.ts:116` | Returns false, declaring it gone | Same logs |
| Install legacy generation, `process-zone-records.test.ts:122` | Passes before through existing format refusal | Same logs, byte-for-byte record retention and live PID check |
| Media sweep report, `media-leftovers-zone.test.ts:9` | Missing unconfirmed event | `media-note-before.log`; fixed in `targeted.log` |
| Rust `process_start_is_utc_even_for_a_child_started_in_another_zone`, `media/src/process_ownership.rs:638` | Actual local start differs from UTC | `rust-before.log`; 12/12 ownership cases in `rust-after.log` |

The three before-passing new checks are reported as preservation of existing defenses, not fabricated failing-first evidence. Existing assertions in the consumer files remain. Current-format fixtures gain only the explicit marker and UTC reference readings.

Real media client: 32/32, zero failed, cancelled or skipped, exit 0. `logs/media-client.log`. Its offline build artifact SHA-256 is `cdce0cbd2a8390671740d582a65745902e63ce5a2f73fea1503d8d34bafff86c`.

Chrome conformance ran exactly once on Chrome 154.0.8037.98: 166 Node checks, 164 passed, zero failed or cancelled, 2 explicit engine opt-outs, exit 0. `logs/chrome-conformance.log`. All required group exits, failure classes, unknown-outcome checks and cleanup assertions pass. Kept runs are `.retest/scratch-timezone-switch/conformance/chrome/<group>/run/`. Firefox and WebKit conformance were not run.

Completed `lockf -t 0 /tmp/retest-heavy-gate.lock npm run test:unit`, exit 1. Log: `/tmp/retest-timezone-switch/logs/whole-unit.log`.
Counts: tests 4091, pass 4080, fail 11, cancelled 0, skipped 0.

Completed `lockf -t 0 /tmp/retest-heavy-gate.lock npm run typecheck`, exit 0. Log: `/tmp/retest-timezone-switch/logs/typecheck-complete.log`.

## Whole-tree unit gate and owned follow-up

Initial `npm run test:unit` exits 1: 4091 tests, 4080 pass, 11 fail, zero cancelled or skipped. `logs/whole-unit.log`. One failure is a current-format fixture this switch needs to update: `tests/unit/native-macos-app.test.ts:513` writes an unmarked folder at :510 and expects current-format cleanup. It now writes `startTimeVersion: 1`; every existing cleanup assertion stays. Separate legacy-folder tests require retention.

The Rust ownership edit also needs its source pin. `src/cli/install/media-pins.ts:20` is updated only for `media/src/process_ownership.rs`, and the manifest digest at :7 is recomputed from the declared pins. No other source pin changes. `media-pin-audit.json` shows that `media/src/frame.rs` was already mismatched at task start, while the ownership file matched before this lane. That unrelated frame mismatch still refuses source installs; it is not bypassed or accepted. The media client real gate used the explicitly selected offline artifact, not that refused cache/source-install path.

Completed `node --conditions=retest-source --test --test-concurrency=1 tests/unit/early-process-waits.test.ts tests/unit/native-macos-app.test.ts`, exit 0. Log: `/tmp/retest-timezone-switch/logs/readiness-and-own-fixture.log`.
Counts: tests 33, pass 33, fail 0, cancelled 0, skipped 0.

The focused readiness/current-native-fixture run passes 33/33, zero failures, cancellations or skips, `logs/readiness-and-own-fixture.log`. The early readiness test passes without changes to its source or the readiness implementation; the full-tree failure is retained and its cause is not diagnosed here.

Unrelated failures in the initial full-tree log, not fixed:

| Assertion location | Observed failure |
| --- | --- |
| `tests/unit/early-process-waits.test.ts:76` | Fake runner process remains at the immediate cleanup assertion. The unchanged focused case passes. |
| `tests/unit/inspect-looks.test.ts:147` | Timeline lacks `retention removal requested`. Its test bodies omit the existing requested-removal event. |
| `tests/unit/media-install.test.ts:45` | Source allowlist refuses the already-mismatched `media/src/frame.rs` hash. |
| `tests/unit/media-install.test.ts:172` | Install reuse reports that same source-hash refusal before the asserted cache-digest message. |
| `tests/unit/media-install.test.ts:198` | Source-hash refusal arrives before the asserted damaged-cache message. |
| `tests/unit/media-install.test.ts:230` | Source-hash refusal arrives before the asserted missing-Cargo message. |
| `tests/unit/media-install.test.ts:272` | Source-hash refusal arrives before the held-lock message. |
| `tests/unit/protocol-identity.test.ts:129` | Identity table omits existing `artifact.removal_requested`, 52 entries for 53 types. |
| `tests/unit/protocol.test.ts:607` | Event samples omit that existing type. |
| `tests/unit/protocol.test.ts:789` | Closed-object count still expects 52 rather than the existing 53. |

The timezone change adds a status and optional problem to `media.leftovers`; it adds no event type. The artifact event and its sample/table defects are separate existing work. The final full-tree unit run below follows the owned fixture and pin updates. Its preload records spawned PID, executable and a hash of command arguments, never argument text or environment values, for the final read-only audit.

Completed `lockf -t 0 /tmp/retest-heavy-gate.lock env RETEST_TIMEZONE_SPAWNS=/tmp/retest-timezone-switch/spawns NODE_OPTIONS=--import=/Users/dragon/Documents/Projects/Gruvi/Products/retest/.retest/scratch-timezone-switch/spawn-records.mjs npm run test:unit`, exit 1. Log: `/tmp/retest-timezone-switch/logs/whole-unit-final.log`.
Counts: tests 4091, pass 4081, fail 10, cancelled 0, skipped 0.

Completed `lockf -t 0 /tmp/retest-heavy-gate.lock npm run test:types`, exit 0. Log: `/tmp/retest-timezone-switch/logs/types-final.log`.

Completed `lockf -t 0 /tmp/retest-heavy-gate.lock python3 .retest/scratch-timezone-switch/final-audit.py`, exit 0. Log: `/tmp/retest-timezone-switch/logs/final-audit.log`.

## Final gate results

Every real-path command above ran once under `/tmp/retest-heavy-gate.lock`. The wrapper checked for a running benchmark before dispatch; `benchmark-guard.log` retains the checks. No benchmark was run.

| Gate | Result | Final log under `/tmp/retest-timezone-switch/logs/` |
| --- | --- | --- |
| Firefox driver, Launch Services | Exit 0; 8/8, no failures, cancellations or skips | `firefox-driver.log` |
| WebKit driver | Exit 0; 11/11, no failures, cancellations or skips | `webkit-driver.log` |
| iOS simulator lifecycle | Exit 0; 9/9, no failures, cancellations or skips | `ios-lifecycle.log` |
| Media client with the offline artifact | Exit 0; 32/32, no failures, cancellations or skips | `media-client.log` |
| Chrome conformance | Exit 0; 164 passed, 0 failed/cancelled, 2 requested engine opt-outs | `chrome-conformance.log` |
| `npm run typecheck` | Exit 0; both root compilers and example project | `typecheck-complete.log` |
| `npm run test:types` | Exit 0; 241 expected errors match 241 markers in 10 projects on each of TypeScript 6.0.3 and 7.0.2 | `types-final.log` |
| `npm run test:unit` | Exit 1; 4,091 tests, 4,081 passed, 10 failed, 0 cancelled/skipped | `whole-unit-final.log` |
| Rust ownership cases | Exit 0; 12 passed, 0 failed/ignored; 86 other unit cases and 55 integration cases filtered | `rust-after.log` |
| Cleanup audit | Exit 0; no recorded process, group member or owned folder remains | `final-audit.log` |

The final unit failures remain the ten files/assertions in the initial-failure table, with one changed failure location: the readiness case at `tests/unit/early-process-waits.test.ts:50` now fails through its call at :69 in `tests/unit/early-waits-clock.ts:32`, with `work did not end at 120.09999999999745 ms`. The first run failed the cleanup assertion at :76. Its untouched focused run passes; the full-tree cause remains undiagnosed. The other nine final assertion locations are unchanged: `inspect-looks.test.ts:147`, `media-install.test.ts:45`, :172, :198, :230 and :272, `protocol-identity.test.ts:129`, and `protocol.test.ts:607` and :789. None was edited to make the gate pass.

All 38 added Node cases pass in the final whole-tree log: 26 named reader cases, the direct worker case, seven record cases, three native/Chromium lifecycle cases and the media sweep note. The shared reuse test file's SHA-256 remains `8acf2cbafe18b8da862dc26d4fdd9821788854d7ccbb94316c8bf70d1f84ba27`; its assertions were unchanged.

The owned Rust pin is `629f356171ef474336344b015ee36853d84f73dce0e6a814933babe970c1d828`; the declared pin-manifest digest is `5ad3b9514beb715905ee10383dc7fb0391a9e7efbacd9ced1a63969d6a206f63`. `media-pins-final.json` records the final pin-file hash. The unrelated `frame.rs` pin mismatch remains and the source installer continues to refuse it.

## Cleanup and verification limits

`final-audit.json` checks 13,254 recorded PIDs, 10,872 recorded group IDs and 21 recorded folders against a C-locale UTC0 process table and the filesystem. It finds zero live recorded PIDs, zero remaining group members and zero remaining folders. It issues zero signals. The 23 validation snapshot entries, including the unchanged shared test, still match their pre-gate hashes; the explicitly selected media binary still matches its recorded SHA-256. These are observations of recorded ownership, not permission to end an unrecorded process.

The original nine-case iOS lifecycle harness confirms its own simulator deletion. Simulator UDIDs were not independently recorded, so the final audit does not supply a separate per-UDID deletion check. No physical iOS device, Linux host, other operating system, full Rust suite, full integration suite, Firefox conformance or WebKit conformance was exercised by this lane. Linux `/proc` behavior and cross-platform test execution remain unverified here. Media source installation remains blocked by the pre-existing `frame.rs` pin mismatch; the real media client gate verifies the selected offline build only.

Pre-change records are deliberately retained as unconfirmed rather than automatically migrated. Their recorded zone cannot be inferred safely. This lane leaves those folders and processes for a separately confirmed cleanup. No passing condition, required outcome or assertion was removed or weakened.

Final workspace inventory is `/tmp/retest-timezone-switch/final-status.txt`. The scoped whitespace check exits 0. A separate read-only `ps` query of the recorded wrapper command PIDs returns no rows (exit 1, the absent-PID result), including the completed final audit wrapper. The final benchmark guard exits 0. No cleanup signal was needed after the gates.
