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
| Adapter subpath | `@rehearsal-labs/retest/evaluation/ai-sdk`, default export a factory; also `createAiSdkEvaluatorWith` (the factory with a package loader of the caller's own), `aiSdkEvaluator`, `requestMessage`, `AiSdkSetupError`, and the types `AiSdkPackageLoader` and `AiSdkPackageName` |
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
- `modelRevision?`, `usage?` (`inputTokens`, `outputTokens`, `totalTokens`), `samplingNotSent?` (each `setting`, one of `temperature`, `topP`, `seed`, `maxOutputTokens`, with the provider's `reason`, at most 500 characters, each setting once)
- no other key: a self-reported `confidence` makes the answer an error

The record (`EvaluationRecord`, in the event and the result): `checkId`, `source`, `mode`, `judge?`, `verdict` (`pass`, `fail`, `inconclusive`, `error`, `cancelled`, `not_run`), `criteria` with verdicts and citations, `context?`, `criteriaSha256` of the criteria and context as sent, `evidence` (`id`, `kind`, `app?`, `sessionId?`, `attemptId`, `capturedAt`, `path?`, `label?`, `sha256`, `bytes`, `width?`, `height?`), `justification?`, `reason?`, `evaluator?` (`provider`, `model`, `modelRevision?`, `evaluatorVersion`, `promptVersion`, `sampling?`, the settings the call sent, `samplingNotSent?`, the ones it did not send as given with the provider's reason, `latencyMs?`, `usage?`), `failure?`, `warning?`, `durationMs`, `location?`. Justification, reasons, criteria, context and labels pass through the run's redactor before the record exists; judge credentials are taught to the redactor when they are read.

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

The Azure provider work below adds one more optional key, `samplingNotSent` on the evaluator record. A version 1 reader that validates rejects a run whose record carries it, as above; a record carries it only when a call did not send a setting as given.

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
28. The adapter's OpenAI `strictJsonSchema: true` is asserted by the unit tests' exact `deepEqual` of the provider options. The pinned OpenAI package sends `strict: true` by default, so the stand-in's check that each schema is strict passes with or without the setting and cannot catch its removal.
29. That the adapter ignores the SDK's own environment variables is proved against the real packages for `AZURE_API_KEY`, `AZURE_RESOURCE_NAME`, `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, `OPENAI_API_KEY` and `OPENAI_BASE_URL`, in the Azure section below. A variable a later package version reads is not covered.

## The Azure provider

3 October 2026. The AI SDK adapter gains `provider: 'azure'`, so the live gate can run against an Azure AI Foundry deployment, where Rehearsal keeps its models.

### What was added

- `src/evaluation/ai-sdk.ts`. `provider: 'azure'` makes its provider with `createAzure` from `@ai-sdk/azure`. The adapter gives it the judge's `apiKey`, exactly one of `resourceName` and `baseURL`, and `apiVersion` when the judge names one. `model` is the deployment's name, which the provider calls through OpenAI's Responses model. Its provider options are `{ azure: { strictJsonSchema: true, store: false } }`. The request is the OpenAI path's: one `generateObject` call, `maxRetries: 0`, no tools, the request's signal and output bound.
- Setup refuses, by name and before loading any package: both or neither of `resourceName` and `baseURL`; a `resourceName` that is not one DNS label, as the provider itself requires; an `apiVersion` with anything but letters, digits, dots and hyphens; `resourceName` or `apiVersion` on another provider; a missing model or key. A missing `@ai-sdk/azure` fails the setup by name, as a missing `ai` does.
- `createAiSdkEvaluatorWith(setup, load)` is a new export of the subpath: the factory with a package loader of the caller's own. The default export passes `import`. The unit tests use it, and the guide names it as the loader hook for a host that bundles the SDK.
- A change to the other two providers, found while reading the SDK. Given no `baseURL`, `@ai-sdk/anthropic` 4.0.71 reads `ANTHROPIC_BASE_URL` and `@ai-sdk/openai` 4.0.83 reads `OPENAI_BASE_URL`, then sends the key wherever that names. The guide already said the adapter uses no variable of the SDK's own; that was false for the endpoint. The adapter now gives both an endpoint when the judge names none: `https://api.anthropic.com/v1` or `https://api.openai.com/v1`, the packages' own defaults. A project that relied on those variables to move the judge now names `baseURL`.
- Retest asks OpenAI and Azure not to keep the request. Their Responses API stores a request unless it is sent `store: false`, and the request holds the evidence, a screenshot of the app included. The adapter now sends `store: false` in the provider options, `{ openai: { strictJsonSchema: true, store: false } }` and `{ azure: { strictJsonSchema: true, store: false } }`, which the pinned OpenAI Responses model writes into the request body as `store`. Anthropic's API has no such setting, so nothing is sent for it and nothing is claimed about what Anthropic keeps.
- `package.json`: `@ai-sdk/azure` `^4.0.90` as an optional peer, beside the other three.

### The pin

`@ai-sdk/azure` 4.0.90 was published with `ai` 7.0.127 and depends on exactly the pinned `@ai-sdk/openai` 4.0.83, `@ai-sdk/provider` 4.0.21 and `@ai-sdk/provider-utils` 5.0.53, so the four packages share one copy of each. 4.0.87 and 4.0.89 have the same dependencies; 4.0.86 and earlier depend on older OpenAI and provider releases. Found with `npm view @ai-sdk/azure versions --json`, `npm view @ai-sdk/azure dist-tags --json` and `npm view @ai-sdk/azure@<version> dependencies`, with nothing installed into the repository.

Inspected, downloaded into `~/Library/Caches/retest-evaluation/inspect/` and an npm cache in the temporary folder, never into the repository; no code copied:

| Package | Version | Licence |
| --- | --- | --- |
| `@ai-sdk/azure` | 4.0.90 | Apache-2.0 |
| `@ai-sdk/deepseek`, a dependency of `@ai-sdk/azure` that the adapter never calls | 3.0.58 | Apache-2.0 |

### The SDK's own variables

The built `@ai-sdk/azure` 4.0.90 reads two variables. `AZURE_API_KEY` is read through `loadApiKey` when the provider has no `apiKey`. `AZURE_RESOURCE_NAME` is read through `loadSetting` when it has neither `resourceName` nor `baseURL`. Both helpers in `@ai-sdk/provider-utils` 5.0.53 return a given string without looking at the environment. OpenAI's model classes, which the Azure provider reuses, read none. The adapter always gives the key and one of the two endpoint settings, so neither variable is read.

### What the tests prove

- Unit, `tests/unit/evaluation-ai-sdk.test.ts`, "the adapter's factory for Azure", against stand-ins for `ai` and the provider packages handed to `createAiSdkEvaluatorWith`. The factory loads `ai` and `@ai-sdk/azure`. `createAzure` receives exactly `{ apiKey, resourceName }`, or `{ apiKey, baseURL, apiVersion }`, or `{ apiKey, resourceName, apiVersion }`. The provider is asked for the deployment and the call carries that model, `{ azure: { strictJsonSchema: true } }`, `maxRetries` 0, Retest's instructions, and no `tools` or `toolChoice`. The key is in no part of the call. Each refusal above matches its whole message and loads no package. With `AZURE_API_KEY`, `AZURE_RESOURCE_NAME`, `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `ANTHROPIC_API_KEY` and `ANTHROPIC_BASE_URL` set to other values in the test's environment, every provider still receives exactly the judge's settings, an endpoint included for OpenAI and Anthropic, and OpenAI's call carries `strictJsonSchema: true` and `store: false`.
- Unit, the same file, "what the adapter asks a provider to keep". Two calls each through an OpenAI, an Azure and an Anthropic judge: every OpenAI and Azure call carries `store: false` under its own provider name, and no Anthropic call carries a `store` setting.
- Unit, the same file, "an Azure judge through the parent". A project's adapter module hands the factory the stand-ins; the credential is `env('RETEST_UNIT_AZURE_KEY')`; the stand-in provider echoes the key in its words and in its model id. `createAzure` received the judge's key, resource and version, not the variables' values. Each record names `azure` and the deployment, and shows the echoed key as `{{azure.apiKey}}`, as does the human report. The key is in no event, `result.json`, report, test output or run folder file.
- Integration, `tests/integration/evaluation-ai-sdk.test.ts`, "through a proxy, Azure, and Anthropic and OpenAI given no baseURL...". The packed package, with the pinned `ai` and all three providers installed from the registry into a project in the temporary folder, runs through `retest run`. Four judges each answer one text check: Azure by `resourceName: 'retest-resource'`; Azure by `baseURL: 'https://retest-endpoint.openai.azure.com/openai'` with `apiVersion: 'preview'`; Anthropic and OpenAI with no `baseURL`. The run reaches the stand-in as its HTTPS proxy (`NODE_OPTIONS=--use-env-proxy`, `HTTPS_PROXY`) and trusts a certificate for `*.openai.azure.com`, `api.anthropic.com` and `api.openai.com` that openssl makes for the run (`NODE_EXTRA_CA_CERTS`). The stand-in ends each tunnel's TLS, so each request arrives as the SDK addressed it. A Node without that flag refuses to start, so no request can leave the machine. The run's environment also holds `AZURE_API_KEY`, `AZURE_RESOURCE_NAME`, `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, `OPENAI_API_KEY` and `OPENAI_BASE_URL` with other values.
- That test asserts: exactly four tunnels, to `api.anthropic.com:443`, `api.openai.com:443`, `retest-resource.openai.azure.com:443` and `retest-endpoint.openai.azure.com:443`; one request each; Azure's `POST /openai/v1/responses?api-version=v1` and `?api-version=preview` with the deployment as the body's `model`, `store: false`, and `text.format` of type `json_schema`, strict, named `retest_verdict`, holding Retest's two answer fields; Anthropic's `POST /v1/messages` with no `store`; OpenAI's `POST /v1/responses` with `store: false` and a strict schema; no tools; Retest's instructions in the system channel and in no user message, and no evidence there; each key in its provider's own header (`api-key`, `x-api-key`, `authorization`) and in no other header, the address or the body; no other judge's key and no value of the SDK's variables in any request; each record naming the provider, the model, the stand-in's model and its token counts; no key in any run folder file, stdout or stderr.
- That test catches the fallback it guards against. With the adapter changed to leave out the resource name, the real SDK sent the request to `decoy-resource.openai.azure.com:443`, the value of `AZURE_RESOURCE_NAME`, and the test failed. With the key left out, the request carried the value of `AZURE_API_KEY`, and the test failed. Both requests went to the stand-in. The source was restored and `dist/` rebuilt.
- The existing OpenAI stand-in test now also asserts that each OpenAI request's schema is strict. The pinned OpenAI package sends `strict: true` by default, so that check passes with or without the adapter's `strictJsonSchema: true`; only the unit test's exact `deepEqual` of the provider options catches its removal, as item 28 now says. The same test asserts that each OpenAI request body carries `store: false`, and that no Anthropic request body has a `store` key.
- Those assertions read the real SDK's request. With `store: false` taken out of the adapter, both stand-in tests failed: the OpenAI bodies had no `store`, nor did the Azure ones.

### After the review

Each fix has a test that failed with the fix taken out and passes with it, in `tests/unit/evaluation-ai-sdk.test.ts` unless named otherwise.

- The record says what a call sent. The pinned OpenAI package, which Azure reuses, drops `temperature` and `topP` for a model it takes to be a reasoning model, judging by the model id or the deployment's name. Anthropic drops them for some models, caps `temperature` at 1, and lowers an output bound above the model's own. Each says so in a `{ type: 'unsupported', feature, details }` warning on the `generateObject` result, which the adapter used to discard. It now reads the warnings and names each setting the call was given that a warning names, with the details as the reason, in the answer's `samplingNotSent`. The parent leaves those settings out of the record's `sampling` and keeps them in `samplingNotSent`, redacted. This needed one optional field through four files outside the adapter: `JudgeAnswer` in `src/evaluation/contract.ts`, the answer reader in `src/evaluation/answer.ts` (each setting once, a reason of 1 to 500 characters), the record built in `src/evaluation/attempt.ts`, and `EvaluatorRecord` with its schema in `src/protocol/evaluation.ts`. Tests: "names each setting a provider warning says was not sent as given", "gives a reason when the warning has no details", "the parent refuses an answer that names an unsent setting twice or with no reason", and, through the parent, "records under sampling only what the call sent", where the record reads `{ topP: 0.5, maxOutputTokens: 1000 }` with `temperature` in `samplingNotSent` and the echoed key redacted. Ignoring the warnings failed 3 tests; keeping the dropped setting in `attempt.ts` failed 1; leaving out the answer check failed 1.
- `seed` is refused. All three pinned packages drop a seed with a warning, so it would only ever be written down. "refuses a seed, which none of the pinned providers sends", for each provider; accepting it failed the test.
- `apiVersion` is refused where the SDK sends none: a base URL whose path ends in `/openai/v1`, a Foundry project address (`.services.ai.azure.com` with a path under `/api/projects/`), or a host outside `openai.azure.com`, `services.ai.azure.com` and `cognitiveservices.azure.com`, as `@ai-sdk/azure` 4.0.90 decides. The message says the SDK sends no api-version there. "refuses an apiVersion with an Azure baseURL the SDK sends none to", each shape refused and taken without `apiVersion`, and the version still taken with a resource name or an `.openai.azure.com` or `.cognitiveservices.azure.com` base URL. Accepting every shape failed the test.
- The refusal no longer suggests a dated `apiVersion`. Microsoft's page on the v1 API, updated 5 June 2026, says it "removes the need for dated `api-version` parameters" and that "`api-version` is no longer a required parameter with the v1 GA API", and lists no accepted values. The message now names only the characters taken.
- `baseURL` over plain http is refused unless the host is `localhost`, `127.0.0.0/8` or `::1`, for all three providers. "refuses a plain http baseURL off this machine for every provider, and takes one to this machine"; taking http anywhere failed the test. The Phase 1 refusal of a value that is not an http or https URL keeps its message.
- `AiSdkPackageLoader` takes `AiSdkPackageName`, the union of `ai` and the three provider packages, so a host's loader typed to those names fits. The doc example returns a promise. `tests/types/fixtures/ai-sdk-loader.ts` shows a narrow loader and a loader over a record typecheck, and a loader for only two of the packages is refused (TS2345); with the loader typed to any string, three unexpected errors failed the type tests.
- A missing package is named from Node's `ERR_MODULE_NOT_FOUND` message. A package the provider's package imports, such as `zod` or `@ai-sdk/deepseek` beside `@ai-sdk/azure`, is named as that package; a missing file inside a package says to reinstall it; a message with no name is quoted. "is named from what Node could not find..."; naming the asked package every time failed the test.
- Anthropic and OpenAI with no `baseURL` are proved against the real packages, in the integration test above. With the default endpoints taken out of the adapter, the real packages addressed `decoy-anthropic.example` and `decoy-openai.example`, the values of `ANTHROPIC_BASE_URL` and `OPENAI_BASE_URL`; the stand-in refused both at TLS and the test failed.

### The live gate

"live provider gate: one text and one screenshot check against an Azure deployment" runs when `RETEST_EVALUATION_AZURE_KEY`, one of `RETEST_EVALUATION_AZURE_RESOURCE` and `RETEST_EVALUATION_AZURE_BASE_URL`, and `RETEST_EVALUATION_AZURE_DEPLOYMENT` are set. `RETEST_EVALUATION_AZURE_API_VERSION` is optional. With both endpoint variables set it uses the base URL, which the SDK also prefers. It asks one judge about a text and a screenshot, and asserts that both pass, that each record names `azure`, the deployment and the model that answered, and that the key is in no run folder file, stdout or stderr. Otherwise it skips, naming what is missing. Here it skipped with:

```text
unverified: RETEST_EVALUATION_AZURE_KEY; RETEST_EVALUATION_AZURE_RESOURCE or RETEST_EVALUATION_AZURE_BASE_URL; RETEST_EVALUATION_AZURE_DEPLOYMENT not set, so no Azure deployment was called
```

To run it, from the Retest root, with the key typed into the shell for one run and kept out of every file and the shell history:

```sh
read -rs RETEST_EVALUATION_AZURE_KEY && export RETEST_EVALUATION_AZURE_KEY
export RETEST_EVALUATION_AZURE_RESOURCE=<resource name>
export RETEST_EVALUATION_AZURE_DEPLOYMENT=<deployment name>
lockf -t 0 /tmp/retest-heavy-gate.lock node --conditions=retest-source --test --test-name-pattern=Azure tests/integration/evaluation-ai-sdk.test.ts
```

`RETEST_EVALUATION_AZURE_BASE_URL` can stand in for the resource name, and `RETEST_EVALUATION_AZURE_API_VERSION` adds a version. The file builds and packs Retest, so it runs under the heavy-gate lock.

### Commands and results

From the Retest root, with Node 24.12.0, Google Chrome and OpenSSL 3.6.5:

| Command | Result |
| --- | --- |
| `node --conditions=retest-source --test tests/unit/evaluation-ai-sdk.test.ts` | 17 passed, 0 failed |
| `npm run test:unit` | 2103 passed, 0 failed |
| `npm run test:types` | 196 expected errors matched 196 markers in 9 projects, on TypeScript 6.0.3 and 7.0.2 |
| `lockf -t 0 /tmp/retest-heavy-gate.lock npm run typecheck` | exit 0. A second run, while another lane's Electron target work was half done, exited 2 with seven errors in `src/cli/doctor/checks.ts` and `src/runner/fingerprint.ts`; a third, once that tree compiled, exit 0 |
| `lockf -t 0 /tmp/retest-heavy-gate.lock node --conditions=retest-source --test tests/integration/evaluation-ai-sdk.test.ts` | 3 passed, 2 skipped as unverified: the Anthropic and OpenAI live gate and the Azure live gate |
| `lockf -t 0 /tmp/retest-heavy-gate.lock npm run test:integration`, first run | 364 passed, 2 skipped as unverified, 3 failed and 25 cancelled, all in the six files that build and pack Retest. Each stopped at `npm run build` on type errors in `src/cli/doctor/checks.ts`, `src/runner/fingerprint.ts` and `src/runner/target-drivers.ts`, from another lane's uncommitted Electron target work in `src/config` |
| `lockf -t 0 /tmp/retest-heavy-gate.lock npm run test:integration`, second run | 384 passed, 0 failed, 2 skipped as unverified, 17 cancelled, exit 1. `consumer-loading` and `evaluation-ai-sdk` passed, the Azure stand-in test among them. `m2-package`, `m3-host-run`, `m3-package` and `package-smoke` stopped at `npm run build` on type errors in `src/native/webdriver-client.ts`, a third lane's file in progress |
| `lockf -t 0 /tmp/retest-heavy-gate.lock node --conditions=retest-source --test tests/integration/package-smoke.test.ts`, once the tree compiled | 6 passed, the exact peer list with `@ai-sdk/azure` among them |
| `node --conditions=retest-source --test tests/unit/evaluation-ai-sdk.test.ts`, after `store: false` | 20 passed, 0 failed |
| `npm run test:types`, after `store: false` | 204 expected errors matched 204 markers in 10 projects, on TypeScript 6.0.3 and 7.0.2; the new markers are another lane's |
| `lockf -t 0 /tmp/retest-heavy-gate.lock node --conditions=retest-source --test tests/integration/evaluation-ai-sdk.test.ts`, after `store: false` | 3 passed, 2 skipped as unverified: the two live gates |
| `lockf -t 0 /tmp/retest-heavy-gate.lock npm run typecheck`, after `store: false` | exit 0, once a type in the new unit test was narrowed; the run before it exited 2 on that one line |
| `node --conditions=retest-source --test tests/unit/evaluation-ai-sdk.test.ts`, after the review | 28 passed, 0 failed |
| `npm run test:types`, after the review | 208 expected errors matched 208 markers in 10 projects, on TypeScript 6.0.3 and 7.0.2, the new loader fixture among them |
| `lockf -t 0 /tmp/retest-heavy-gate.lock npm run typecheck`, after the review | exit 0 |
| `lockf -t 0 /tmp/retest-heavy-gate.lock node --conditions=retest-source --test tests/integration/evaluation-ai-sdk.test.ts`, after the review | 3 passed, 2 skipped as unverified: the two live gates |
| `npm run test:unit`, after the review, since four shared evaluation files changed | 2229 passed, 0 failed |

Four changes to the adapter were each run against the unit file, and each failed it: no endpoint given to the provider, Azure's options under `openai`, both endpoint settings accepted, no default endpoint for OpenAI and Anthropic. The two changes described above failed the Azure integration test. Taking `store: false` out of the OpenAI path, and out of the Azure path, each failed the unit file.

### The live run

One run of the live gate called a real deployment. The orchestrator ran it, not this record's lane: Rehearsal's Azure AI Foundry deployment `gpt-6-astra`, addressed by a base URL on `<name>.services.ai.azure.com/openai/v1` with no API version, the key exported into a subshell for that run only. As the Azure provider row of [progress.md](../progress.md) reports it, and as its log `/tmp/retest-azure-live-gate-2.log` (4 October 2026, 01:21) shows, `tests/integration/evaluation-ai-sdk.test.ts` ended 4 passed and 1 skipped: "live provider gate: one text and one screenshot check against an Azure deployment" passed, and the Anthropic and OpenAI live gate was skipped as unverified, with neither of its keys set. The log was never kept in the repository; it lives in a temporary folder and may be gone. The run predates commit `9b38691` and the fix below that keeps unsent settings on an error record. It has not been run again: no key was available to the fix round, and no key may be read from any file.

### After the Phase 2 review

When the provider answered but its answer could not be read, the adapter threw a plain error and the record's `sampling` claimed every setting as sent, though the provider's warnings had said one was dropped. The adapter now reads the warnings before it checks the answer and throws `AiSdkAnswerError` with `samplingNotSent`; the parent's error record leaves those settings out of `sampling` and names them beside it, as it does for an answer. An evaluator of another kind can give its error the same list; one that breaks the answer's rules for it names nothing.

| Command | Result |
| --- | --- |
| `node --conditions=retest-source --test tests/unit/evaluation-ai-sdk.test.ts` | 31 passed, 0 failed (`/tmp/retest-lane-c-t12-on.log`) |
| the same with the fix taken out of the adapter and the parent | 29 passed, 2 failed: the adapter's error named nothing, and the parent's error record kept `temperature` under `sampling` (`/tmp/retest-lane-c-t12-off.log`) |

### What remains unverified

1. A live Azure run on the current tree. The one live run, [above](#the-live-run), predates commit `9b38691` and the error-record fix; it showed one deployment giving a valid answer to the request Retest sends, a strict JSON schema on the Responses API with a PNG input, with no API version. Whether that deployment kept the output bound of 1000 tokens was not asserted. An API version given explicitly, and any other deployment, are unverified.
2. A Foundry project endpoint, `https://<name>.services.ai.azure.com/api/projects/...`, which the SDK addresses differently, and endpoints under `.cognitiveservices.azure.com`. The stand-in used `.openai.azure.com` addresses only; the live run used a `.services.ai.azure.com/openai/v1` base URL.
3. A gateway that is not an Azure host. A `baseURL` that already ends in `/openai/v1`, which the SDK uses as given and without `api-version`, was used once, by the live run.
4. A screenshot through the Azure path against the stand-in. Its checks were text; the live gate sends a screenshot.
5. What OpenAI or Azure keep after `store: false`. The stand-ins show the setting reaches the request body; nothing here can see what a provider retains.
6. On a check that ends in an error before the provider answers, such as a refused request or a timeout, no warnings exist, so that record's `sampling` is what the evaluator was given. An answer that came but could not be read now keeps its warnings, [above](#after-the-phase-2-review).
7. Which settings a real provider drops for a given model. The warnings were stood in for; the rules come from reading the pinned packages.
8. Deployment-based addresses, Microsoft Entra tokens and the chat completions route. The adapter offers none of them.
9. The Anthropic and OpenAI default endpoints against the providers themselves. The proxy test shows the requests are addressed to `api.anthropic.com` and `api.openai.com`; the stand-in answered them.


## Recorded frames, diagnostics context and the corpus review

This section records the frames-evaluation work for release 0.1.0 against media protocol 2. Earlier sections remain intact. The frame settlement rule here supersedes the earlier rule that all judge failures stand over missing frames.

### Evidence and parent decisions

`test.evaluate` and host checks accept recording evidence by the latest named step or by `lastMs`, and explicitly selected console/network diagnostics. `src/evaluation/frames.ts` asks the attempt's media recording for bounded frames on the run clock. It verifies the interval, frame order, unique ids, sizes, format signatures, byte lengths and complete accounting of returned and omitted frames. Each image sent is saved and hashed. The record keeps capture times, identity, fates, losses, omissions, stretches and evidence status with its reason.

Only frames marked `shown` or `superseded` reach a judge. Pending and unprocessed frames are named in `framesNotSent` and represented as intervals without a picture. Undecodable and out-of-range frames are counted as missing by the media process. A sequence with no usable frame remains inconclusive without calling a judge. No recording or withheld pixels is a refusal; a failed recording, unavailable frame store or late frame reply cannot produce a pass.

A sequence with known losses, omissions, capture gaps, unlisted stretches, unplaced frames, unstored tail or a media warning is partial. Queries request `minGapUs: 1`, because the media default can omit a short capture gap. Quiet stretches with no reported loss remain listed and do not alone make evidence partial. Complete here describes what the media store supplied, not continuous observation of every paint.

Every criterion is sent marked as written. Over missing frames, the parent applies this table in `settle`, shared with the corpus runner:

| Criterion | Judge answer | Parent criterion verdict |
| --- | --- | --- |
| Something must appear | pass | inconclusive |
| Something must appear | fail | inconclusive, missing frames may have shown it |
| Something must never appear | pass | inconclusive |
| Something must never appear | fail | fail only with a specific frame citation actually sent; otherwise inconclusive |

Complete samples still cannot prove absence. A sequence citation alone cannot support an absence failure. Records preserve `judgeVerdict`, citations and the parent's rule. The frame prompt version is `retest-judge-1+frames-2`, with `+diagnostics-1` when selected. Parent failures continue to lead over inconclusive results, then errors; a test process's claimed outcome cannot replace the parent's records.

`src/evaluation/diagnostics-evidence.ts` selects only the requested parts, bounds their newest records, keeps capture states and omissions, redacts their text again, and saves the exact JSON sent. A foreign test, attempt, app or session is refused before persistence. Callback credentials are resolved before freezing evidence, so their values are known to the redactor before text or diagnostics are sent or saved.

`src/evaluation/evidence.ts` asks the run's pixel policy before an evaluation screenshot and again for its capture span before saving or sending. A refusal sends no judge call, spends no call budget and saves no image. This applies to browser and native screenshot branches; the new failing-first tests use a valid Chromium fixture PNG and exercise refusals before capture and during capture. Native branch checks have not been exercised against a real native target in this review. The current runner constructs this policy only for recording runs or explicit pixel rules. Default non-recording runs can therefore supply no policy; secret screenshot protection for that path is not established by this fix and needs runner wiring, as the lane report records.

### Protocol and reports

Run folders retain `schemaVersion: 1`. The evaluation schemas include recording and diagnostics selectors, absence criteria, frames and diagnostics records, optional frame fate and `framesNotSent`, optional `judgeVerdict`, and `frames_incomplete`. Current records are parsed in the tests. These additions do not match the earlier closed schemas; an old installed reader was not exercised here. Human and agent descriptions name the evidence status and the rule that set a judge answer aside.

### Corpus and provenance

The corpus has 45 cases: 14 text, 20 screenshot and 11 frame sequences. Labels are 14 pass, 20 fail and 11 inconclusive; 31 are critical and 33 are unambiguous conclusive cases. All 45 labels remain `awaiting-founder`. `frames-flash-absence` was provisionally corrected to fail because the saved frame shows the forbidden red banner. Other doubts are listed in the lane report, especially the temporal wording of wrong-toast and failed-save frame cases and the treatment of saving-state snapshots.

Browser captures were made by the predecessor with:

```sh
lockf -t 0 /tmp/retest-heavy-gate.lock env RETEST_FIREFOX_ROUTE=launch-services node --conditions=retest-source fixtures/evaluation-corpus/capture/capture-browsers.ts
```

`fixtures/evaluation-corpus/captures/capture-browsers.json` records Chrome 154.0.8037.93, Firefox 133.0.3 and WebKit 626.1.6+, build 2359, on darwin-arm64 with Node v24.12.0. Those captures were retained, not rebuilt during this review. `captures/native/sources.json` records the original TaskPhone and TaskDesk proof paths and hashes; the unit gate checks their hashes. The native cases use healthy captures with differing requirements, not app-side controlled defects. Every frame case uses one of five Chromium scenes. No native frame sequence is present.

The corpus uses frozen captures through a frame-store stand-in and the production gathering, instructions, answer validation and settlement code. Its runner deliberately applies no run call budget; it executes cases sequentially. The scorer requires one result for every declared case/repeat pair, rejecting unknown, missing, duplicate or invalid results before computing the denominator. The known-critical gate allows no pass; the unambiguous conclusive gate requires at least 90% correct judgments and counts inconclusive/error judgments as incorrect.

The four offline judges test this arithmetic. The perfect fake uses a fixed script by case id, separate from the labels being scored. Altering a label no longer alters its answer. It does not interpret images or text and establishes no judge quality. Always-pass, flip and error exercise gate failure, repeat disagreement and provider failure.

### Chrome reproduction

The original newest-pending-frame premise failed after a pixel suspension. `/tmp/retest-frames-chrome-trace.log` shows Chrome delivered later paints, but each frame's earliest possible capture time remained screencast start. The capture sender correctly treated those windows as overlapping the withheld stretch. There were 13 delivered frames, eight sent and five withheld, including three delivered after resume. The last-1500-ms query returned zero frames with a stored timestamp before its interval. This finding concerns `ChromiumFrameSource.#frame` in `src/browser/capture.ts` and `FrameSender.#withholds` in `src/media/capture.ts`; neither was edited.

The pending-frame assertion now runs before suspension. The teardown first stops capture, finishes and releases the recording, then closes media, before removing files or closing Chrome. The traced reproduction has no teardown error. The completed real-Chrome gate remains pending behind the shared lock. The harness supplies recordings and step spans directly to `AttemptEvaluations`; it exercises the real screencast and media process, but is not a full CLI recorded-step evaluation.

### Verification still pending

The targeted failing-first and passing regression logs are listed in the [lane report](../codex/phase-4/frames-evaluation-report.md). The final batch has not started: the shared heavy-gate lock is held by another lane. The queued command is `node /tmp/retest-frames-locked-gate.mjs /tmp/retest-frames-final-gates.log node /tmp/retest-frames-final-gates.mjs`. It checks for benchmarks before acquiring the lock and before each gate. The completed gate records will be in `/tmp/retest-frames-final-gates-result.json`; final results are not inferred from earlier checks.

The named Anthropic, OpenAI and Azure live gates skipped without keys, exit 0 with three skips, in `/tmp/retest-frames-live-skips.log`. No live judge call was made. Default secret screenshot protection, founder approval of the labels, native defect/frame evidence, full CLI recorded-step checks, diagnostics runner wiring, current SDK frame transport against installed provider packages, and an older installed reader remain unverified.


## Explicit criterion kinds

The founder settled the disputed corpus requirements by adding `state`, `seen` and `never`. This section describes the current behavior for explicit kinds and supersedes the older frame settlement and provisional label counts above. The older `absence: true` marker retains its conservative sampled-frame behavior.

```ts
await test.evaluate({
  requirement: {
    saved: { kind: 'state', requirement: 'The message shows the saved title exactly.' },
    toast: { kind: 'seen', requirement: 'A saved notification appears.' },
    calm: { kind: 'never', requirement: 'No error banner appears during the save.' },
  },
  evidence: { recording: { step: 'save' } },
})
```

A state judges the interval's end, the last frame the capture holds. A seen claim needs a witnessed appearance and never fails. A never claim fails on a seen violation and can pass only when the interval's capture is complete. The kind is carried in the API, protocol schema, judge request, criterion record and criteria hash. The frame instructions are `retest-judge-1+frames-3`, with `+diagnostics-1` when diagnostics are selected. They name each kind in plain words; the parent settles from the declared kind, capture status and citations, never the judge's explanation.

| Kind | Complete capture | Partial capture | No usable frames |
| --- | --- | --- | --- |
| `state` | Last frame held; pass, fail or inconclusive | Pass and fail become inconclusive | Inconclusive, no judge call |
| `seen` | Pass with a seen-frame citation; otherwise inconclusive, never fail | Inconclusive, including a witnessed pass | Inconclusive, no judge call |
| `never` | Fail with a seen-frame citation; pass only on complete capture; otherwise inconclusive | Fail with a seen-frame citation; otherwise inconclusive | Inconclusive, no judge call |

Complete means no known capture gap or missing frame in the interval. It does not establish that every screen instant was observed. No stretch without a frame proves a fleeting event absent. The existing missing-frame restrictions remain: every partial-capture pass is inconclusive, and a witnessed forbidden appearance can still fail. Both the parent record and the original judge verdict and citations are retained when a rule sets the answer aside. New rule names are `seen_over_frames` and `never_over_frames`; `frames_incomplete` and the older `absence_over_frames` remain.

Run folders retain schema version 1. The fields and rule values are additive, and the updated reader accepts earlier criterion records. By the strict-key schema contract, an earlier reader is expected to refuse a criterion's new `kind` field or new rule value. An older installed reader was not exercised here. Conflicting kind and absence markers are refused in the public API and protocol schemas.

Every corpus requirement now declares its kind. `frames-toast-wrong` and `frames-injection` change from fail to inconclusive, and `frames-spinner-early` remains inconclusive, all under the seen rule. The founder chose those strict labels. `shot-chrome-saving` is an explicit state snapshot and an unambiguous failure. The captured files and requirement wording are unchanged. The four settled labels are reviewed; 41 await review. The corpus has 45 cases, 14 pass, 18 fail and 13 inconclusive, with 31 critical and 32 unambiguous conclusive cases. The scorer reports each kind separately without changing the full-matrix requirement or the 90% threshold.

The complete evaluation units, including protocol and mixed-kind regressions, passed 295/295 with zero skips, `/tmp/retest-criterion-kinds-unit-stable.log`. The offline corpus integration passed 7/7, `/tmp/retest-criterion-kinds-corpus-final.log`. Each CLI matrix retains 135 judgments under `/tmp/retest-criterion-kinds-corpus/<judge>/`. Perfect exits 0 with 135 correct, no false passes or failures, and the conclusive gate 96/96. Always-pass, flip and error each exit 1. The perfect fake uses a fixed script independent of labels, with specific frame citations; none of the fakes reads pixels. This proves lifecycle and scoring, not model quality or injection resistance.

Exact commands, gate results and process records are written as work finishes in [criterion-kinds-report.md](../codex/phase-4/criterion-kinds-report.md). Chrome integration and the corrected two-compiler public type gate could not start because another builder's failed native run retained the shared lock. The first completed type attempt failed on schema/type mismatches; the exclusive-type correction is covered by runtime units but has no compiler result. The waiting queue was stopped without a test running. Whole-tree source typecheck was not run in this lane. Native frame checks, new Firefox or WebKit behavior, real model accuracy and live provider transport have not been verified by this change. No benchmark or download is part of this proof.

Final process audit `/tmp/retest-criterion-kinds-process-audit.json` checked 33 recorded identity entries and found none still owned and running. No command remains queued from this lane. The foreign native lock holder was never signalled. The final source unit run is 295/295 with zero skips; corrected type and Chrome verification remain unverified for the reason above.
