# Milestone 2 review

30 September 2026. Independent review of the milestone 2 body of work (everything uncommitted on top of `e087be2`) against `docs/plans/milestone-2/build-plan.md`, `docs/implementation-brief.md` and `AGENTS.md`, followed by the fixes. The handoff's part 2 was read as a list of claims to check. Findings were written as they were found, most severe first within each section, and each carries its resolution and the test behind it. Reproductions ran against Google Chrome 154.0.8037.92 and Chrome for Testing 153.0.8010.12 on macOS arm64 with Node 24.12.0. No file in `README.md` or the `description` of `package.json` was touched; nothing was committed.

## Verdict

The body of work does what the plan asks, and its architecture held under review: the parent still owns events and the browser, the child never sees a config or a secret value, commands and events stay validated on both sides, the compile-fail fixtures reproduce on both compilers, and every process, profile, server and state file the harness checks for is gone after each run. It was not acceptable as handed over, because the secret invariant had four holes: one the builders knew about in the browser (B1), two they had failing tests for (M1, M2), and one in `doctor` they had not seen (M3). All four are closed below with tests that fail on the code before the fix, except where noted, and the smaller findings are fixed or documented. After the fixes, the gates in the Re-check section pass.

## Facts established in real Chrome

Everything below was observed on both browsers with `/tmp/retest-fable-m2/probe-navigation.ts`, a script over Retest's own CDP client, and drives the design of B1's fix.

1. Every navigation the browser begins in the main frame, whoever started it, is announced by `Page.frameStartedNavigating` (with `url`, `loaderId` and `navigationType`), and ends in one of three ways: `Page.frameNavigated` with that loader (a commit), `Page.frameStoppedLoading` with nothing committed since (a 204 or a download, both `net::ERR_ABORTED`), or a newer `Page.frameStartedNavigating` that takes its place. `Page.frameRequestedNavigation` comes before it for navigations the page requests, and not at all for `Page.navigate`.
2. While such a navigation is pending, Chrome holds `Runtime.evaluate`, `Page.createIsolatedWorld` and `Input.insertText` and answers all three right after the commit. The held text lands in the document that arrived: a field autofocused by the new document read `while-pending` afterwards.
3. The top window's `navigate` event fires with `cancelable: true` for a same-origin frame's `top.location`, a meta refresh and a script `form.submit()`, and `preventDefault()` stops each; it does not fire for a `Page.navigate` from CDP.
4. A `Runtime.callFunctionOn` waiting on a promise when the frame navigates is answered with the protocol error `Inspected target navigated or closed`, not one of the three messages `isGoneContext` knew.

## Blockers

### B1. A secret can be typed into another origin's document

- Where: `src/browser/page-scripts.ts` (`hold` heard only the `navigate` event of the armed document, and only for a fill bound to origins); `src/browser/input-guard.ts` (`guardInput` sent `Input.insertText` with no view of the frame's state between the ready answer and the input); `src/browser/page.ts` (`#act`); `src/browser/contract.ts` said so: "A navigation that was already under way when the fill began is not held".
- Problem: `Input.insertText` goes to whatever document the frame holds when the browser processes it (fact 2). The origin was checked in the document that answered `prepare`. A navigation the browser began after that answer took the text into the document it opened, and only navigations the page itself requested while the guard was armed, for a fill bound to origins, were held (fact 3). Not held: a navigation the browser or another target began, a plain fill's page leaving mid-typing (never held at all), and a frame Retest is not attached to. A navigation already in flight when the fill began turned out to be safe by accident: Chrome held `prepare` until the commit (fact 2), so the old code checked the origin in the new document after all. But the same accident made a navigation that never arrived end as `timeout` "The page did not answer within 1000 ms", which is not what happened.
- Scenario: a sign-in page that redirects to an identity provider on another origin once the password field has focus, started by a frame or by the browser; the value lands in the provider's field and `action.failed` says `outcome_unknown`. Or, on the old code's `replaced` path in real Chrome, `outcome_unknown` "the browser gave an answer it cannot read" (fact 4).
- Resolution: three layers, each tested.
  1. The parent's CDP session tracks the pending navigation (`ChromiumPage.#navigationStarted`, `#loadingStopped`, `#frameNavigated` in `src/browser/page.ts`, from fact 1). `waitUntilActionable` (`src/browser/actionability.ts`, now an options object with `pendingNavigation`) does not look at the page while one is pending and looks for the element in the document that arrives; when the budget runs out first the action fails `not_actionable` "the page was still opening <origin and path>, and Retest does not fill in a document about to be replaced" with `details.check: 'navigation'`. `#act` lets a ready target go, disarming it, when a navigation began after the page's ready answer, and waits again. This applies to every action, since a press into a document about to be replaced was never what a test meant either.
  2. The guard in every document stops trusted typing nothing is armed for and notes the first (`guard.stray` in `src/browser/page-scripts.ts`, `strayFunction`). After the guard's document has gone, `guardInput` asks the document that replaced it; a noted stop is the verdict `stopped`, and `guardFailure` turns it into `not_actionable` "the page moved to <origin> before the text arrived. Retest stopped the typing before that document received it, and typed nothing", with `details: { origin, moved: true }`. A press is not stopped this way, and stays `outcome_unknown` as documented.
  3. `Inspected target navigated or closed` counts as a gone context (`src/browser/isolated-world.ts`), so the `replaced` path is reachable in real Chrome (M4 below).
- Proved by: unit `browser-actionability` "while the browser is opening another document, the page is not looked at, and the look resumes in the document that arrives" and "a navigation that never ends fails the action when the time runs out, naming the address without its query"; unit `browser-input-guard` "typing the new document stopped names that document and says nothing was typed", "a document that went away ... once the new document reports no stray typing", "a new document that stopped typing meant for the old one makes the verdict stopped"; unit `browser-page-scripts` lists `stray`. Real Chrome, `tests/integration/browser-secrets.test.ts`:
  - "a document that arrives while the text is on its way never receives it, and the fill names that document": the text is held on its way to the browser by a gated transport (`launchGated` in `browser-harness.ts`, through the new `transport` parameter of `launchBrowser`) while a browser-started `goto` opens another origin whose page autofocuses a field; the text is released once that page has loaded. On the code before the fix this test gave `outcome_unknown` "the browser gave an answer it cannot read" (fact 4) and the new page's field held the value; it now gives the `not_actionable` above, the field is empty and neither origin's page saw an `input` event.
  - "a fill waiting for a document that never arrives fails when its time runs out, naming the address, and types nothing": before the fix, with the tracking blinded, `timeout` "The page did not answer within 1000 ms"; now `not_actionable` naming the address, and nothing typed anywhere.
  - "a fill that begins while the page is opening another document waits for that document, whose origin decides": passes before and after the fix with the same refusal, because of fact 2. It pins the behaviour and does not distinguish the two; said here so nobody reads it as proof.
- Left open, documented in the guide: a page that moves the keyboard focus into a frame of another site as the text arrives can receive it there. Such a frame is a target Retest is not attached to, so no guard is installed in it, and the verdict is `outcome_unknown` naming the frame. Closing it needs attaching to out-of-process frames.

## Major

### M1. A secret in a URL was never redacted, encoded or not

- Where: `src/runner/redactor.ts` (`freeText` named `message`, `details`, `expected` and `actual` only; `learn` kept the value as typed; `redactCommandResult` passed a `goto` answer through).
- Problem: two gaps. `navigation.url`, the `pageUrl` on every action and assertion, `app.*.ready`, the base URLs on `run.started`, `result.json`'s copies of them and the `goto` answer sent to the child were not free text, so a value in a path stayed there even as the plain value. And the redactor knew only the value as typed, so `abcd%20efgh` (a path), `abcd+efgh` (a query or a form) and their lowercase-hex twins passed through every field, free text included: the observation sent to the test process, the `actual` text of a check, the failure card, the terminal.
- Reproduced: `tests/integration/m2-secrets.test.ts` "a secret a page writes into its address, where it is percent-encoded, is hidden there too" failed on the unchanged code (`events.jsonl` and `result.json` held the value).
- Resolution: `learn` registers every form a URL gives a value (the value, `encodeURIComponent`, `encodeURI`, a form submission's, and the URL standard's path, query and fragment encodings, each also with lowercase hex; `writtenForms` in `src/runner/redactor.ts`), all to the same placeholder, and `url`, `pageUrl`, `ready`, `baseUrl` and `baseUrls` are free text. A `goto` answer is redacted before it reaches the child. A form that equals the value is dropped, so a value of unreserved characters costs one entry, and no form is shorter than the value, so the four-character floor still holds.
- Proved by: unit `runner-redactor` "hides a value in every form a URL gives it, and never a look-alike that decodes to something else" and "hides a value written into an address, in the navigation event, the page URL of an action and a check, and the addresses of apps" (both fail without the change; the old identifier test now expects the page URL redacted too), and the integration test above, which passes.
- Not covered: HTML entities (`&amp;`) and JSON escapes (`\"`) in a test file's own output, where a value with `"` or `\` would not match the streaming redactor. Noted below.

### M2. Server and test file logs kept a value learned later

- Where: `src/runner/app-server.ts` (`copyTo` redacts each chunk with what is known then), `src/runner/run-session.ts` (`#redactBrowserLogs` reread browser logs only), `#outputFor` (the test file's output, the same way).
- Problem: a function source's value is learned when a fill reads it. A dev server that printed a one-time code as it sent it, and a test file that printed page text it read before the fill, wrote the value into `logs/` before the redactor knew it, and those logs were never read again.
- Reproduced: `tests/integration/m2-secrets.test.ts` "a one-time code a server printed before the fill read it is hidden in the server log too" failed on the unchanged code.
- Resolution: `RunStore.redactLogs` rewrites every file under `logs/` once nothing writes to them, and `RunSession.#redactLogs` calls it at release with everything the redactor knows by then; the browser-only pass and the pool's `logFiles` are gone. `logsFolder` joins `src/protocol/run-folder.ts`.
- Proved by: unit `store-run-store` "reads every log again with what was learned late, and leaves the rest of the folder alone", and the integration test above, which passes. The events and stdout written before the first read, and what the test process saw, cannot be recalled; the guide says so.

### M3. `doctor` wrote server output with no redaction, and kept it when the server failed

- Where: `src/cli/doctor/checks.ts` (`checkServer` called `startAppServer` without a `redactor`; `checkSecrets` read the environment secrets only to say whether they were set); `src/cli/commands/doctor.ts` keeps `.retest/doctor/<time>/` exactly when a check names a file in it, which the failed-server case does.
- Problem: a server that prints its settings as it starts, as the fixture does and many dev servers do, wrote an `env` secret's value into `logs/app-<name>.log`; when it then never answered, that folder was kept in the project, unredacted.
- Resolution: `runChecks` reads the environment secrets once, builds a `Redactor` from them, and every server it starts writes through it (`environmentSecrets`, `redactorFor`).
- Proved by: unit `cli-doctor` "gives each server it starts a redactor that already knows the environment secrets" (fails without the change), and `tests/integration/m2-doctor.test.ts` "doctor reports a missing browser ... each with its fix", extended: the never-answering server now prints `RETEST_E2E_TOKEN`, and the kept log reads `RETEST_E2E_TOKEN={{token}}` and never holds the value.

### M4. The `replaced` verdict was unreachable in real Chrome

- Where: `src/browser/isolated-world.ts` (`goneContextMessages`).
- Problem: fact 4. When the frame navigated while the guard's verdict call waited, Chrome answered `Inspected target navigated or closed`, which `isGoneContext` did not recognise, so `guardInput` threw and the action ended `outcome_unknown` "the browser gave an answer it cannot read ... (-32000)" instead of the designed `replaced` path. Found by the gated test in B1.
- Resolution: the message counts as a gone context.
- Proved by: unit `browser-isolated-world` "every answer Chrome gives for a document that has gone counts as one", and the gated test in B1.

## Minor

### m1. The human report printed each browser as a heading

- Where: `src/reporters/human.ts` (`browserLine`, the `browser.started` case).
- Problem: `  web=beta  Chrome 154…` at a file heading's indent, as the browser started; tests print as they finish, so a test whose variant needs no label read as if it ran on the browser named above it. Handoff part 2, section 10, item 10.
- Resolution: `    started web=beta  Chrome 154…` at the tests' indent, so it reads as something that happened. The per-target summary keeps the mapping. Unit `reporters-variants` updated.

### m2. The `runner` and `protocol` subpaths gave no default budgets

- Resolution: `defaultTimeouts`, `mergeTimeouts`, `timeoutsSchema`, the new `partialTimeoutsSchema` and the `Timeouts` type come from `./protocol`, and `defaultTimeouts`, `mergeTimeouts` and `Timeouts` from `./runner` too. `partialTimeoutsSchema` replaces the copy `src/config/validate.ts` kept. Unit `protocol-entry` "both entries give the default budgets and the merge".

### m3. The rerun command repeated budgets the config already set

- Where: `src/reporters/commands.ts` (`changedTimeouts` compared the recorded, merged budgets with the defaults).
- Resolution: `RunOptions.commandLineTimeouts` and `run.started.options.commandLineTimeouts` (additive, in the schema) record what the command line gave; the CLI always sets it, and the rerun command prints exactly that. A run without the field, as a programmatic caller's, keeps the old rule. Unit `reporters-format` "rerun repeats the budgets the command line gave, and none of them when it gave none".

### m4. A target written on its own hid the checks of its `baseUrl` and `start`

- Where: `src/config/read-apps.ts` (`readStandaloneTarget` returned on any schema problem before `loadApp` ran the URL and `start` checks). The handoff's wording ("only the first problem within one app") was wider than the code: an app with `targets` already reported every key.
- Resolution: the app settings and the target shape are read on their own, so `chrome({ headless: 'yes', baseUrl: 'localhost:3000', start: { command: ' ', ready: 'x' } })` reports all four keys. Unit `config-validate`, the base URL test, extended.

### m5. Screenshots are not redacted

- Kept as a documented limit. The guide and the handoff say so plainly, and the new secret tests never show a value on screen.

### m6. A download the page started went to the person's Downloads folder

- Where: `src/browser/browser.ts` (`newPage` set no download behaviour). Chrome's default download folder does not depend on the profile, so a test that clicked an export link would have written into the person's own folder, which `AGENTS.md` forbids touching.
- Resolution: every context asks the browser to deny downloads (`Browser.setDownloadBehavior`). The probe showed a denied download navigation abandoned with `net::ERR_ABORTED` and `Page.downloadWillBegin` still fired; whether any file was written was not checked, on purpose, since checking it means writing to that folder. The guide says downloads are refused.

## Nits

- Eight names were exported with no consumer outside their file (`fillValueSchema`, `minSecretLength`, `parseGrep`, `registeredTestSchema`, `resultKey`, `singleTargetName`, `targetBrowsers`, `targetCall`); they are module-private now. `CdpError` (a base class) and `AppLocator` (a public type) stay.
- `waitUntilActionable` took four positional parameters; it takes an options object now, which the new `pendingNavigation` hook joined.
- `tsconfig.json` excluding `examples/tasks` is the right fix: a `Register` augmentation applies to the whole program it is in, so the example cannot share the root program. `npm run typecheck` now also runs `tsc -p examples/tasks/tsconfig.json`, so the example is checked by the gate and not only by `m2-example`.
- `launchBrowser` gained a third, optional parameter that makes the transport from the pipe; the default is the pipe transport. It is the seam the gated test needed, and the only production code that changed for it.

## What is good and should stay

- The secret's path is one line of code wide where it matters: the child sends `{ secret: name }`, `SecretFiller.resolve` reads the value only after the origin check, `ResolvedFill` carries the label and the allowed origins, and the redactor learns the value before it goes anywhere.
- The `Redactor` scans by first character with the longest value first, keeps a placeholder from being read as a value, and holds back a tail across chunks; adding the URL forms needed no change to the scan.
- `hold` in the page cancels a navigation the page starts while a bound fill is armed, and the probe showed the `navigate` event covers frames, meta refresh and form submission too.
- `Register`, `RequiresConfig`, `NoInfer` on the state option, the `RetestTypeError` brand and one project per registered config: 109 markers matched on both compilers, and the unregistered fixture still compiles `page` tests.
- The browser pool launches each distinct executable, headless setting and emulation once, announces one `browser.started` per app target, and a lost browser stays lost; `AppServers` reuses a server that already answers and stops only what it started; states are removed at release and on exit.
- Every event carries `origin`, and the parent adds `variant` and `variantKey` to every event of an attempt, so a reader can tell what the parent saw from what the child claimed, and which run of a test it was.
- `runOutcome` still cannot produce a pass from a torn run, `inspect` rebuilds from events only, and `result.json` is claimed with `wx`.
- No `any`, `as` cast, non-null `!`, `@ts-ignore`, `@ts-expect-error`, `eslint-disable`, `console` or default export in `src/`; kebab-case files; explicit export types under `isolatedDeclarations`; `protocol` still imports only itself.

## What was not verified

Most important first.

1. The cross-site frame case in B1: a page that moves focus into an out-of-process frame as the text arrives. Not built; documented as open.
2. "A fill that begins while the page is opening another document" gives the same refusal before and after the fix (fact 2); the distinguishing tests are the other two.
3. Whether a denied download writes anything to disk (m6). Not checked, since the check would write to the person's folder.
4. HTML-entity and JSON-escaped forms of a value (`&amp;`, `\"`) in a test file's own output are not redacted. Noted, not fixed: the child prints them only when it had the value, which is the function-source limitation.
5. Linux, Windows, Edge, Chrome channels other than stable, headed browsers and CI runners: not run, as the handoff says.
6. `src/api/` structure (`describe`, hooks, `for`, `setup`), `src/runner/schedule.ts`, `plan.ts`, selection and `init` were read for shape and relied on their unit and integration tests; they were not reviewed line by line the way the secret path and the browser were.
7. Nothing here was rerun on Chrome for Testing 153 beyond the probes and the full integration suite in the Re-check section.

## Method

- Read: `AGENTS.md`, the architecture, the brief, the milestone 2 plan, both handoff parts, the milestone 1 review and the guide; then every file on the secret path (`secrets.ts`, `redactor.ts`, `running-test.ts`, `run-session.ts`, `app-server.ts`, `app-servers.ts`, `event-log.ts`, `run-store.ts`, `secret.ts`, `read-secrets.ts`), every file of the browser's action path (`page.ts`, `page-scripts.ts`, `input-guard.ts`, `actionability.ts`, `element-queries.ts`, `isolated-world.ts`, `input.ts`, `navigation.ts`, `origin-document.ts`, `origin-refusal.ts`, `browser.ts`, `launch.ts`, `chromium-process.ts`, `profiles.ts`, `transport.ts`, `connection.ts`), the pool, the test pages, the config reader and validator, `doctor`, the reporters' commands, human and targets modules, the subpath entries, the contract, the schemas, the example project, the `init` templates, the type fixture runner and the harnesses.
- Probes, each in its own profile under the temporary folder and removed afterwards: `/tmp/retest-fable-m2/probe-navigation.ts` on both browsers, scenarios `navigate`, `script-slow`, `204`, `download`, `redirect`, `frame-nav`, `frame-nav-late`, `meta`, `form`, `cancelled-by-next`, `insert-after-commit` and `deferred`. A scratch copy of the secrets test with the navigation tracking blinded (`Page.frameStartedNavigating` dropped by the gate) established the pre-fix outcomes quoted in B1; it was deleted afterwards.
- Greps over `src/` for casts, `any`, non-null assertions, suppressions, `console`, default exports, and a count of files using each export.
- Every test file touched was run on its own after each change; the gates in the Re-check section were run at the end.
- Killed only the browsers the probes started (each closed by `Browser.close` and its group stopped), and checked afterwards that no `retest-*` folder of this review is left in the temporary folder and no process of it still runs.

## Re-check

30 September 2026, after every fix above, re-reading each changed file once more and running the gates from the repository root, one after another, on Chrome 154.0.8037.92 and Chrome for Testing 153.0.8010.12.

### Re-reading the fixes

- `src/browser/page.ts`: the three listeners are registered in the constructor beside the ones that were there, so no navigation can begin unheard between `open` and the first command; `#frameNavigated` clears the pending navigation before it moves the URL, so a `goto` that returns sees none pending; a same-document `frameStartedNavigating` (`sameDocument`, `historySameDocument`) is ignored, so `history.pushState` never stalls an action; `#loadingStopped` clears it for a 204 or a download. A navigation of a child frame carries the child's `frameId` and is ignored. `#act` disarms a target it lets go, so the guard's `latest` never points at a stale arming.
- `src/browser/actionability.ts`: the `navigating` state is only ever the last look's, so the message names the address of the navigation that was pending when the time ran out, origin and path only.
- `src/browser/page-scripts.ts`: the stray record is per document (`installGuard` runs once per document), so a document that stopped typing once keeps saying so, which is the honest reading: something typed into it was stopped. Only `fill` events are stopped when nothing is armed; a press into an unarmed document still goes through and is reported `outcome_unknown` as before, so the change touches no click test.
- `src/browser/input-guard.ts`: `guardInput` asks the current document for its stray record only after the guard's own document is gone, through `world.call`, which makes the new document's world; the deadline bounds it. A press whose verdict is `stopped` is still reported `outcome_unknown`, since nothing was stopped for it.
- `src/runner/redactor.ts`: `writtenForms` drops forms equal to the value, so a value of unreserved characters registers once; every form is at least as long as the value; the `#byFirst` index and the held-tail scan take the forms as more values, unchanged. `freeText` gained `url`, `pageUrl`, `ready`, `baseUrl` and `baseUrls`; `testId`, `file`, `locator` and `variant` stay untouched, and the identifier test says so.
- `src/store/run-store.ts` and `src/runner/run-session.ts`: `redactLogs` runs after the browsers closed, the servers stopped and every test file process was killed, so nothing appends to a log after the pass; a log appended to afterwards by the store itself would go through the streaming redactor as before.
- `src/cli/doctor/checks.ts`: the environment secrets are read once, before any server starts, and each server writes through a redactor that knows them; the checks reported are the same as before, in the same order.
- `src/config/read-apps.ts`: the standalone path reads settings and target shape separately, and an entry that is not an object still reports the union's message once.
- `src/reporters/commands.ts`: `commandLineTimeouts` is optional on the event, so a run recorded before this change, and a programmatic run that sets none, keeps the old rule.

### Gates

| Command | Exit | Result |
| --- | --- | --- |
| `npm run build` | 0 | `dist/` rebuilt; `dist/schemas/event-v1.schema.json` now carries `commandLineTimeouts` |
| `npm run typecheck` | 0 | TypeScript 6.0.3 and 7.0.2 on the root project, then 6.0.3 on `examples/tasks`; no errors, no `FATAL` |
| `npm run test:unit` | 0 | 1092 tests in 197 suites: 1092 passed (1080 before the review, plus 12) |
| `npm run test:types` | 0 | "109 expected errors matched 109 markers in 4 projects" on 6.0.3 and on 7.0.2 |
| `npm run test:integration` | 0 | 238 tests: 238 passed, 0 failed, 0 cancelled, 223.2 s (235 before, of which 2 failed; plus the three secrets tests) |

Output captured under `/tmp/retest-fable-m2/`. After the last run the system temporary folder held no `retest-*` folder and no process of this review was running.

### Still open after the fixes

1. The cross-site frame case (B1, layer left open): typing into an out-of-process frame that took focus as the text arrived. Documented in the guide.
2. HTML-entity and JSON-escaped forms of a value in a test file's own output (M1).
3. Screenshots are not redacted (m5), as documented.
4. Whether a denied download writes anything (m6), not checked on purpose.
