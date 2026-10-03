# AI evaluation contract, fake evaluator and AI SDK adapter: record

3 October 2026. Release 0.1.0, Phase 1 item 9 ([release-0.1.0.md](../release-0.1.0.md)), the [AI evaluation contract](../ai-evaluation.md), and "AI evaluation and diagnostic output" in [releases.md](../releases.md).

## Result

A test can ask for an AI check with `test.evaluate`, and a host can require checks with `RunOptions.hostEvaluations`. In both cases the parent process captures the evidence, resolves the judge's credentials, sets the judge up, reserves the call, sends one request with a deadline and no tools, checks the answer and records the verdict. The test file's process never holds a credential, never loads a judge and never decides a verdict. A scripted fake judge in `tests/support/fake-evaluator.ts` proved the lifecycle through the real parent, offline, for the outcomes the table under "What the fake evaluator proved" names. The optional AI SDK adapter was run from the packed package against a local stand-in for the Anthropic and OpenAI APIs, with the pinned SDK installed from the registry into a project outside the checkout; that test skips as unverified when the install fails, so a green file alone does not show it ran, and its log does. No provider was called: the live gate stays unverified until `RETEST_EVALUATION_ANTHROPIC_KEY` and `RETEST_EVALUATION_OPENAI_KEY` are supplied.

Fake runs prove lifecycle and aggregation. They say nothing about how well any model judges.

## How to run it

From the Retest root, with Node 24.12 or later and Google Chrome:

```sh
node --conditions=retest-source --test tests/unit/evaluation-contract.test.ts tests/unit/evaluation-config.test.ts tests/unit/evaluation-runs.test.ts tests/unit/evaluation-ai-sdk.test.ts tests/unit/evaluation-commands.test.ts
node --conditions=retest-source --test tests/integration/evaluation.test.ts
node --conditions=retest-source --test tests/integration/evaluation-ai-sdk.test.ts
npm run test:types
```

The second integration file builds and packs Retest and installs the pinned SDK from the registry into a project in the temporary folder, with an npm cache at `$TMPDIR/retest-ai-sdk-npm-cache`; without the network that test reports itself unverified. Set `RETEST_EVALUATION_ANTHROPIC_KEY` and `RETEST_EVALUATION_OPENAI_KEY` to run the live gate. No other variable or file is read for a key.

## Settled names

| What | Name |
| --- | --- |
| Test API | `test.evaluate({ judge?, requirement, evidence, context?, mode?, timeoutMs? })`, resolving to nothing |
| Requirement | a sentence, one criterion with id `requirement`, or criteria by id: `{ saved: '...', titled: '...' }` |
| Evidence | `{ capture: 'screenshot', app? }`, `{ text, label? }`, `{ recording: { step }, app? }` (declared, refused at run time by name) |
| Modes | `required` (default), `advisory` |
| Config block | `evaluation: { judges, defaultJudge?, timeoutMs?, limits? }` |
| Judge | `{ adapter, credentials?, options?, accepts }`; `adapter` is a module path relative to the config, a package specifier resolved from the config's folder, or a function; `accepts` lists `text`, `images`, `frames` |
| Limits | `callsPerTest` 5, `callsPerRun` 100, `concurrentCalls` 2, `maxOutputTokens` 1000, `maxInputBytes` 8000000, `maxImages` 4, `maxImageWidth` 4096, `maxImageHeight` 4096; `timeoutMs` 30000. Bounds, not measured |
| Typed names | `JudgeName`, `DefaultJudgeName`, `JudgeAccepts` in `register.ts`; `EvaluateOptions`, `EvaluateCheck`, `EvidenceFor` in `src/api/evaluate.ts` |
| Host option | `RunOptions.hostEvaluations`, keyed by test id or file as `hostChecks` is; each `{ id, criteria, evidence, judge?, context?, timeoutMs? }`, always required |
| Evaluator contract | `EvaluatorFactory`, `EvaluatorSetup`, `Evaluator`, `EvaluatorIdentity`, `EvaluationRequest`, `JudgedEvidence`, `JudgeAnswer`, `JsonValue` from the package root |
| Adapter subpath | `@rehearsal-labs/retest/evaluation/ai-sdk`, default export a factory; also `aiSdkEvaluator`, `requestMessage`, `AiSdkSetupError` |
| Child messages | `evaluate` (child to parent), `evaluation-result` (parent to child) |
| Event | `evaluation.finished`, with the record under `evaluation` |
| Result | `TestResult.evaluations`, `run.started.options.hostEvaluations` |
| Failure classes | `evaluation_failed`, `evaluation_inconclusive`, `evaluation_error` |
| Instructions version | `retest-judge-1` (`src/evaluation/instructions.ts`); adapter version `retest-ai-sdk/1` |
| Check ids | `evaluation-1`, `evaluation-2`... per attempt for a test's own checks; the host's own ids for host checks |

## Request and answer

The request (`EvaluationRequest`), frozen, built by the parent:

- `requestId` (`<attempt>:<check>`), `judge`
- `instructions` and `promptVersion`: Retest's fixed rules, written before any evidence exists
- `criteria`: `{ id, requirement }[]`, redacted; `context`, redacted
- `evidence`: `{ id, kind: 'text', text, label? }` (text redacted) or `{ id, kind: 'image', mediaType: 'image/png', data, width, height, app, capturedAt }`; the image bytes are a copy of what was hashed and saved
- `maxOutputTokens`, `timeoutMs`, `signal`

No function and no handle on a page: a judge cannot act.

The answer the parent accepts (`JudgeAnswer`):

- `criteria`: every requested id exactly once, each with `verdict` `pass`, `fail` or `inconclusive` and `citations` drawn only from the supplied evidence ids; a pass or a fail cites at least one
- `justification`: non-empty, at most 2000 characters
- `modelRevision?`, `usage?` (`inputTokens`, `outputTokens`, `totalTokens`)
- no other key: a self-reported `confidence` makes the answer an error

The record (`EvaluationRecord`, in the event and the result): `checkId`, `source`, `mode`, `judge?`, `verdict` (`pass`, `fail`, `inconclusive`, `error`, `cancelled`, `not_run`), `criteria` with verdicts and citations, `context?`, `criteriaSha256` of the criteria and context as sent, `evidence` (`id`, `kind`, `app?`, `sessionId?`, `attemptId`, `capturedAt`, `path?`, `label?`, `sha256`, `bytes`, `width?`, `height?`), `justification?`, `reason?`, `evaluator?` (`provider`, `model`, `modelRevision?`, `evaluatorVersion`, `promptVersion`, `sampling?`, `latencyMs?`, `usage?`), `failure?`, `warning?`, `durationMs`, `location?`. Justification, reasons, criteria, context and labels pass through the run's redactor before the record exists; judge credentials are taught to the redactor when they are read.

## Policy as implemented

Verdict from criteria: any `fail` fails the check; otherwise any `inconclusive` leaves it inconclusive; only all `pass` passes (`aggregateVerdict` in `src/evaluation/answer.ts`).

| Check ends | Required | Advisory |
| --- | --- | --- |
| pass | satisfies the check, counts as an assertion | nothing |
| fail | `evaluation_failed`, test `failed`, exit 1, counts as an assertion | warning |
| inconclusive | `evaluation_inconclusive`, test `inconclusive`, exit 2 | warning |
| error | `evaluation_error`, test `error`, exit 2 | warning |
| cancelled | the run's interruption itself when the run was stopped; otherwise `evaluation_error` "did not finish", ranked as an error behind any failure, so a test that left the check unawaited ends `failed`, led by `not_awaited` | nothing |
| not_run (host only) | after a body failure, nothing added to that failure; after an interruption, the interruption is the test's failure | not used |

`src/evaluation/policy.ts` writes the table; `src/runner/outcome.ts` maps `evaluation_inconclusive` to the `inconclusive` status and counts `evaluation_error` as ours.

How the test's failure is decided (`withEvaluationFailures` in `src/evaluation/run-evaluations.ts`): the test file's process can never soften what the parent recorded, turning a failed check into an error, an undecided result or a pass. The parent waits for every check still in flight, then takes its own records. With no failed check, the reported failure stands, since a process may always fail its own test. With one, three kinds of failure may lead: the parent's check records; any failure in the report the parent saw for itself, one of `BodyReport.observed` (`src/runner/running-test.ts`: a page command's failed answer, a `check_failed` assertion naming a look the parent served, the parent's stop of the test, the process ending); and any failure the process reports that fails the test, such as a failed `expect` on a value or `not_awaited`, since such a claim can only make the test fail. Among them a failure of the application comes first, then an undecided check, then any other, whatever order they happened in; within one rank, what the parent saw comes before what the process only claims. The lead sets the status, the counts and the exit code. A class the process reports that is not a failure, such as `session_lost`, `outcome_unknown`, `unsupported`, `interrupted` or `setup_failed`, is appended to `details.also` and never leads; its claims of an evaluation class are dropped, lead or line, since the parent writes its own. The parent does not check that a failed assertion naming a served look really fails on that look; such a failure can only make the test fail. The body counts as passed only when the records have no failure; page host checks, then host AI checks, run only after a passing body. An interruption that keeps host AI checks from running becomes the test's failure, as `run-host-checks.ts` does for page checks.

Inconclusive also covers missing evidence: a browser that is gone, a screenshot that fails or is not a PNG with a readable header. Error covers no judge, an unknown judge, evidence the judge does not accept, recorded-step evidence, a judge whose credential, adapter or factory fails, a call past a limit, no answer in time, a judge that throws, and an answer that breaks the contract.

## What the fake evaluator proved

All in `tests/unit/evaluation-runs.test.ts` unless named otherwise; each run is a real test file process and the runner's own parent path, with the fake browser.

| Contract item | Test |
| --- | --- |
| Required pass, fail, inconclusive, malformed, thrown error, each with its status and class | "required AI checks through the parent" › "a pass passes the test and counts as its assertion", "each outcome keeps the test from passing with a reason of its own", "the reasons say what happened without quoting the judge as Retest" |
| Exit code per required outcome, run alone: 0, 1, 2, 2 | "the exit code of a run, for each required outcome alone" |
| An error caught in test source still fails the test | "an error the test catches still fails the test, as the parent recorded it"; real Chrome: `tests/integration/evaluation.test.ts` ("caught") |
| The parent decides even when the test process forges a pass | "a test file that sends the parent a forged pass after a failed check" |
| Missing required ids, a fabricated citation, a self-reported confidence are errors | the outcome tests above, plus `tests/unit/evaluation-contract.test.ts` › "a judge's answer" |
| Negation cannot turn uncertainty into success | "uncertainty about one criterion keeps the check undecided, whatever the others say"; `evaluation-contract.test.ts` › "a check verdict from its criteria" |
| An earlier failure survives a later pass | "a later pass clears no earlier failure" |
| No tool executes; the judge gets data and a signal | "the judge receives data and a signal: no function, no page, nothing it can act with"; "a test that only acts and captures" (the page's only command is the test's own goto) |
| Hostile app text travels as evidence | "hostile app text reaches the judge as evidence only, never in its instructions or criteria"; adapter: `tests/unit/evaluation-ai-sdk.test.ts` › "writes app text as a JSON string after the criteria". These prove where the text goes. The fake's verdict is scripted, so nothing here shows that hostile text cannot change a real model's verdict |
| A check's time never extends the test's or the config's | "a check's own time never lengthens what its test has left, nor the config's time" (60000 asked: given at most the test's 1500, and at most the config's 2000) |
| Timeout is an error; a check left running when its test ends is cancelled; its answer, arriving while the run goes on, is never read | "a judge that does not answer in time, and a check the test leaves behind": the test file waits until the fake has the call before its test ends, the fake holds its answer until a reporter sees the check written as `cancelled`, and the next test waits until the fake has answered, so the answer comes after the stop and before `run.finished` by construction, with no timer; the test keeps one `cancelled` record. It was run by hand several times, alone and beside other files, with no log kept. "a run stopped while a judge is answering" (exit 130, the record carries the interruption) |
| An interruption while the parent settles a test keeps its host AI checks from running and fails the test | "a run interrupted while the parent settles a test, before its host AI checks" (a reporter stops the run when the click's navigation is written during settle; the test is not passed, both host checks `not_run`, exit 130) |
| A failed check outranks an undecided one whatever order they end in; the process cannot reclassify a check or soften the outcome, and a failure it reports may lead only an undecided or broken check | "two checks at once, the undecided one answering before the failed one" (exit 1); "test processes that report their own failure after the parent recorded a failed check": an evaluation error, a `session_lost` and a `check_failed` the process forged after a failed check, in one run: each test `failed` with `evaluation_failed`, the forged class in `also`, counts 3 failed and 0 error, exit 1, every card led by "AI check failed"; "a failed value expect after an undecided required check" (`failed`, led by `check_failed`, exit 1); "a check still running when the test ends" (`failed`, led by `not_awaited`); `evaluation-contract.test.ts` › "the parent adding the AI check failures to a test" |
| Judge credential variables left out of the environment of the run's test file processes and app servers, the browser launched with them hidden, the key redacted from the start | "a judge's credential, with an app server that reads the same variable": the server's log and the test file's own output say the variable is absent, the fake launcher received it in `hiddenVariables`, a page that shows the key before any check runs is redacted, the run folder holds it nowhere |
| `doctor` and `list` withhold the variables too, and doctor's log is redacted | `tests/unit/evaluation-commands.test.ts`: doctor starts a real server that says the variable is absent, prints the key and fails; the log doctor keeps shows `{{visual.apiKey}}` and no file under `.retest` holds the key; the launch and the start name the variable hidden. `collectFiles`, which `list` calls, loads a test file that writes whether it sees the variable: absent. Without a judge both see it, so neither check passes by accident |
| Provider strings and host criteria redacted | "provider strings and host criteria that hold a value" (a model revision that echoes the key, and `run.started.options.hostEvaluations` with a secret in its criteria, context, evidence text and label) |
| An adapter that never loads cannot hold the run | "an adapter whose module never finishes loading" (top-level await that never settles; the checks fail naming the judge and the adapter, `run.finished` is written) |
| A screenshot of the default app takes its lane | "a screenshot check of the default app beside an action on it" (`concurrent_commands`, no judge asked) |
| An attempt leaves nothing listening on the run | "the run's signal after a run with AI checks" (no abort listener left) |
| Budgets reserved atomically across workers, concurrency bounded | "the call budget" › "refuses the call past the test limit before it is sent", "is shared by every file worker: exactly the run limit reaches the judge, one call at a time" (2 workers, 4 requests, 3 sent, 1 refused, never 2 at once); `evaluation-contract.test.ts` › "the call budget" |
| Credentials never in the child's environment, events, results or run folder; provider text redacted | "the judge's credential stays in this process", "a provider's words that echo the credential are redacted before anything is kept, and the run folder holds it nowhere" (every file in the run folder read); real Chrome: `tests/integration/evaluation.test.ts` |
| A missing credential fails only the check that needs it, by name | "a judge whose credential is not set" |
| Advisory checks warn, never change status, and alone do not satisfy the assertion rule | "advisory AI checks" |
| Events, `result.json`, a rebuilt result, human and agent reports and `inspect` show criteria, warnings and evaluator metadata | "each check is one parent event, and result.json, a rebuilt result and the events agree", "the human report shows each check on its card…", "the agent report shows each check under its failure", "inspect shows the check in the timeline, and its JSON holds the record", "advisory AI checks" › "are shown by both reports though every test passed" |
| Host-declared checks run without test code, cannot be satisfied by an advisory override, are not run after a body failure, are refused for bad keys, judges, apps and kinds | "AI checks a host declares" |
| Config validation: unknown keys, undeclared default judge, inline credentials refused unquoted, non-JSON options, missing `accepts` | `tests/unit/evaluation-config.test.ts` |
| Typed judge names, accepted evidence kinds, apps, modes; no judges means a type error | `tests/types/fixtures/evaluation/checks.ts`, `tests/types/fixtures/evaluation-none/checks.ts` |
| Real screenshots through a real `retest run`: the saved screenshot's SHA-256 matches the record's, its session and attempt are that attempt's, and the judge's call log names the same kind, app, width, height and byte count; the bytes the judge received are not compared with the file | `tests/integration/evaluation.test.ts` |

## The AI SDK adapter

Inspected and run, downloaded into `~/Library/Caches/retest-evaluation/inspect/` and an npm cache in the temporary folder, never into the repository; no code copied:

| Package | Version | Licence |
| --- | --- | --- |
| `ai` | 7.0.127 | Apache-2.0 |
| `@ai-sdk/anthropic` | 4.0.71 | Apache-2.0 |
| `@ai-sdk/openai` | 4.0.83 | Apache-2.0 |
| `@ai-sdk/provider` (inspected) | 4.0.21 | Apache-2.0 |
| `@ai-sdk/provider-utils` (inspected) | 5.0.53 | Apache-2.0 |

`package.json` declares the three as optional peers: `ai ^7.0.127`, `@ai-sdk/anthropic ^4.0.71`, `@ai-sdk/openai ^4.0.83`, each `optional: true`. Retest still has no dependencies, and installing the packed package installs none of them (`tests/integration/package-smoke.test.ts`).

What the adapter does: an explicit provider instance (`createAnthropic` or `createOpenAI`) with the judge's `apiKey` and an optional `baseURL`; `generateObject` with a strict JSON Schema naming only the request's criterion and evidence ids, `instructions` set to Retest's rules, one user message with the criteria first and evidence after, app text as JSON strings, screenshots as PNG image parts, `maxRetries: 0`, the request's signal, no `tools`; Anthropic's `structuredOutputMode: 'outputFormat'` and OpenAI's `strictJsonSchema: true` (the OpenAI flag is set in the code and asserted by no test). `generateObject` is deprecated in ai 7 in favour of `generateText` with `output`; it was kept because it is the call the pinned versions document for structured objects, and the record names the version. The adapter checks the object with the same reader the parent uses, then returns it with the response's model id and the token counts.

Proved:

- Its own logic against an injected `generateObject`: `tests/unit/evaluation-ai-sdk.test.ts`.
- Setup refuses unknown options, a provider it cannot make, a missing model or key, and fails by name when `ai` is not installed: same file, and through the parent with the adapter named by its package in a project without the SDK.
- From the packed package in a project outside the checkout, without the SDK: a judged check fails its setup naming `ai`, and ordinary tests run (`tests/integration/evaluation-ai-sdk.test.ts`, first test).
- From the packed package with the pinned SDK installed, against a local stand-in for each API, through `retest run` and real Chrome, for each provider: a text check passed, a screenshot check sent a PNG and failed as scripted, a server error was an evaluation error and only one request for it reached the stand-in, so nothing was retried, no request carried tools, every request asked for a JSON schema, Retest's instructions were in the system channel (Anthropic's `system`, OpenAI's instructions or system and developer items) and in no user message, no evidence text reached that channel, the request used the judge's key, the record named the stand-in's model and token counts, and no key reached the run folder or the terminal (second test). This test installs the SDK from the registry and skips as unverified when it cannot, so it proves this only on a run whose log shows it ran.

Intended models for the live gate, untested: Anthropic `claude-sonnet-5`, OpenAI `gpt-5.5-2026-04-23`. The live test in `tests/integration/evaluation-ai-sdk.test.ts` runs one text and one screenshot check against each when both variables are set, and otherwise reports itself skipped as "unverified: RETEST_EVALUATION_ANTHROPIC_KEY and RETEST_EVALUATION_OPENAI_KEY not set, so no provider was called".

## Protocol changes

`schemaVersion` stays 1. Every change adds: a new event type `evaluation.finished`, an optional `evaluations` on a test result, an optional `run.started.options.hostEvaluations`, three new failure classes, two new child messages, and the `inconclusive` test status, which existed and is now produced.

A version 1 reader refuses every run that has an AI check. Objects in the published schema are closed, so a reader that validates with the version 1 schema it shipped with, Retest's own `readRunFolder` and `inspect` included, rejects the new event type, the new keys and the new failure classes. Only a run with no AI checks and no host AI checks stays readable. This follows the repository's precedent of adding to version 1 as the schema grows. It is not the deliberate versioned protocol change the contract asks for before adding a state; that change has not been made, and an older reader gets a refusal, not a degraded read.

## What remains unverified

1. The live provider gate: no Anthropic or OpenAI model has judged anything through Retest. The intended model ids are untested, and so is how either provider treats the structured output request beyond what the stand-in proves.
2. Judgement quality: the frozen corpus of 40 labelled cases and its gates belong to Phase 4. Nothing here measures false passes, false failures or repeat agreement.
3. Frames: recorded-step evidence is declared and refused by name; there are no recordings yet.
4. Regions, crops and pixel masking: a screenshot is sent as the page shows it, secrets on screen included. The contract's separate pixel policy is not built.
5. Native targets and Firefox or WebKit captures: only Chromium screenshots were judged.
6. Rehearsal's host evaluator callback, attempt fencing across restarts and AI activity tracking are Phase 5.
7. Prompt-injection resistance of real models: the fixtures prove that hostile text travels as evidence; they cannot prove a verdict cannot change.
8. A credential function is called once per run; a key that rotates during a run is not read again.
9. A real browser's environment: the launch names the judge variables hidden and `chromium-process.ts` spawns without them, but no test here read a real Chrome process's environment. The reviewer ran the same spawn path with `/usr/bin/env` as the executable and saw the variable left out.
10. A check stopped in the moment between taking its call slot and sending: the code checks the signal before it reserves a call and before it sends, but no test lands a stop in that gap.
11. What a start command does itself: Retest leaves the variables out of the environment it gives, but a start command that sources the user's shell profile or loads a `.env` file brings them back, and Retest cannot prevent that.
12. A judge whose `adapter` is a function, inside a run: function adapters appear in the config and the `doctor` and `list` tests only; every run names a module.
13. A factory that does not return in time, apart from a module that never loads: the stuck-module test accepts either message.
14. The setup signal aborted when the run ends.
15. A function credential at run level: that it is called once, its timeout, its redaction, and that it never reaches the child or the run folder. The one run with a function credential (`tests/unit/evaluation-ai-sdk.test.ts`, the project without the SDK) asserts none of these.
16. That the text evidence a judge receives has a secret replaced: the record and the events are checked, the judge's own copy is not.
17. `test.evaluate` refusing an unknown key (`src/api/evaluate.ts`): the config and `hostEvaluations` refusals are tested, this one is not.
18. Inconclusive because the browser was gone or the screenshot failed (`src/evaluation/evidence.ts`): only "not a PNG" is run.
19. The "this run has no judges" error (`src/evaluation/judges.ts`, `run-evaluations.ts`).
20. The input limits `maxImages`, `maxImageWidth`, `maxImageHeight` and `maxInputBytes`: read in `evidence.ts`, reached by no test.
21. A check cut off because its test ran out of time while the check was in flight: the check's own timeout and a test that ends are run, that case is not.
22. "A check stopped before it is sent spends no call" (`attempt.ts`): the stop before the slot is taken is not landed by any test, as item 10 says.
23. `evaluation-1`, `evaluation-2` numbering starting again in a second attempt.
24. The value of `criteriaSha256`: only its shape, 64 hex digits, is checked.
25. Redaction of the identity's `provider` and `model`: only `modelRevision` is checked.
26. A host check cancelled while in flight.
27. The same host check id given both under the file key and under a test key (`run-evaluations.ts`).
28. The adapter's OpenAI `strictJsonSchema: true`: set in the code, asserted by no test.
29. That the adapter ignores the SDK's own environment variables such as `ANTHROPIC_API_KEY`: the adapter makes its own provider with the judge's key, and no test sets the SDK's variable to see it ignored.
