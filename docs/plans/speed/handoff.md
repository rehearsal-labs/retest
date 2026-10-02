# Handoff: speed, workers and Playwright compatibility

2 October 2026. Written for the session that continues this work. It says what commit `09af8f2` holds, how to check it, what was decided and why, what is not built, and what cost time. Every number and every decision in full is in [plan.md](plan.md) beside this file. The months ahead are in [docs/roadmap.md](../../roadmap.md).

## State

- Branch `main`. The work is commit `09af8f2`; this handoff and the roadmap are the commit after it. Both are ahead of `origin/main` and neither is pushed.
- `package.json` is still `private: true` at version 0.0.0. Nothing is released and no tag exists.
- One file is untracked and was left alone: `pnpm-lock.yaml`. It is not from this work, and the repository uses npm and `package-lock.json`. Ask before committing or deleting it.
- The commit also holds the milestone 3 post-review changes that a parallel session had left uncommitted in the same working tree: titles, page facts, host checks, redaction, stop reasons and the Chromium process. This work was built and verified on top of them, eight files hold both, and the commit message says so. `docs/implementation-handoff.md` and `docs/plans/milestone-3/` are that session's record.

## Check it

Node.js 24.12 or later, Google Chrome where macOS installs it or `RETEST_TEST_BROWSER`, and for the integration suite a second browser build, Chrome for Testing, at `~/Library/Caches/ms-playwright/chromium-1243/…` or `RETEST_TEST_SECOND_BROWSER`.

```sh
npm run typecheck          # TypeScript 6 and 7, and the examples project: clean
npm run test:unit          # 1639 pass
npm run test:integration   # 314 pass, about 5 minutes, real Chrome
npm run bench -- --sizes 1,20 --runs 3     # about 6 minutes, needs the network once to install Playwright
```

These are the results on commit `09af8f2`, macOS arm64, Chrome 154, Node 24.12. The Linux container gates in `docker/linux/run.sh` were not run on this commit.

## What was built

| Area | What | Where |
| --- | --- | --- |
| Benchmark harness | `npm run bench`. Packs Retest, installs it and Playwright into projects outside the repository, runs generated tests on two fixtures, writes per-phase medians as JSON and Markdown, with the commit and whether dist was rebuilt | `benchmarks/`, `benchmarks/README.md` |
| App-dominated fixture | A search page with a 150 ms API and a 300 ms debounce | `fixtures/search-app/` |
| Change-driven looks, S4 | A script in Retest's world tells the parent through a binding when the document changes. `observe` takes `after: { changes, waitMs }` and answers on the next change. The assertion loop keeps its delays as the ceiling and 50 ms as the floor | `src/browser/page-scripts.ts` `changeScript`, `src/browser/page.ts`, `src/assertions/poll-locator.ts`, `src/protocol/commands.ts` |
| Launch at schedule time, S2 | Browsers start once the schedule is known, for the targets scheduled tests use | `src/runner/run-session.ts` `#warmBrowsers`, `src/runner/browser-pool.ts` `warm` |
| Short close, S3 | `Browser.close` is sent and not waited for; the process group is ended at once | `src/browser/browser.ts` `#close` |
| Compile cache, S6 | Each entry is a bootstrap that turns the cache on, then loads the program | `src/cli/main.ts` and `program.ts`, `src/runner/child.ts` and `child-program.ts` |
| Workers, S8 | `--workers`, `RunOptions.workers`. Setup visits run first in sequence, test visits run on workers, one process per file | `src/runner/workers.ts`, `src/runner/schedule.ts` `phasesOf`, `src/runner/run-session.ts` |
| Browser pool | `--browsers`, `RunOptions.browsers`. Each worker keeps to one of a target's browsers; a target's count follows its share of the run's tests | `src/runner/browser-pool.ts` `spread`, `src/runner/run-session.ts` `#spreadBrowsers` |
| Playwright compatibility, first slice | `retest run --playwright`. The `/playwright` subpath, a resolve hook for `@playwright/test` and for imports without an extension, `.spec` discovery, and an `unsupported` failure naming each member Retest lacks | `src/playwright/`, `src/runner/playwright-resolve.ts`, `src/cli/test-files.ts` |
| Shared test helper | The test browser's path, used by the integration harness and the benchmark | `tests/support/test-browser.ts` |
| Docs | The plan, the guide's sections on workers, browsers and Playwright files | `docs/plans/speed/plan.md`, `docs/guide.md` |

## Numbers

Apple M4 Max, 14 cores, Chrome 154, Playwright 1.63.0, medians of three unless said. The plan has every table.

| | Before this work | Now | Playwright |
| --- | --- | --- | --- |
| One cold test, task app | 1276 ms | 663 ms | 1478 ms |
| Startup | 529 ms | 365 ms | 375 ms |
| Teardown | 457 ms | 26 ms | 823 ms |
| 20 tests, search app, one file | 22.7 s | 12.2 s | 19.7 s |
| 200 tests in 10 files | 48.7 s | 18.7 to 19.9 s | 19.1 to 20.1 s |
| Playwright's own spec files, one cold test | did not run | 652 ms | 1478 ms |

At suite scale the two tools are level, not Retest ahead.

## Facts shown, with the probe

| Fact | What was shown | Probe |
| --- | --- | --- |
| F4 | `Browser.close` to exit takes 507 to 535 ms whatever is sent; ending the group takes 21 to 30 ms | A script timing `launchBrowser`, `newPage`, `goto`, `dispose`, `close`, three rounds, before and after |
| F5 | The compile cache saves about 13 ms on `retest run --help`, 3 ms on the bare test process. Node alone boots in 36 to 43 ms | Five timed boots each, with and without `NODE_COMPILE_CACHE` |
| F7 | `Runtime.bindingCalled` never arrives until `Runtime.enable` is sent | The integration test `an observe with after answers on the next change…` failed without it and passed with it |
| Pool size | Seven workers, 200 tests: 27.3 s in one browser, 21.3 in two, 18.9 in three, 20.1 in four, 19.3 in seven | Three runs each with `--workers 7 --browsers N` |
| Where the wait is | With one browser and seven workers, Retest's own process was 96% idle over the whole run | `node --cpu-prof` on the parent |

F1, F2, F3 and F6 of the plan are not established.

## Decisions taken, and why

- **Browsers launch when the schedule is known, not at t=0.** The unit suite holds that a run which runs no test, from a failed collection, an empty selection or a refused host check, starts no browser. A launch before collection breaks that.
- **A browser may now start while an app server is awaited.** Two tests changed meaning on purpose: when the server never answers, one browser was launched meanwhile and is closed at the end.
- **Close is ask, then end the group.** A test browser has nothing to save. The container rule stands: killed processes need an init, which the guide already requires.
- **The Runtime domain is enabled on every page**, as Playwright and Puppeteer do. Events without listeners are dropped. No cost was measured.
- **Parallel is the default**: half the cores for workers, one browser for every three workers that have a file. `--workers 1` is the old behaviour.
- **A target's browsers follow its load.** A matrix of four targets on two files starts one browser each, and the matrix integration tests hold that.
- **Every browser is an event; the result lists each target once.** Further browsers carry `instance`, the first carries `instances`, and `rebuildResult` skips the further ones.
- **Compatibility is entered with `--playwright`, and nothing is softened.** The plan's open questions were not answered, so these two are assumptions: a flag, and no "findings" level yet. What Retest lacks is refused by name as `unsupported`, the test ends as an error, and the run exits 2.
- **`.test.` files are taken only when named.** With no files, discovery takes `.spec.` files alone, since a project's unit tests end in `.test.`.
- **Lazy loading of commands was measured and left out**: 4 ms.
- **No Rust in the runner, no Chromium fork, no agent browser.** The plan's tier 3 says why.

## What a reader of events and reports must know

All additive, `schemaVersion` stays 1.

- `observe` commands may carry `after`, and their results `changes` and `waitedMs`. The `observation` event may carry `waitedMs`.
- `run.started.options` gained `workers`, `browsers` and `playwright`.
- `browser.started` gained `instances` and `instance`, and may come before any `test.started`.
- The human report prints the browser line at the run's indent, with `· N browsers` when a target has several, and its first line says `playwright compatibility` in such a run.
- New flags on `retest run`: `--workers`, `--browsers`, `--playwright`.
- The task app fixture answers `GET /api/submissions?title=…` with that title's count.

## Not built

- S7, a kept browser for a watch mode. S9, the tests of one file across processes. S10, a disk cache. Tier 2, fast mode.
- `lock`, for tests that share something outside the page. Workers made it a real need: the example project's count of saves flaked 9 times in 16 under load until it counted a title of its own.
- Of compatibility wave 1: `playwright.config.ts`, the counted level and findings, `force`, the wider locator set, `skip`, `only`, `fixme`, `slow`, `test.info()`, `test.use`, Playwright's reporter names, projects, the generated compatibility table. The `npm init playwright` demo file does not run.
- The full five-run benchmark matrix on an idle machine, the Linux container run of the benchmark, and any published benchmark page.

## Open decisions for the user

1. Whether parallel stays the default, now that tests sharing outside state can disturb each other.
2. Whether a test that uses a Playwright escape hatch stays `passed` with a finding, or fails.
3. Whether `--playwright` stays a flag, or turns on by itself for a file that imports `@playwright/test`.
4. Which three public Playwright suites are the acceptance set for compatibility wave 2.
5. What to do with `pnpm-lock.yaml`.
6. When `private: true` comes off and 0.1.0 is published.

## Traps that cost time

- **Scripted edits and `$`.** `String.replace(a, b)` reads `` $` ``, `$'` and `$&` in `b` as patterns. Pass the replacement as a function.
- **A frozen context and a proxy.** A proxy must return a frozen property's own value. The compatibility guards stand on an empty shell object and read the target behind it.
- **The in-process unit harness gives assertions 300 ms**, and one `inProcessRun` keeps its first failure across `runPage` calls. Use a fresh one per case.
- **The unit harnesses default to one worker.** `runSupportFiles` and `runProject` pass `workers: 1` unless a test asks.
- **Never run tests while a benchmark runs.** Both use every core and Chrome, and the numbers move.
- **Retest refuses a run folder that holds files**, and the harness refuses a filled `--output` for the same reason.
- **The harness keeps its workspace in `<tmp>/retest-benchmarks`**: the two projects, the npm cache and Playwright. `--reinstall` refreshes Playwright; `latest` is asked of the registry on every run.
- **A background command started with `&` inside a foreground call reports nothing when it ends.** Start it as a background task.
- **Two sessions in one working tree.** Stage by path, and expect files that hold both sessions' changes.

## Next

The roadmap orders the months. The three things nearest to hand:

1. The next compatibility slice, so the `npm init playwright` demo file runs: chained locators, `nth`, `filter`, CSS, `getByPlaceholder`, `.not`, `toHaveClass`, `toBeChecked`, `toBeEmpty`, `toContainText`, `dblclick`, `page.reload` and `page.waitForFunction`.
2. `lock`, and the measurement of what a fresh renderer process costs each test, which is what both tools pay under load.
3. The full benchmark matrix on an idle machine and in the Linux container, before any number is published.
