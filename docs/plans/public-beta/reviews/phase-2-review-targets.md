# Phase 2 review: Electron, Azure provider, fixtures, process ownership, the phase's claims

## Findings, most severe first

**T-1, high, new.** `tests/integration/cross-platform-service.test.ts:65` and `tests/integration/electron-web-flow.test.ts:117`
- **Claim:** both register `t.after(() => signalGroup(pid, 'SIGKILL'))` for a service the test spawned itself. Since 9b38691, `signalGroup` throws for any group this process did not launch through `ChromiumProcess` (`src/browser/chromium-process.ts:211-212`).
- **Failure:** any test that starts the service fails in its after hook with "Process group N has no recorded launch ownership in this process, so it was not signaled." I ran "signs in only the seeded accounts…" under the lock and it failed exactly so, at line 65. By reading the code, the three Electron-to-web tests never stop their service otherwise, and neither do the service tests that skip `service.stop()`. Those services stay running after the run, detached on loopback ports.
- **Effect on the record:** the fixtures record's "16 of 16" and the Electron record's two-app flow do not hold on the committed tree.
- **Fix:** end the service through its `ChildProcess` handle or an `OwnedProcessGroup` the test records, as `cli-harness.ts` now does.

**T-2, medium, new (a third rule beside identity-fix item 1).** `src/native/processes.ts:534,543,608` and `src/native/session.ts:461-463`
- **Claim:** `endRecorded`, `killRecordedNow` and `#owns` identify a process by pid and exact command, with no start time. That breaks the rule that identity is pid plus start time.
- **Failure 1:** a runner or app pid is reused by a new process with the identical command line, as executor and fixture launches have. `killRecordedNow` in an exit hook (`macos-app.ts:128`, `executor-process.ts:101`, `ios-simulator.ts:549`) SIGKILLs the newcomer.
- **Failure 2:** an exiting app reads as `(TaskDesk)` and is classed `'other'`. `endProblem` then reports nothing left while the process may still be present.
- **Fix:** carry `startedAt` in `RecordedProcess`, compare with `sameProcessIdentity`, and treat a reading that cannot show arguments as unreadable, not as `'other'`.

**T-3, medium, held identity-fix item 1 (Rust part).** `media/src/process_ownership.rs:33-35,126-128`
- **Claim:** `matches` still requires exact command equality.
- **Failure:** in `Flow::NoFrames` (`recording.rs:628`), stdin closes, the fake or real ffmpeg begins exiting, and `stop_encoder` reads it as `(ffmpeg)` in a non-zombie state. The result is "recorded encoder process N changed identity and was left alone", and `recording.rs:736-739` turns `no_frames` into `encoder_failed`.
- **Fix:** port the TypeScript `unreadableCommand` rule.

**T-4, medium, new.** `src/shared/metadata-process.ts:42,99,114` and `metadata-process-worker.ts:15,28`
- **Claim:** `bridgeFailure` is never cleared. A worker that fails to answer within 6 s, exits or errors makes every later `readMetadataProcess` throw for the life of the process. The same happens for every later query if one `ps` child never closes, because `unresolved` stays set.
- **Failure:** in a long-lived host, such as the planned Rehearsal runner, one stalled read under load means:
  - every later `signalReport` sends nothing;
  - `remains()` stays true forever, so leases and Electron data folders are never freed;
  - exit hooks kill nothing, and every browser and app outlives Retest.
- **Fix:** after a failure, start a fresh worker for the next query, keeping the failed reading's problem, and report a stuck child without disabling all reads.

**T-5, medium, held identity-fix item 2 (concrete victim).** `src/runner/app-server.ts:128,151-152` with `src/shared/process-ownership.ts:234-237`
- **Claim:** the server is `spawn(command, { shell: true })` and captured immediately. bash replaces itself with the last simple command (`sh -c "node server.js"` keeps its pid with a new command line).
- **Failure:** under load, the record holds `/bin/sh -c node server.js` and the later reading is `node server.js`. Both are readable and differ, so SIGTERM and SIGKILL are refused, the server keeps running past the run (the exit hook refuses too), and the run reports `cleanup_failed`.
- **Fix:** record the server only after its first reading where the command no longer starts with the shell, or allow a single recorded launch-to-command change for the shell's own root.

**T-6, medium, held agent-session item 4 (still applies).** `src/shared/process-ownership.ts:106-109`, `src/browser/chromium-process.ts:127,133-134,160-161,346`, `src/browser/browser.ts:81,133,140-144`
- **Claim:** renderers spawned by `newPage` are never recorded until close. If the main process dies first, through a crash or an outside kill, its unrecorded children move to launchd.
- **Failure 1:** `capture()` reports "contains processes whose launch ownership could not be verified". `close()` throws `cleanup_failed` even after they exit on their own; the comment at `agent-capacity.test.ts:136-138` acknowledges this.
- **Failure 2:** if one such child hangs, it is never signalled. `#awaitGone` and `waitForOwnedExit` then poll forever, with a roughly 40 ms synchronous `ps` every 25 ms, and `gone`/`whenFree` never settle.
- **Fix:** call `recordDescendants()` after each `newPage` and on disconnect, and settle "unknown member gone" problems by a later proof of absence, as the native code does.

**T-7, medium, new.** `media/tests/process.rs:684-745,747-768`
- **Claim:** `cargo test` in `media/` is red.
- **Failure 1:** the two forking-wrapper tests fail whenever they run in parallel (the default); "the wrapper started no child" failed 3 of 3 times. They pass alone and with `--test-threads=1`.
- **Failure 2:** `an_output_path_in_use_is_refused_by_name` races. `server.rs:228-238` checks the `.partial` file before the running recording, so the refusal text depends on whether the fake already opened the file. It failed in serial and in parallel runs.
- **Records:** no Phase 2 record shows a cargo run after 9b38691 changed `recording.rs`, `encoder.rs` and `process_ownership.rs`.
- **Fix:** assert only `code: output_in_use`, and find why parallel media processes lose the wrapper's start.

**T-8, medium, held Electron-lane open item.** `src/runner/secrets.ts:106-108`
- **Claim:** a secret is allowed on any origin among all of the test's apps' base URLs plus `secretOrigins`, whichever app the fill targets. On Electron the origin is whatever the app serves under `protocol.handle`.
- **Failure:** a test with `web: chrome({ baseUrl: 'https://bank.example' })` and any Electron app lets that app present a page "on" `https://bank.example` and receive the password. The guide states this (lines 308-310), but the invariant that secrets stay host-controlled is not enforced.
- **Fix:** for an Electron target, require `secretOrigins` to name the Electron app explicitly.

**T-9, medium, new (record honesty).** `docs/plans/public-beta/progress.md:133-142,146`, `proofs/fixtures.md:100`, `proofs/electron.md:7,123`
- **Claim:** every integration and real-target claim of the phase predates 9b38691. That commit landed with only typecheck and unit results.
- **Failure:** on the committed tree:
  - the fixture suite and the Electron-to-web flow cannot pass (T-1);
  - Chrome closes were refused 8 of 10 times until the uncommitted fix;
  - the media tests are red (T-7).

  The lane rows still say "Done" with pass counts.
- **Fix:** rerun and record the integration, proof and cargo gates on the committed tree, or mark the rows "not re-run after 9b38691".

**T-10, low, held (two) plus new.** `docs/guide.md` statements now out of date:
- line 215, 255: helpers unfinished (held);
- lines 215, 261, 457: native secret input refused (held);
- line 253: "Pair one native app with web apps", while the reference flow pairs phone, desk and web;
- line 458: "The parent does not refuse a second command itself", contradicted by `running-test.ts:374-379`;
- line 919: "no Azure deployment has judged anything yet";
- line 908: the `/openai/v1` and `services.ai.azure.com` shapes called untested, though the live gate used one;
- line 320: the two-app Electron check, which now fails in teardown;
- line 186: Firefox has no driver (the current tree routes it, Phase 3).

**Fix:** correct each sentence.

**T-11, low, new.** `proofs/evaluation.md:285` and `guide.md:919`
- **Claim:** both say no Azure deployment judged anything. `progress.md:135` says the live gate passed, and `/tmp/retest-azure-live-gate-2.log` shows "live provider gate … Azure deployment ✔", but no record cites that log.
- **Failure:** a reader of the record cannot find the evidence, and it is in an ephemeral folder.
- **Fix:** record the run, its command and its log in `evaluation.md`.

**T-12, low, held Azure open item.** `src/evaluation/ai-sdk.ts:257-258` and `attempt.ts:446`
- **Claim:** when the provider answers but `readAnswer` fails, the warnings are dropped and the record's `sampling` is "as given".
- **Failure:** a reasoning-model deployment drops `temperature`, the answer is malformed, and the error record claims `temperature` was sent.
- **Fix:** compute unsent settings before validation and attach them to the error.

**T-13, low, new.** `fixtures/cross-platform/service/store.ts:131-133` and `README.md:30,86`
- **Claim:** `update` merges onto the newest version, including one hidden by `--broken-sync=<from>:<to>`. The service's own test at `cross-platform-service.test.ts:479-486` shows a later phone change carrying the web's `done` to the desk. The README's "never reach" is false.
- **Failure:** a broken-sync reference flow with any later phone write would pass the desk check.
- **Fix:** document it, or have merged versions preserve the hidden fields.

**T-14, low, held harness-fix item 1 plus new.** Other tests that still signal groups without an ownership check:
- `tests/integration/m2-guarantees.test.ts:138` still fails; I ran it. Its line 273 expectation passed in my run.
- `run-interrupt.test.ts:92`, `reference-flow.test.ts:59` and `native-diagnostics-wired.test.ts:63` call `signalGroup` on foreign groups on their leak or timeout paths, so they throw instead of cleaning up.
- `matrix-lifecycle.test.ts:74`, `session-contract.test.ts:109` and `m3-press.test.ts:78` send a raw `process.kill(-pid)` with no check.

**Fix:** use the recorded-ownership path, or end a deliberate outside kill by pid after a `sameProcessIdentity` read.

**T-15, low, new.** `src/shared/process-ownership.ts:161-184,241-243`
- **Claim 1:** the window between the per-record `ps` snapshot and `kill` is the length of a `ps` run (about 40 ms here). There is no pidfd on macOS.
- **Claim 2:** any readable command of 16 characters or fewer in parentheses or brackets, such as Linux `(sd-pam)` or a self-titled process, counts as unreadable and therefore matches.
- **Failure:** a pid reused within the same second by such a process is signalled.
- **Fix:** re-read with `ps -p <pid>` immediately before signalling; use `pidfd_send_signal` on Linux.

**T-16, low, new.** `src/config/read-apps.ts:293-297`
- **Claim:** `ELECTRON_LOG_FILE` and `ELECTRON_ENABLE_LOGGING` are withheld, but the equivalent switches `--enable-logging=file` and `--log-file=<path>` in `args` are accepted.
- **Failure:** the window's console lines, typed values among them, go to a file Retest never redacts.
- **Fix:** refuse those switches by name, as `--user-data-dir` is refused.

**T-17, low, held Electron-lane open item.** `src/browser/electron.ts:581-584`
- **Claim:** `test.setup` on Electron runs its body, then fails `unsupported`.
- **Fix:** refuse it at planning.

**T-18, low, held identity-fix item 3.** `tests/integration/browser-lifecycle.test.ts:393`
- **Claim:** `await once(child.stdout, 'data')` has no bound.
- **Failure:** a child that dies without printing hangs the file forever.
- **Fix:** race it against the child's exit and a timer.

**T-19, low, new.** `src/browser/profiles.ts:36-43`
- **Claim:** `removeStaleProfiles` now removes nothing.
- **Failure:** every killed run or refused close leaves a Chrome profile, cookies included, in `$TMPDIR` forever. Two are there now, from 00:40 and 03:06 today.
- **Fix:** remove a profile once its owner pid is gone and no process names the folder.

## Held findings in scope

| Held item | Status today |
| --- | --- |
| Phase 3 Playwright lane 1 | Fixed by the uncommitted `sameProcessIdentity` and `unreadableCommand` (`process-ownership.ts:234-243`). `browser-ownership.test.ts` passed 20 of 20 closes. The comparison script itself was not rerun. |
| Phase 3 builds lane 1 | Fixed by the same change. `doctor` was not rerun by me. |
| Identity-fix lane 1 | Fixed in `firefox/orphans.ts:163` and `webkit/sweep.ts:69`. Still applies in Rust (T-3). Native holds a third rule (T-2). |
| Identity-fix lane 2 | Still applies by design (`process-ownership.ts:234-237`). Concrete victim in T-5. |
| Identity-fix lane 3 | Still applies (`browser-lifecycle.test.ts:393`). |
| Agent session lane 4 | Still applies (T-6). |
| Agent session lane 5 | Not reproduced. Most likely the old harness `signalGroup` teardown, which `cli-harness.ts:247-255` replaced. `resources.test.ts` was not run. |
| Harness fix lane 1 | Line 138 still applies (ran: fails). The line 273 expectation passed. |
| Harness fix lane 3 | Still applies by design. The harness records only descendants, and a Firefox started through Launch Services has parent pid 1 (Phase 3). |
| WebKit driver lane 4 | Still applies, cause not established (`webkit/process.ts:446-450`). The same 1 s bound exists at `chromium-process.ts:174,294-303`. |

## Phase 2 verification bullets

1. **Reference flow passes on real iOS, Chrome and macOS; broken sync fails at the intended check.** Met by a real run on 4 October (`proofs/reference-flow.md`, `/tmp/retest-reference-flow-2.log`, 2 of 2). Not rerun on the current tree.
2. **Native locators, input and checks pass and fail; stale refs, denied permissions, crash, lost executor, cancel after dispatch.** Real runs for all but denied permissions. The suite only asserts the fixtures declare no privacy keys (`native-interaction.test.ts:92`). Partly met.
3. **Shared device, desktop or lock never overlap unsafely; partial setup releases.** Locks were tested on real Chrome. Desktop and device leases were tested against a stand-in runtime only. Partly met, native part by fake only.
4. **A second run starts isolated and cannot pass from stale state.** Real runs: native relaunch isolation, random task ids, a fresh service per test, a fresh Electron folder (verified today). Met in part.
5. **Typed named-app API, no hosted account.** Met (`reference-flow.retest.ts`).
6. **Native visual evaluation on actual pixels; logs and network with the right identity; honest unavailable status.** iOS pixels were real, judged by a fake pixel-hash judge. macOS screenshot checks were refused by an overlapping window, so not met on macOS. Logs and network passed 1 of 1 on real apps. Partly met.
7. **Electron through the same locators, actions and checks as Chrome, with passing and deliberate failures; windows, versions and unavailable capabilities recorded; nothing left running.** Met by a real run: I ran `electron.test.ts`, 5 of 5, nothing left. Only a subset of the API, and one deliberate check failure. The Electron-to-web flow test now fails in teardown (T-1).

**Dependency rule:** zero runtime dependencies. `ai` and the three `@ai-sdk/*` packages are optional peers. Nothing under `src/` imports Playwright, Appium, Selenium or Electron. Electron's licence and sha256 are recorded. The WebKit install refuses for missing notices.

**Guide and docs:** the Phase 2 additions to the guide carry no plan codes. "Milestone N" at guide lines 3, 7, 361, 1057 and 1232 predates the phase. The proofs records carry plan codes (`electron.md:3` "Phase 2 item 8", `fixtures.md:3`) and record dates.

## What I ran

- Unit, `node --conditions=retest-source --test`:
  - `process-ownership`, `metadata-process` and `browser-chromium-process`: 18 pass.
  - `evaluation-ai-sdk`, `config-electron` and `runner-electron-target`: 68 pass.
- `cargo test` in `media/`:
  - library tests: 42 pass.
  - process tests, first run: 24 of 25 (`output_in_use` failed).
  - process tests, second run: 22 of 25 (that test and both forking tests failed).
  - the forking pair run alone in parallel: 0 of 2, twice.
  - the pair with `--test-threads=1`: 2 of 2.
  - all with `--test-threads=1`: 24 of 25.
- Under `lockf -t 0 /tmp/retest-heavy-gate.lock`:
  - `cross-platform-service.test.ts` with `--test-name-pattern="signs in only the seeded accounts"`: failed at line 65.
  - `browser-ownership.test.ts`: 2 of 2.
  - `electron.test.ts`: 5 of 5, with no Electron or profile process left.
  - `m2-guarantees.test.ts`: 6 of 7, failing at line 138.
- 150 samples of `ps -ww -axo …`: no line the TypeScript parser rejects. One read takes about 40 ms.

## What I could not verify, most important first

1. The reference flow and the native suites on the current tree (simulator and desktop, not run).
2. The cause of the media forking-wrapper failures in parallel.
3. Linux behaviour: the bracket form, and zygote-forked renderers that change their title and would be refused.
4. A live Azure rerun (no keys, no live calls). Only the old log exists.
5. Whether the SDK forwards `api-key` or `x-api-key` across a redirect to plain http.
6. Whether the app-server shell race (T-5) is hit in practice.
7. Whether 9b38691's code was in the tree when each lane ran its integration tests.
8. `electron-web-flow.test.ts` was not run; the same teardown failure was shown on the fixture service file.

Outside scope: Firefox processes from the Phase 3 lane, started 07:31 with parent pid 1, are still running. I left them alone.
