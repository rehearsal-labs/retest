# Conformance lane report

## 1. What was built

- `tests/conformance/cases.ts`: the fixed list, 145 cases. 130 are tests in 33 `.retest.ts` files under `fixtures/conformance/`, each with a declared outcome: passed, skipped, left out, not run with a class, or failed or error with its class, the operation it failed at and, where named, its step. 15 are facts about whole runs. Every row of the browser scope table is covered except AI checks and diagnostic output. Includes the forty workflow cases F1.1 to F10.5, their sources copied from the Chromium integration tests.
- `fixtures/conformance/`: 11 folders, one per run, each with its own config built from `config.ts` (engine, executable and address from variables). `unregistered.ts` types `state` and `apps` for unregistered configs; `limits/host.ts` is a host program that runs two files under session limits.
- `tests/conformance/execute.ts`: runs the 15 runs on one engine through the CLI from source (one through the host program), starts the task apps and app servers they need, stops or ends the browser for the three failure-handling runs, and judges every case from the run folder, events and the app's own counters.
- `tests/conformance/process.ts`: run process in its own group. It stands in for the CLI harness's `RetestProcess`, whose teardown is broken (finding 2), and reuses the harness's readers and leftover checks.
- `tests/conformance/engines.ts`: engine availability at run time. Chrome always; Firefox and WebKit on macOS once `src/browser/<engine>/` holds a driver and the browser is there. A first run that refuses every test for want of a driver makes the engine not available. Firefox goes through Launch Services when this process may not read its data folder.
- `tests/conformance/report.ts` and `run.ts`: write `docs/compatibility/conformance.md` and fail on any difference.
- `tests/integration/conformance.test.ts`: one test per engine, a subtest per run and per case. It fails on any difference and skips an engine that is not available, giving the reason.
- `docs/compatibility/conformance.md`: generated table.
- `docs/plans/public-beta/proofs/conformance.md`: findings, with file, line and scenario.

## 2. Commands and results

- `lockf -t 0 /tmp/retest-heavy-gate.lock node node_modules/typescript/bin/tsc -p /tmp/retest-conformance-tsconfig.json --pretty false`, a tsconfig outside the repo that extends the root one with only this lane's files included: exit 0 (`/tmp/retest-conformance-tsc6-2.log`). The last run gave exit 2 with 2 errors, both in `src/runner/browser-pool.ts:270,283` (another lane's WebKit branch, being written) and none in this lane's files (`/tmp/retest-conformance-tsc6-3.log`).
- The same with `node_modules/typescript-7/bin/tsc`: exit 0 (`/tmp/retest-conformance-tsc7-2.log`), then exit 1 with the same two errors (`/tmp/retest-conformance-tsc7-3.log`).
- `lockf -t 0 /tmp/retest-heavy-gate.lock node --conditions=retest-source tests/conformance/run.ts`: exit 1. The table was written and the differences are listed (`/tmp/retest-conformance-run-4.log`).
- `lockf -t 0 /tmp/retest-heavy-gate.lock node --conditions=retest-source --test tests/integration/conformance.test.ts`: exit 1. 483 tests: 427 pass, 56 fail. Failed subtests: Chrome 1 of 160 (X5), Firefox 38 of 160, WebKit 14 of 160 (`/tmp/retest-conformance-wrapper-3.log`). An earlier run, before WebKit was wired, skipped WebKit as not available (`/tmp/retest-conformance-wrapper-2.log`).
- `lockf -t 0 /tmp/retest-heavy-gate.lock node --conditions=retest-source --test tests/integration/viewport.test.ts`: exit 1 in the harness teardown, which is finding 2 (`/tmp/retest-conformance-viewport-probe.log`).

Generated table summary:

| Engine | Identity | Cases as declared | Runs as declared |
| --- | --- | --- | --- |
| Chrome | Chrome 154.0.8037.93 | 144 of 145 | 15 of 15 |
| Firefox | Firefox 133.0.3, Launch Services route | 111 of 145 | 12 of 15 |
| WebKit | WebKit 626.1.6+, build 2359 | 133 of 145 | 11 of 15 |

## 3. Artifacts

- `/tmp/retest-conformance/<engine>/<run>/`: each run folder, with `stdout.log` and `stderr.log`.
- The logs listed in section 2.

## 4. Driver findings (details in proofs/conformance.md)

- Runner, all engines: a browser lost while a check looks records no `assertion.failed` and no location (`src/runner/running-test.ts:495-504`). Case X5 differs on Chrome as well.
- Harness: `RetestProcess#release` (`tests/integration/cli-harness.ts:220-223`) signals reported groups. Since `9b38691`, `signalGroup` throws for those, so every CLI-harness integration test that starts a browser fails in teardown.
- Fixture: `fixtures/task-app/device-page.ts:14` calls `navigator.userAgentData`, which Firefox lacks, so the click listener is never added (C1 to C3).
- Firefox: password field not found by label (22 cases), loose and pattern labels refused (L4, L5), a second hover at the same point gives an unknown outcome (A3), keyboard select (A5, F4.1, F5.1, F7.1), the wheel on an element (A7), navigating actions sometimes give an unknown outcome (F1.1, F9.2, A4), a save click sometimes not heard (A1, U1), cell by name (F8.1).
- WebKit: Enter does not submit a form (N3, A4, F4.2, F9.1, F9.3), select multiple keeps one option (A5), the page reports a touch screen under a plain viewport (C1 to C3), cell by name (F8.1), one read timeout (S8), one unheard click (U1).

## 5. Not verified

1. Whether the Firefox and WebKit differences that came and went between runs are flaky or came from edits made to the drivers between runs.
2. Firefox's default spawn route: this host may not read Firefox's data folder.
3. The full `npm run typecheck` and `npm run test:integration`.
4. Chrome on Linux.

## 6. Existing files changed

None. No dependency, script or environment change. All files are new: `tests/conformance/**`, `fixtures/conformance/**`, `tests/integration/conformance.test.ts`, `docs/compatibility/conformance.md`, `docs/plans/public-beta/proofs/conformance.md` and this report. `/tmp/retest-conformance-tsconfig.json` lives outside the repo.
