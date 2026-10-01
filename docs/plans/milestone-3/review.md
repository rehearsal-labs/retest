# Milestone 3, wave 1 review

1 October 2026. Independent review of the milestone 3 wave 1 body of work, the commits `0b90b67` to `aba4f87` on top of milestone 2's `58def5a`, against `docs/plans/milestone-3/build-plan.md`, `AGENTS.md` and the architecture, followed by the fixes. Part 3 of the handoff was read as a list of claims to check. Findings were written as they were found, most severe first within each section, and each carries its resolution and the test behind it. Reproductions ran against Google Chrome 154.0.8037.92 and Chrome for Testing 153.0.8010.12 on macOS arm64 with Node 24.12.0, and the milestone 3 group in the Linux harness. `.github/`, `scripts/ci/` and `docs/plans/speed/` were not reviewed and not touched; `README.md`, `package.json` and `docs/releasing.md` were not touched; nothing was committed.

## Verdict

The wave does what the plan asks, and the trust architecture holds: the parent writes every event, each `observe` answer is written down before it goes and a passed locator assertion is judged again on the look it names, host checks read the page through the parent's own world and never through the test process, navigations and their causes come from CDP events the test process cannot send, the test process's environment is exactly what the host gives, and a secret in a title, an address, an observation or a check's text reads as its placeholder. Nothing the test process sends becomes a parent fact: a forged `judgedBy`, a forged `pageUrl`, a look it was never served, a look for another locator or app, and a pass the look does not support each end the test `test_error`.

It was not acceptable as handed over on one point: the page a failed action names. The host's own report, that an action after an Enter submit named the page before the navigation, is fixed for an action that passed, since the browser now reads the page in the call that checks the element, but a failed action still named the document it arrived on. The two defects the handoff listed are confirmed, one of them with a smaller cause than it says, and the redaction of host checks was consistent for `text` only. Everything is fixed below, each with a test that fails on the code before the fix, except where the resolution says otherwise. After the fixes, the gates in the Re-check section pass.

## Major

### M1. A failed action names the page it arrived on, not the page it failed on

- Where: `src/runner/running-test.ts`, `commandPage` (the fallback for a failed result was `entry.document`, the document the parent last saw commit when the command arrived) and `#execute` (a failed result waited only for the navigations noted before the command arrived).
- Problem: an action that arrives while the frame is opening another document waits for that document (`waitUntilActionable`, the milestone 2 fix) and looks for its element there. When it then fails, `not_found`, `not_actionable` or `ambiguous`, its `action.failed` said `pageUrl` and `pageTitle` of the page before the navigation, and was written before the `navigation` event of the page it was looked for on. A passed action is right, since `result.page` is read in the same call that checked the element (M3-4). This is the host's report, item 5 of the brief, on the failure path.
- Scenario: `press('Enter')` submits a form; the next `click` is sent before the new document commits; the element is not on the new page. The card read `Page "Sign in" at /login` under `Not found getByTestId('save')`, while the element was looked for on `/account`, whose `navigation` came after the `action.failed` in `events.jsonl`. A reader concluded the button was missing from the sign-in page.
- Resolution: a failed action names the document the parent last saw commit when the answer came, and its event waits for every navigation noted before the answer, as a `goto`'s does, so the `navigation` of the page it failed on is written before it, with its title. A passed action keeps its own rule: the page it names was read before its input, and the navigation its input caused comes after it, so a reader sees the click, then the page it opened. `#complete` takes the document at completion; `#execute` waits for `waiting(app)` as of the answer for a goto and for every failure.
- Proved by: unit `runner-titles` "an action that fails after the page moved names the page it was looked for on, after that page's navigation", which fails on the code before the fix: `pageUrl` named `/tasks`, and `navigation /login` came after `action.failed`.
- What a reader can now tell: `pageUrl` on a passed action is the page the command was sent to, read in the call that checked the element; on a failed action it is the page as the parent last saw it when the failure came; the page a command ended on is the `navigation` that follows it, with `cause: 'action'` when its input caused it. The guide says so under "Titles and what opened each page".

## Minor

### m1. A failed `select` said "set by script" when nothing was set

- Where: `src/runner/running-test.ts`, `actionDetails` spread `input: 'script'` on every `select` result, failed ones included. Handoff section 22, defect 1.
- Scenario: `select('Atlantis')` fails `not_found`; the card read `Not found getByLabel('Country').select('Atlantis'), set by script`.
- Resolution: `input: 'script'` only on `action.completed`. A completed select that found the option already chosen keeps it: the card says "already selected, sent nothing" for `changed: false`, and a reader of the events can still tell the kind of input a select makes.
- Proved by: unit `runner-actions` "a select that fails keeps its options, says nothing of a change, and does not say a script set anything", which asserted the old behaviour and fails on the code before the fix; integration `m3-actions` now checks that the refused select carries no `input`.

### m2. A host check's `name` and `path` were recorded as written, while its `text` was redacted

- Where: `src/runner/redactor.ts`, `isHostCheckText` named only `text`. Handoff section 10, item 4, and the guide told hosts to keep secrets out of `name` and `path`.
- Problem: a host writes every field of a check, and it holds the secret values. A path check `path: '/reset/<token>'` for a one-time link, with the token one of the run's secrets, recorded `actual.url` as `/reset/{{token}}` and `check.path` with the value, in `run.started`, both `host_check.*` events and `result.json`. The same for a `name` that quotes a value.
- Resolution: every text a host writes into a check, `text`, `name`, a string `path` and a `RegExp` path's `pattern`, is free text for the redactor, wherever a check is recorded (`hostCheckWriting`, `isHostCheckWriting`). The page is still asked for the text as written and the address is still matched against the path as written: redaction touches the record only. A locator's `text` and a test's `name` stay identifiers, since only a record that parses as a host check is treated this way. The guide now says so.
- Proved by: unit `runner-redactor` "redacts a check's name and path too, wherever a check is recorded", which fails on the code before the fix.

### m3. A navigation that committed during the host checks was not recorded

- Where: `src/runner/run-session.ts`, `#runBody` called `running.close()` before the host checks ran, which removed the navigation listeners; `src/runner/running-test.ts`, `#stepId` stayed at the body's last step.
- Problem: M3-2 names "a page that is still redirecting when the body ends (the check waits for it)" as a case. The check waited, read the document that arrived and recorded its address in `actual`, but no `navigation` event said that document was opened, by what, or with which title. `inspect` showed `navigated to "Saving" at /save, by action` and then a passing address check on `/done`, and the guide's rule for a host, "the app's last `navigation` before the checks", read the earlier page.
- Resolution: the navigation listeners stay on through the host checks and are removed after them, before the screenshot, the saved state and `test.finished`. `RunSession.#runAttempt` owns the order: body, settle, checks, `settleNavigations` (a title still to come is waited for within the cleanup budget, and nothing else is waited for twice), close. A navigation told after the body carries no `stepId`, since `#finish` clears the step.
- Proved by: unit `runner-host-checks` "a page that moves while a check looks has that navigation written, with no step, before the test finishes", which fails on the code before the fix (no `navigation` for the second page).

### m4. `judgedBy` was optional in the event schema

- Where: `src/protocol/events.ts`. Handoff section 11, defect 3: left optional so milestone 2 event files stay valid.
- Problem: M3-3 says every `assertion.passed` says who judged it, and the parent always writes it, but a host validating `events.jsonl` against the schema could not rely on the field, and a reader had to treat its absence as a case. Nothing is released and M3-12 regenerates the schemas; a milestone 2 run folder is not a compatibility target. The one cost: `inspect` on a run folder from before this change reports its `assertion.passed` lines as not version 1 events.
- Resolution: required, in the type and the schema; `dist/schemas/event-v1.schema.json` lists it under `required`, and the fixtures that build `assertion.passed` events carry it.
- Proved by: unit `protocol` "judgedBy is the parent's mark on a passed assertion", extended with "an assertion.passed without judgedBy is not a version 1 event", which fails on the code before the fix.

### m5. The plan and the code disagreed on where the `action` window opens

- Where: `docs/plans/milestone-3/build-plan.md` M3-4 ("the window runs from the first input call Retest sends"); `src/browser/page.ts` `#act` opens `NavigationCauses.delivering` around `guardInput`, whose first call into the page is the guard's verdict call, sent just before the input. Handoff section 22, defect 2.
- Finding: the difference is nil on the wire. `guardInput` sends the verdict call and the first input call in the same synchronous turn: `IsolatedWorld.callIn` writes before it yields, and `clickAt`, `pressKey` and `wheelAt` write their first command before any await, so no event from the browser can be read between them. What bounds the start of the window in either wording is the answer to the ready call that armed the guard: every event the browser wrote before processing that call arrives before its answer. A navigation the page starts on its own in the gap between that answer and the input is counted as the action's in both wordings, and the only fence that could tell them apart is one more call into the page per action.
- Resolution: no code change. The plan's M3-4 "Decided by fact F12" paragraph now says what the code does and why the two are the same, and the handoff's defect note says it is settled.

## Nits

### n1. A goto's cause rests on the request and the start sharing an address

- `NavigationCauses.started` takes the cause of a pending `requested` when the addresses match, and `opened` overrides it for the loader `Page.navigate` returns. A page that requested the same address as a `goto` at the same moment, whose own navigation never started, would have its request taken by the goto's loader; `opened` rights it, since `Page.navigate` answers before the commit (fact below). Noted as a limit, not fixed: the misreading needs a request Chrome never started, and the worst case reads a `goto` as `page`, which a host's "not opened by `goto`" rule would accept. `browser-navigation-cause` "the goto's loader is the goto's even when the page asked for the same address" pins the override.

### n2. A child assertion event's `session` is not checked against the test's apps

- `RunningTest.#childEvent` reads `event.session ?? firstApp` and passes a name the test does not use into a failed value assertion's event. A passed locator assertion with a wrong app is refused, since the look it names was served for another app, and a value assertion's `session` is already the test process's claim. Noted, not fixed: the event is marked `origin: 'child'` and no verdict rests on it.

### n3. `readPage` reads `url` from the commit record after the call answered

- `ChromiumPage.readPage` answers `found` from the document that ran the read and `url` from the main frame's latest commit, read after the answer. A navigation that started and committed in the same chunk of the pipe as the answer would pair the old document's `found` with the new address. The window is one chunk and the check looks again; noted, not fixed.

### n4. Exports with no consumer outside their file

- Every such name is a parameter or return type a public function or class needs under `isolatedDeclarations` (`ParsedKey`, `KeyStroke`, `Judged`, `ServedObservation`, `CheckedPages`, `HostCheckSubject` and the options types). None is dead code; nothing to remove.

## Facts checked in real Chrome

- `Page.navigate` answers before `Page.frameNavigated` for a document that needs the network: 10 of 10 rounds on each browser, a page the server answers after 150 ms (`/tmp/retest-fable-m3/probe-navigate-order.ts`, output in `probe-navigate-order-output.txt`, each round in its own profile under the probe folder, removed afterwards). So `NavigationCauses.opened` runs before `committed` for a goto, as the override in n1 needs.

## What is good and should stay

- The parent's judgement is the right shape: the test process sends its matcher and arguments whole as `check`, names the look it rested on, and the parent rebuilds the rule from `protocol/locator-checks.ts`, the same module the test process polled with, and judges the observation exactly as it sent it, redacted and whole. `matcher`, `expected`, `comparison` and `actual` on the event are the parent's; the test process's copies are dropped on every locator assertion, and its `pageUrl` and `pageTitle` are dropped on every assertion.
- Every refusal in `ServedObservations.judge` ends the test as a protocol violation and kills its process, as milestone 2 treats every message the parent cannot accept. `forged-visible.retest.ts` speaks the protocol itself and is caught in a real run.
- Host checks never leave the parent: `readPage` sends the queries into Retest's world and gets back booleans, the page's text never crosses the pipe, and `PageReading.url` is the commit record, not anything the page says. A check looks again, never acts, waits for a document the frame is opening, and a lost page is `session_lost`, not a failed check.
- The proxy is a setting of the browser context, so a service worker's and a cross-site frame's requests go through it (fact F1), and a `server` with credentials in it is refused without being quoted anywhere.
- `TestFileProcess.spawn` builds the child's environment from `testEnvironment` alone when it is given, and drops the variables `env` secrets read either way, so the resolve hook (`own-package.ts`) and the environment are the two sides of "a test file anywhere, seeing only what the host gives".
- The navigation and title machinery keeps its promises bounded: a title settles at `DOMContentLoaded`, the next command, one second, or the next commit (`NavigationTitles`), the runner waits at most two seconds more (`PageNavigations`), every command to a page settles pending titles before it goes past its start, and a navigation still waiting when the test ends is written without one. No path waits on a promise that cannot settle.
- A `select` is the one scripted input, and it stays honest about it: its one call both checks and sets in the task of the hit test, goes through `Dispatch.attempt`, and an answer lost to a closed connection is `outcome_unknown`. `check` clicks once and then only reads. The guard's `wheel` listener exists only while a scroll is armed (fact F6), and a key decides at `keydown`.
- The milestone 2 secret invariant holds through the new fields: titles are redacted before they are cut (`redactTitle`), `redactCommandResult` covers the `page` on every answer, the checkbox's own `input` event passes the guard as a plain `Event` while `InputEvent` typing into an unarmed document is still stopped, and `m3-titles` shows a secret the page makes its title reading `{{password}}` everywhere.
- No `any`, `as` cast, non-null `!`, `@ts-ignore`, `@ts-expect-error`, `eslint-disable`, `console` or default export in `src/`; kebab-case files; explicit export types; `protocol` still imports only itself; the runner never imports `src/assertions/` or CDP.

## What was not verified

Most important first.

1. The Linux harness ran only the milestone 3 group, as the brief asked; the browser, milestone 1 and milestone 2 groups ran on macOS only, and Chrome for Testing 153 did not run on Linux in this review.
2. Proxy authentication, SOCKS and https proxies and the four other proxy error codes are wave 2 or untested, as the handoff says.
3. Two runs in one process were exercised by `m3-concurrent-runs` with different roots; two runs that share a root, and so a `lastRunFile`, were not tried.
4. `press` on an emulated touch screen, with a window, and with the macOS editing commands a headed browser needs, did not run, as the handoff says.
5. The `cause` race in n1 was reasoned from the code and the `Page.navigate` ordering fact; a page that requests a navigation Chrome never starts was not built.
6. `src/cli/`, `src/reporters/` and `src/store/` were read for the new lines (actions, host checks, looks, the timeline, `readRunFolder`, `rebuildResult`) and relied on their unit and integration tests; the rest of them, and `src/api/` beyond `page.ts`, `app-page.ts`, `action-arguments.ts` and `key-argument.ts`, were not reviewed line by line.
7. The Linux container decisions (M3-6, `start-failure.ts`, `unreaped-group.ts`) were read for shape and run only through the milestone 3 group in the harness; a root user, a missing library and an unreaped group were not provoked here.

## Method

- Read: `AGENTS.md`, the architecture, the milestone 3 plan, part 3 of the handoff, the guide, the milestone 2 review; then every file on the trust path (`protocol/commands.ts`, `events.ts`, `messages.ts`, `host-check.ts`, `locator-checks.ts`, `observation-record.ts`, `page-facts.ts`, `keys.ts`, `option-choices.ts`, `scroll-delta.ts`, `text.ts`; `runner/running-test.ts`, `observations.ts`, `page-navigations.ts`, `run-host-checks.ts`, `host-checks.ts`, `test-pages.ts`, `run-session.ts`, `redactor.ts`, `secrets.ts`, `child.ts`, `own-package.ts`, `test-file-process.ts`, `contract.ts`, `run.ts`, `last-run.ts`, `outcome.ts`, `event-log.ts`; `store/read-run-folder.ts`), every file of the browser's new paths (`page.ts`, `navigation-causes.ts`, `navigation-titles.ts`, `navigation.ts`, `input-guard.ts`, `page-scripts.ts`, `element-queries.ts`, `actionability.ts`, `isolated-world.ts`, `dispatch.ts`, `checked-state.ts`, `keys.ts`, `input.ts`, `document-facts.ts`, `browser.ts`, `contract.ts`, `start-failure.ts`, the Linux diff of `launch.ts` and `chromium-process.ts`), the config's proxy reader, the test-side API for the new actions and `pollLocator`, the reporters' actions and host check modules, `inspect`'s looks and timeline, the subpath entries, the host example, the proxy fixture and the milestone 3 integration tests.
- Probe: `/tmp/retest-fable-m3/probe-navigate-order.ts` on both browsers, over the probe support the Browser agent left in `/tmp/retest-m3r-browser/probes/support.ts`.
- Greps over `src/` for casts, `any`, non-null assertions, suppressions, `console`, and a count of consumers for every export in the changed files.
- Each new test was run on its own against the fixed code, then against the source file as committed at `HEAD` (copied from `git show`, never checked out), to show it fails there; the files were restored from copies afterwards.
- Killed only the browsers the probe started (each closed by `Browser.close` and its group signalled), and checked afterwards that no `retest-*` folder of this review is left in the temporary folder and no process of it still runs.

## Re-check

1 October 2026, after every fix above, re-reading each changed file once more and running the gates from the repository root, one after another, on Chrome 154.0.8037.92 and Chrome for Testing 153.0.8010.12, then the milestone 3 group in the Linux harness.

### Re-reading the fixes

- `src/runner/running-test.ts`: `#execute` waits for `entry.navigations` only for a passed command that is not a goto, and for `waiting(app)` as of the answer otherwise, so a failure is written after the navigation of the page it was looked for on, and a passed click still comes before the navigation its input caused (the order `runner-titles` pins). `commandPage` takes the latest document only for a failure; a passed command without page facts, which only a fake gives, keeps the document it arrived on. `#serve` passes the same document, which an observe never uses, since the browser reads the page in the look. `settleNavigations` flushes and nothing else, so a hung command the first `settle` already reported costs no second wait. `#finish` clears the step, so a navigation told after the body carries none.
- `src/runner/run-session.ts`: `#runAttempt` owns the order body, settle, checks, `settleNavigations`, close, with `close` in a `finally` so a throw between leaves no listener on the page or the process; the `endedBeforeStart` return is inside the `try` for the same reason. `#test` is cleared before the checks as before, so a browser lost during them is answered by `readOnce`, not routed to the body.
- `src/runner/redactor.ts`: `isHostCheckWriting` parses the record against `hostCheckRecordSchema`, so only a check's own `text`, `name` and `path` are free text; a locator's `text` and a test's `name` fail that parse and stay. A `RegExp` path's `pattern` is walked as part of `path`; its `flags` are walked too, which can only ever match a secret of four or more flag letters and never changes the record's shape.
- `src/protocol/events.ts`: `judgedBy` is required on `assertion.passed` in the type and the schema, and still refused on `assertion.failed` and on anything the test process sends; the regenerated `dist/schemas/event-v1.schema.json` lists it under `required`.
- `docs/guide.md`, `docs/plans/milestone-3/build-plan.md`, `docs/implementation-handoff.md`: the guide says what a failed action's page is, that a navigation during the checks is written with no step, and that a check's `text`, `name` and `path` are redacted; the plan's M3-4 says where the window opens and why; the handoff's four notes point here.

### Gates

Each command ran from the repository root with its output captured under `/tmp/retest-fable-m3/`, read after it ended. A first pass of the same commands ran before the last source change (the `finally` around the host checks) and gave the same counts; its output is under `/tmp/retest-fable-m3/pass-1/`.

| Command | Exit | Result |
| --- | --- | --- |
| `npm run build` | 0 | `dist/` rebuilt; `dist/schemas/event-v1.schema.json` requires `judgedBy` on `assertion.passed` |
| `npm run typecheck` | 0 | TypeScript 6.0.3 and 7.0.2 on the root project, then 6.0.3 on `examples/tasks`; no errors, no `FATAL` |
| `npm run test:unit` | 0 | 1536 tests in 278 suites: 1536 passed (1533 before the review, plus 3) |
| `npm run test:types` | 0 | "141 expected errors matched 141 markers in 4 projects" on 6.0.3 and on 7.0.2 |
| `node --conditions=retest-source --test --test-concurrency=1 "tests/integration/browser-*.test.ts" tests/integration/cdp.test.ts` | 0 | 184 tests: 184 passed, 68.9 s |
| `node --conditions=retest-source --test --test-concurrency=1 "tests/integration/matrix-*.test.ts" tests/integration/run-interrupt.test.ts tests/integration/cli-commands.test.ts tests/integration/package-smoke.test.ts` | 0 | 51 tests: 51 passed, 71.9 s |
| `node --conditions=retest-source --test --test-concurrency=1 "tests/integration/m2-*.test.ts"` | 0 | 54 tests: 54 passed, 121.5 s |
| `node --conditions=retest-source --test --test-concurrency=1 "tests/integration/m3-*.test.ts"` | 0 | 19 tests: 19 passed, 64.4 s |
| `RETEST_LINUX_IMAGE=retest-linux:fable-m3 sh docker/linux/run.sh node --conditions=retest-source --test --test-concurrency=1 "tests/integration/m3-*.test.ts"` | 0 | 19 tests: 19 passed, 53.9 s, in Docker on linux/arm64 with Chrome's sandbox on |

The image `retest-linux:fable-m3` was removed by name afterwards; `retest-linux:dev` was left as it was, and nothing was pruned. After the last run the system temporary folder held no `retest-*` folder, and no browser, fixture server, proxy or test file process of this review was running.

### Still open after the fixes

1. The `cause` race of n1, reasoned from the code and the `Page.navigate` ordering fact, not provoked.
2. A child assertion event's `session` is not checked against the test's apps (n2).
3. `readPage` pairs `found` and `url` from one chunk apart at most (n3).
4. Everything the handoff lists as not verified and this review did not reach: proxy kinds and errors, a shared `lastRunFile`, `press` on a touch screen or in a headed browser, Chrome for Testing on Linux, the browser and milestone 1 and 2 groups on Linux.
