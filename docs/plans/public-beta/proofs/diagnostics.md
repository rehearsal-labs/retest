# Console, runtime error and network diagnostics on Chromium: record

3 October 2026. Release 0.1.0, Phase 1 item 10 ([release-0.1.0.md](../release-0.1.0.md)), the [console/network output contract](../diagnostics.md), and "AI evaluation and diagnostic output" in [releases.md](../releases.md).

## Result

Every test page on Chromium has its console messages, uncaught errors and network metadata captured, in passing and failing runs alike. The parent process holds the collectors: each starts on the test's own page target before the page's first navigation and ends once the body and the parent's checks are over. Every page text is redacted whole, then the addresses in it are cleaned, and only then is it cut; a value Chrome itself cut in a preview is never kept. Each session writes one bounded JSON lines artifact, which `result.json` and the events name by a relative path. Each kind, console and network, has an explicit state: `complete`, `partial` with a reason and counts, `unavailable` with a reason, or `disabled`. Console errors and HTTP error responses fail nothing unless a declared strict policy names them; a strict rule never passes on capture that was not complete, and a declared required-capture policy keeps a test with incomplete capture from passing. Neither ever replaces a failure the test already had.

Revised the same day after the lane review's eleven findings; each is answered under "Review findings and what changed".

Everything below was exercised on Google Chrome 154.0.8037.93 on macOS arm64. Firefox, WebKit and native sources were not touched.

## How to run it

From the Retest root, with Node 24.12 or later and Google Chrome:

```sh
node --conditions=retest-source --test tests/unit/diagnostics-sanitize.test.ts tests/unit/diagnostics-capture.test.ts tests/unit/diagnostics-policy.test.ts tests/unit/diagnostics-run.test.ts
node --conditions=retest-source --test tests/integration/diagnostics.test.ts tests/integration/diagnostics-collector.test.ts
npm run test:types
node --conditions=retest-source scripts/measure-diagnostics.ts 10
```

## Settled names

| What | Name |
| --- | --- |
| Config block | `diagnostics: { capture?, strict?, requireComplete?, limits? }` (`DiagnosticsConfig`, `StrictDiagnostics` in `src/config/types.ts`) |
| Host option | `RunOptions.diagnostics`, the same shape; it replaces the config's whole block |
| Capability | `OwnedPage.collectDiagnostics?(sink, timeoutMs)`, implemented by `ChromiumPage` (`src/browser/page.ts`); absent on a driver that collects nothing |
| Collector | `ChromiumCollector` and `chromiumScope` (`src/diagnostics/chromium-collector.ts`) |
| Parent side | `SessionCapture`, `AttemptBudget` (`src/diagnostics/session-capture.ts`), `AttemptDiagnostics` (`src/diagnostics/attempt.ts`) |
| Records and schemas | `src/protocol/diagnostics.ts`, exported from `@rehearsal-labs/retest/protocol` |
| Events | `diagnostics.started`, `diagnostics.finished` |
| Result | `TestResult.diagnostics: DiagnosticsSummary[]` |
| Artifact | `diagnostics/<test slug>-<attempt>[-<app>].jsonl` (`diagnosticsFile` in `src/protocol/run-folder.ts`) |
| Failure classes | none new: a strict policy fails as `host_check_failed`, a required capture as `reporting_failed` |

## The records

An artifact is JSON lines: a `capture.started` line, the records in the order they arrived, a `capture.finished` line. Every record carries `testId`, `attemptId`, `app`, `sessionId` and, in a run with variants, `target`. Times are ISO 8601 from the browser's clock: `Runtime` and `Log` timestamps as given, network times from each request's own wall time plus Chrome's monotonic offsets, or the response's `responseTime` when Chrome gives it.

| Record | Fields |
| --- | --- |
| `console` | `id` (`c1`...), `consoleType` as Chrome gave it (`log`, `debug`, `info`, `warning`, `error`, `table`, `count`, `assert`, `trace`, `dir`..., or a log entry's level), `level` (`debug`, `info`, `warning`, `error`), `origin` (`page`, `worker`, `browser`), `source` for a browser entry, `text` (a truncated text: `text`, `truncated`, `length`; a preview value Chrome cut reads `(cut)`, strings are quoted and never escaped, a function is its whole first line), `time`, `url`, `line`, `column` (from 1, when given), `frame` (`main`, `child`), `requestId` for a browser entry about a recorded request |
| `runtime_error` | `id` (`e1`...), `kind` (`uncaught`, `unhandled_rejection`), `message` (Chrome's line, such as `Uncaught Error: boom`), `time`, `url`, `line`, `column`, `frame`, `stack` (`function`, `url`, `line`, `column`), `framesDropped`, `handledLater` |
| `network.request` | `requestId` (`n1`...), `method`, `url`, `urlTruncated`, `resourceType`, `frame`, `time`, `redirectedFrom` |
| `network.response` | `requestId`, `status`, `statusText`, `contentType` (the media type Chrome read), `time`, `cache` (`disk`, `memory`, `prefetch`, `none`, only when Chrome said), `serviceWorker` (only when Chrome said), `protocol`, `redirectedTo` |
| `network.finished` | `requestId`, `time`, `durationMs` (Chrome's monotonic clock, from the request to the end), `transferredBytes` (Chrome's encoded length); each absent when Chrome gave nothing, never zero in its place |
| `network.failed` | `requestId`, `time`, `durationMs`, `reason` (`net::ERR_...`), `canceled`, `blocked` |
| `network.pending` | `requestId`, `time`, `lastState` (`requested`, `responded`, `receiving`), `reason` (`attempt_ended`, `run_interrupted`, `page_crashed`, `connection_lost`, `out_of_scope`) |

An HTTP 404 or 500 is a `network.response` with that status, followed by `network.finished`. A refused connection is a `network.failed` with no response. An error answer with no body is a `network.response` with its status followed by Chrome's `network.failed` (`net::ERR_HTTP_RESPONSE_CODE_FAILURE`); both records are kept, and it counts once, as the HTTP error. The requests of Chrome's own error page (`documentURL` `chrome-error://…`, its `data:` images) are marked `out_of_scope`. Each hop of a redirect is a request of its own: the hop's response carries `redirectedTo`, the next hop's request `redirectedFrom`, and a redirect hop gets `network.finished` when its response arrives.

A session's summary in `result.json` and `diagnostics.finished`: `app` (in a run from a config), `sessionId`, `path`, `scope`, `startedAt`, `endedAt`, and `console` and `network` each as `{ state: 'complete' | 'partial', reason?, ...counts }`, `{ state: 'unavailable', reason }` or `{ state: 'disabled' }`. Console counts: `entries`, `errors` and `warnings` (written by the page's code or its workers; Chrome's own entries count only in `entries`), `runtimeErrors` (never handled), `handledLater` (rejections handled after Chrome reported them), `dropped`, `truncated`, `bytes`. Network counts: `requests`, `httpErrors`, `transportFailures`, `canceled`, `pending`, `outOfScope`, `dropped`, `truncated`, `bytes`.

`diagnostics.started` carries `scope`, `limits`, `startedAt` and, when anything is strict or required, `policy`. A capture that never started has no start marker.

## Declared scope, and what is not covered

The source is the CDP session of the test's own page target, with `Runtime`, `Log` and `Network` enabled (`Network.enable` with `maxPostDataSize: 0`, so post bodies never cross the pipe, and both body buffers at 0, so Chrome keeps no response body for later reading). Each row below except shared workers was exercised by `tests/integration/diagnostics.test.ts`; the out-of-scope marks of the worker's script and the other site's document are asserted there. For service workers, the worker's own message not being captured and a response it answered carrying `serviceWorker: true` are asserted; its own requests not being recorded is not.

| Area | Console | Network | How it was exercised |
| --- | --- | --- | --- |
| The page's document | covered | covered | every main-page record |
| Frames in the page's own process | covered, `frame: 'child'` | covered, `frame: 'child'` | a same-origin `<iframe>` logs and fetches; both recorded |
| Frames of another site (out of process) | not covered | not covered | a `localhost` frame inside a `127.0.0.1` page logs and fetches, then tells the page it did; neither is recorded. Its document request is recorded and marked `out_of_scope` when Chrome swaps it to its own process (`Page.frameDetached` with `reason: 'swap'`) |
| Dedicated workers | covered, `origin: 'worker'`, level only | not covered | a worker logs and fetches, then tells the page the status; its message is recorded through Chrome's `Log` forwarding, its fetch is not. Its own script request is marked `out_of_scope` |
| Service workers | not covered | not covered | a worker in its own folder logs on each navigation and answers the page; its message is not recorded. Responses it answered for the page are recorded with `serviceWorker: true` |
| Shared workers | not covered | not covered | not exercised, so not claimed |

Messages from Retest's own isolated world, and from any other non-default world, are left out: shown by a unit test on the fake session only. Capture ends before the failure screenshot and before the page closes, so neither should leave records; no test checks that.

## Limits and defaults

Per attempt, all its sessions together: `consoleEntries` 1000 and `consoleBytes` 1048576 (console messages and runtime errors), `requests` 1000 hops and `networkBytes` 2097152; per message `textLength` 4096; per stack `stackFrames` 20. Bounds, not tuned numbers. A record past a limit is dropped and counted in `dropped`, and the kind becomes `partial`. A cut message or error text keeps its full length; a cut address is marked `urlTruncated` with no length; the short fields (method, status text, reason, function name, content type, protocol, resource type) are cut to their own limits with no mark; a cut record counts in `truncated`. A request hop is admitted only while the attempt can also hold its later records at their largest (every bounded field written at six bytes per character), so a kept request never loses its response or its end, and the byte limits hold. One exception: a rejection the page handles later adds 20 bytes to a record already kept, and they are counted, not refused.

## Redaction and sanitizing

- Addresses: credentials removed; query replaced by `?…`, fragment by `#…`. A path segment is replaced by `…` when it has a JSON Web Token's shape, or, unless it has a file extension or the shape of a version or a date, when it holds 12 digits or more or 16 letters and digits or more; a slug of several words is replaced once it holds 16 letters and digits, so `buy-milk` is kept, and a file name that holds a token is kept. `data:` keeps its media type, `blob:` its origin, other schemes their name. Every address field is cleaned. In free text, every address with a scheme is cleaned the same way, running to whitespace, a quote or an angle bracket, with brackets, parentheses and IPv6 hosts inside it, and keeping a stack frame's line and column; a closing bracket the address did not open stays outside it. An address with no scheme inside free text, such as `/api?token=…`, is not cleaned: only the redactor reads it.
- Order: redact the whole text with the run's redactor, then clean its addresses, then cut. A message more than four times its limit is cut first, and the redactor holds back any tail that may begin a secret. Nothing is escaped before the redactor reads it. Chrome cuts a value of 100 characters or more in an object's preview, keeping its first 50 and last 49; such a value is written `(cut)` and none of it is kept. A function's description is kept as its whole first line, cut only after redaction. Records are redacted again when the artifact is written and once more at the end of the run, as logs are, for a value learned later; the end-of-run pass is tested as the helper (`redactArtifactText`, unit) only, not through the run's own call of it in `src/runner/run-session.ts`.
- No request or response header and no body is ever recorded; the collector's schemas drop every key they do not name, so headers and post data never reach a record. A response keeps only Chrome's media type.
- Console arguments are rendered from what Chrome sent with the message: values, descriptions and one-level previews. Retest never calls `Runtime.getProperties` or `callFunctionOn` for them and keeps no `objectId`. A getter is shown as `(...)`; the fixture's getter would change the page title and the test checks that it did not.
- AI evaluators receive no diagnostics in this release: nothing passes them, by construction. No test reads an evaluator payload for them.

## Policy

- Strict (`strict: { runtimeErrors?, consoleErrors?, transportFailures?, httpErrors?, allow? }`): counts runtime errors not handled later, console errors from the page's code or its workers, transport failures that are neither cancellations nor the failure that ends an error answer, and responses of 400 or more, leaving out a record whose message or address holds an `allow` entry. Judged by the parent from the records it kept, after the body, the host checks and the AI checks; test code cannot answer it. It fails a test that otherwise passed as `host_check_failed` with `details.policy: 'diagnostics.strict'`, exit 1. The failure names counts and records by session and id (at most 20, then how many more) and the artifact; no page text enters it. A test that already failed keeps its failure first and gets the policy's in `details.also`.
- A strict rule never passes vacuously: when a kind a declared rule reads (the console for `runtimeErrors` and `consoleErrors`, the network for the others) is not `complete` in any session, the test cannot pass, as `reporting_failed` with `details.policy: 'diagnostics.strict'`, status `error`, exit 2, saying the policy could not judge it. Matches found stay first.
- Required (`requireComplete: true`): any session's console or network not `complete` keeps the test from passing as `reporting_failed` with `details.policy: 'diagnostics.requireComplete'`, status `error`, exit 2. Capture loss never replaces an earlier failure.
- Why no new failure classes: both reuse classes every version 1 reader already accepts, with their status rules (`host_check_failed` fails, `reporting_failed` is ours). A strict policy reads as a check the run requires and test code cannot answer, as a host check does; a required capture that is not complete is output the run could not keep. The ending a replay host reads for these is the replay lane's to settle in `attemptEnding`.
- `capture: false` together with `strict` or `requireComplete` is refused by the one validator the config block and `RunOptions.diagnostics` share (`src/diagnostics/policy.ts`); only the `RunOptions` path is tested.

## Protocol changes

All additive to `schemaVersion` 1. What a reader built before this lane rejects, since every version 1 object refuses unknown keys:

- `events.jsonl` lines of type `diagnostics.started` and `diagnostics.finished`: an old `readEvents` refuses the whole file ("not a version 1 event"), and an old `inspect` then shows the result without steps.
- `result.json` with `diagnostics` on a test: an old `readRunFolder` refuses the result ("does not match the version 1 result").
- A config with a `diagnostics` key: an old loader refuses it as an unknown key.
- Nothing else changed shape: no failure class, status, exit code or existing field was added to or altered.

The artifact lines have their own schema (`diagnosticLineSchema`), with `capture.started.schemaVersion: 1`.

## Gates

Each claim, the test that shows it on real Chrome, and its file. `tests/integration/diagnostics.test.ts` runs `retest run` from source on the task app; `tests/integration/diagnostics-collector.test.ts` drives the same `AttemptDiagnostics` the runner uses on a launched browser.

| Claim | Test |
| --- | --- |
| Every console level and other types, each with its type, level, frame, address, line and column; object previews; a getter shown, never called | `a page with every kind of record leaves one artifact whose records say what happened, and the test passes` |
| Two runtime errors (uncaught, unhandled rejection) with stacks, the token in the script address gone | same |
| A 404 and a 500 as responses with statuses and finishes; a closed port as `net::ERR_CONNECTION_REFUSED` with no response and no status | same |
| Two redirect hops (302, 307) each related to the next, ending in the final answer | same |
| A request that never finishes marked pending at the attempt's end, with how far it got | same |
| The declared scope: same-process frame and worker console covered, other-site frame and worker fetch not; the worker's script (`requested`) and the other site's document (`responded`) marked `out_of_scope` | same |
| Capture started before the first navigation; events name the artifact | same |
| Human and agent reports print counts and the artifact location, never a page word, for a passing run and for a strict failure; `inspect --test` shows console entries and a request table by time, with the action running then; `--json` has every line | `the reports say how much was captured and where, never what a message said, and inspect shows the records`; `a declared strict policy fails a test that otherwise passed, in the parent, and names what matched` (strict failure: it asserts the counts and that no page word prints, not the artifact location) |
| A secret put in a console message, an error, a query, a path, Authorization and X-API-Key headers, a cookie and a stack address reaches no file in the run folder; a secret with a quote and a backslash neither, raw or JSON-escaped; no ten characters of a 143-character secret inside an object (which Chrome cuts in its preview), of a short secret inside a 149-character string, or of a secret in a function source; an unknown query token neither; no header name appears in the artifact (the reports are not read for one) | `a secret the page puts in messages, errors, queries, paths, headers, cookies and stacks reaches no file` |
| A strict policy fails a passing test in the parent, names counts and record ids, never text, honours `allow`, and records itself in `diagnostics.started` | `a declared strict policy fails a test that otherwise passed, in the parent, and names what matched` |
| A strict rule whose console capture overflowed before the error never passes: `reporting_failed`, could not judge | `a strict policy whose console capture overflowed before the error says it could not judge, and never passes`; unavailable capture: `a strict policy on a driver that collects nothing cannot pass: the test says it could not be judged` (unit) |
| An empty 404 and an empty 500 on a navigation count once each as an HTTP error, a strict transport rule passes, Chrome's error page requests are `out_of_scope` | `an error answer with no body is one HTTP error, never a transport failure too, and Chrome's error page is out of scope` (collector file) |
| A run stopped while a page is slow to start capture waits for no page; the test is interrupted | `a run stopped while a page is slow to start its capture waits for no page, and the test is interrupted` (unit, a page that answers only after its 20 s budget) |
| A strict policy never replaces the test's own failure | `a strict policy never replaces the failure a test already had` |
| Expected console errors and HTTP errors fail nothing without a policy | `without a policy, expected console errors and HTTP error responses fail nothing` |
| Record overflow drops and counts, makes the kind partial, keeps every kept hop whole; a required capture refuses the test as `reporting_failed` | `records over the limits are dropped and counted, the capture is partial, and a required capture keeps the test from passing` |
| An oversized message is cut with its length kept; the byte limit drops what does not fit | `an oversized message is cut, with its length kept, and counted as cut; the byte limit drops what does not fit` |
| Two files at once in one browser, three tests each in its pool, twice: every record with its own attempt | `two files at once in one browser, each test after another in its pool, keep every record with its own attempt` |
| Two apps of one test, two contexts at once: each artifact holds its own page only | `two apps of one test, two contexts at once, each keep their own records in an artifact named with the app` |
| Cancellation (SIGINT) keeps what was captured, marks the open request `run_interrupted`, exit 130 | `a run stopped while a request hangs keeps what it captured, marks the request interrupted, and exits 130` |
| `capture: false` writes nothing and says `disabled` | `capture turned off records nothing, writes no artifact, and every result says it was disabled` |
| An empty page is a complete, empty capture with its markers | `a page with nothing to say leaves a complete, empty console capture, which reads apart from an unavailable one` |
| A service worker's answer is marked; its own message is not captured | `a response a service worker answered says so, and the worker's own messages are not captured` |
| App crash (renderer killed): partial with the reason, earlier records kept, open request `page_crashed` | `a page whose renderer crashes leaves a partial capture that keeps what came before, with open requests marked` (collector file) |
| Injected collector disconnect (`Target.detachedFromTarget` for the page's session): partial, open request `connection_lost` | `a connection to the page that ends leaves a partial capture, with open requests marked as lost` (collector file) |
| A capture that cannot start (Network.enable held past its budget) is `unavailable` with the reason, no artifact, no start marker; an empty page is `complete` with zero entries | `a capture that cannot start is unavailable, with the reason, and never reads as an empty capture` (collector file) |
| No listener survives the end of capture | `counts an event it cannot read, reports a crash and a detach once, and removes every listener when it stops` (unit): the proof is the fake session's live-handle count reaching zero. On real Chrome, `a capture that ended hears nothing more, though the page goes on` (collector file) shows only that nothing more reaches the artifact after the end, and that a second ending changes nothing; it cannot see a listener that records nothing |
| Two contexts of one browser at once | `two contexts of one browser at once each keep only their own records` (collector file) |
| A rebuilt result keeps every reference; a capture cut off with the run is `unavailable` | `a result rebuilt from the events keeps every reference, and a capture cut off with the run reads as unavailable` (`tests/unit/diagnostics-run.test.ts`) |
| A driver with no capability is `unavailable` in every result, and the summary counts it, so it never reads as a complete, quiet capture | `diagnostics in a run with a driver that collects none` (unit) |
| A failure card names the counts, a partial or unavailable capture with its reason, the artifact, and the scope beside it | `a strict policy fails each test that otherwise passed, from the parent, and the run exits 1` and `a required capture keeps a test whose driver collects none from passing, as an error, and its card says why` (unit) |
| A `RunOptions.diagnostics` block that cannot be read refuses the run | `a block the run cannot read refuses the run before any test runs` (unit) |

### Gate runs on the shared tree, 3 October 2026

| Command | Result | Log |
| --- | --- | --- |
| `npm run test:unit` | 2072 pass, 0 fail; after the review fixes 2087 pass, 0 fail | `/tmp/retest-diagnostics-gate-unit.log`, `/tmp/retest-diagnostics-review-unit.log` |
| `npm run test:types` | 196 expected errors matched on TypeScript 6.0.3 and 7.0.2, before and after the fixes | `/tmp/retest-diagnostics-gate-types.log`, `/tmp/retest-diagnostics-review-types.log` |
| `lockf -t 0 /tmp/retest-heavy-gate.lock npm run typecheck` | clean, exit 0, before and after the fixes | `/tmp/retest-diagnostics-gate-typecheck2.log`, `/tmp/retest-diagnostics-review-typecheck.log` |
| `lockf -t 0 /tmp/retest-heavy-gate.lock npm run test:integration` | before the review fixes: 389 tests, 388 pass, 0 fail, 1 skipped (the live AI gate, without keys). Not rerun after them; the two diagnostics integration files were: 21 pass | `/tmp/retest-diagnostics-gate-integration.log`, `/tmp/retest-diagnostics-review-integ.log` |

## Measurements

Measured once, by `scripts/measure-diagnostics.ts 10`, on this machine (macOS arm64, Node 24.12.0, Google Chrome 154.0.8037.93), holding the heavy-gate lock so no other gate ran, with no benchmark running. Ten rounds, capture on and off alternating in each round. Times are each test's own duration from `result.json`, and a whole run's wall time. Held bytes are the serialized size of the records an attempt kept, as its summary counts them; the capture holds those records until the attempt ends, so it is the largest that buffer grew, not a measure of the process's memory. Measured again after the review fixes, the numbers below; the first measurement, before them, was within a few milliseconds of these medians. One machine: no claim follows from these numbers.

| Test | Capture on, median (min to max) | Capture off, median (min to max) | Held bytes, median |
| --- | --- | --- | --- |
| `/diagnostics` (18 console records, 2 runtime errors, 14 request hops) | 146 ms (136 to 160) | 144 ms (134 to 151) | 20112 |
| `/diagnostics/flood?count=500&size=200&fetches=200` | 154 ms (145 to 176) | 152 ms (141 to 176) | 470665 |
| Whole run of both tests | 655 ms (641 to 701) | 650 ms (631 to 662) | |

The spreads overlap; the medians differ by 2 to 5 ms on tests of about 150 ms. The first measurement, before the review fixes, gave medians of 164 and 153 ms (main), 149 and 147 ms (flood) and 665 and 657 ms (run), on and off.

## Review findings and what changed

| Finding | Change | Shown by |
| --- | --- | --- |
| 1. Chrome's preview cuts long strings, leaving parts of a secret; Retest's own function cut did too | A preview value of 100 characters or more is written `(cut)` and none of it kept; a function keeps its whole first line; every text is redacted before any cut of Retest's | secrets integration test (143-character secret in an object, short secret inside a 149-character string, function source; no ten characters left); `keeps none of a value Chrome cut in a preview…` and `finds a secret with quotes and backslashes…` (unit) |
| 2. Escaping before redaction kept `pa"ss\word9` | Strings are quoted and never escaped; JSON escapes only after redaction | the same tests; a secret with a quote and a backslash in the integration test |
| 3. Addresses with brackets or IPv6 hosts kept their tokens | The address in free text runs to whitespace, a quote or an angle bracket; a closing bracket it did not open stays outside | `takes brackets in a query and an IPv6 host as part of the address…` (unit) |
| 4. Strict passed when capture was unavailable or partial | A rule whose kind is not complete cannot pass: `reporting_failed`, could not judge | overflow integration test; unavailable unit test |
| 5. Reports never said a capture was unavailable, cut or what it covered | The summary counts partial and unavailable captures and records cut; cards name a partial or unavailable capture and a Scope line beside the artifact | `the reports count the captures that were never there…` and the card tests (unit) |
| 6. Strict failures quoted page text | The failure names counts, record ids and the artifact only | `keeps a page from writing a line into a report…` (unit); strict integration test |
| 7. An empty error answer counted as an HTTP error and a transport failure | It counts once, as the HTTP error; Chrome's error page requests are `out_of_scope` | `an error answer with no body is one HTTP error…` (collector file); unit tests in capture and policy |
| 8. The token rule kept long codes and hid file names, versions and dates | Rewritten: JWT shape replaced; file name, version and date kept; 12 digits or 16 letters and digits replaced | `hides a long run of digits and a long name with no extension…` (unit), all six of the reviewer's segments |
| 9. A stop during a slow `Network.enable` waited out the setup budget per page | Each start is raced against the run's stop; a late collector is stopped; the attempt ends interrupted | `waits for no page once the run stops…` and `a run stopped while a page is slow to start its capture…` (unit) |
| 10. `runtimeErrors` counted handled rejections | `runtimeErrors` counts errors never handled; `handledLater` counts the rest | `counts a failure that ends an error answer… and a rejection handled later apart` (unit) |
| 11. The record claimed more than its tests showed | Corrected: listener removal, out-of-scope marks (now asserted), reports under a policy (now tested), which addresses are cleaned, what held bytes measure | this record |

## Release 1 diagnostic fixtures

Frozen as of this record, in `fixtures/task-app/diagnostics-page.ts` and `fixtures/task-app/diagnostics-routes.ts`, served by the task app:

| Path | What it does |
| --- | --- |
| `/diagnostics` | every console level and `table`, `count`, `assert`, `trace`, `dir` with a getter; a same-origin frame and a `localhost` frame; a dedicated worker; an uncaught error from `/diagnostics/thrower.js?token=…`; an unhandled rejection; fetches answering 200, 404 and 500, a two-hop redirect, a closed loopback port and a request that never finishes; shows `Done` once all but the last settle and the frames and worker report |
| `/diagnostics/frame`, `/diagnostics/remote-frame` | the two frames, each logging, fetching and telling the page |
| `/diagnostics/worker.js`, `/diagnostics/thrower.js` | the worker and the throwing script |
| `/diagnostics/data`, `/missing`, `/broken`, `/redirect/1`, `/redirect/2`, `/hang` | the endpoints: 200 (with a Set-Cookie echo of `secret`), 404, 500, 302, 307, headers then nothing |
| `/diagnostics/empty-404`, `/diagnostics/empty-500` | error answers with no body, which Chrome will not show |
| `/diagnostics/quiet` | nothing to say |
| `/diagnostics/flood?count=&size=&fetches=&throws=` | messages and requests for the limits, and with `throws=1` an uncaught error after them |
| `/diagnostics/secrets` | puts what is typed into a message, an error, a query, a path, headers, a cookie, a script address, an object's preview (long and short values) and a function's source |
| `/diagnostics/pending` | one request that never ends, for cancellation |
| `/diagnostics/marker/<alpha…foxtrot>` and `/data` | a page and an endpoint per marker, for isolation |
| `/diagnostics/worker-scope/register`, `/sw.js`, `/page` | a service worker in its own folder that logs and answers navigations |

The human-reviewable evaluation corpus the Phase 1 item also names belongs to Phase 4, with the judge calibration gates in [ai-evaluation.md](../ai-evaluation.md); this lane did not build it.

## What remains

- Firefox and WebKit: no driver yet. The capability is optional on `OwnedPage`, so each driver adds its own collector over BiDi's `log.entryAdded` and `network.*` events, or WebKit's inspector, with its own exercised scope. A driver without one reports `unavailable`.
- Native sources: the app-supplied network source and owned-process logs from the plan are Phase 2. They feed the same records through `SessionCapture`.
- HTML report: none exists yet; the plan's searchable view comes with it.
- Shared workers, service workers' own traffic and frames of another site would need auto-attached targets, which the CDP connection does not route yet.
- Linux was not run.
- Paths no test exercises: the `protocol` field of a response; a name that does not resolve; the 20-frame stack limit and `framesDropped`; a duration that runs backwards, left out (`src/diagnostics/chromium-collector.ts`); an address without a scheme inside free text, kept after redaction; capture ending before the failure screenshot (`src/runner/run-session.ts`); the artifact a body that never ran leaves, which no result names (`#bodyNotRun`); a failed `wx` write of an artifact (`src/store/run-store.ts`); a run given both a config block and `RunOptions.diagnostics` (the resolver is unit-tested, a run with both is not); the default limits of 1000 entries and 1000 requests, which no test reaches; `testId` and `target` on a record's identity, never asserted; the `scope` and `limits` of `diagnostics.started`, never asserted (its `policy` is).
- Shown with the fake session in unit tests only, not on Chrome, though the guide states them as how Chrome's records read: `%s` left as written; entries with `origin: 'browser'`; `handledLater`; a request's `frame`, `contentType`, `cache` and `transferredBytes`; a cancelled request (on Chrome only "not a cancellation" is asserted); user name, password and fragment removal from an address; the path-segment token rules (on Chrome only a query token is shown gone); the `networkBytes` limit; the strict `consoleErrors` rule; the failure card's lines; a quiet run printing no summary row; the stack of an unhandled rejection (on Chrome its kind and message are asserted); a function kept as its whole first line.
