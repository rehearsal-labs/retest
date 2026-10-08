# Report: the WebKit driver

## What was built

All new unless marked. The record is `docs/plans/public-beta/proofs/webkit-driver.md`.

- `src/browser/webkit/build.ts`: the pin (build 2359, `protocol.json` sha256), where a build comes from (`executablePath`, then `RETEST_WEBKIT_BUILD`, nowhere else), the protocol check, the WebKit version from `WebKit.framework`'s `CFBundleVersion`.
- `connection.ts`: the inspector-protocol client over `--inspector-pipe`: browser, page proxy and page target addresses, wrapped target commands, one id counter.
- `process.ts`: launch in its own process group with a temporary home removed at close; helpers (XPC services outside the group) attributed with `launchctl print pid/<pid>`, recorded by pid, start time and command in an owner record in the home, and ended only by that record.
- `sweep.ts`: removes homes a killed Retest process left, killing only recorded processes that are still the same process, by `sameProcessIdentity` from `src/shared/process-ownership.ts` (adopted this round); a home whose Retest process lives is left alone.
- `target-session.ts`: a real `CdpSession` whose `send` maps the Chrome DevTools commands of the shared page code (isolated world, accessibility, input, dispatch, actionability, element queries, input guard, checked state) to WebKit and maps answers and errors back, so locator rules, actionability and the guard are the shared code.
- `relay.ts`: a main-world script at document start that relays trusted events to the guard in Retest's user world.
- `input-events.ts`, `roles.ts`, `select.ts`, `screen.ts`, `storage.ts`: WebKit key and mouse mapping (Enter as `insertNewline:`, Home and End), role mapping, the list-box plan for a `select multiple`, the screen and its refusals, cookies and storage state.
- `roles.ts` (this round): refuses by name `getByRole` with a name for cell, gridcell, columnheader, rowheader and tooltip, and the role `option` while the document holds a select's options.
- `navigation.ts`: goto, reload, back and forward with the shared waits and records; a navigation WebKit gives up fails in WebKit's words.
- `page.ts`: the web session. This round: a main-frame document request that fails before its document commits is a navigation given up (a move back onto a 204 now fails at once); touch emulation is turned off under a plain viewport; the lookup refusals; a timeout is told only after its budget has passed by the clock (`outlast`).
- `browser.ts`, `capture.ts`: the browser (contexts, pages, identity, close) and the screencast frame source with identity.
- `src/diagnostics/webkit-collector.ts`: console, runtime errors, requests and responses for the top-level document, with the scope and capture status.
- Wiring (anchored edits to the WebKit branch): `src/runner/target-drivers.ts`, `src/runner/browser-pool.ts`, `src/config/loaded.ts`, `src/config/types.ts`, `src/cli/doctor/checks.ts` (`checkWebKit`: "WebKit 626.1.6+, build 2359 found; a run starts it", no download).
- Tests: unit `tests/unit/webkit-{collector,connection,input-events,navigation,page,process,relay,runner,sweep,target-session}.test.ts` with `webkit-scripted-inspector.ts`; integration `tests/integration/webkit-{lookup,browser-actions,browser-navigation,browser-locators,browser-secrets,m2-state}.test.ts` (wrappers that run the shared suites unchanged on WebKit) and `tests/integration/webkit-driver.test.ts` (helpers outside the group, a lost browser, a stop after input, the collector across a process swap, the frame source, the sweep, the lookup refusal).
- Docs: the guide's WebKit section (`docs/guide.md`: intro sentence, Targets paragraph, a new "WebKit" subsection, the browsers line of "What Retest does not do yet").

## Commands and results

Heavy commands ran under `lockf -t 0 /tmp/retest-heavy-gate.lock` via `.retest/scratch-webkit/locked.sh` (retries every 60 s). Logs in `/tmp`.

- `npm run typecheck` after the last change: exit 0, no FATAL (`retest-webkit-typecheck-6.log`); TS7 alone exit 0 (`retest-webkit-tsc7-6.log`). The `browser-pool.ts` errors the conformance lane saw are gone. An earlier run this round failed on two errors of mine (`select.ts` plan type, a test locator), fixed (`retest-webkit-typecheck-2.log`).
- `node --conditions=retest-source --test tests/unit/webkit-*.test.ts tests/unit/runner-target-drivers.test.ts`: 97/97 (`retest-webkit-unit-7.log`); after the last edits `webkit-page` 8/8, `webkit-input-events` 11/11, `webkit-sweep` 6/6 (`retest-webkit-unit-8.log`, `-unit-roles.log`, `-unit-sweep.log`).
- `npm run test:unit`: 2987/2989; both failures in `tests/unit/playwright-resolve.test.ts`, not mine (`retest-webkit-unit-all-4.log`). An earlier full run also failed `diagnostics-run.test.ts` once; alone it passed 9/9 (`retest-webkit-unit-diagrun.log`).
- `webkit-driver`: 7/7 (`retest-webkit-int-webkit-driver-4.log`, `-5.log`).
- `webkit-lookup`: 1/1 in three runs after the timeout change (`-4.log`, `-4b.log`, `-4c.log`); before it, one run ended `timeout` at `toHaveURL` (`-3.log`).
- `webkit-browser-actions`: 66/68; fails the phone page (refused by name), skips one DevTools-gate case (`-4.log`).
- `webkit-browser-navigation`: 23/26; fails three cases that assert Chrome's facts: the connection-refused wording, the raw title with ESC, and the history after a given-up back move (`-4.log`).
- `webkit-browser-locators` 21/21, `webkit-browser-secrets` 10/11 with one DevTools-gate skip, `webkit-m2-state` 3/3 (`-4.log`).
- `node --conditions=retest-source tests/conformance/run.ts`, four runs, WebKit column:
  - after the Enter, multiple-select and touch fixes: 144/145 cases, 15/15 runs; F8.1 not found (`retest-webkit-conformance-1.log`, table `-1-table.md`)
  - after the role refusal: 144/145, 15/15; F8.1 refused by name (`-3`)
  - after the timeout change: 144/145, 14/15; `workflow` exit 2, `cleanup_failed` "The browser's output did not finish writing and closing within 1000 ms." Chrome and Firefox columns of that run broke on removed temp folders (`ENOENT … retest-tests-zkkw4S`), not mine (`-4`)
  - last run, which wrote `docs/compatibility/conformance.md`: WebKit 144/145, 15/15, F8.1 refused by name; Chrome 145/145, 15/15; Firefox 112/145, 14/15 (`-5`)
  - N3, A4, F4.2, F9.1, F9.3 (Enter), A5 (multiple select), C1 to C3 (touch), S8 and U1 pass in all four runs.
- An early, hanging version of my scripted-inspector unit test was picked up by another lane's unit run (pid 56469, child 59921, near 98% CPU). I did not touch it; the test was fixed and the process is gone.
- Probes (scratch, `.retest/scratch-webkit/`), all under the lock: `probe-back.ts` (`retest-webkit-probe-back-{2,3}.log`), `probe-back2.ts` (`-probe-back2.log`), `probe-touch.ts` (`-probe-touch-2.log`), `probe-rolenames.ts` (`-probe-rolenames.log`, `-2.log`), `probe-reads.ts` (`-probe-reads-1.log`), `probe-lastlook.ts` (`-probe-lastlook.log`, `-2.log`).

## Artifacts

- Conformance run folders: `/tmp/retest-webkit-conformance-{1,3,4,5}/<engine>/<run>/` (stdout, stderr, run folder with events, screenshots, browser logs); tables `/tmp/retest-webkit-conformance-{1,3,4,5}-table.md`.
- `docs/compatibility/conformance.md`, regenerated by the last run.
- Logs listed above.

## Browser scope, WebKit

| Row | Status |
| --- | --- |
| Navigation | passing; three engine differences (WebKit's error words, raw title, history after a given-up move) |
| Locators | passing; cell, gridcell, column and row header, tooltip by name, and options on a page with a select's options, refused by name |
| Actions | passing; phone or touch screen and `tap` refused by name; a multiple select of options with a gap refused by name |
| Assertions | passing |
| AI checks | not yet: screenshots captured, no judge run on WebKit; frame source not in the protocol |
| Diagnostic output | passing for the top-level document; frames in other processes and workers named not covered |
| Test structure | passing |
| Basic configuration | passing for viewport; mobile layout, touch screen, proxy refused by name |
| Authentication | passing |
| Web participants | passing |
| Scheduling | passing |
| Failure handling | passing |

## What I could not verify

1. One conformance run ended `cleanup_failed` on WebKit: the browser's output pipe did not close within 1000 ms after the browser and helpers ended; cause not established; nothing of the build was left running.
2. No AI judge ran over a WebKit capture; recorded-frame evidence needs the protocol change below.
3. The cross-platform reference flow and the shared console/network fixtures on WebKit: other lanes, not run.
4. Chrome's page has the same early-timeout race (3 of 200 last looks in the probe); not fixed, outside this lane.
5. The lookup refusals also take a cell named by `aria-label` and a custom option on a page holding a select.
6. Phone and touch emulation and `tap` not built; touch input never tried.
7. A web content process killed under a live page never tried; only whole-browser loss.
8. Only build 2359 for mac26-arm64 on macOS 27.0; WebKit on Linux refused by design.
9. `~/Library/Preferences/org.webkit.Playwright.plist` unchanged since 3 October 02:33, but not prevented.
10. Two shared-suite cases that need a DevTools gate cannot run on WebKit.

## Existing files changed

- `src/runner/target-drivers.ts`, `src/runner/browser-pool.ts`, `src/config/loaded.ts`, `src/config/types.ts`, `src/cli/doctor/checks.ts`: the WebKit branch only.
- `tests/unit/runner-target-drivers.test.ts`: WebKit removed from the refused list; the new WebKit cases.
- `docs/guide.md`: the WebKit sentences and subsection. The Firefox half of the Targets sentence and of the browsers line keeps its old claim, narrowed to Firefox, for the Firefox lane to change.
- `tests/integration/engines.ts` (the Firefox lane's new file): the WebKit engine.
- `docs/compatibility/conformance.md` (the conformance lane's generated file): rewritten by the conformance command the coordinator asked me to run.
- No dependency, `package.json`, script or environment change. Scratch probes and scripts are in the gitignored `.retest/scratch-webkit/`. I removed one temporary WebKit home my own scratch probe had left in `$TMPDIR` (`retest-webkit-7pP2uX`, made 01:36 by a probe using the Phase 1 launcher).

## Protocol or shared changes needed

1. `src/protocol/identity.ts`: add `'webkit'` to `CaptureSourceName` and its schema. Then `screenshotSource` in `src/runner/test-pages.ts` can name `'webkit'`, and `WebKitFrameSource` can implement `src/media/capture.ts`'s frame source and sit inside the session contract (the agent session lane hit the same gap).
2. `TargetInfo`: an optional `webkit: { build, version, protocolSha256 }`; today `browser.started.version` carries "626.1.6+, build 2359" as one string.
3. Chrome's early timeout: `src/browser/page.ts` could wait out its budget before telling a timeout, as the WebKit page now does, or `src/assertions/look-until.ts` could take a last look's timeout as the deadline when its budget was all the time left.
4. Earlier note, still open: a shared interface for the isolated world and a shared gone-context error would let the bridge drop its Chrome-message mapping.
