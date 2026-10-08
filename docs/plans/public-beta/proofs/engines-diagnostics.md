# Console, network and visual evaluation on every engine

Phase 3 item 7 of [release-0.1.0.md](../release-0.1.0.md): the same console and network fixtures on Chrome, Firefox and WebKit, visual evaluation over each engine's real captures, subscriptions across navigation, isolated contexts, pooling and cancellation, missing optional protocol fields and collector failures reported without claiming complete coverage, and the live provider gates by name. Recorded on macOS 27.0.1, arm64, Node 24.12.0, with Google Chrome 154.0.8037.93, Playwright's WebKit build 2359 (WebKit 626.1.6+) and Firefox 133.0.3.

## Result

- `tests/integration/diagnostics-engines.test.ts` runs the task app's diagnostics pages, the Release 1 diagnostic set, on each engine with one set of assertions, through `retest run` and below it through the `AttemptDiagnostics` the runner uses. A case that fails on one engine is a finding for that engine's driver; no assertion branches on the engine.
- `tests/unit/diagnostics-engines.test.ts` feeds each of the three collectors its own engine's events, through the parent's own session capture, and holds them to one contract for missing optional fields, unreadable events, the collector's tracking limit, a lost connection, a capture that cannot start and one that answers too late.
- `tests/integration/evaluation-engines.test.ts` runs AI checks over each engine's own screenshots with judges that call no model: the fake judge, a pixel judge that decodes the PNG and fails a page showing a magenta banner, and a text-only judge that must never be sent an image.
- `tests/integration/evaluation-ai-sdk.test.ts`: the Anthropic and OpenAI live gates are now one test each, beside the Azure gate, so each provider runs by name when its own key is in the environment and skips by name otherwise. No key is read from a file.
- `src/diagnostics/session-capture.ts`: an event the collector could not read, or a request past its tracking limit, now counts as network when its name starts `network.` in any case, so Firefox's `network.…` names count where Chrome's and WebKit's `Network.…` already did (finding 2). Nothing else in that file changed. `src/diagnostics/{attempt,policy,report}.ts` needed no field: the scope every summary carries already names its engine and what it covers. `src/evaluation/evidence.ts` needed no change: the capture source comes from `screenshotSource`, which another lane changed while this lane ran, and which now names every web engine (finding 9).

## Capture coverage per engine

Firefox ran through Launch Services: this session's host app may not read `~/Library/Application Support/Firefox` (`EPERM` when listed), so `tests/integration/engines.ts` picks that route, as the [conformance record](conformance.md) describes. A spawned Firefox, the product's default route, was not exercised by this lane.

"Passed" means the case ran on the real engine on this machine and passed. A fraction is how many of the fixture page's records carried the field, read from the run's own artifact.

| Capture | Chrome | Firefox | WebKit |
| --- | --- | --- | --- |
| State of the fixture page's capture | complete | complete | complete |
| Console covers, as declared | document, frames in the page's process, dedicated workers | same as Chrome | document |
| Network covers, as declared | document, frames in the page's process | same as Chrome | document |
| Fixture records delivered from areas declared not covered | none | the other site's frame: its message and its fetch | frames of the page's site and of another site: messages, documents and fetches |
| Each console level with its severity, from the page | passed | passed | passed |
| A message's address, line and column | 14 of 14 page messages | 3 of 16: only messages with a stack (error, assert, trace) | 15 of 15 |
| A message's frame, main or child | 14 of 14 | 16 of 16 | 0 of 15 |
| A message's text holds every argument | passed | failed: objects `[object Object]`, arrays `1,2,3` | failed: first argument only |
| `table`, `dir`, `count`, `trace` kept; `assert` an error | passed | passed | passed; `count` at debug level |
| The browser's own entries, such as `Failed to load resource` | 3, `origin: 'browser'` | none heard | 3, `origin: 'browser'` |
| A dedicated worker's message as `origin: 'worker'` | passed | failed: recorded as `page` | not claimed |
| Uncaught error with its stack, no query in it | passed | passed | passed |
| Unhandled rejection as its own kind | passed | failed: `uncaught` | passed, no stack |
| Browser messages kept out of runtime errors | passed | failed: a CORS message is an uncaught error (3 for 2) | passed |
| Capture leaves the page as it was | passed | failed: a logged object's getter ran | passed |
| Request method, address without its query | passed | passed | passed |
| Resource type | 14 of 14 | 0 of 16 | 16 of 16 |
| Response content type | 10 of 12 (not on the two redirects) | 15 of 15 | 13 of 15 (not on the two redirects) |
| Cache named | 12 of 12 | 15 of 15 | 15 of 15 |
| Protocol | 12 of 12 | 15 of 15 | 0 of 15 |
| Duration by the engine's clock | 10 of 10 | 14 of 14, whole milliseconds | 14 of 14 |
| Transferred size | 10 of 10 | 14 of 14 | 12 of 14 (not on the two redirect hops) |
| 404 and 500 finished with their status; refused connection a failure with its reason and no status | passed (`net::ERR_CONNECTION_REFUSED`) | passed (`NS_ERROR_CONNECTION_REFUSED`) | passed ("Could not connect to the server.") |
| Redirect of two hops, each naming the next | passed | passed | passed |
| Request open at the end marked pending, with how far it got | passed | passed | passed |
| Summary counts equal the records' own | passed | passed | passed |
| Capture across navigations, into another site and back, and a reload | passed | passed | passed |
| Two apps of one test at once, one artifact each, nothing crossed | passed | passed | passed |
| One pooled browser, two files, two rounds, records per attempt | passed | passed | passed |
| Run stopped mid-capture: exit 130, request `run_interrupted`, artifact ended | passed | passed | passed |
| Over the limits: partial with the reason; `requireComplete` fails the test | passed | passed | passed |
| Secrets in messages, errors, queries, paths, headers, cookies and stacks reach no file or report | passed | passed | passed |
| Quiet page complete and empty; capture off `disabled` with no artifact | passed | passed | passed |
| Capture on a closed page `unavailable` with its reason, no artifact | passed | passed | passed |
| Browser gone mid-capture: both kinds partial, request marked lost | passed | passed | passed |
| An ended capture hears nothing more; two contexts below the runner keep their own | passed | passed | passed |
| Unit: optional fields an engine leaves out stay out; those it gives are kept | passed | passed | passed |
| Unit: an unreadable network event makes the network partial | passed | passed after the fix in `session-capture.ts`; failed before it, counted under console | passed |
| Unit: an unreadable console event makes the console partial | passed | passed | passed |
| Unit: a request past the collector's tracking limit makes the network partial | passed | passed after the fix; failed before it | passed |
| Unit: the capture counts each engine's own event names under their kind | passed | passed after the fix; failed before it | passed |
| Unit: a lost connection makes both partial, open request marked | passed | passed | passed |
| Unit: a capture that cannot start, or answers late, is unavailable and keeps no listener | passed | passed | passed |
| Visual evaluation: same contract, defect judged from pixels, images only to an image judge | passed | passed | passed |
| Screenshot evidence names its capture source | `chromium` | `firefox` | `webkit` |

## Engine differences

Findings for the driver lanes, each with where and the scenario. None was answered by changing an assertion.

1. **Firefox: capture runs a getter of an object the page logs.** The fixture page logs `console.dir({ get danger() { document.title = 'the getter ran'; … } })`. With capture on, the page's title becomes "the getter ran" and the test's `toHaveTitle('Diagnostics')` fails; with `diagnostics: { capture: false }` the same test passes (`/tmp/retest-diag-probe-firefox-result.json`, `/tmp/retest-diag-probe-firefox-off-result.json`). Where: the collector's subscription to `log.entryAdded` (`src/diagnostics/firefox-collector.ts:41`, subscribed in `start`); Firefox serializes each console argument for that event, which reads the object's properties. Chrome and WebKit send previews and leave the title alone. Observation changes the app under test, against the diagnostics contract.
2. **Firefox: an unreadable network event, or a request past the collector's tracking limit, left the network capture `complete`. Fixed by this lane.** `SessionCapture.unreadable` and `limited` picked the kind with `method.startsWith('Network.')`, and the Firefox collector passes BiDi's lowercase names (`src/diagnostics/firefox-collector.ts:153`, `:218-219`). Scenario: `network.responseStarted` arrived without its `request`, or a 1001st request was tracked: the console became partial with "1 console event from the browser could not be read" and the network stayed complete. Now one helper, `isNetworkEvent` in `src/diagnostics/session-capture.ts`, counts a name starting `network.` in any case as network. Shown by the two collector-level Firefox cases and a capture-level case per engine in `tests/unit/diagnostics-engines.test.ts`: the Firefox ones failed on the old code (`/tmp/retest-diag-engines-unit-2.log`, `/tmp/retest-capture-kind-before.log`) and all pass now (`/tmp/retest-capture-kind-after.log`). The Chrome and WebKit capture-level cases passed before the fix too, since their names already started `Network.`; they hold those names to the same rule.
3. **Firefox: its own messages become uncaught runtime errors.** Every `log.entryAdded` of type `javascript` is a runtime error (`src/diagnostics/firefox-collector.ts:185-198`). On the fixture page Firefox's "Cross-Origin Request Blocked: The Same Origin Policy disallows reading the remote resource", for the refused request to another port, is recorded as an uncaught error: 3 runtime errors where the page made 2, and a strict `runtimeErrors` rule would fail a test on a message the page never threw.
4. **Firefox: an unhandled rejection is recorded as `uncaught`.** `src/diagnostics/firefox-collector.ts:191`. The record claims a thrown error for a rejection.
5. **Firefox: a dedicated worker's message is recorded as the page's.** Every console entry gets `origin: 'page'` (`src/diagnostics/firefox-collector.ts:204`), while the scope claims dedicated workers. "from the dedicated worker" carries `origin: 'page'`, `frame: 'main'`.
6. **Firefox: a message's text is Firefox's own string.** The collector keeps `entry.text` (`src/diagnostics/firefox-collector.ts:205`), so `console.log('diagnostic log message', 42, { saved: true, title: 'Release checklist' }, [1, 2, 3])` reads `diagnostic log message 42 [object Object] 1,2,3`. A message has an address, line and column only when Firefox sends a stack.
7. **WebKit: a message keeps only its first argument when another is a plain object.** WebKit 2359 leaves `overflow` out of a plain object's lossless preview (`/tmp/retest-diag-probe-webkit-args.log`); the shared schema requires it (`src/diagnostics/console-text.ts:36`), and `textOf` then falls back to WebKit's own text, which is the first argument (`src/diagnostics/webkit-collector.ts:332-341`). The record reads `diagnostic log message` and is not marked cut. `console.table` and `console.dir` read `[object Object]` the same way.
8. **WebKit and Firefox: the scopes claim less than was captured.** WebKit's scope covers the document only (`src/diagnostics/webkit-collector.ts:32-37`), yet the messages, documents and fetches of the same-site frame and of the other site's frame arrived, the latter because build 2359 runs it in the page's process. Firefox's scope leaves out frames of another site (`src/diagnostics/firefox-collector.ts:28-39`), yet that frame's message and fetch arrived. On WebKit those records named no frame and sat inside a `complete` capture, from areas the scope disowned, so a strict `consoleErrors` rule would have counted another site's error as the document's (review finding D-10). After the review the WebKit scope covers both kinds of frame and each message names its frame, and the Firefox collector refuses capture.
9. **Firefox and WebKit screenshots named no capture source. Resolved by another lane while this lane ran.** Earlier runs here recorded no `source` for a Firefox or WebKit screenshot, since `screenshotSource` answered only for Chromium and `CaptureSourceName` had no name for either engine. Another lane added `firefox` and `webkit` to `src/protocol/identity.ts` and made `screenshotSource` (`src/runner/test-pages.ts:103-106`) name the page's engine; the final run records `chromium`, `firefox` and `webkit`, and `evaluation-engines.test.ts` now requires the record to name the engine that took the capture. `tests/unit/protocol-identity.test.ts:205` still expects `webkit` to be refused and failed in the unit run here; it belongs to that lane.
10. **Smaller gaps, each left out rather than invented.** WebKit names no frame for a message and records no protocol, though its collector reads `metrics.protocol` (`src/diagnostics/webkit-collector.ts:67`) and drops it; WebKit's redirect hops carry no size. Firefox gives no resource type and measures in whole milliseconds. WebKit reports `console.count` at the debug level and Firefox `console.trace` at the debug level.

## Visual evaluation per engine

`tests/integration/evaluation-engines.test.ts` serves a saved-task page and a broken one, the broken one with a magenta banner over the top half of an 800 by 600 viewport, and runs six checks on each engine through `retest run`:

| Check | Judge, `accepts` | Every engine |
| --- | --- | --- |
| page without the defect | pixel judge, `['images']` | passed, verdict pass |
| page with the defect | pixel judge, `['images']` | failed `evaluation_failed`, verdict fail |
| scripted pass, fail, inconclusive | fake judge, `['text', 'images']` | passed; failed `evaluation_failed`; inconclusive `evaluation_inconclusive` |
| screenshot for a text judge | fake judge, `['text']` | error `evaluation_error`, "does not accept images", nothing captured, judge never called |

On each engine every screenshot record names the app, session, attempt and test, sits on the run's clock, is 800 by 600 (the viewport at a pixel ratio of 1) and matches its file by SHA-256; the pixel judge was handed those bytes, matched by hash; the fake judge's three calls are matched to the scripted checks' captures by kind, app, size in bytes and dimensions only, not by hash, and it was never called for the text judge. The defect colour covered 0 of the fixed page and 0.4989 of the broken page on all three engines. Each record names the engine that took the capture: `chromium`, `firefox`, `webkit` (finding 9).

The pixel judge decodes the PNG with Retest's own decoder and counts pixels of the banner's colour; it proves the evidence path on real captures, not any model's judgement.

## Live provider gates

Three gates, each its own test, each needing only its own key in the environment of the process that runs the tests:

| Gate | Runs when | Model | Without its key |
| --- | --- | --- | --- |
| `live provider gate, Anthropic: …` | `RETEST_EVALUATION_ANTHROPIC_KEY` is set | `claude-sonnet-5` | skipped: "unverified: RETEST_EVALUATION_ANTHROPIC_KEY not set, so Anthropic was not called" |
| `live provider gate, OpenAI: …` | `RETEST_EVALUATION_OPENAI_KEY` is set | `gpt-5.5-2026-04-23` | skipped: "unverified: RETEST_EVALUATION_OPENAI_KEY not set, so OpenAI was not called" |
| `live provider gate: … Azure deployment` | `RETEST_EVALUATION_AZURE_KEY`, a resource or base URL, and a deployment are set | the deployment named | skipped, naming each missing variable |

Each runs one text check and one screenshot check from the packed package with the pinned SDK, the judge declaring `accepts: ['text', 'images']`. The Anthropic and OpenAI gates assert the pass, the judge, provider and model in the record, a model revision, the screenshot record, and that the key is in no run file and no output; the Azure gate is unchanged. Before this change the Anthropic and OpenAI checks shared one test, which skipped unless both keys were set. No key was available here: all three skipped by name (log below). The provider paths are exercised without a key against the local stand-ins in the same file, which are unchanged. The live gates take Chrome's screenshot only; live judges over Firefox and WebKit captures were not wired.

## Commands and results

Every command that starts a browser or a compiler over the tree ran under `lockf -t 0 /tmp/retest-heavy-gate.lock`, through `.retest/scratch-diagnostics/locked.sh`, which tries again every sixty seconds while another lane holds the lock. Logs are under `/tmp`. Other lanes were editing `src/native/**`, `src/runner/**`, `src/shared/**`, `src/browser/webkit/**`, `src/agent/**` and `src/cli/**` throughout; runs that died on their half-written files were run again once the tree imported, and the failures that are theirs are named.

| Command | Result | Log |
| --- | --- | --- |
| `node --conditions=retest-source --test tests/integration/diagnostics-engines.test.ts`, all three engines in one run, the last | 61 of 69: Chrome every case; Firefox 10 of 11 cases, the fixture page case failing 5 of its 12 subtests, 6 of 13 counting the case itself (findings 1, 3, 4, 5, 6); WebKit 10 of 11 cases, the fixture page case failing 1 check (finding 7) | `retest-final-diagnostics-engines-11.log` |
| the same, the run before it, before the capture sources changed | 61 of 69, the same failures | `retest-final-diagnostics-engines-7.log` |
| the Firefox cases alone, after the Firefox driver landed | 10 of 11 cases, the same 5 checks failing | `retest-diag-engines-int-firefox-10.log` |
| `node --conditions=retest-source --test tests/integration/evaluation-engines.test.ts`, the last | 3 of 3; sources `chromium`, `firefox`, `webkit` | `retest-final-evaluation-engines-11.log` |
| the same, before another lane named the capture sources | 3 of 3; Firefox and WebKit records with no source | `retest-final-evaluation-engines-7.log` |
| `node --conditions=retest-source --test tests/unit/diagnostics-engines.test.ts` before the fix in `session-capture.ts` | 22 of 24; the two failures Firefox's (finding 2) | `retest-diag-engines-unit-2.log` |
| the capture-level case per engine, before the fix | 2 of 3; Firefox's failed | `retest-capture-kind-before.log` |
| the six diagnostics unit files after the fix (`diagnostics-engines`, `diagnostics-capture`, `firefox-collector`, `webkit-collector`, `diagnostics-run`, `diagnostics-policy`) | 78 of 79; `diagnostics-run` could not load, on another lane's half-written `src/browser/webkit/target-session.ts` | `retest-capture-kind-after.log` |
| `npm run test:unit`, after the fix | 3176 of 3196; no failure in a diagnostics file; the 20 are in other lanes' files (agent host, session and recipes, native helpers and simulator, builds install, playwright-resolve, protocol identity, Electron target, native run end, target drivers, WebKit target session) | `retest-diag-unit-all-12.log` |
| `npm run test:unit`, before the fix | 3036 of 3040: the two Firefox cases and the two `playwright-resolve` cases | `retest-diag-unit-all-1.log` |
| `npm run test:types` | 234 expected errors matched on TypeScript 6.0.3 and 7.0.2 | `retest-diag-types-8.log` |
| `npm run typecheck`, before other lanes' edits reached the tree | exit 0 on both compilers and the example | `retest-diag-typecheck-1.log` |
| `npm run typecheck`, the last | exit 2: 3 errors, all in other lanes' files (`tests/conformance/engines.ts`, `tests/integration/webkit-roles.test.ts`); none in this lane's, no `FATAL` | `retest-diag-typecheck-15.log` |
| `tsc -p tsconfig.json` on 6.0.3 and on 7.0.2, before that | 9 and 10 errors, all in other lanes' files (`src/cli/doctor/checks.ts`, `tests/conformance/execute.ts`, `tests/integration/webkit-roles.test.ts`, `tests/unit/builds-fixtures.ts`); none in this lane's | `retest-diag-typecheck6-13.log`, `retest-diag-typecheck7-13.log` |
| `node --conditions=retest-source --test tests/integration/diagnostics.test.ts`, `diagnostics-collector.test.ts`, `evaluation.test.ts` | 15 of 15, 6 of 6, 1 of 1 | `retest-final-diagnostics-7.log`, `retest-final-diagnostics-collector-7.log`, `retest-final-evaluation-7.log` |
| `node --conditions=retest-source --test --test-name-pattern="live provider gate" tests/integration/evaluation-ai-sdk.test.ts`, no key in the environment | 3 skipped, each by its own name and variable | `retest-eval-live-gates-skip-1.log` |
| `node --conditions=retest-source --test tests/integration/evaluation-ai-sdk.test.ts`, after the edit | 3 pass, the stand-in and proxy cases among them; the 3 live gates skipped by name | `retest-final-evaluation-ai-sdk-14.log` |
| the same, an earlier attempt | 3 failed and 3 skipped: `npm run build` failed on another lane's `src/native/executors.ts`, so nothing was packed | `retest-final-evaluation-ai-sdk-7.log` |
| Probe: the fixture page on Firefox with `diagnostics: { capture: false }` | passes; the title stays "Diagnostics" | `retest-diag-probe-firefox-off-result.json` |
| Probe: the fixture page on Firefox with capture on | fails: "The page's title is \"the getter ran\"" | `retest-diag-probe-firefox-result.json` |
| Probe: WebKit's `Console.messageAdded` for a message of four arguments | a plain object's preview has no `overflow` | `retest-diag-probe-webkit-args.log` |

The cases that depend on how a driver labels a frame: none asserts the frame of a document a navigation loaded. The fixture case reads `frame: 'child'` only on the same-site frame's fetch and document, where an engine's scope claims frames (Chrome and Firefox), and the navigation case compares hosts and paths. A WebKit change that stops labelling the main document of a cross-process navigation a child frame changes no assertion here.

## What could not be verified

Most important first.

1. **Firefox through its default route.** Every Firefox run here went through Launch Services, because this host app may not read Firefox's data folder; a spawned Firefox, which the product uses by default, was not exercised by this lane.
2. **The live provider gates with a key.** No key was available. The Anthropic, OpenAI and Azure gates skipped by name; the two new per-provider gates have never run with a key. Live judges over Firefox and WebKit screenshots are not wired; the live gates take Chrome's.
3. **The whole `npm run test:integration` suite.** Not run: other lanes were editing the runner, native, shared and WebKit code throughout. Only the six diagnostics and evaluation files were run.
4. **Why Firefox runs the getter.** The cause is read from the protocol: Firefox serializes the arguments of every console entry it sends for `log.entryAdded`. Retest has no setting here that asks for entries without arguments; which property read runs the getter was not traced.
5. **A renderer crash on Firefox and WebKit.** Only a browser closed mid-capture was tried there; Chrome's renderer kill stays in `diagnostics-collector.test.ts`.
6. **Service workers and shared workers on Firefox and WebKit.** Not exercised; neither scope claims them.
7. **Linux.** Nothing here ran on Linux; Firefox and WebKit are refused there by design.
8. **Capture overhead per engine.** Not measured.

## After the review

The review, `reviews/phase-3-review-diagnostics.md`, found 5 medium and 8 low items. The fix lane's report is `reviews/fix-reports/fix-diagnostics-tests-report.md`.

- D-1, D-2, D-3, D-5, D-6 and D-11, in `tests/integration/diagnostics-engines.test.ts`:
  - each area of the page is its own subtest, and a record from a frame or a worker must carry its true label whatever the scope declares;
  - the scope must match what arrived: an area declared covered left its record, and one declared not covered left none;
  - pending is exactly 1, and the page's own fetches are counted exactly;
  - a message's text is checked whole, all four arguments;
  - the secrets case requires a record holding `{{token}}` and one holding `{{password}}` from the logged object;
  - the strict policy and a deliberately failing test run on every engine;
  - the stopped run asserts the network state, and the pooled runs the console state.
- D-7 and D-8, in `tests/unit/diagnostics-engines.test.ts`:
  - the cannot-start case asserts that a collector was made and holds no listener;
  - listeners are counted after a lost connection and after stop;
  - the time on a message is asserted.
- D-8, the WebKit collector: a message or a repeat without WebKit's own time is now counted as unread. Two unit cases pin it, and both fail on the earlier collector.
- D-9: each live gate has a screenshot check with a false requirement that must come back `fail`. No gate has run with a key.
- D-10 and D-13: corrected in finding 8, the visual evaluation paragraph and the commands table above.
- D-12: an unreadable event counts under the kind it feeds, so Chrome's `Page.frameDetached` counts as network.
- D-4: the guide's "Per engine" section now names what ran on each engine.

The coverage table and the differences above are this lane's first run, before the WebKit and Firefox fix lanes changed both collectors. Where they disagree with the following, the following is current.

Firefox now records requests only, and names its console unavailable. The two files expect that through one table each (`expected` in the integration file, `consoleUnavailable` in the unit file). The table holds the two differences the release decided: Firefox's console, and its worker requests named by the page. Chrome and WebKit cannot pass a console check by declaring less.

| Engine | `diagnostics-engines.test.ts`, 13 cases, 30 tests | Log |
| --- | --- | --- |
| Chrome | 30 of 30 | `.retest/scratch-fix-diagnostics-tests/logs/diagnostics-chrome-3.log` |
| WebKit | 30 of 30; the scope covers frames of both kinds, and every argument reaches the text | `.retest/scratch-fix-diagnostics-tests/logs/diagnostics-webkit-3.log` |
| Firefox | 30 of 30. The console is `unavailable` with its reason in every case, and a strict runtime-error rule cannot judge. The network checks pass, with a dedicated worker's fetch counted as the page's, as its scope's reason says. | `.retest/scratch-fix-diagnostics-tests/logs/diagnostics-firefox-3.log` |

`tests/unit/diagnostics-engines.test.ts` passes 34 of 34.
