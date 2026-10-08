# Integration leftovers

The required 129-file whole-list command passes and exits naturally with code 0: 1,663 tests, 1,659 passed, zero failed or cancelled and four documented host skips. The original 12 failures have eight stale-rule verdicts and four fixture/environment verdicts; no product regression is demonstrated and no product file changed in this lane. Firefox's hang is a fixture cleanup defect: an earlier failed hook prevented two HTTP servers from closing. Cleanup now attempts every hook, retains failures and checks active resources. The package typecheck passes.

The original run is `.retest/clean-run/integration-browsers.log`, with 1,584 tests, 1,562 passed, 12 failed and 10 skipped. Its list is `.retest/clean-run/integration-browsers.list`. Contrary to the task summary, its Firefox capture input case failed in teardown with a metadata output-limit refusal. The reported process hang is investigated separately.

All heavy commands in this lane use `.retest/integration-leftovers/locked.sh`, which retries `lockf -t 0 /tmp/retest-heavy-gate.lock` and checks benchmark candidates inside the lock. Process dispatch records are `.retest/integration-leftovers/processes.log`. No benchmark, download or git mutation is authorized or run.

## Reproductions

`agent-sessions.test.ts` alone on Chromium completed, exit 0, 11 tests, 9 passed, 0 failed, 2 skipped. Log `.retest/integration-leftovers/logs/agent-sessions-before.log`. The two failing copies in the original log are imported by `agent-firefox.test.ts` and `agent-webkit.test.ts`; those files are queued separately.

The package helper `tests/integration/cli-harness.ts:864` already runs `npm run build` then `npm pack` in a fresh folder before every package suite. The original package-smoke failure lists the deliberately shipped media crate and notices. `codex/phase-4/media-install-report.md` records their addition to `package.json.files`. `fix-agent-report.md` records the deliberately added `./agent` export. A stale dist or tarball verdict would be unsupported for these two failures.

## Original skips

| File or imported suite | Test | Original reason | Original verdict and correction |
| --- | --- | --- | --- |
| agent-firefox | A reference acts only on the one element its look listed | Firefox pins elements; next case exercises it | Coverage defect. Assert the pinning rule in this case. |
| agent-firefox | Chrome live frame source | Firefox does not speak Chrome screencast | Coverage defect. Assert Firefox screenshot-loop mode and actual PNG frames. |
| agent-sessions | A reference acts only on the one element its look listed | Chromium pins elements; next case exercises it | Coverage defect. Assert the pinning rule in this case. |
| agent-sessions | Driver with no live frame source | Chrome supplies a source | Coverage defect. Assert its exact mode, identity and stopped state. |
| agent-webkit | A reference acts only on the one element its look listed | WebKit pins elements; next case exercises it | Coverage defect. Assert the pinning rule in this case. |
| agent-webkit | Chrome live frame source | WebKit does not speak Chrome screencast | Coverage defect. Assert WebKit screencast mode and actual JPEG frames. |
| evaluation-ai-sdk | Live Anthropic provider | RETEST_EVALUATION_ANTHROPIC_KEY absent | Documented host limitation. No provider call. |
| evaluation-ai-sdk | Live OpenAI provider | RETEST_EVALUATION_OPENAI_KEY absent | Documented host limitation. No provider call. |
| evaluation-ai-sdk | Live Azure deployment | Key, resource or base URL, and deployment absent | Documented host limitation. No provider call. |
| evidence-timelines | Every app flow timeline has recorded pixels | RETEST_EVIDENCE_TIMELINES absent | Coverage defect. Generate a fresh real flow rather than depend on caller-supplied folders. |

## Investigation findings

The evidence helper defaults to one shared `.retest/evidence-targets/artifacts` folder. The original pixel-artifacts failure contains two prior `pass` calls before its expected three calls. Its judge-call file is appended, not truncated. The isolated run will determine whether a fresh per-process proof folder resolves the interference without changing the exact expected call list.


## Failure verdicts and changes

| Original failure | Verdict and evidence | Correction |
| --- | --- | --- |
| agent-sessions imported by agent-firefox, driver with no live frame source | a, stale. Isolated Firefox file reproduces one failure. The capture-sources report documents the Firefox screenshot-loop contract hook. | Assert exact screenshot-loop mode, PNG signature, owner/session identity and no delivery after session end. |
| agent-sessions imported by agent-webkit, same refusal | a, stale. Isolated WebKit file reproduces one failure. The capture-sources report documents its screencast hook. | Assert screencast mode, JPEG signature, owner/session identity and no delivery after session end. |
| browser-launch, silent program cleanup | a, stale fixture expectation under the documented presence-first ownership rule (`unit-ownership-conflicts-report.md`). Both baseline and diagnosis runs fail. The diagnosis message records a changed launch-root command reading. The script uses `exec sleep 30`, changing its recorded shell into another command. The new rule intentionally refuses that changed identity; the silent-program cleanup case must retain its original recorded identity. | Keep the launched shell and run its sleep child without exec. All timeout, exact message, group-gone and profile-gone assertions remain. No signal authority changed. |
| secrets-across-lanes, first test expected passed | a, stale. Diagnosis fails with the exact secret screenshot withholding reason for password. The evaluation-closeout report documents applying pixel policy even without recording. | Require an advisory withheld screenshot error and zero evidence, then navigate to a safe document and require the original credential-redaction judge checks. All file, process, report and inspect privacy assertions remain. |
| package-smoke, exact tarball file list | a, stale. Isolated run reproduces the added crate and licence entries. Its helper rebuilt before packing. The media-install and report-jump-and-notices reports document the shipped files. | Pin the exact expanded outside-dist list. Keep no TypeScript source, no runtime packages, built source correspondence, installed declarations and real CLI outcome checks. |
| matrix-reporting, retained killed profile | c, fixture interference. Isolated run reproduces it. The intended retained profile shares the next run's temporary folder, while finishRun requires no Retest entries there. | Check exactly the old retained profile and no new folder, both runs' process groups gone, no process using the folder and no saved state. General cleanup helper stays strict. |
| m2-package, exact exports | a, stale. Isolated run reproduces the added ./agent export, documented in fix-agent-report.md. Its helper rebuilds and packs. | Require ./agent in both exact export lists, including its source/types/default conditions. |
| install, missing WebKit licence refusal | a, stale. Isolated run reproduces the checksum-only refusal. report-jump-and-notices-report.md documents supplied notices and the sole absent archive checksum. | Require the exact checksum refusal, all nine supplied notices and each notice's actual SHA-256. Keep zero requests and no cache writes. |
| evidence-pixel-artifacts, two extra judge calls | c, shared evidence folder. The original log shows earlier pass calls in the appended judge log. Isolated rerun instead fails because its pixels folder already exists. | Give every test process a fresh proof folder by default. Exact three-call order, overwrite refusal, withheld evidence, privacy and pixel assertions stay unchanged. Explicit evidence folders still refuse overwrites. |
| electron, unexpected initial navigation | c, fixture startup timing. File alone passes 5/5. The fixture starts loadURL without awaiting it, so initial commit can land before or after the driver subscribes. | Type the secret as the first action before URL assertions can wait. Preserve the original exact empty navigation list and add exact first-action and action-sequence checks. Keep URL, task, typed secret and privacy checks. A new strict rerun is queued. |
| consumer-loading, JSX message | a, stale original message, with concurrent build failure in first isolated attempt. The resolver's documented refusal now names the import and its selected .tsx file. The isolated package build stops on the active criterion builder's protocol schema typing errors, so none of its eight cases ran then. | Pin the complete refusal with the import path and selected source path. Require another fresh build/pack run after the schema edit settles. |
| capture-firefox, input proof teardown | c, host metadata refusal in the original run. The isolated unforced run passes 5/5 and exits. The original exact refusal is a metadata output-limit error, not an input or capture failure. | Investigate the cleanup-refusal hang and retain strict handle cleanup coverage. No product ownership check or buffer bound changed. |

## Firefox hang investigation

Command dispatched through the lock:

```sh
env RETEST_FIREFOX_ROUTE=launch-services \
 RETEST_RESOURCE_LOG="$PWD/.retest/integration-leftovers/logs/capture-resources" \
 NODE_OPTIONS="--import=$PWD/.retest/integration-leftovers/resources.mjs" \
 node --conditions=retest-source --test --test-concurrency=1 tests/integration/capture-firefox.test.ts
```

Exit 0, five passed, zero failures or skips. Log `logs/capture-firefox-before.log` under `.retest/integration-leftovers/`. Active-resource and asynchronous creation-stack observations are `logs/capture-resources.102.jsonl`. Force-exit was not enabled. This establishes current normal cleanup, not the original hang's cause.

The current hypothesis is an open fixture HTTP server. Browser cleanup is registered before ticker-server and task-app cleanup. Node can stop later after hooks when an earlier one rejects. The queued fault probe runs the actual browser close, then throws the original cleanup-refusal class at the second close. It records asynchronous creation stacks, active resources and every probe PID. The probe owns its fixture-server objects and has a SIGUSR2 handler to close only those servers after the handle evidence is collected. That handler is diagnostic cleanup, never a passing-run exit workaround.

## Commands read so far

All log paths below are under `.retest/integration-leftovers/logs/`. Every isolated browser command is `env RETEST_FIREFOX_ROUTE=launch-services node --conditions=retest-source --test --test-concurrency=1 tests/integration/NAME.test.ts`, dispatched through the shared lock wrapper. Each log has an adjacent `.exit` file.

| NAME and log suffix | Tests | Passed | Failed | Cancelled | Skipped | Exit |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| agent-firefox-before | 28 | 25 | 1 | 0 | 2 | 1 |
| agent-sessions-before | 11 | 9 | 0 | 0 | 2 | 0 |
| agent-webkit-before | 28 | 25 | 1 | 0 | 2 | 1 |
| browser-launch-before | 10 | 9 | 1 | 0 | 0 | 1 |
| capture-firefox-before | 5 | 5 | 0 | 0 | 0 | 0 |
| consumer-loading-before | 8 | 0 | 0 | 8 | 0 | 1 |
| electron-before | 5 | 5 | 0 | 0 | 0 | 0 |
| evidence-pixel-artifacts-before | 1 | 0 | 1 | 0 | 0 | 1 |
| install-before | 13 | 12 | 1 | 0 | 0 | 1 |
| m2-package-before | 6 | 5 | 1 | 0 | 0 | 1 |
| matrix-reporting-before | 6 | 5 | 1 | 0 | 0 | 1 |
| package-smoke-before | 6 | 5 | 1 | 0 | 0 | 1 |
| secrets-across-lanes-before | 1 | 0 | 1 | 0 | 0 | 1 |

`browser-launch-diagnosis.log` has 10 tests, nine passed and one failed, exit 1. `secrets-across-lanes-diagnosis.log` has one failed test, exit 1. They add failure-message diagnostics without changing assertions.

`npm run typecheck`, through the lock, exits 2. `typecheck.log` records this lane's nonexistent action.started event usage, now corrected to action.completed ordering, plus concurrent protocol/evaluation.ts and Firefox diagnostics typing errors in the two other builders' files. Those files are untouched. The later compilers did not run after the first compiler failed.

## Cleanup-hook cause reproduced

`python3 .retest/integration-leftovers/benchmark-guard.py && node --test --test-isolation=none .retest/integration-leftovers/hook-repro.test.mjs` reproduces Node's cleanup ordering with only the built-in HTTP server and test runner. `logs/hook-repro-before.log` prints `resources after all test hooks ["TCPServerWrap"]`. The later server-close hook never prints its marker. The process remains alive after its one failed test. This is a controlled reproduction of the hook failure mechanism, not an observed resource dump from the original orchestrator process.

The fixture owner is recorded in `logs/hook-repro-owner.json`. A fresh UTC/C process reading matched its recorded command, and SIGUSR2 asked that process to close its own server. It then exited 1, one failed test, zero skips. No external process or socket was touched. The initial signal check rejected a full-path-versus-bare-node spelling mismatch and sent no signal; the next check matched the actual recorded command.

`tests/integration/capture-browser-proof.ts` now wraps only its capture cases. It attempts every registered fixture cleanup and reports all failures in an AggregateError afterward. The original body failure is retained by Node. No timeout, image, identity, frame mapping, input or media assertion changes. `capture-firefox.test.ts` also asserts no active socket, server, child, timer or filesystem watcher after close.

The real Firefox close-refusal probe uses a saved copy of the original capture fixture through a load hook, without reverting working source. It closes the real owned Firefox, then injects the same cleanup class at the second close. The first probe is still queued behind another worker's iOS evidence gate. Its result and handle creation stacks will distinguish the actual fixture server handles from a capture-source handle.

The helper-only after reproduction runs `python3 .retest/integration-leftovers/benchmark-guard.py && node --test --test-isolation=none .retest/integration-leftovers/hook-repro-after.test.ts`. It uses the exact cleanup wrapper copied from the current capture fixture. `logs/hook-repro-after.log` prints `fixture close ran` and `resources after all test hooks []`, retains the injected error inside AggregateError and exits naturally with one failed test, zero skips. `logs/hook-repro-after.exit` is 1. The failed outcome is required; cleanup cannot turn the fault into a pass. Two event-loop turns allow the server's close event and resource destruction to complete before the resource observation.

The final Firefox resource assertion allows already-closing handles to finish their event-loop destruction within a bounded observation. It still requires zero active sockets, servers, children, timers and filesystem watchers. It never closes or unreferences a leaking resource to make the assertion pass.

The after-file queue currently waits behind the native builder's evidence-ios gate. A read-only lock/process inspection found lockf 5128 and its Python supervisor, Node test parent/child and CLI descendants. They are another builder's processes and were neither modified nor signalled. That gate's output file was empty at the inspection. This is a shared-gate wait, not a passing or failed check in this lane.

## Exact original skipped names and reasons

- a reference acts only on the one element its look listed, through the look's own locator; one of several is refused by name and clicks nothing # the firefox driver pins elements, so one of several acts on its own node; the next case shows it
- Chrome's live frame source of a session carries the session's identity and keeps its frames encoded # a live frame source is Chrome's screencast, which firefox does not speak
- a reference acts only on the one element its look listed, through the look's own locator; one of several is refused by name and clicks nothing # the chromium driver pins elements, so one of several acts on its own node; the next case shows it
- a driver with no live frame source refuses one by name # Chrome gives a live frame source, which the test before this one exercises
- a reference acts only on the one element its look listed, through the look's own locator; one of several is refused by name and clicks nothing # the webkit driver pins elements, so one of several acts on its own node; the next case shows it
- Chrome's live frame source of a session carries the session's identity and keeps its frames encoded # a live frame source is Chrome's screencast, which webkit does not speak
- live provider gate, Anthropic: one text and one screenshot check against claude-sonnet-5 # unverified: RETEST_EVALUATION_ANTHROPIC_KEY not set, so Anthropic was not called
- live provider gate, OpenAI: one text and one screenshot check against gpt-5.5-2026-04-23 # unverified: RETEST_EVALUATION_OPENAI_KEY not set, so OpenAI was not called
- live provider gate: one text and one screenshot check against an Azure deployment # unverified: RETEST_EVALUATION_AZURE_KEY; RETEST_EVALUATION_AZURE_RESOURCE or RETEST_EVALUATION_AZURE_BASE_URL; RETEST_EVALUATION_AZURE_DEPLOYMENT not set, so no Azure deployment was called
- every app flow timeline has actual recorded pixels at its checks # requires retained real flow folders in RETEST_EVIDENCE_TIMELINES; unverified

The controlled real Firefox before and after close-refusal probes are queued consecutively inside one acquired gate. The after probe must retain the injected failure and exit on its own, with no cleanup signal.

The gate dispatcher exports `npm_config_offline=true` for package and SDK installs. The package suites already use `npm install --offline`; this also keeps the existing AI SDK cached-package path from fetching registry content during the final list. Local fixture HTTP traffic remains part of the tests.

## Real Firefox teardown refusal reproduced

The saved original fixture runs through the acquired gate with the same real Firefox capture cases and a post-close injected metadata refusal. `logs/capture-fault-before.log` completes all five case bodies but remains alive with two referenced `TCPServerWrap` resources. `logs/capture-fault-handle-evidence.json` records the async resource creation stacks. `logs/capture-fault-owned-signal.json` records the fresh PID/start/command identity of owned child 28626 and its two loopback listening sockets. There is no active capture timer or Firefox child at that observation. The remaining servers are the ticker and task-app fixtures registered after the rejected browser close.

SIGUSR2 asks only child 28626 to close its own tracked HTTP server objects. The unchanged fixture then exits 1 with six tests (including the file-level active-resource failure), three passed and three failed, no skips. The injected input-case cleanup refusal and new resource assertion both fail. The changing-pixels case also encounters an independent ffprobe EOF reading one captured PNG; that failure is retained in the log. No force-exit is enabled. The signal emits an automatic Node diagnostic dump; that owned dump is removed without reading its environment.

The fixed fixture probe now runs the same real close and injected refusal. It must retain the failure while draining the remaining hooks and exiting without a signal.

The fixed real Firefox refusal probe exits on its own: five tests, four passed, one failed, zero skips, exit 1. The one failure retains the exact injected metadata refusal inside AggregateError. The active-resource assertion passes without a signal. Log `logs/capture-fault-after.log`; owners `logs/capture-fault-after-owners.jsonl`; asynchronous observations `logs/capture-fault-after-resources.29886.jsonl`. This establishes a fixture-hook cleanup defect, not a Firefox capture object leak.

The first corrected Chromium agent-session run exposes another formerly skipped exact rule: a pinned single-node action records `pick: 0` in its locator. The new case initially expected the old unpinned locator shape. It now pins `pick: 0` exactly for the pinning branch and keeps the unchanged unpinned assertion for that branch. Its failing log is `logs/agent-sessions-after.log`. The three engine files will be rerun after the queued targeted checks.

## Completed targeted checks so far

| Log name | Tests | Passed | Failed | Cancelled | Skipped | Exit |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| agent-firefox-after | 28 | 27 | 1 | 0 | 0 | 1 |
| agent-sessions-after | 11 | 10 | 1 | 0 | 0 | 1 |
| agent-webkit-after | 28 | 28 | 0 | 0 | 0 | 0 |
| browser-launch-after | 10 | 10 | 0 | 0 | 0 | 0 |
| m2-package-after | 6 | 6 | 0 | 0 | 0 | 0 |
| matrix-reporting-after | 6 | 6 | 0 | 0 | 0 | 0 |
| package-smoke-after | 6 | 6 | 0 | 0 | 0 | 0 |
| secrets-across-lanes-after | 1 | 1 | 0 | 0 | 0 | 0 |

The two initial agent after failures are the exact pinned locator assertion above; their correction was loaded by the WebKit after run, which passes. The other completed checks pass without skips.

The first generated-timeline check fails, one test, zero passed, one failed, zero skips, exit 1. `logs/evidence-timelines-after.log` preserves the missing-result error. Its retained `artifacts-jf6jXd/fresh-flow.log` shows Node refusing a recursive test runner because the child inherited `NODE_TEST_CONTEXT` from the parent test worker. No flow ran. The child environment now removes only that test-runner context; every flow assertion and timeline requirement remains. A missing local fixture or executor fails this case, rather than becoming a new skip.

The independent child flow now runs: its Retest result passes, exit 0, and phone/web recordings decode. Its integration check retains four failures because the desk capture is unavailable and its forwarded-frame log does not exist. The unavailable recording names one overlapping layer-1000 window. This is the exact host limitation documented in `proofs/native.md` (Wispr Flow overlay) and `fix-native-lifecycle-report.md` (512×614 at 608,445, over the fixed TaskDesk frame 20,60,700,480). Log `logs/evidence-timelines-validated.log`; real result and events `.retest/evidence-targets/artifacts-di0U9P/fresh-flow/chromium-recorded/`. No capture or timeline assertion is changed to accept that missing recording. A current read-only owner/bounds check is next.

The original consumer expectation is reproduced with a loader selecting a saved HEAD copy of only that test file, preserving its import URL. `logs/consumer-loading-original-expectation.log` has eight tests, seven passed, one failed, zero skips, exit 1. Its package helper rebuilds and packs; the exact failure is the JSX message assertion. `logs/consumer-loading-after.log` has eight passed, zero failed or skipped, exit 0 with the complete new refusal pinned. This settles the stale-rule verdict independently of the earlier concurrent compiler failure.

All three agent validation files now pass with no skips: Chromium 11/11, Firefox 28/28, WebKit 28/28. `npm run typecheck` passes TypeScript 6, TypeScript 7 and the example compiler; `logs/typecheck-validated.log`, exit 0. The read-only window metadata command `node --conditions=retest-source .retest/integration-leftovers/window-state.ts` runs through the lock and exits 0; `logs/window-state.json` records the main screen and confirms Wispr ownership, with its current window off-screen at 7963,445,512,614. No foreign window or process is moved or ended by this lane.

The timeline fixture now checks for the documented Wispr host limitation by the current window owner, layer and actual overlap with its exact TaskDesk fixture frame. Only that identified, documented host limitation can skip this real-flow case; a different app or an unknown window still fails the real recording checks. An off-screen Wispr window does not skip. The real flow is rerun with the currently clear frame.

The next timeline run sees Wispr back at its documented overlapping bounds and skips by its exact owner/layer/overlap reason: one test, zero failed, one documented host skip, exit 0 (`logs/evidence-timelines-clear-host.log`). The three-app recording timeline remains unverified on this host while that window overlaps the fixture. All original timeline assertions remain.

A concurrent browser-pin lane now changes `install.test.ts` and the browser pin sources, recorded in `pin-checksums-report.md`. The subsequent typecheck fails on a literal newline inside its new `.split` string (`logs/typecheck-final.log`). This lane corrects only that escape. Its three new cached publisher-archive checks would otherwise skip for an unset fixture environment variable; they now default to the existing local proof cache and fail if the named archive is absent. All hash, record, no-extra-fetch and doctor assertions remain. No publisher download is issued by this lane. The revised install file and typecheck are queued for another check before the full list.

The revised install run completes 16 tests: 11 passed, five failed, zero skips, exit 1 (`logs/install-current.log`). Four expectations loaded during the pin-table edit still see the old missing-checksum refusal. The disk-image case additionally fails its global temporary-folder assertion on the existing empty `retest-install-image-E3vZz5` folder made before this run. That folder is left alone. This file now owns a fresh TMPDIR for its in-process stand-ins and mounts and requires the same exact empty mount-point list there. Its cancelled-attach check likewise scans only that owned temporary root; all attach/detach and installed-app assertions remain.

The pin lane is instructed to delete its downloaded archives. This lane stages temporary local copies of the three macOS archive fixtures for its install and full-list checks, verifies their size and SHA-256 against the current pins, then removes its copies after the checks. The dispatcher supplies that owned fixture folder through `RETEST_TEST_BROWSER_ARCHIVES`. This is a local copy, with no publisher fetch. `logs/staged-archives.json` records the input and output paths and digests.

`logs/typecheck-current.log` stops on the concurrent pin unit file accessing `refusal.lead` after narrowing refusal to undefined. That unit file belongs to the pin lane and is untouched here.

The temporary archive stage passes and records all three exact pin digests in `logs/staged-archives.json`; its command log is `logs/staged-archives.log`, exit 0. The latest install run has 16 tests, 13 passed, three failed and zero skips, exit 1 (`logs/install-stage.log`). All three cached real-archive install/list/verify/repeat checks succeed and then fail at doctor because the new fixture places baseUrl on the target. The pin lane records the same failure and corrects that fixture to the app-level rule in `pin-checksums-report.md`. The mount-point isolation case now passes. A fresh install file run checks the corrected config.

The source compiler still stops only on the pin unit file's redundant narrowed `refusal?.lead` access (`logs/typecheck-stage.log`, exit 2). A coordination question identifies the exact one-line assertion-preserving correction; the unit file is outside this lane's assigned scope.

The install verification rerun again completes 16 tests, 13 passed, three failed, zero skips, exit 1 (`logs/install-verified.log`). The pin lane's next correction serves an actual readiness response at `/doctor-app` and pins one archive request plus one readiness request. The earlier app-level URL had no server, which doctor correctly refused. The newest fixture is queued as `logs/install-final.log`; only its success permits the full 129-file browser list command to start.

## Final full-list gate queued

The newest install file passes: 16 tests, 16 passed, zero failures, cancellations or skips, exit 0. `logs/install-final.log` includes the real cached publisher bits, all installed-file and notice hashes, list/verify/repeat/doctor, exact archive/readiness request counts, isolated mount-point cleanup and the eight cancelled-attach timings. No assertion is weakened.

The full command is queued once through the lock, without force-exit:

```sh
env RETEST_FIREFOX_ROUTE=launch-services node --conditions=retest-source --test --test-concurrency=1 $(cat .retest/clean-run/integration-browsers.list)
```

The dispatcher supplies the temporary local archive fixture folder and `npm_config_offline=true`; no test opts out an engine or required check. Log `.retest/integration-leftovers/logs/integration-browsers-final.log`; eventual exit file `.retest/integration-leftovers/logs/integration-browsers-final.exit`. The unchanged list contains 129 files. Full counts and natural exit are pending.

The running full list passes all five Firefox capture cases and advances through WebKit capture into CDP and CLI files. Its Firefox active-resource after hook passes. This is the whole-tree natural-exit check for the previously hanging worker; no force-exit or signal is used in the full run. No failure or skip is reported at this milestone.

The first full list reports an additional WebKit conformance S6 failure, plus its containing engine case. S6 still requires the original soft-check failure, continued click, exact source location and 300 ms deadline facts. No declaration or assertion is edited. Its complete differences will be read from the full-run footer and the file will be reproduced through the gate with retained raw run records after this full command finishes. This is a newly observed full-run failure outside the original 12, not a green full gate.

The full list then stalls after all diagnostics-collector bodies finish. This worker has no TCP listener; `ps` and `lsof` show its live owned Chrome root 16532 beneath test worker 16467, plus the debugging Unix pipe. The ownership chain leads to recorded full-list root 91112. The unrelated workerd on TCP 9229 is left untouched. `logs/diagnostics-full-owned-stop.json` records complete PID, parent, group, start identity, command and descriptors before a second matching reading authorizes SIGTERM to only Chrome 16532. Ending that owned root lets the worker exit and the full list advance, retaining the diagnostics failure. This attempt therefore cannot count as the required natural-exit full gate. No test failure is suppressed.

## Latest completed file checks

| Log name | Tests | Passed | Failed | Cancelled | Skipped | Exit |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| agent-sessions-validated | 11 | 11 | 0 | 0 | 0 | 0 |
| agent-firefox-validated | 28 | 28 | 0 | 0 | 0 | 0 |
| agent-webkit-validated | 28 | 28 | 0 | 0 | 0 | 0 |
| browser-launch-after | 10 | 10 | 0 | 0 | 0 | 0 |
| secrets-across-lanes-after | 1 | 1 | 0 | 0 | 0 | 0 |
| package-smoke-after | 6 | 6 | 0 | 0 | 0 | 0 |
| matrix-reporting-after | 6 | 6 | 0 | 0 | 0 | 0 |
| m2-package-after | 6 | 6 | 0 | 0 | 0 | 0 |
| install-final | 16 | 16 | 0 | 0 | 0 | 0 |
| evidence-pixel-artifacts-after | 4 | 4 | 0 | 0 | 0 | 0 |
| electron-after | 5 | 5 | 0 | 0 | 0 | 0 |
| consumer-loading-after | 8 | 8 | 0 | 0 | 0 | 0 |
| capture-firefox-after | 5 | 5 | 0 | 0 | 0 | 0 |
| evidence-timelines-clear-host | 1 | 0 | 0 | 0 | 1 | 0 |

## Command record

The wrapper is `sh .retest/integration-leftovers/locked.sh <command>` for every heavy command. It invokes `lockf -t 0 /tmp/retest-heavy-gate.lock sh .retest/integration-leftovers/dispatch.sh <command>`. The dispatcher checks benchmark candidates before execution and records its PID and argv. The reproduction script and validation scripts retain each complete command and its log redirection.

```sh
sh .retest/integration-leftovers/reproduce.sh
sh .retest/integration-leftovers/after.sh
sh .retest/integration-leftovers/validate.sh
sh .retest/integration-leftovers/install-and-full.sh
sh .retest/integration-leftovers/new-failures.sh
```

Each ordinary file check executes the following command with its exact file name from the tables, using the log stem as its output and exit-file stem:

```sh
env RETEST_FIREFOX_ROUTE=launch-services node --conditions=retest-source --test --test-concurrency=1 tests/integration/<file>.test.ts
```

The package checks themselves use the existing package helper's exact scripts: `npm run build`, then `npm pack --pack-destination <fresh-test-folder>/pack`, then `npm install --offline --no-audit --no-fund <fresh-tarball>`. No preexisting tarball is reused and no package build script changes are needed. The build deletes dist through the package's own script before compiling. No stale artifact has been established for these original failures.

The same full attempt later reports the Electron-to-web broken-sync refusal-flow case as failed. Its complete assertions, including the exact failed locator, sole assertion failure, no later operations, no PATCH and password privacy, are unchanged. This additional file is queued for independent reproduction after the full attempt. The original electron.test.ts now passes all five cases in the full list, including the first-address case.

The current criterion lane has also added an exact CLI assertion in evaluation.test.ts that the declared kind reaches the fake judge. The full list reports that file failed. A source read shows `tests/support/fake-evaluator.ts` logs criteria by destructuring only id, requirement and absence; it currently drops kind from its observation log. This is a candidate fixture observation defect; the actual failure and an independent file reproduction are still required before a verdict or correction. No evaluation product file is edited by this lane.

An assertion audit rejects the interim Electron expectation that allowed one precisely described startup navigation. That would relax the original empty-list assertion. The source now keeps the original exact empty navigation list, retains secret fill as the first operation before either URL assertion, and adds exact action-order checks. The earlier 5/5 checks used the interim expectation and do not validate this stricter final source; `logs/electron-strict.log` is queued. No passing claim is carried forward without that check.

The full list reaches install.test.ts and reports two additional leaf failures: installed stand-in Electron doctor, and real cached WebKit install/list/verify/repeat/doctor. Both containing groups also fail. The same file passed 16/16 immediately before this full attempt, so an interference or changed-source verdict needs the exact footer and another isolated file run. `logs/install-whole-repro.log` is queued with the identical staged archives and all assertions intact.

A pure Node fixture probe now proves the missing-kind observation defect independently: `logs/fake-criterion-before-valid.log` has one failed test, no skips, exit 1. It supplies all three valid declared kinds, state/seen/never, plus one legacy absence criterion, and requires the exact criterion list to be retained by the fake observer. The three kind fields are lost. The earlier exploratory `fake-criterion-before.log` used invalid presence/absence names and is not the contract evidence.

A proposed assertion-preserving fixture correction is `.retest/integration-leftovers/fake-evaluator-proposed.patch`. It types optional kind and records it only when the actual request declares it; legacy criterion shapes remain exact. A loader selecting only that proposed fixture at its unchanged module URL passes the same exact four-criterion test, one passed, zero failed or skipped, exit 0 (`logs/fake-criterion-proposed.log`). The tree fixture is unchanged while the additional-fixture scope question is pending. These pure Node fixture probes use the common-rules single/unit-file exemption, with the same benchmark guard, and no browser or heavy process.

```sh
python3 .retest/integration-leftovers/benchmark-guard.py && node --conditions=retest-source --test .retest/integration-leftovers/fake-criterion.test.ts
python3 .retest/integration-leftovers/benchmark-guard.py && node --conditions=retest-source --import ./.retest/integration-leftovers/fake-proposed.mjs --test .retest/integration-leftovers/fake-criterion.test.ts
```

Scope review resolves the additional-file question from the existing instruction: these integration files are named in the supplied 129-file list, and their fixture fixes are needed for the required zero-failure command. This lane proceeds within that list and its fixtures. The fake observer correction is now applied to tests/support/fake-evaluator.ts, which is also the original named tests' fixture. `logs/fake-criterion-after.log` passes the same exact valid four-criterion list, one passed, zero failed or skipped, exit 0. No criterion or required outcome is changed. The queued evaluation file will now load this corrected fixture; its log stem remains evaluation-before and will be labelled by the actual loaded source, not mistaken for an untouched baseline.

The two existing unit files consuming the fake observer pass unchanged: 112 tests passed, zero failed, cancelled or skipped, exit 0. Command `node --conditions=retest-source --test --test-concurrency=1 tests/unit/evaluation-evidence-api.test.ts tests/unit/evaluation-frames.test.ts` after the benchmark guard; log `logs/fake-criterion-consumers.log`. This checks that optional kind preservation adds the declared field without changing legacy exact criterion lists.

## First full attempt and additional findings

The exact 129-file full-list command finishes with exit 1: 1,663 tests, 1,652 passed, seven failed, zero cancelled and four skipped. The six leaf failures plus the containing conformance test account for the seven; failed suites are reported separately. Log `logs/integration-browsers-final.log`, exit `logs/integration-browsers-final.exit`. This attempt needed the already-recorded owned Chrome stop and cannot establish natural exit. The count increase includes the criterion lane's new coverage and the real browser archive cases. The original list is unchanged.

| Additional leaf failure | Evidence and correction |
| --- | --- |
| WebKit conformance S6 | The exact soft-check failure, location and continued click agree, but its observation takes 552 ms against the unchanged 300 ms budget plus 250 ms late bound. The same complete file passes all 492 tests in isolation with retained raw records under `.retest/integration-leftovers/conformance-before/`. No declaration, budget or late bound is edited. This is observed timing variance; the final whole command must still pass the original bound. |
| Chromium diagnostics detach cleanup | The full footer names ENOTEMPTY removing its browser-log folder. Its injected detach leaves real Chrome messages arriving; the diagnostic append logger can recreate browser.log while recursive removal runs. That removal hook rejects before the browser-close hook, leaving the recorded Chrome and pipe alive. launchInjecting now closes Chrome and checks its group before removing the folder, attempts both cleanups and preserves every error in AggregateError. The corrected file passes and exits with the resource preload and close trace; `logs/diagnostics-close-trace.jsonl` records every actual app and browser close. Its `-before` stem is historical; it loaded this correction. No product file is edited. |
| Electron broken-sync web check | The full footer reports failed/timeout instead of failed/not_found. The same file independently passes its original exact not_found, sole failed locator, no later operations, no PATCH and privacy checks. The expected class is unchanged; an assertion diagnostic now includes the actual failure if it happens again. The final whole run remains required to resolve this observed variance. |
| Criterion kind seen by fake judge | The full failure is exactly undefined instead of state in the fake's log. The pure failing-first four-criterion probe demonstrates the observer omission and then passes after the fixture preserves declared kind. Legacy shapes and verdicts are unchanged. The corrected real CLI file passes. |
| Stand-in Electron doctor text | The founder's newer rule is documented in `codex/phase-4/licence-wording-prompt.md` and implemented in `licence-wording-report.md`: doctor still verifies every notice, but adds the exact short verified-status text. The integration assertion now pins the complete new row. |
| Real WebKit notice output | The same founder decision moves notice details from install/doctor terminal rows to JSON and the implemented licences command. The test now requires exactly one prescribed install message, every notice path/identifier/checksum/source in the JSON list, all 15 actual installed notice texts in the command in order, all actual file hashes, both source/patch pointers at the end, exactly nine supplied files, the exact short doctor row and unchanged no-extra-fetch counts. All earlier installed-file, archive, record and notice verification assertions remain. No production notice check is changed. |

The install file passes 16/16 against the newer wording and implemented notice command, with no skips. The exact original Electron empty-navigation assertion also passes 5/5; this replaces the interim less strict results. The final full command will load that strict source.

| Log name | Tests | Passed | Failed | Cancelled | Skipped | Exit |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| conformance-before | 492 | 492 | 0 | 0 | 0 | 0 |
| diagnostics-collector-before | 6 | 6 | 0 | 0 | 0 | 0 |
| electron-web-flow-before | 3 | 3 | 0 | 0 | 0 | 0 |
| evaluation-before | 1 | 1 | 0 | 0 | 0 | 0 |
| electron-strict | 5 | 5 | 0 | 0 | 0 | 0 |
| install-whole-repro | 16 | 16 | 0 | 0 | 0 | 0 |
| evaluation-proposed | 1 | 1 | 0 | 0 | 0 | 0 |

The first post-fix source typecheck catches this lane's unused scratchFolder import and an inference cycle for the notice byte buffer (`logs/typecheck-completed.log`, exit 2). The import is removed and the actual fs buffer is explicitly typed Buffer. No type is widened and no diagnostic is ignored. A fresh package typecheck is queued as `logs/typecheck-resolved.log`.

The corrected package typecheck completes with exit 0, including TypeScript 6, TypeScript 7 and the task example (`npm run typecheck`, `logs/typecheck-resolved.log`, `logs/typecheck-resolved.exit`).

The final whole-list command is queued through the same shared lock as `sh .retest/integration-leftovers/locked.sh sh .retest/integration-leftovers/full.sh`. Its output is `logs/integration-browsers-verified.log` and its exit file is `logs/integration-browsers-verified.exit`. The script executes the exact requested `env RETEST_FIREFOX_ROUTE=launch-services node --conditions=retest-source --test --test-concurrency=1 $(cat .retest/clean-run/integration-browsers.list)`, with npm offline mode and the three locally staged, pin-verified archives. No force-exit option is set.

The verified full command acquired the lock after 16 busy refusals, each running no test. Dispatch identity: `full browser list node pid 22259; list .retest/clean-run/integration-browsers.list`. The benchmark guard confirmed clear before the exact command started. It has reached the Firefox agent file with no failure or skip at this milestone.

The verified whole-list command passes all five Firefox capture cases and its final active-resource assertion, then advances through WebKit capture and CLI checks into conformance. This worker exits naturally, without a signal or force-exit. There are no failures or skips at this milestone.

The verified full command passes all 492 conformance tests across the three engines, including the unchanged WebKit S6 budget and late bound. It advances to consumer-loading. The earlier timing failure has not recurred in this full run; no timing assertion or product timeout behavior was changed.

The verified full command also passes consumer-loading after its own build/pack and all six Chromium diagnostics cases, then advances to cross-engine diagnostics. The corrected detach cleanup exits naturally; no owned Chrome stop, worker signal or force-exit has been used in this attempt.

The verified full command passes all three Electron-to-web flow cases. The broken-sync case retains its exact not_found class and all later-operation, PATCH and privacy exclusions. The first attempt's timeout-class variance does not recur; no product change or expected-class relaxation was made. The strict first-address Electron case also passes with the original exact empty navigation list.

The verified full command passes the fresh pixel-artifact cases and reaches the timeline case. That case identifies Wispr Flow by its current process owner, layer 1000 and exact overlapping bounds 608,445,512,614, then names the existing proofs/native.md host limitation. Four skips now consist exactly of that limitation and the three missing live-provider credential gates. No engine is opted out, and no other test is skipped. The original unconditional timeline-environment skip is removed.

The verified whole-list command passes all 16 install tests with no install skip, including each real cached browser archive and the exact licence-output rule, record metadata, full notice texts and notice hashes. It advances to runner-lock tests. The shared original archive caches are never removed or changed by this lane.

The verified full attempt reports a new WebKit viewport-wheel failure: `the wheel turned at the centre of the viewport scrolls the page, which loads more items once`, imported from browser-actions.test.ts. The run continues. Its exact footer and an isolated gate of webkit-browser-actions.test.ts are required before a verdict. The original successful scroll result, item count, exactly one load and exactly one heard wheel assertions remain unchanged. This attempt cannot be reported as a zero-failure gate.

## Second full attempt and wheel follow-up

`logs/integration-browsers-verified.log` finishes naturally with exit 1: 1,663 tests, 1,658 passed, one failed, zero cancelled and four documented skips. No signal or force-exit is used in this full attempt. All original 12 failures pass. The final identity audit finds none of the 303 recorded full-run process observations still present (`logs/verified-process-audit.json`); command identities are hashed so application arguments are not retained.

The sole new failure is the WebKit viewport-wheel case imported from browser-actions.test.ts:965. Its action returns outcome_unknown, with landed <main>, because no wheel receipt was observed by the document guard. The exact expected successful scroll result, 30 items, one load and one heard wheel remain. The failed dispatch is never reissued in that run. No causal product regression is established from this observation; it is retained as an unresolved delivery observation, not relabelled a pass.

Through the lock, `env RETEST_FIREFOX_ROUTE=launch-services node --conditions=retest-source --test --test-concurrency=1 tests/integration/webkit-browser-actions.test.ts` passes 81/81, zero failed, cancelled or skipped, exit 0 (`logs/webkit-wheel-alone.log`, `logs/webkit-wheel-alone.exit`). Its wheel case uses the same original assertions. No fixture or product change is made for that failure.

A further independent full run of the exact unchanged 129-file command is queued, with output `logs/integration-browsers-complete.log` and exit `logs/integration-browsers-complete.exit`. It starts new test fixtures; it does not retry the uncertain action in the earlier session. The required zero-failure result remains pending.

The complete full attempt acquired the lock after 4 busy refusals. Dispatch identity: `full browser list node pid 86965; list .retest/clean-run/integration-browsers.list`. The benchmark guard confirmed clear before execution. The exact command now runs without force-exit; no failure or skip at the Firefox agent milestone. Its process ledger is `logs/full-process-identities-86965.jsonl`, with final audit reserved as `logs/full-process-audit-86965.json`.

The complete attempt passes all five Firefox capture cases, its no-active-resource after hook, WebKit capture and CLI checks, then advances into conformance. The Firefox worker exits naturally again. No signal or force-exit is used; no failure or skip at this milestone.

The complete attempt passes the entire 492-test conformance file across Chromium, Firefox and WebKit, including the original S6 deadline and late bound. No declaration, expected outcome or timing assertion is changed. No failure or skip at this milestone.

The complete attempt passes consumer-loading, Chromium and cross-engine diagnostics, Electron, evaluation and the fresh pixel-artifact cases. Its four skips are exactly the three absent live-provider credential gates and the identified Wispr layer-1000 overlap at 608,445,512,614. It advances into Firefox locators with no failure. Benchmark checks during the run continue to confirm clear.

The complete attempt passes all 16 install tests, M2 packaging after fresh build/pack, runner lifecycle and locks, and all six matrix-reporting cases including the exact retained-profile state. It reaches matrix-targets with no failure and exactly four documented skips.

The complete attempt passes all 81 WebKit browser-actions cases, including the unchanged viewport-wheel success result, 30 items, exactly one load and exactly one heard wheel. The earlier outcome_unknown observation does not recur. No action is retried in its original session, and no source, fixture, expected class, bound or assertion was changed for this follow-up. The run advances through WebKit locators and navigation into driver checks with no failure.

## Final required gate

`logs/integration-browsers-complete.log`, exit `logs/integration-browsers-complete.exit`: 1,663 tests, 11 suites, 1,659 passed, zero failed, zero cancelled, four skipped, zero todo, exit 0. The command exits on its own. No external process intervention, force-exit, engine opt-out or assertion change is used in this successful attempt. The deliberate signal tests retain their original behavior; natural exit refers to the test workers and full parent.

```sh
sh .retest/integration-leftovers/locked.sh sh .retest/integration-leftovers/full.sh
# full.sh executes exactly:
env RETEST_FIREFOX_ROUTE=launch-services node --conditions=retest-source --test --test-concurrency=1 $(cat .retest/clean-run/integration-browsers.list)
```

The list has 129 files; SHA-256 `288f422a864053545757382c7713c9c51229067ca9ca6dbc09963c7b1204ee08`. The dispatcher supplies npm offline mode and the three locally copied, size- and pin-verified archive fixtures. The source archives are existing publisher archives; this lane runs no download. Package tests themselves rebuild and pack through the existing package scripts. No stale dist or tarball was established, and no build script needed correction.

The only final skips, including their exact emitted reasons, are:

- live provider gate, Anthropic: one text and one screenshot check against claude-sonnet-5 # unverified: RETEST_EVALUATION_ANTHROPIC_KEY not set, so Anthropic was not called
- live provider gate, OpenAI: one text and one screenshot check against gpt-5.5-2026-04-23 # unverified: RETEST_EVALUATION_OPENAI_KEY not set, so OpenAI was not called
- live provider gate: one text and one screenshot check against an Azure deployment # unverified: RETEST_EVALUATION_AZURE_KEY; RETEST_EVALUATION_AZURE_RESOURCE or RETEST_EVALUATION_AZURE_BASE_URL; RETEST_EVALUATION_AZURE_DEPLOYMENT not set, so no Azure deployment was called
- every app flow timeline has actual recorded pixels at its checks # Documented host limitation in proofs/native.md: Wispr Flow's layer-1000 window at 608,445,512,614 overlaps TaskDesk's fixture frame 20,60,700,480. Its pixels cannot enter the recording.

The six original agent skips now execute and pass. The timeline fixture generates a real three-app flow when host prerequisites permit, and retains every original pixel/timeline assertion. The live providers and the three-app timeline under the covering Wispr window remain unverified.

Both earlier full failures remain in their original logs and are not counted as successful gates. The first needed the recorded owned Chrome stop and ended with seven failures. The second exited naturally with one WebKit wheel outcome_unknown. That dispatched action was not repeated in its session. Its exact 81-test file and this full command pass unchanged. The causal mechanism of that one receipt observation remains unverified; no timing bound, required outcome or uncertainty check was relaxed.

`npm run typecheck` passes TypeScript 6, TypeScript 7 and the task example, exit 0 (`logs/typecheck-resolved.log`). The two existing fake-observer unit consumers pass 112/112, and the exact declared-kind probe fails before the fixture change and passes after it. Those checks and every targeted original file count are recorded above.

`python3 .retest/integration-leftovers/process-audit.py --final` finds no remaining identity among 205 recorded full-run observations, including root 86965; evidence `.retest/integration-leftovers/logs/full-process-audit-86965.json`. `python3 .retest/integration-leftovers/cleanup-archives.py --chromium-removed-before-source-check` completes removal of only the three owned archive copies after verifying their ledger paths, sizes and hashes; evidence `logs/archive-cleanup.json`. The source cache paths were already absent at cleanup and no source path was modified. The first cleanup verified all three copies and removed Chromium, then stopped because its source path was absent; the explicit resume verifies and removes only the remaining two copies. That bookkeeping error and resume do not alter any test result. All dispatched tool sessions have completed; no owned process is left running. No benchmark, download, commit, stash, reset, revert or publication is run.

The additional namespace audit finds no remaining task-script process (`logs/namespace-process-audit.json`). The final install tests used the three verified staged publisher archives. Both those owned copies and the original source cache paths are absent after cleanup; reproducing the install gate requires those exact local fixture inputs again. This does not change the recorded successful run.
