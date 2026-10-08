# Firefox console probe

Work is limited to the Firefox collector, its tests, the Firefox expectations in the shared diagnostics tests, and anchored Firefox documentation. Existing work is preserved. No benchmark, download or commit is part of this task.

## Starting evidence

The previous probe survives at `/tmp/retest-fix-firefox/probes/probe-console.ts` and `.log`. Its logged enumerable getter changed the title with a bare `log.entryAdded` subscription in two trials. Without a subscription and with network alone, the title stayed unchanged. That probe did not separate value types or try serialization parameters.

The collector already subscribes to network events alone and exposes `unavailable.console`. The shared diagnostics tests already contain explicit Firefox expectations for that refusal. This pass will verify and strengthen those expectations against the new probe.

Firefox will launch through `RETEST_FIREFOX_ROUTE=launch-services`. This is the recorded host route, not a defect. Browser probes and compiler checks use the shared `/tmp/retest-heavy-gate.lock`, one command per acquisition. Probe sources, wire records, ownership records and gate logs are retained under `/tmp/retest-firefox-console-probe/`. Profiles use a separate root there so the launcher cannot sweep another builder's profiles.

## Probe results

The raw probe completed on Firefox 133.0.3, build 20241209150345. Each cell below has two trials, each in a fresh document. Every document also held an unlogged getter. None of those unlogged getters ran. The marker was an array of getter names and `document.title`.

| Logged value | No subscription | Network alone | Bare log subscription | Log `serializationOptions: { maxObjectDepth: 0 }` | Log `maxObjectDepth: 0` | Session `serializationOptions: { maxObjectDepth: 0 }`, then log |
| --- | --- | --- | --- | --- | --- | --- |
| String | untouched, 2/2 | untouched, 2/2 | untouched, 2/2 | untouched, 2/2 | untouched, 2/2 | untouched, 2/2 |
| Number | untouched, 2/2 | untouched, 2/2 | untouched, 2/2 | untouched, 2/2 | untouched, 2/2 | untouched, 2/2 |
| Plain object, data property only | untouched, 2/2 | untouched, 2/2 | untouched, 2/2 | untouched, 2/2 | untouched, 2/2 | untouched, 2/2 |
| Object with enumerable getter | untouched, 2/2 | untouched, 2/2 | getter ran, 2/2 | getter ran, 2/2 | getter ran, 2/2 | getter ran, 2/2 |
| DOM node with an enumerable own getter | untouched, 2/2 | untouched, 2/2 | untouched, 2/2 | untouched, 2/2 | untouched, 2/2 | untouched, 2/2 |
| Nested enumerable getter | untouched, 2/2 | untouched, 2/2 | getter ran, 2/2 | getter ran, 2/2 | getter ran, 2/2 | getter ran, 2/2 |
| Custom `toString` | untouched, 2/2 | untouched, 2/2 | untouched, 2/2 | untouched, 2/2 | untouched, 2/2 | untouched, 2/2 |
| `Symbol.toStringTag` getter | untouched, 2/2 | untouched, 2/2 | untouched, 2/2 | untouched, 2/2 | untouched, 2/2 | untouched, 2/2 |

A seventh matrix condition sent invalid subscription depth, `serializationOptions: { maxObjectDepth: 'invalid' }`. Firefox returned success and produced the same result for all eight values in both trials. This confirms the field was ignored, rather than validated and applied. All subscribed log trials returned one event with the expected argument type. No-subscription and network-only trials returned no log event.

There were 112 value trials, 20 with getter mutation. Two separate direct `script.evaluate` controls returned the getter object: depth 0 returned `{ type: 'object' }` without running it; depth 1 returned its property values and ran it once. Thus Firefox does honour depth on script results, but an evaluate result setting does not constrain logs emitted during that evaluation.

Two more browser launches tried session capabilities `serializationOptions` and `moz:serializationOptions`, each with depth 0. Both `session.new` commands returned `invalid argument`. The top-level session field returned success but did not affect console serialization. The wire record retains the exact errors. These are rejected capability attempts, not browser-start defects.

Raw evidence is `/tmp/retest-firefox-console-probe/probe.mjs`, `probe.log`, `results.jsonl` and `wire.jsonl`. The previous getter result is reproduced with value types separated.

## Protocol and implementation

The installed app's extracted source survives under `/tmp/retest-fix-firefox/omni/`. Its log handler computes `args.map(String)` and then serializes each argument after `Cu.waiveXrays`, using `setDefaultSerializationOptions()` with no caller options. The default `maxObjectDepth` is `null`. Generic object serialization uses `Object.entries(value)`, which invokes enumerable getters. The subscription implementation reads only `events` and `contexts`.

Filtering entries after delivery cannot prevent page code that Firefox already ran while preparing the event. None of the tested session or subscription settings avoided it.

The probe found no effective log setting. Source facts are in `source-facts.json`. The three saved Mozilla modules exactly match the bytes extracted from the installed app's `omni.ja`; `unzip -p` returned them with archive-layout warnings and exit 2, while Python's ZIP reader refused that archive. Nothing was downloaded, and no upstream implementation was copied into Retest.

The WebDriver BiDi model separates `script.SerializationOptions` for script result serialization from subscription parameters and the remote values carried by `log.ConsoleLogEntry.args`. An event's arguments are output, not a place to send options. The local Firefox source links the [log event algorithm](https://w3c.github.io/webdriver-bidi/#event-log-entryAdded) and [remote value serialization](https://w3c.github.io/webdriver-bidi/#serialize-as-a-remote-value), and its implementation exposes no session or subscription route for choosing the log serializer's options. `session.subscribe` destructures only `events` and `contexts`; the log handler calls `setDefaultSerializationOptions()` itself. Generic object serialization with nonzero depth calls `Object.entries` on the waived object. The DOM-node branch restores Xrays before describing the node. That matches the DOM own-getter control.

No full local W3C specification snapshot was found in the inspected proof or research files. The current online specification was not fetched under the no-download instruction. The spec distinction above is the protocol model reflected by the tree and the installed implementation, not a claim that the current online draft was freshly checked. The Firefox 133 behaviour was checked directly.

Playwright's Firefox console uses its patched browser and its own Juggler protocol, not BiDi. The already-installed Playwright package at `/tmp/retest-measurements-workspace/playwright-project/node_modules/playwright-core/lib/coreBundle.js` launches Firefox with `-juggler-pipe` and listens to `Runtime.console`, including separate worker sessions. It does not use this stock Firefox `log.entryAdded` path. Its console support therefore does not prove this path is safe. Chromium's Retest collector reads CDP previews; `console-text.ts` renders an accessor as `(...)` and never requests an object's properties.

## Outcome built

The refusal remains. Its reason now says exactly which observed objects run page getters and why filtering arrives too late. Strings and numbers are safe in these trials, and an otherwise quiet subscription does not touch unrelated getters. That does not make primitive-only capture safe for a page that may later log an object. Firefox provides no argument filter before serialization, so discarding the resulting object entry cannot undo its getter. Retest cannot honestly offer the proposed partial primitive capture while preserving read-only observation.

Network capture remains active. Console is `unavailable`, with the reason, and records neither console messages nor runtime errors. Required console completeness or strict console/runtime-error policy still cannot judge the test. No passing-test requirement was loosened. The shared diagnostics files already had explicit Firefox unavailable-console expectations; this pass strengthens their reason checks and adds an attempt-level check.

The added real-browser regression contains the value matrix, nested getters, depth parameters, an attempted primitive filter, and script-result depth controls. It did not acquire the shared lock in this pass. In particular, the attempted `filter.argumentTypes` field in that new test remains unexercised; it is not a spec feature or a verified browser capability. The refusal rests on the completed raw matrix and the installed serializer, not on that unrun case.

## Commands and checks

Read-only inspection commands included `cat`, anchored `sed`, `rg`, `rg --files`, `git status --short` and `pgrep -fl '[b]enchmarks/run.ts|[F]irefox.app/Contents/MacOS/firefox'`. Owned-file snapshots are under `/tmp/retest-firefox-console-probe/baseline/`.

| Command | Result | Log |
| --- | --- | --- |
| `lockf -t 0 /tmp/retest-heavy-gate.lock env RETEST_FIREFOX_ROUTE=launch-services node --conditions=retest-source /tmp/retest-firefox-console-probe/probe.mjs` | Exit 0; 112 value trials, two script controls, two rejected capability attempts | `/tmp/retest-firefox-console-probe/probe.log`, `results.jsonl`, `wire.jsonl` |
| `node /tmp/retest-firefox-console-probe/run-guarded.mjs node --conditions=retest-source --test --test-concurrency=1 tests/unit/firefox-collector.test.ts tests/unit/firefox-collector-attempt.test.ts tests/unit/diagnostics-engines.test.ts` | Exit 0; 44 passed, zero failed or skipped, before the new shared attempt test | `/tmp/retest-firefox-console-probe/unit.log` |
| `lockf -t 0 /tmp/retest-heavy-gate.lock env RETEST_FIREFOX_ROUTE=launch-services node --conditions=retest-source --test --test-concurrency=1 tests/integration/firefox-diagnostics.test.ts` | Exit 75; lock not acquired, no tests ran | `/tmp/retest-firefox-console-probe/firefox-diagnostics.log` |
| Same integration command through `node /tmp/retest-firefox-console-probe/run-guarded.mjs` | Three immediate attempts exited 75; lock not acquired, no tests ran | The later queue log preserves its own attempts |
| `node /tmp/retest-firefox-console-probe/run-guarded.mjs python3 /tmp/retest-firefox-console-probe/analyze.py` | Exit 0; independently checked all 112 recorded trials, 20 mutations, two script controls and two rejected capabilities | `/tmp/retest-firefox-console-probe/analysis.log` |
| `python3 /tmp/retest-firefox-console-probe/source-inspection.py` | Exit 0; all three local modules match the app archive; individual extraction warnings retained | `/tmp/retest-firefox-console-probe/source-inspection.log`, `source-facts.json` |

`run-guarded.mjs` records the benchmark check, child pid, exact command and exit in `gates.jsonl`. The initial `pgrep -fl '[b]enchmarks/run.ts'` matched two other builders' shell commands containing their own benchmark guard, not a benchmark. Reading the command lines found no running Node benchmark. The guarded checks also inspect Node command lines before dispatch.

The raw probe recorded successful browser pids 81158 and 83663 and their full command lines in `processes.jsonl`; the rejected session launches were pids 84004 and 84080, recorded by their own browser logs and the launcher's ownership files before cleanup. All four launches were ended by their own launcher. The probe profile root is empty. A later unrelated Firefox pid 85940 belongs to another builder and was left alone.

The updated focused unit command passed 45 checks, zero failed or skipped, in `/tmp/retest-firefox-console-probe/unit-final.log`. The shared attempt test preserves `unavailable` in the artifact beside a partial network capture. `queue-one.mjs` retried `lockf -t 0` after each busy lock and recorded every attempt in `queue.jsonl`. Both waiting queues are now ended; none remains running.

The guide edits change only the Firefox diagnostics bullet and the Firefox paragraph under per-engine diagnostics. Other guide changes visible against the initial snapshot belong to concurrent builders and are preserved.

The first browser queue made 17 lock attempts, all exit 75, with no tests started. Another builder's native evidence gate held the lock at pid 5128 and was left alone. The waiting queue was then ended after checking its recorded pid and command. An initial check refused because `ps` names the executable `node` while `process.argv` uses its full path; the check was corrected to compare the executable name and every argument before signaling that same live queue. No browser command was active in it.

The gate became available during those steps. `lockf -t 0 /tmp/retest-heavy-gate.lock node /tmp/retest-firefox-console-probe/run-guarded.mjs npm run typecheck` ran and exited 2, with five errors in the new integration test, all for the public `WebSession` type lacking Firefox's context ID. Log: `/tmp/retest-firefox-console-probe/typecheck.log`. The test now verifies `page instanceof FirefoxPage` before using its context. The compiler retry is queued alone. A shared Firefox integration attempt while that compiler held the lock exited 75 and ran no test; its log is `/tmp/retest-firefox-console-probe/diagnostics-engines.log`.

The current focused unit command again passed 45/45, zero skips, in `/tmp/retest-firefox-console-probe/unit-current.log`. Its exact command was the focused unit command above, with that output path. The compiler queue made ten attempts, all exit 75, without starting a compiler. Its exact command was `node /tmp/retest-firefox-console-probe/queue-one.mjs node /tmp/retest-firefox-console-probe/run-guarded.mjs npm run typecheck`, logged in `typecheck-final.log`. The earlier browser queue used `env RETEST_GATE_INITIAL_WAIT=1 RETEST_FIREFOX_ROUTE=launch-services node /tmp/retest-firefox-console-probe/queue-one.mjs node /tmp/retest-firefox-console-probe/run-guarded.mjs node --conditions=retest-source --test --test-concurrency=1 tests/integration/firefox-diagnostics.test.ts`, logged in `firefox-diagnostics.log`.

Final sequential attempts were:

| Exact command | Result | Log |
| --- | --- | --- |
| `lockf -t 0 /tmp/retest-heavy-gate.lock node /tmp/retest-firefox-console-probe/run-guarded.mjs npm run typecheck` | Exit 75, no compiler started | `/tmp/retest-firefox-console-probe/typecheck-last.log` |
| `lockf -t 0 /tmp/retest-heavy-gate.lock env RETEST_FIREFOX_ROUTE=launch-services node /tmp/retest-firefox-console-probe/run-guarded.mjs node --conditions=retest-source --test --test-concurrency=1 tests/integration/firefox-diagnostics.test.ts` | Exit 75, no tests started | `/tmp/retest-firefox-console-probe/firefox-diagnostics-last.log` |
| `lockf -t 0 /tmp/retest-heavy-gate.lock env RETEST_FIREFOX_ROUTE=launch-services node /tmp/retest-firefox-console-probe/run-guarded.mjs node --conditions=retest-source --test --test-concurrency=1 --test-name-pattern='^Firefox:' tests/integration/diagnostics-engines.test.ts` | Exit 75, no tests started | `/tmp/retest-firefox-console-probe/diagnostics-engines-last.log` |

## Final verification limits and cleanup

The raw Firefox 133.0.3 matrix and its stored-data verification completed. The current 45 focused unit tests pass with zero skips. The added integration regression and the shared Firefox integration rerun did not start, so neither has a passing count here. The five initial compiler errors were addressed by the explicit Firefox-page instance checks, but the corrected source remains unverified by TypeScript 6 or 7 because the retries never acquired the gate. The first compiler failure prevented that command from reaching TypeScript 7 or the examples check.

The final cleanup audit is `/tmp/retest-firefox-console-probe/cleanup.json`. All four recorded Firefox pids and both waiting-queue pids are absent, and the probe profile root is empty. Only the two recorded waiting queues were signaled manually, after checking their exact arguments and confirming the previous lock attempt had already exited 75. Browser teardown used each launcher's recorded ownership. No other builder's process was ended. No benchmark, download, commit, stash, reset or revert ran in this task.

The guide edits stay at the two Firefox anchors. The proof names the new regression as added and unrun. No newer Firefox, another platform, arbitrary object class, or current online spec revision is claimed by this probe.
