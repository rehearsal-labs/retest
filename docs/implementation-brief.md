# Retest first implementation brief

Prepared 29 September 2026 for a separate implementation session. This session owns implementation and verification. The originating session will review the finished work afterward. Do not launch another session or send messages to it on the user's behalf.

## 1. Objective

Build the first working Retest library: an original TypeScript test runner and Chromium automation client, usable by a coding agent or a developer from a local repository.

The completed milestone must load a test file, launch an explicitly selected Chromium binary, interact with a small web app through real browser input, check the visible result, produce useful evidence and clean up. A deliberately broken application must produce a genuine failed test and nonzero process exit status.

This is one complete browser milestone. The larger ecosystem should inform the boundaries, but mobile, desktop, VLM execution and hosted services are later work.

## 2. Working directory and current state

Work only in this repository.

Read these files first:

1. `AGENTS.md`
2. `README.md`
3. `docs/architecture.md`
4. `docs/naming.md`
5. This brief

The repository currently has an empty local Git history and untracked foundation files: README, AGENTS, package metadata, Apache-2.0 license, `.gitignore` and architecture/naming documents. There is no implementation, lockfile, build configuration or dependency installation. Preserve the existing files and any changes another session has made since this brief was written.

The provisional package is `@rehearsal-labs/retest`, version `0.0.0`, with `private: true`. The unscoped npm name is occupied. The scoped package was not publicly visible when checked, but publishing permission is unverified and nothing is reserved. Local npm authentication returned 401. Publishing is outside this task and is not needed to implement or verify the library.

The sibling Rehearsal repository is an existing product with extensive unrelated work. Do not edit it, import its internal packages, link its dependencies, or copy its implementation, credentials or private data. The earlier proposal that depended on Playwright Test has been superseded.

## 3. Requirements from the user

These requirements are fixed for this handoff:

1. Retest is a separate project in the Rehearsal ecosystem.
2. Retest owns its implementation. Do not wrap or depend on Vitest, Playwright Test, Playwright, Puppeteer, Selenium, Cypress, Appium or another testing/automation framework to execute the milestone.
3. Make it easy for coding agents to author tests, run them and inspect precise failures.
4. Keep local use independent of a Rehearsal account or service.
5. Keep the library suitable for the proposed open-source direction and the separate closed-source Rehearsal product.
6. This session implements; the originating session performs the subsequent review.

The following implementation choices are recommendations selected to keep this milestone concrete. Resolve routine details without asking the user. Explain any material departure in the handoff:

- TypeScript, ESM and Node.js 24.12+ as the initial execution host.
- No third-party runtime npm dependencies. Node built-ins and browser/OS interfaces are allowed foundations.
- TypeScript and `@types/node` are reasonable development-only dependencies for compilation and checking. Keep tooling small, pin it with one lockfile, and list additions in the handoff. Avoid a bundler unless the implementation actually needs one.
- Use one package and npm scripts initially. Do not introduce a monorepo manager or a package per internal module.
- Original CDP transport and browser implementation against an explicitly selected installed Chromium/Chrome binary. No browser download step in this milestone.
- Use `node:test` and `node:assert` for independent verification of Retest. They must not implement Retest's production lifecycle.

Do not commit, push, publish, create a remote repository or change npm ownership. Keep `private: true`. Do not start, stop or alter the user's existing app servers or everyday browser profile. Starting and stopping your own disposable fixture server and isolated browser processes is necessary verification work within this milestone.

## 4. Module responsibilities

Use this structure as a guide. Create files only when they contain used implementation. Exact filenames may follow the code's needs.

```text
src/
  index.ts             public authoring exports
  api/                 test registration, context and configuration
  runner/              collection, execution, deadlines and cleanup
  assertions/          immediate values and retrying locator assertions
  browser/
    cdp/               WebSocket transport, requests, sessions and events
                       browser launch, contexts, pages and locators
  protocol/            typed, versioned commands/results/events
  reporters/           terminal and JSONL output
  cli/                 argument parsing, finite commands and exit status
tests/
  unit/                focused deterministic checks
  integration/         process-level and real-browser checks
fixtures/              controlled passing and broken app states
examples/              one working application test
docs/
  implementation-handoff.md
```

The runner owns the test lifecycle. Browser code owns browser behavior. Reporters consume results and must not decide whether a test passed. Human output and agent output derive from the same event/result model. Avoid cyclic imports and an all-purpose runtime singleton.

Start with explicit built-in `page` lifecycle management. A public fixture dependency language, worker-scoped fixtures and `test.extend` are deferred. This deliberately narrows the broader architecture document. The internal lifecycle must still handle partial setup, reverse cleanup and failure preservation.

Do not create empty Firefox, mobile, desktop, model-provider or cloud packages.

## 5. Minimum public experience

Support ordinary ESM JavaScript tests and TypeScript tests using erasable syntax. State the initial limitations: no JSX, TypeScript path aliases, enum transformation or implicit extension resolution. Publishable build output must be JavaScript plus declarations; do not depend on Node stripping types inside `node_modules`.

The authoring API should support this small example or an equally clear, documented equivalent:

```ts
import { test, expect } from '@rehearsal-labs/retest'

test('saves a task', async ({ page }) => {
  await page.goto('/')
  await page.getByTestId('task-title').fill('Release checklist')
  await page.getByTestId('save-task').click()
  await expect(page.getByTestId('saved-task')).toHaveText('Release checklist')
})
```

The example application is a controlled fixture created by this implementation. Saving should cross a real local HTTP request boundary and update the page after the response. Its broken mode must withhold or render an incorrect outcome while leaving the test's assertion unchanged. Do not make the library recognize fixture-specific behavior.

Provide `test(name, callback)`, `test.step(name, callback)`, `expect(value).toBe(expected)`, `expect(locator).toBeVisible()` and `expect(locator).toHaveText(expected)`. Value assertions are immediate. Locator assertions retry observations within a bounded deadline. Define string comparison precisely, including whitespace; do not perform fuzzy matching.

Implement `page.goto`, `page.getByTestId`, locator `fill` and locator `click`. A locator stores a recipe and resolves fresh for each action/assertion. Initial scope is the top-level document and standard HTML inputs/buttons. Do not expose role, frame or shadow-DOM APIs that are only partly implemented.

The exact CLI spelling below is proposed. Keep equivalent behavior if a small syntax improvement is justified:

```sh
retest --help
retest --version
retest list examples/task.retest.ts --json
retest run examples/task.retest.ts \
  --browser /absolute/path/to/chromium \
  --base-url http://127.0.0.1:PORT \
  --reporter jsonl \
  --output .retest/example-run
retest inspect .retest/example-run --json
```

All commands terminate. No watch mode. `list` reports collected tests and source locations, not inferred tests from a text search. `inspect` reads an existing result and does not rerun the browser. `--help` documents only implemented options. Unknown arguments, malformed configuration and missing files fail clearly.

Support one explicit file or a small explicit list of files. Recursive discovery, glob languages, TypeScript configuration loading and project matrices are unnecessary for this milestone. Use the existing package name in an external-consumer smoke test; do not rely only on imports into the source tree.

## 6. Runner contract

- Execute selected files sequentially. Use a disposable child process per file. Give each test fresh browser state. Document that arbitrary module state remains shared within a file.
- Bound collection as well as execution. A file with an infinite top-level loop cannot hang the CLI forever.
- Browser ownership and the command boundary must let the parent stop a timed-out child from issuing new browser actions. A bare `Promise.race` is not cancellation.
- Use separate finite setup, action, assertion and cleanup budgets under an overall deadline. Defaults may be chosen by the implementer; document them and make verification use short explicit budgets.
- After an uncooperative timeout, terminate only owned child processes and release owned browser resources. Mark unexecuted tests honestly. Do not quietly retry them in a fresh process.
- No full test retries, skip/only modifiers, parallelism or watch mode in this milestone. Reject unsupported public options rather than silently accepting them.
- A test that performs no Retest assertion fails with a useful message in this initial application-testing contract. Report actual assertion counts. Track asynchronous assertions and browser actions; work still pending when the callback ends is a test error, and a recorded assertion rejection cannot be lost. Document that these operations must be awaited. This does not require detecting a missing `await` after an operation has already completed successfully.
- A selected run is successful only when collection, all selected tests and required cleanup finish successfully. No matching tests, collection failures, setup failures and interruptions must not return success.
- Preserve a test's original failure alongside any evidence or cleanup errors. Reporter/output-write failures also require an unsuccessful command result.
- Define stable test identity from file and declared name; reject duplicate names in one file rather than overwriting results. Attempt/run identities are distinct and generated per execution.

Child-process isolation is not a sandbox for hostile test code. Make no such security claim. No hosted untrusted-code execution is part of this task.

## 7. Browser contract

- Launch a browser with a temporary profile owned by this run. Use a loopback debugging endpoint or private transport and an ephemeral port. Never attach to the everyday user profile or a discovered unrelated session.
- Keep the Chromium sandbox enabled. Do not solve launch failures by adding `--no-sandbox` or disabling machine security controls.
- Validate the supplied binary path and explain missing/incompatible executables. Record the browser version that actually ran. Avoid declaring support for all Chromium versions or operating systems.
- The CDP client correlates responses, routes target/session events, bounds pending commands and rejects pending work on disconnect. Validate the protocol boundary without `any` or unchecked data casts.
- Resolve `data-testid` by exact value and require one match. Handle strings safely; never concatenate user values into executable JavaScript without correct serialization.
- Before input, resolve fresh and check visibility, relevant enabled/editable state, location and hit testing. Scroll when supported. Reject ambiguous matches; do not select the first element silently.
- Dispatch browser input for click/fill. JavaScript evaluation is appropriate for reading DOM state, but assigning `input.value` or calling `element.click()` is not a substitute for the user interaction promised by these methods.
- `fill` replaces the current value. Define supported input types, newline behavior and disabled/readonly behavior. Reject unsupported fields clearly.
- Navigation uses events and an explicit completion condition with a deadline. Installing listeners after issuing the navigation must not miss the event. Do not rely on arbitrary sleep or a universal network-idle heuristic.
- Assertions repeatedly observe state; they never redispatch the preceding action. An overlay or DOM replacement before dispatch may require fresh resolution. After input might have been dispatched, a lost connection must not trigger another click automatically.
- Failures distinguish not found, ambiguous, not actionable, assertion failure, timeout, lost session and unknown action outcome. Do not claim an application root cause based only on a timeout.
- Capture a screenshot on failure if the browser remains available. If capture is impossible, record why. Screenshot failure cannot turn a failed test into a pass or conceal its primary error.

Cross-origin frames, shadow DOM, downloads, uploads, popups, dialogs, network mocking, video and visual assertions are outside this milestone. Document the scope. Unexpected browser events must cause an explicit supported failure or bounded timeout, never an endless wait or success inferred from missing evidence.

## 8. Agent-readable results

Define a version-1 event union and JSON schema or another checked machine-readable schema for supported events and stored results. TypeScript types alone are insufficient documentation for a non-TypeScript agent. Use shared definitions or verification to keep runtime output and schemas aligned.

Events need: schema version, type, run ID, sequence, timestamp, and applicable test/attempt/step/target IDs. Use monotonic elapsed time for durations. A parent-assigned sequence gives deterministic event order within the run.

At minimum, record collection completion, test start, action completion/failure, assertion completion/failure, test completion and run completion. Every action/assertion should link to a source location where available. Store expected and actual values for supported assertions, the locator recipe, timeout and evidence references. Truncate oversized values with explicit truncation metadata.

In JSONL mode stdout contains only valid event lines. Browser diagnostics and user test stdout must not corrupt it. Route or capture them separately and document where they go. `inspect --json` returns one valid JSON result, including partial evidence for a run interrupted before completion.

Use exit code 0 for a complete passing run, 1 for completed test failures, 2 for usage/setup/collection/infrastructure/reporting failures, and 130 for SIGINT where the platform supports that convention. Document how mixed failures choose the final nonzero status. An externally forced SIGKILL can prevent a final event; an incomplete result must remain recognizable afterward.

Write artifacts under the selected output directory with generated safe names. Do not overwrite a previous run silently. Artifact references should remain relative to the run directory so a report can be moved. Keep intermediate output usable when a process fails halfway through writing it.

Do not capture process environments, request headers or raw typed values in action events. The fixture and example use synthetic data, not real credentials. Screenshots and page text can still contain sensitive content; keep evidence local and document that this milestone does not provide comprehensive image redaction. No telemetry or automatic artifact upload.

## 9. Verification matrix

Use independent Node tests and real browser runs. Mocks may verify transport edge cases, but they do not establish browser behavior. Build purpose-specific local fixtures and retain commands/results for review.

| Check | Required observation |
| --- | --- |
| Passing save | One action sequence, exact expected UI text, passing result and exit 0 |
| Broken application | Same test against broken fixture fails its outcome check and exits 1 |
| Zero assertions | Action-only test cannot return success |
| Unawaited work | An assertion still pending when the callback returns, or an unawaited failed assertion, cannot produce a clean pass |
| Empty selection | Missing/no-test selection exits nonzero with an explicit explanation |
| Collection error/hang | Invalid import and top-level infinite loop end unsuccessfully within a bound |
| Missing browser | Invalid executable path reports setup failure, not a test pass |
| Duplicate targets | Two matching test IDs fail rather than interacting with an arbitrary element |
| Covered target | An overlay prevents the underlying click; no forced DOM click gets through |
| Disabled/readonly field | Input fails clearly and leaves the field unchanged |
| Replaced element | A locator used after DOM replacement resolves the current element |
| Delayed result | The assertion waits for a controlled delayed response without repeating submission |
| Submit counter | A fixture-side counter proves one click caused one submission during assertion polling |
| Timeout | Both cooperative waits and an infinite test loop terminate with owned resources released |
| Browser disconnect | Kill only the owned browser during a command; get a non-pass and honest uncertainty |
| Cleanup failure | The original assertion error remains visible alongside the cleanup failure |
| File/test isolation | A second test receives clean browser storage and no inherited page |
| Reporter integrity | Test output and browser logs do not invalidate JSONL; event/result schemas validate |
| Report interruption | Inspecting incomplete output cannot report a completed passing run |
| External consumer | A locally packed package imports with its public name and runs outside the source checkout |

For checks that require a deliberate fault, use a controlled fixture, mock at a defined boundary or subprocess termination. Do not add undocumented production flags that silently bypass behavior merely to make verification easier.

Verify no owned browsers, workers or fixture servers remain after the exercised completion, failure and cancellation paths. Track owned PIDs/handles; never kill processes by a broad name or port match.

The starting machine is macOS with Node 24.12.0 observed in the planning session. Recheck the implementation environment. If an installed browser is unavailable, report the exact blocker; do not replace all real-browser checks with mocks and declare completion.

## 10. Implementation sequence

1. Inspect the working tree, choose minimal development tooling, establish strict compilation and independent tests.
2. Implement event types, collection, sequential execution and exit statuses. Prove negative cases with subprocess tests.
3. Implement browser ownership and original CDP transport. Prove navigation and clean shutdown against the installed browser.
4. Add exact test-ID locators, input and polling assertions, tested against controlled fixtures.
5. Complete the end-to-end example, JSONL output, stored results and `inspect`.
6. Verify timeouts, ambiguous/covered targets, disconnects, cleanup and package consumption.
7. Update documentation to match implemented behavior and write the handoff.

Keep scope narrow enough that every advertised method is exercised. Do not stop after producing interfaces and mocks. Do not claim completion if required real-browser behavior is unverified.

## 11. Required handoff

Write `docs/implementation-handoff.md` and provide a concise final response linking it. Include:

- What actually works and the exact supported environment/browser version.
- Files/modules added and any material departures from this brief, with reasons.
- Direct and transitive development dependencies; confirm production dependency status.
- Exact build, typecheck, test and example commands, exit codes and meaningful counts.
- Paths to the passing and deliberately failing run reports/screenshots, plus timeout/disconnect evidence.
- Results for every row of the verification matrix, clearly separating real-browser checks from mocked checks.
- External-consumer/package smoke-test results.
- Cleanup verification and any resources left running.
- Remaining limitations and incomplete requirements, most important first.

Do not commit or publish. Keep report paths local and do not include credentials. Update `README.md` with instructions that another session can execute without reconstructing this conversation.

## 12. Subsequent review

The originating session will read the implementation and handoff, inspect public types and dependency boundaries, rerun appropriate checks, and reproduce the passing and deliberately failing browser flow. It will specifically look for false passes, action retries, timeout races, leaked processes, stale locators, corrupted agent output and unsupported compatibility claims.

An implementation agent's summary is evidence to investigate, not proof that the milestone works. The review is a separate step after this handoff; do not label the implementation independently reviewed.

## 13. Amendments, 30 September 2026

The developer-experience plan in `docs/plans/developer-experience/` (`design.md`, decision numbers in brackets) changes these milestone 1 details. Everything else above stands. Where this section and an earlier one disagree, this section wins.

1. **Files.** Test files end in `.retest.ts`, as in `examples/task.retest.ts` [2].
2. **One `test` signature.** It is `test(name, options?, fn)` [10]. In milestone 1, `options` accepts only `timeout`. Any other key is rejected, both by the types and at run time with a clear message.
3. **`expect`** [13]. It is one function whose argument decides the matchers.
   - Value matchers are immediate, and `toBe` requires the value's own type (`NoInfer`).
   - Locator matchers (`toBeVisible`, `toHaveText`) are awaited and retry by looking again.
   - Passing a promise, an `any` or a `Secret` is a compile error through a branded `RetestTypeError`. For `any`, the message says to write `expect<T>(value)`.
   - Calling a value matcher on a locator is a branded error that names the right matcher.
4. **Text comparison.** `toHaveText` compares the whole text after trimming both ends and reading each run of spaces or line breaks as one space. Document this rule, and print it in every failure.
5. **One command at a time for each page** [17].
   - A second command sent while the first is still running fails at once, naming both source lines.
   - Assertions start only when awaited.
   - Work still pending when the callback returns fails the test.
   - Waits that listen for an event may overlap one action, but milestone 1 has none.
6. **Event schema v1.**
   - Locators are recorded as a JSON union, even though milestone 1 has one member: `{ "by": "testId", "value": "save-task" }`.
   - Every action and assertion event carries the page URL as origin plus path, with no query or fragment. Navigation gets its own events.
   - Every event has an optional `session` field (the app name), which milestone 1 always sets to `page`.
   - The outcome union includes `inconclusive`, which milestone 1 never produces.
   - Failure classes: `check_failed`, `not_found`, `ambiguous`, `not_actionable`, `timeout`, `session_lost`, `outcome_unknown`, `setup_failed`.
7. **Exit codes** [21].
   - 130 comes first.
   - Then 2, when nothing trustworthy came out: a usage error, a collection or setup failure before any test ran, or results that could not be written.
   - Then 1, once tests ran and at least one failed its checks, even if other tests hit infrastructure problems. The JSON result marks such a run `complete: false` and lists the tests that did not run.
8. **Default timeouts** [18]. Action 10 s, navigation 30 s, assertion 5 s, test 60 s, setup 60 s, cleanup 10 s. Verification still uses short explicit budgets.
9. **Output** [19, 20].
   - A failure prints as one card: class, locator, expected and received with a diff and the comparison rule, what the runner waited for, a code frame at the test's line, the screenshot path, a rerun command and an `inspect` command.
   - When a coding agent is detected (`CLAUDECODE`, `CODEX_THREAD_ID`, `AGENT`, `AI_AGENT`, or `--agent`), the terminal shows only failures and the summary, ending with a `next:` line. `--no-agent` turns that off.
   - Test ids in commands use ASCII: `"examples/task.retest.ts > saves a task"`.
10. **Transport.** Prefer `--remote-debugging-pipe` to a loopback port, unless measured behaviour on this host rules it out.
11. **Left out on purpose** [14]. No sleep, no `force`, no element handles, no `first()` or `nth()`.
12. **TypeScript** [28, 29].
    - Support TypeScript 6.0 and later.
    - Retest's own source adds `isolatedDeclarations`.
    - Test the public types with compile-fail fixtures run through the `tsc` command line. Each expected error is marked on its line with `// type-error TSnnnn fragment`, every error must match a marker, and every marker must be used.
    - Run the fixtures on TypeScript 6 and 7. That means two compiler versions as development dependencies; list both in the handoff.
13. **Downloads.** Milestone 1 still downloads no browser [42].
