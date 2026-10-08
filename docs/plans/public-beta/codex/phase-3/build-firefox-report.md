# Firefox driver: report

The record is [proofs/firefox-driver.md](../../proofs/firefox-driver.md); this report follows the brief's order.

## What was built

- `src/browser/firefox/bidi-client.ts`, `bidi-message.ts`, `bidi-errors.ts`: the WebDriver BiDi connection over Node's WebSocket, ported from the earlier Firefox proof. Bounded waits, aborts, a pending limit, events, a lost connection told once; Firefox's own error text kept only where a command asks. Keys a result has beyond what Retest reads are dropped, in unions too.
- `route.ts`, `process.ts`, `process-table.ts`, `profile.ts`, `launch.ts`, `executable.ts`: launch with a fresh profile per browser in an owned temporary folder removed at close; the spawn route by default and Launch Services when `RETEST_FIREFOX_ROUTE` says; an owner record per launch; `session.new` checked against the process and profile the launch made; the executable from the target, the pinned cache, or `/Applications`, never downloaded.
- `orphans.ts`: the sweep every launch runs first. It ends a recorded Firefox only when its launcher is gone and the process is still the one recorded, by the shared `sameProcessIdentity` rule (pid and start time; an unreadable command line is no difference; two readable ones that differ are another process).
- `browser.ts`: one BiDi session per browser, each page in a user context and window of its own; refusals by name for a proxy and for emulation beyond a viewport at a pixel ratio of 1.
- `page.ts`, `bridge.ts`, `sandbox.ts`, `accessible-names.ts`, `navigation.ts`, `input.ts`, `storage.ts`: the web session. The shared page code runs unchanged through a bridge that answers its DevTools methods from BiDi in Retest's sandbox. Navigation from Firefox's events and the document's own report of its commit and address; input through `input.performActions` with the shared actionability checks and guard; the guard's listeners behind relays a preload script adds; input held until the guard's verdict call waits in the page; a navigation hold for fills bound to origins; storage state saved and restored without running the site's code; screenshots.
- `src/diagnostics/firefox-collector.ts`: console messages, runtime errors and request and response metadata from BiDi events, with an explicit scope.
- Wiring: `src/runner/target-drivers.ts` (the Firefox driver), `src/runner/browser-pool.ts` (the Firefox branch), `src/config/loaded.ts` and `types.ts` (the Firefox target), `src/cli/doctor/checks.ts` (the Firefox check).
- Tests: `tests/integration/engines.ts` (the shared engine parametrization); `tests/integration/firefox-{lookup,browser-actions,browser-navigation,browser-locators,browser-secrets,m2-state}.test.ts` (the six suites on Firefox); `tests/integration/firefox-driver.test.ts` (identity and profile, one session per browser, four pages filling at once, a password field by label, a lost browser before and after input, cancellation after input, collector coverage and loss, the orphan sweep on a real Firefox); `tests/unit/firefox-*.test.ts` (scripted BiDi for the client, bridge, page, collector, navigation, storage, browser, input, sandbox, orphans, pool, route, executable and profile).
- Docs: the guide's Firefox section, and the record.

## Commands and results

Heavy gates ran through `lockf -t 0 /tmp/retest-heavy-gate.lock`, retried while another agent held it.

| Command | Result | Log |
| --- | --- | --- |
| `node --conditions=retest-source --test tests/unit/firefox-*.test.ts` | 81 of 81 pass | `/tmp/retest-firefox-lane/unit-firefox.log` |
| `node --conditions=retest-source --test tests/unit/runner-target-drivers.test.ts tests/unit/builds-doctor.test.ts` | 29 of 29 pass | `/tmp/retest-firefox-lane/unit-wiring.log` |
| `npm run test:unit` | 3029 of 3041 pass; the 12 failures are in other lanes' files (`diagnostics-engines`, two Firefox cases from the shared capture code; `playwright-resolve`; `native-macos-app`; `runner-command-lanes`; `runner-observations`; `diagnostics-run`) | `/tmp/retest-firefox-lane/gate-unit.log` |
| `lockf … npm run typecheck` | exit 2; every error is in `src/native/**` or `tests/integration/native-macos-lifecycle.test.ts`, mid-edit by other builders; none in this lane's files | `/tmp/retest-firefox-lane/gate-typecheck.log` |
| `lockf … tsc -p /tmp/retest-firefox-lane/tsconfig.json`, with TypeScript and TypeScript 7 (every file of this lane, and what they import) | exit 0, exit 0 | `/tmp/retest-firefox-lane/tsc-a.log`, `tsc-b.log` |
| `lockf … node --conditions=retest-source --test --test-concurrency=1 tests/integration/firefox-lookup.test.ts` | 1 of 1 | `/tmp/retest-firefox-lane/it-lookup.log` |
| the same for `firefox-browser-actions.test.ts` | 62 of 68; 5 fail on named engine differences; 1 skipped (a DevTools gate) | `it-browser-actions.log` |
| `firefox-browser-navigation.test.ts` | 24 of 26; 2 fail on named differences | `it-browser-navigation.log` |
| `firefox-browser-locators.test.ts` | 20 of 21; 1 fails on a named difference | `it-browser-locators.log` |
| `firefox-browser-secrets.test.ts` | 8 of 11; 2 fail on named differences; 1 skipped (a DevTools gate) | `it-browser-secrets.log` |
| `firefox-m2-state.test.ts` | 3 of 3 | `it-m2-state.log` |
| `firefox-driver.test.ts` | 8 of 8 | `it-driver.log` |
| `agent-firefox.test.ts` (the agent sessions lane's suite on this driver) | 15 of 16; 1 skipped (Chrome's screencast) | `it-agent-firefox.log` |
| `lockf … node --conditions=retest-source tests/conformance/run.ts` | exit 1: Firefox 142 of 145 cases and 15 of 15 runs; Chrome 144 of 145, WebKit 143 of 145 | `/tmp/retest-firefox-lane/conformance.log`, `conformance-after.md` |

Firefox's three conformance cases not as declared: A7 (the wheel, an engine difference), F8.1 (a cell by name, now refused by name), and X5, which ended the same way on Chrome in the same run. Earlier conformance runs in this lane, as the driver changed: 111 of 145 cases and 12 of 15 runs at the conformance lane's first look, then 132 and 15, then 141 and 15. Three runs are not counted: one while the machine's open-file table was full from processes outside this lane, two while the CLI could not load because another builder's files were half edited.

The findings handed to this lane, each run again:
- Conformance lane: a password field by label (22 cases), loose and pattern labels (L4, L5), a second hover at one point (A3), the keyboard select (A5, F4.1, F5.1, F7.1), clicks and keys that open a page (F1.1, F9.2, A4) and the save click not heard (A1, U1) pass in the last run. The wheel (A7) is an engine difference; the cell (F8.1) is refused by name, as on WebKit.
- Agent sessions lane: a labelled password field by `getByLabel` (fixed: Retest reads password fields from their labelling markup, since Firefox's locator leaves them out); the `Accessibility.queryAXTree` answer that could not be read (fixed: a node in a mixed answer was checked against a string schema, and unknown keys inside a union were not dropped); fills answered `sent` with the field empty when several contexts were open (cause found: guard listeners made by a preload script lose key events; fixed with relays; `firefox-driver` fills four pages at once for three rounds, all held).
- `src/browser/firefox/orphans.ts` uses `sameProcessIdentity` from `src/shared/process-ownership.ts`; unit cases for a command line `ps` cannot read and for a readable one that differs.

## Artifacts

- Conformance tables: `/tmp/retest-firefox-lane/conformance-after.md` (the last run's), with its run folders under `/tmp/retest-firefox-lane/conformance-runs/firefox/`. The committed table `docs/compatibility/conformance.md` belongs to the conformance lane; each run of `tests/conformance/run.ts` rewrites it, so the script copied it aside and put it back after every run.
- Probes and their logs: `/tmp/retest-firefox-lane/probe30.ts` to `probe45.ts` (raw BiDi on the real Firefox), `smoke13.ts` to `smoke19.ts` (the driver), `smoke19-trace.log` (the BiDi trace that showed commands running out of order).
- Suite logs: `/tmp/retest-firefox-lane/it-*.log`; unit: `/tmp/retest-firefox-lane/unit-firefox.log`, `gate-unit.log`; typecheck: `gate-typecheck.log`, `tsc-a.log`, `tsc-b.log`.

## Browser scope for Firefox

| Row | Firefox |
| --- | --- |
| Navigation | Passing; Firefox's own error names and title characters kept |
| Locators | Passing; a cell by name refused by name; a failed image not found by its alternative text |
| Actions | Passing; `tap` and phone emulation refused by name; the wheel scrolls one page per turn |
| Assertions | Passing |
| AI checks | Not yet |
| Diagnostic output | Passing for the top-level document, same-process frames and dedicated workers' console; the rest named as not covered |
| Test structure | Passing |
| Basic configuration | Passing for a viewport; other emulation and a proxy refused by name |
| Authentication | Passing |
| Web participants | Passing |
| Scheduling | Passing |
| Failure handling | Passing |

The evidence for each row is in the record.

## What could not be verified

1. The spawn route on this host: this host app may not read Firefox's data folder, so every real run here took Launch Services. The spawn code is unit-tested and was proved by the earlier Firefox proof on a host with that access, not by this lane.
2. A frame source: none is offered until the protocol names a Firefox capture source.
3. AI checks over a Firefox capture: no judge ran over one.
4. The build id in `browser.started`: the event has no field for it.
5. A multiple select chosen by keyboard misses an arrow key about once in thirty on one page; every key reaches the select. Cause not known.
6. The fallback that stops a refused navigation whose request never reached the intercept: no test reaches it.
7. `browsingContext.create` failing with "unknown error" once in a conformance run; not repeated in thirty tries; Firefox's own message is now kept for it.
8. The whole `npm run typecheck` clean: it failed in other builders' files while they edited.
9. Firefox off macOS on Apple silicon: refused by name, never claimed.

A headless Firefox from one of this lane's probes is still running: main pid 18630, parent pid 1, profile under `retest-firefox-18626-p7fUP5` in the temporary folder. The probe (`probe40.ts`, through the earlier proof's launcher) had its output piped into `head`, which ended it before it closed the browser; the Firefox holds that probe's log `/tmp/retest-firefox-lane/ff40.log` open and listens on the port the log names. No owner record exists for it (the proof's launcher writes none, and a later run of that launcher removed the folder), so the driver's sweep cannot show it is a Retest launch by pid and start time, and it was left running.

## Existing files changed

- `src/runner/target-drivers.ts`: Firefox targets run on the Firefox driver instead of being refused.
- `src/runner/browser-pool.ts`: the Firefox branch (`#firstFirefox`, `LaunchFirefox`, `FindFirefox`, the engine in the runtime identity). The WebKit branch beside it is the WebKit lane's.
- `src/config/loaded.ts`: `LoadedFirefoxTarget`. `src/config/types.ts`: the Firefox target's doc comment.
- `src/cli/doctor/checks.ts`: `checkFirefox`.
- `tests/unit/runner-target-drivers.test.ts`: the Firefox refusal cases moved to WebKit's, and a case that Firefox runs on its driver.
- `tests/integration/browser-harness.ts`: `launch`, `sharedBrowser` and the new `launchEngine` launch the engine under test.
- `tests/integration/cli-harness.ts`: a run on another engine gets a config naming that engine's target, and the engine's environment.
- `tests/integration/m2-state.test.ts`: the targets come from the engine under test.
- `tests/integration/browser-actions.test.ts`, `browser-secrets.test.ts`: `protocolOnly` on the two cases whose instrument is a DevTools gate; `browser-secrets` launches its own browser through `launchEngine`.
- `docs/guide.md`: the Firefox section, the targets paragraph, and the Firefox line of the limitations list.

No dependency, script, `package.json` or environment change. No assertion was edited or loosened.

## Protocol or shared changes needed

- `src/protocol/identity.ts`: `firefox` in `CaptureSourceName` and its schema, so a Firefox screenshot can be evidence and a periodic capture loop can be the session's frame source; then `SessionCapture` in `src/browser/contract.ts` and `screenshotSource` in `src/runner/test-pages.ts` name it.
- `src/protocol/events.ts`: optional `build` and `engine` on `browser.started`.
- `src/diagnostics/session-capture.ts`: count a method starting with `network.` as network in `unreadable` and `limited`, not only `Network.`; today an unreadable Firefox network event marks the console capture partial (two Firefox cases in `tests/unit/diagnostics-engines.test.ts` show it).
