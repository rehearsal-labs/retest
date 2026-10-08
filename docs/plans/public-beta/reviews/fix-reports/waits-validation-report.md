# Waits validation

Final outcome: the wait sweep's focused checks, Chrome/WebKit driver checks, final Firefox driver/shared/table gate, Firefox conformance, packaged media install and both typecheck commands pass. Native units finish 365/366; the remaining ownership-reading assertion is in the other worker's file and is unchanged. No owned process remains running.

| Final gate | Result | Log under `.retest/scratch-waits-validation/logs/` |
| --- | --- | --- |
| Focused wait/process units | 72/72, zero skips; final type-narrowing cases 2/2 | `early-focused-preserved-final.log`, `firefox-protocol-typed-final.log` |
| Browser page/process/window units | 49/49, zero skips | `browser-units.log` |
| Native units | 365/366, one outside-lane failure, zero skips | `native-units-final.log` |
| Chrome shared suites and WebKit driver | All pass in the initial 182/183 gate; its Firefox failure is fixed below | `browser-drivers.log` |
| Final Firefox driver/shared/table/refusal gate | 176/176, zero skips | `firefox-shared-and-driver-final.log` |
| Live Chrome/Firefox role comparison | 23,733 lookups, 21,635 matching counts, 2,098 named refusals, zero differing counts | `firefox-drivers-and-tables.log` |
| Firefox conformance, once | 148/148 cases, 15/15 groups, 164/164 Node checks, zero skips | `firefox-conformance.log` |
| Media installer/locator units | 17/17, zero skips | `media-units-final.log` |
| Packaged media install | 4/4, zero skips | `install-media-final.log` |
| Main/example and proof typechecks | Both exit 0 | `typecheck-final.log`, `typecheck-proofs.log` |
| Owned-process audit | 227 recorded identities; zero live or changed-command candidates | `owned-processes-final.json` |

The history below retains failed attempts, corrections and each exact command. Logs have adjacent `.command` and `.result` records. No passing assertion was loosened. No commit, download, benchmark or publication was made.

## Intake

Read the repository instructions, README, architecture, common rules, release invariants and Phase 2 decisions. Read the early-waits report, the Firefox driver-defect reproduction and the media-install handoff. No early-waits-last.md exists. The earlier early-waits gates have no reported completion; their green status is unverified.

Existing shared changes are preserved. This lane owns only the assigned wait, Firefox accessible-name, media installer and associated test/documentation files. No commit, stash, reset, revert, benchmark or download is authorized or run.

Logs and command/process records are under `.retest/scratch-waits-validation/`. Heavy tests use `sh .retest/scratch-waits-validation/gate.sh <log> <command>`. That wrapper checks for a benchmark, acquires `lockf -t 0 /tmp/retest-heavy-gate.lock`, checks again inside the lock, records its own and command process identities, captures output and writes the exact exit code. A busy lock starts no test. Only one heavy command is queued at a time. Focused unit files use the wrapper's `--unit` route, as common-rules.md allows; that route performs the same benchmark and ownership checks without the heavy lock.

## Step 1: early waits

Read the assigned source changes against the saved early-waits diff and current implementation, and read the three early-waits test files, fake clock and wait-before-read tests. The source review found no unbounded deadline loop, shortened frame gap, second input dispatch or changed non-time protocol failure in this sweep. The frame gap uses a separate deadline starting at the first frame read. Final-read flags are captured before reads, so a straddling read still permits the final probe. Screenshot retry classifiers preserve malformed and non-retryable replies. Selection, check, field, keyboard and alert verification only read after input.

The focused unit command is queued through the shared lock:

```sh
sh .retest/scratch-waits-validation/gate.sh .retest/scratch-waits-validation/logs/early-focused-first.log node --conditions=retest-source --test --test-concurrency=1 --test-timeout=120000 tests/unit/early-browser-waits.test.ts tests/unit/early-native-waits.test.ts tests/unit/early-process-waits.test.ts tests/unit/wait-before-read.test.ts
```

That queue started no test. The lock holder is another worker's multi-platform flow. Ended only this lane's recorded idle wrapper and its recorded sleep after rechecking each pid, start time and full command. Evidence: `logs/idle-gate-stop.log`; exact command `python3 .retest/scratch-waits-validation/stop-idle-gate.py`. The unit command now runs under the allowed `--unit` route with log `logs/early-focused-first-unit.log`. The Node test timeout bounds a hung unit child without changing any test assertion. No pass count is claimed yet.

Focused result: exit 0, 39/39 tests pass, zero failures, cancellations or skips. Exact executed command:

```sh
sh .retest/scratch-waits-validation/gate.sh --unit .retest/scratch-waits-validation/logs/early-focused-first-unit.log node --conditions=retest-source --test --test-concurrency=1 --test-timeout=120000 tests/unit/early-browser-waits.test.ts tests/unit/early-native-waits.test.ts tests/unit/early-process-waits.test.ts tests/unit/wait-before-read.test.ts
```

No wait source or existing assertion was changed. Browser driver integration and native unit verification follow.

Started the following validation commands. Their results are pending:

```sh
sh .retest/scratch-waits-validation/gate.sh .retest/scratch-waits-validation/logs/browser-drivers.log env RETEST_FIREFOX_ROUTE=launch-services node --conditions=retest-source --test --test-concurrency=1 tests/integration/browser-actions.test.ts tests/integration/browser-navigation.test.ts tests/integration/browser-locators.test.ts tests/integration/browser-secrets.test.ts tests/integration/firefox-driver.test.ts tests/integration/webkit-driver.test.ts
sh .retest/scratch-waits-validation/gate.sh --unit .retest/scratch-waits-validation/logs/native-units-first.log node --conditions=retest-source --test --test-concurrency=1 --test-timeout=120000 'tests/unit/native-*.test.ts'
```

The native run has reported a failure in `native-actionability.test.ts`, "an action with too little time left for the whole frame gap fails as not steady in time, and nothing is sent". Its required stable refusal and no-input checks remain unchanged. The run is still active; full failure details and totals are pending. Browser integration still waits on the shared lock.

The unchanged short-gap test passes in isolation, 1/1, exit 0, no skips. Exact command:

```sh
sh .retest/scratch-waits-validation/gate.sh --unit .retest/scratch-waits-validation/logs/native-short-gap-before.log node --conditions=retest-source --test --test-concurrency=1 --test-name-pattern='an action with too little time left' tests/unit/native-actionability.test.ts
```

This isolated pass does not clear the full-run failure. Recorded live owned descendants during the unit run with `python3 .retest/scratch-waits-validation/record-descendants.py`; identities are retained in `descendants.jsonl` for cleanup verification.

Started the saved pre-sweep source check to verify that the early-waits tests detect the changed behavior. It redirects imports to the prior lane's snapshots and changes no live source:

```sh
sh .retest/scratch-waits-validation/gate.sh --unit .retest/scratch-waits-validation/logs/early-old-code.log node --conditions=retest-source --import ./.retest/scratch-early-waits/old-code.ts --test --test-concurrency=1 --test-timeout=120000 tests/unit/early-browser-waits.test.ts tests/unit/early-native-waits.test.ts tests/unit/early-process-waits.test.ts
```

Saved-source result: exit 1, 36 tests, 3 pass and 33 fail, zero cancellations or skips. The failures reject early final reads, shortened stability gaps, timeout handling and other pre-sweep behavior. All stand-in startup cleanup checks completed. This is evidence that the tests reject the old behavior, never a passing gate. Current focused source remains 39/39 green.

Started the affected page/process/window unit files while the real-browser gate waits:

```sh
sh .retest/scratch-waits-validation/gate.sh --unit .retest/scratch-waits-validation/logs/browser-units.log node --conditions=retest-source --test --test-concurrency=1 --test-timeout=120000 tests/unit/browser-page.test.ts tests/unit/firefox-page.test.ts tests/unit/firefox-process.test.ts tests/unit/firefox-window-order.test.ts tests/unit/webkit-page.test.ts
```

No result is claimed yet. Native units continue with the one reported short-gap failure and no additional failures so far.

Browser units complete: exit 0, 49/49 pass, zero failures, cancellations or skips, `logs/browser-units.log`.

Native units complete: exit 1, 366 tests, 364 pass and 2 fail, zero cancellations or skips, `logs/native-units-first.log`. The short-gap case received the original executor lookup timeout, "Finding the Button \"sign-in-button\" on the executor: POST /session/fake-session-2/elements: no answer within 19 ms." It never reached the frame-gap check. The other failure is `native-processes.test.ts:690`, "a long-running process takes no blocking ownership reading while it runs", at its required "the stop reads the pid it signals" assertion. That production source is another worker's file and remains untouched.

Changed only the short-gap test fixture: the first tree consumes the same 220 ms on a controlled deadline clock instead of a wall-clock server delay. Kept the 300 ms action budget, exact stable refusal, zero rect requests and zero clicks; added a required full-deadline bound. Restored clocks before fixture cleanup. Production timeout behavior remains unchanged. Started its failing-first saved-source check:

```sh
sh .retest/scratch-waits-validation/gate.sh --unit .retest/scratch-waits-validation/logs/native-short-gap-old-clock.log node --conditions=retest-source --import ./.retest/scratch-early-waits/old-code.ts --test --test-concurrency=1 --test-timeout=120000 --test-name-pattern='an action with too little time left' tests/unit/native-actionability.test.ts
```

Result pending. The first full-run failure is retained above.

The controlled-clock test rejects saved pre-sweep source, exit 1, 0/1 pass, because readiness ended at 220.2 ms instead of using its 300 ms deadline. Current source passes 1/1, exit 0, zero cancellations or skips. Logs: `native-short-gap-old-clock.log`, `native-short-gap-clock.log`. Current command:

```sh
sh .retest/scratch-waits-validation/gate.sh --unit .retest/scratch-waits-validation/logs/native-short-gap-clock.log node --conditions=retest-source --test --test-concurrency=1 --test-timeout=120000 --test-name-pattern='an action with too little time left' tests/unit/native-actionability.test.ts
```

The browser driver gate finished with one Firefox loss-ordering failure. Dispatched input remains `outcome_unknown`; the returned message describes an unreadable protocol answer before page loss is observed, while the existing real-browser test requires the confirmed loss wording. Its matcher remains unchanged. Diagnosis is in progress. Started the native full rerun after the fixture correction:

```sh
sh .retest/scratch-waits-validation/gate.sh --unit .retest/scratch-waits-validation/logs/native-units-final.log node --conditions=retest-source --test --test-concurrency=1 --test-timeout=120000 'tests/unit/native-*.test.ts'
```

Browser driver totals: exit 1, 182/183 pass, one failure, zero cancellations or skips. The failed case is `firefox-driver.test.ts:196`; its original matcher and single-press assertion remain intact.

The full native rerun completes with exit 1, 365/366 pass, one failure, zero cancellations or skips. The short-gap correction passes. The remaining failure repeats `native-processes.test.ts:690`, assertion `the stop reads the pid it signals`. Its source and test belong to the other worker and were not changed. Log: `logs/native-units-final.log`.

Added two unit cases for dispatched Firefox protocol failures. Before the fix, the queued connection-loss case fails its required loss message; the later-stop case passes unchanged. Exact command, exit 1, 1/2 pass, zero skips:

```sh
sh .retest/scratch-waits-validation/gate.sh --unit .retest/scratch-waits-validation/logs/firefox-protocol-loss-before.log node --conditions=retest-source --test --test-concurrency=1 --test-timeout=120000 --test-name-pattern='Firefox dispatched protocol failure' tests/unit/early-browser-waits.test.ts
```

Changed FirefoxPage's dispatched input-protocol-error path to reconcile one queued event turn, sending no command. If that turn confirms page loss, it returns `outcome_unknown` with the original sanitized protocol error retained in `details.protocolError`. Otherwise it returns the original error unchanged; a later stop cannot replace it. Both unit cases require one input and no clock/deadline hold. Started the affected focused gate:

```sh
sh .retest/scratch-waits-validation/gate.sh --unit .retest/scratch-waits-validation/logs/early-focused-final.log node --conditions=retest-source --test --test-concurrency=1 --test-timeout=120000 tests/unit/early-browser-waits.test.ts tests/unit/early-native-waits.test.ts tests/unit/early-process-waits.test.ts tests/unit/wait-before-read.test.ts tests/unit/native-actionability.test.ts tests/unit/firefox-page.test.ts
```

The focused affected gate passes, exit 0, 66/66 tests, zero failures, cancellations or skips. The real Firefox loss rerun remains pending.

## Step 2: Firefox native tables

Pending. The reported reproduction establishes seven native team-table rows in both engines, while Firefox's raw named-cell lookup omits Grace Hopper. The blanket table refusal and named-cell refusal are separate checks in accessible-names.ts.

Prepared `tests/integration/firefox-native-tables.test.ts` while the Step 1 gate waits. It requires the raw Firefox counts, all seven driver row texts, 24 cells, the named Role header, the caption-named table and the exact named-cell refusal. The source guard is unchanged, so the required row observation should fail first. No Firefox test has run yet.

Started the real failing-first regression through the lock while the Firefox loss failure is investigated:

```sh
sh .retest/scratch-waits-validation/gate.sh .retest/scratch-waits-validation/logs/firefox-native-tables-before.log env RETEST_FIREFOX_ROUTE=launch-services node --conditions=retest-source --test --test-concurrency=1 tests/integration/firefox-native-tables.test.ts
```

Result: exit 1, 0/1 pass, one failure, zero cancellations or skips. Raw Firefox first confirms seven rows, 24 cells, one Role header and zero cells named Grace Hopper. The driver then refuses the required row observation at `firefox-native-tables.test.ts:55`. This is the failing-first evidence; the guard was unchanged when it ran. Browser cleanup passed.

Narrowed the native-table markup guard to tables without visible data-table cues: a caption or header must belong to that table, and an explicit table/grid/treegrid role is accepted. Hidden cues and nested-table cues do not qualify. Named cells remain refused by the existing separate check. The layout-table refusal fixture now has no header; its exact failure assertions are unchanged. The team regression requires all the formerly refused row/header/cell/table observations. F8.1a now names its later, genuine named-cell refusal at `toBeVisible`, keeping its exact message, role fact and at-once budget requirement.

Started the table regression, refusal checks, complete Firefox driver and live Chrome/Firefox role comparison in one locked command:

```sh
sh .retest/scratch-waits-validation/gate.sh .retest/scratch-waits-validation/logs/firefox-drivers-and-tables.log env RETEST_FIREFOX_ROUTE=launch-services node --conditions=retest-source --test --test-concurrency=1 tests/integration/firefox-native-tables.test.ts tests/integration/firefox-refusals.test.ts tests/integration/firefox-driver.test.ts tests/integration/firefox-roles.test.ts
```

Result pending. The full role comparison is required to check that admitting data tables does not introduce a silent set difference.

The running gate has reported failures in the real Firefox loss case and the team-table test; both remain unresolved until the complete log gives their details. The layout refusal test passes unchanged. No additional heavy command is queued.

Complete result: exit 1, 11/13 pass, two failures, zero cancellations or skips. The live role comparison passes all 23,733 lookups across 286 pages: 21,635 answered alike, 2,098 explicitly refused, zero silent differences. The Firefox loss case still has the same protocol-error message; one event turn does not establish loss on this host. The team regression passes its row count but my new text assertion reads a nonexistent `texts` property. Corrected it to `items.map(item => item.text)`, retaining every required row string. Further regression validation is pending.

The deliberate-crash helper ends recorded descendants before the browser, allowing its still-live Remote Agent to answer the dispatched input with a protocol error first. A failing-first process unit check requires the freshly verified browser to be signalled before its content process. Exact command:

```sh
sh .retest/scratch-waits-validation/gate.sh --unit .retest/scratch-waits-validation/logs/firefox-crash-order-before.log node --conditions=retest-source --test --test-concurrency=1 --test-timeout=120000 --test-name-pattern='a deliberate Firefox crash' tests/unit/firefox-process.test.ts
```

Changed FirefoxProcess.crash to end its verified browser before the recorded helpers, retaining fresh ownership checks and visible signal failures. The existing reused-pid refusal is unchanged. Started the affected process units:

```sh
sh .retest/scratch-waits-validation/gate.sh --unit .retest/scratch-waits-validation/logs/firefox-process-final.log node --conditions=retest-source --test --test-concurrency=1 --test-timeout=120000 tests/unit/firefox-process.test.ts tests/unit/early-process-waits.test.ts
```

Crash-order failing-first result: exit 1, 1/2 pass, one failure, zero cancellations or skips. The old helper signals `[4243, 4242]`; the test requires verified browser then content `[4242, 4243]`. Affected process units after the fix pass, exit 0, 8/8, zero failures, cancellations or skips. The real Firefox loss matcher is unchanged and awaits its rerun.

Removed this lane's provisional event-turn reconciliation from FirefoxPage. Its real run did not establish loss, and a later close must not replace a non-time protocol failure already received. Corrected this lane's new unit case to require the original failure through a later close, alongside the later-stop case, and to prove each later event actually arrives. Against the provisional code that preservation test fails first, exit 1, 1/2 pass, zero cancellations or skips:

```sh
sh .retest/scratch-waits-validation/gate.sh --unit .retest/scratch-waits-validation/logs/firefox-protocol-preserved-before.log node --conditions=retest-source --test --test-concurrency=1 --test-timeout=120000 --test-name-pattern='Firefox dispatched protocol failure' tests/unit/early-browser-waits.test.ts
```

Final action handling is the original early-waits implementation. It holds only timeout errors; no new non-time hold remains. The deliberate-crash correction is separate in FirefoxProcess, and no existing real-driver assertion changed. Started the final affected sweep:

```sh
sh .retest/scratch-waits-validation/gate.sh --unit .retest/scratch-waits-validation/logs/early-focused-preserved-final.log node --conditions=retest-source --test --test-concurrency=1 --test-timeout=120000 tests/unit/early-browser-waits.test.ts tests/unit/early-native-waits.test.ts tests/unit/early-process-waits.test.ts tests/unit/wait-before-read.test.ts tests/unit/native-actionability.test.ts tests/unit/firefox-page.test.ts tests/unit/firefox-process.test.ts
```

Final affected sweep result: exit 0, 72/72 pass, zero failures, cancellations or skips. Both later-event tests prove the event arrives and the received protocol failure stays unchanged, with one input.

Updated Firefox proof item 7 and its current role-comparison counts, and only the guide's Firefox role paragraph. Added exact layout-refusal checks for a plain table, hidden header, nested header and explicit presentation role. The team regression and conformance outcomes still require the next real gate.

Started the declaration validation units after updating the proof and declaration:

```sh
sh .retest/scratch-waits-validation/gate.sh --unit .retest/scratch-waits-validation/logs/engine-declarations-unit.log node --conditions=retest-source --test --test-concurrency=1 --test-timeout=120000 tests/unit/engine-expectations.test.ts
```

Declaration validation result: exit 0, 21/21 pass, zero failures, cancellations or skips. Literal outcomes, source anchors, required facts, stale declarations and declarations with no asserted case remain enforced.

Started the final Firefox driver, table/refusal regressions and all four Firefox shared suites. Each shared suite runs once, with its declared full outcomes unchanged:

```sh
sh .retest/scratch-waits-validation/gate.sh .retest/scratch-waits-validation/logs/firefox-shared-and-driver-final.log env RETEST_FIREFOX_ROUTE=launch-services node --conditions=retest-source --test --test-concurrency=1 tests/integration/firefox-driver.test.ts tests/integration/firefox-native-tables.test.ts tests/integration/firefox-refusals.test.ts tests/integration/firefox-browser-actions.test.ts tests/integration/firefox-browser-navigation.test.ts tests/integration/firefox-browser-locators.test.ts tests/integration/firefox-browser-secrets.test.ts
```

Final Firefox gate result: exit 0, 176/176 pass, zero failures, cancellations or skips. This includes all four shared suites once, 164/164 checks, the driver 8/8, the team-table regression 1/1 and refusals 3/3. The original real loss message, unknown input, later session loss and one-press assertions all pass after the browser-first crash correction. Team rows, all row texts, cells, named header, caption-named table and exact absent named-cell refusal pass. The four layout-cue fixtures retain the exact refusal.

Started Firefox conformance once, selecting the whole Firefox parent and leaving engine opt-out empty. Its run artifacts are retained in `/tmp/retest-waits-validation-conformance.Ly09od`. Chrome and WebKit conformance are outside this requested gate.

```sh
sh .retest/scratch-waits-validation/gate.sh .retest/scratch-waits-validation/logs/firefox-conformance.log env RETEST_FIREFOX_ROUTE=launch-services RETEST_CONFORMANCE_OPT_OUT= RETEST_CONFORMANCE_KEEP=/tmp/retest-waits-validation-conformance.Ly09od node --conditions=retest-source --test --test-concurrency=1 --test-name-pattern='every conformance case ends as declared on Firefox' tests/integration/conformance.test.ts
```

Result pending. The retained workflow record reaches the exact unsupported Grace Hopper cell at `f08-lists.retest.ts:20`, after its row and positional-cell checks, with `role: 'cell'`. Artifact: `/tmp/retest-waits-validation-conformance.Ly09od/firefox/workflow/run/result.json`. This interim record does not replace the whole conformance gate verdict.

Firefox conformance completes with exit 0, 164/164 Node checks, zero failures, cancellations or skips. All 148/148 declared cases and 15/15 run-group checks match once. F8.1a matches the new exact named-cell refusal at `toBeVisible`; row and positional-cell checks now run and pass first. The artifact folder contains every group's stdout, stderr and run records. No Chrome or WebKit conformance run was selected by this command.

## Step 3: packaged media install

Pending. The prescribed integration file builds and packs a copied crate, uses cached dependencies offline, and transfers only its own stand-in over localhost.

A read-only SHA-256 inventory finds one shipped media source entry differing from `media-pins.ts`. Evidence: `logs/media-source-inventory.json`. This inventory did not build or install anything. The prescribed packaged test remains pending, and the manifest is unchanged.

Started the existing media installer/locator unit checks before changing any manifest entry:

```sh
sh .retest/scratch-waits-validation/gate.sh --unit .retest/scratch-waits-validation/logs/media-units-before.log node --conditions=retest-source --test --test-concurrency=1 --test-timeout=120000 tests/unit/media-install.test.ts tests/unit/media-locate.test.ts
```

Result: exit 1, 13/17 pass, four failures, zero cancellations or skips. All four failures start with the stale `media/src/jobs.rs` pin before later installer branches can run. The source belongs to the other worker and remains untouched. The required packaged gate has not started.

Started the prescribed packaged test through the lock with the stale pin still unchanged:

```sh
sh .retest/scratch-waits-validation/gate.sh .retest/scratch-waits-validation/logs/install-media-before.log node --conditions=retest-source --test --test-concurrency=1 tests/integration/install-media.test.ts
```

Result pending. This compiles the package, packs offline and builds only from cached crates.

Packaged failing-first result: exit 1, 1/4 pass, three failures, zero cancellations or skips. Package compilation and offline packing now succeed. The packed CLI exits 2 before Cargo because jobs.rs differs from its pin; the dependent prebuilt case has no binary, and the missing-Cargo case sees the same source refusal. The wrong-greeting checks pass. The outside-lane cause is the existing jobs.rs source change. That file remains untouched.

Refreshed only its installer SHA-256 and the aggregate allowlist digest. Every other shipped source hash, Cargo.lock, licence and notice hash is unchanged. The read-only inventory command is `python3 .retest/scratch-waits-validation/media-pin-inventory.py`; its saved output is `logs/media-inventory-before-final.json`. The new jobs.rs SHA-256 is `7e1b1d5775ea1509d315dc76f2bd90589bc3480c9a3bd690caa58c2d0f3e71db`; aggregate digest is `7a2be50a1a49443778fe24975c4615fb269a55dacfe55614173b8d862f9bb2cd`. Integrity checks, source allowlist and empty publisher-prebuilt pins remain intact.

Started installer/locator units after the pin refresh:

```sh
sh .retest/scratch-waits-validation/gate.sh --unit .retest/scratch-waits-validation/logs/media-units-final.log node --conditions=retest-source --test --test-concurrency=1 --test-timeout=120000 tests/unit/media-install.test.ts tests/unit/media-locate.test.ts
```

Media unit rerun result: exit 0, 17/17 pass, zero failures, cancellations or skips. Source integrity, changed-lock refusal, missing/old toolchain, uncertain cleanup, generation lock, damaged cache, licence checks and discovery all keep their original assertions. The packaged rerun remains required.

Started the packaged integration rerun through the lock after the source-pin correction:

```sh
sh .retest/scratch-waits-validation/gate.sh .retest/scratch-waits-validation/logs/install-media-final.log node --conditions=retest-source --test --test-concurrency=1 tests/integration/install-media.test.ts
```

Packaged media rerun result: exit 0, 4/4 pass, zero failures, cancellations or skips. The packed copy alone compiles, packs offline, builds the locked crate from cached dependencies into a fresh target/cache, runs protocol 2, records the checked source/target/binary/licence identity and releases its generation lock. It discovers and reuses the installed binary with Rust absent from PATH. The localhost-only pinned stand-in, bad checksum/lock/toolchain/encoder and wrong-greeting cleanup checks pass unchanged.

Recorded target is `aarch64-apple-darwin`, Rust is `1.98.1` from Homebrew, and binary SHA-256 is `77d304c68867ceea7fe8fb1a8becb76d159ea2dfac4113e3f2d87fe39c5e45e7`. The workspace package remains private and its existing version is `0.0.0`, recorded accurately as `installedBy`; the media version is `0.1.0`. Host ffmpeg is 9.0.2 at `/opt/homebrew/bin/ffmpeg`, reports GPL version 3 or later, and supplies the tested raw/PNG/JPEG, libx264/mp4 and libvpx/webm prerequisites. Retest ships no ffmpeg. No publisher artifact or registry dependency was downloaded.

## Final checks

Started the complete declared typecheck command through the lock:

```sh
sh .retest/scratch-waits-validation/gate.sh .retest/scratch-waits-validation/logs/typecheck.log npm run typecheck
```

Result pending. This command checks the main tree with both declared TypeScript compilers and the example project with TypeScript. No second heavy command is queued.

First typecheck exits 2 at three errors in this lane's new protocol-failure tests: the shared fixture helper returns OwnedPage, whose contract has no dispatch method. The real fixture is FirefoxPage. Added an explicit instance assertion before dispatch, narrowing to the actual class without widening a type or changing a failure/input assertion. The first compiler's failure prevented the second compiler and example check from running in that attempt. Log: `logs/typecheck.log`.

Started the two affected unit cases and the complete typecheck rerun:

```sh
sh .retest/scratch-waits-validation/gate.sh --unit .retest/scratch-waits-validation/logs/firefox-protocol-typed-final.log node --conditions=retest-source --test --test-concurrency=1 --test-timeout=120000 --test-name-pattern='Firefox dispatched protocol failure' tests/unit/early-browser-waits.test.ts
sh .retest/scratch-waits-validation/gate.sh .retest/scratch-waits-validation/logs/typecheck-final.log npm run typecheck
```

Affected typed unit cases pass, exit 0, 2/2, zero failures, cancellations or skips. Complete typecheck rerun passes, exit 0: both declared compilers check the main tree, and TypeScript checks the example project. No production source changed after the green integration gates.

Started the declared proof typechecks through the lock:

```sh
sh .retest/scratch-waits-validation/gate.sh .retest/scratch-waits-validation/logs/typecheck-proofs.log npm run typecheck:proofs
```

Result pending. This checks Firefox, WebKit, native and media proof projects with both declared compilers.

Proof typecheck result: exit 0. All eight compiler/project checks pass. No further source change was made after the green main/example and proof typechecks.

Final read-only audit commands:

```sh
python3 .retest/scratch-waits-validation/record-descendants.py
python3 .retest/scratch-waits-validation/audit-processes.py > .retest/scratch-waits-validation/logs/owned-processes-final.json
python3 .retest/scratch-waits-validation/media-pin-inventory.py > .retest/scratch-waits-validation/logs/media-inventory-final.json
```

The process audit checks the recorded pid, birth and full command; a changed command is reported instead of silently discarded. Launch Services Firefox identities were captured through their matching launcher/browser owner records and their recorded descendants. Audit exits 0: 227 recorded identities, zero live owned processes and zero changed-command candidates. Test cleanup checks passed, and the retained conformance artifacts are data only. The final media inventory has all 21 source/lock/licence/notice hashes matching the manifest and the aggregate digest. No heavy command remains queued or running.

Final implementation changes are the browser-first verified Firefox crash helper; the native-table data-cue guard; the two media pin values; their unit/integration regressions; the controlled-clock native stability fixture; the narrow F8.1a declaration; and the cited Firefox proof/guide lines. The original early-waits production implementation is retained. Runner, evaluation, capture, media crate/client, shared ownership and the excluded browser/native process files were not edited by this lane.

## Unverified

The native full suite retains one failure: `tests/unit/native-processes.test.ts:690`, the required `the stop reads the pid it signals` assertion. Its production source and test belong to the other worker and remain unchanged by this lane. All this lane's assigned final gates otherwise finish green. Current package metadata remains private. Other hosts, browser builds, native devices, actual recording sessions and Firefox's default spawn route were not exercised. This lane verified packaged installation and discovery; it did not run the other worker's recording lifecycle, evaluation work or native integration proofs.
