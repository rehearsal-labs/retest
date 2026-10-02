# Retest speed and Playwright compatibility plan, after milestone 3

1 October 2026. A proposal for review. Nothing here is approved, and nothing is built apart from S1, the benchmark harness. The first half is the speed plan, tiers 1 to 3. The second half, from "Playwright compatibility", is the plan for running Playwright suites on Retest unchanged, and the appendix sets the two tools side by side. It cites the design in `docs/plans/developer-experience/design.md` as [D1] to [D42] and milestone 3's contract in `docs/plans/milestone-3/build-plan.md` as [M3-1] onwards. It starts after milestone 3 wave 2 has passed its acceptance checks and an independent review. Where it meets milestone 4, the order is a user decision, listed at the end.

## The goal

Retest is to be two to three times faster than Playwright on the time a runner controls, with every number measured and published beside the script that produced it. Not ten times. A gain of that size compounds across a suite of thousands of tests, and it makes every Rehearsal run cheaper.

Two rules hold from the first commit. They come from `docs/architecture.md` section 10 and from `AGENTS.md`.

- No speed claim before it is measured, phase by phase, with the app's own waiting separated from Retest's.
- Nothing here loosens what a pass means. An action runs once. An assertion retries observation, never an action. A covered element is refused. A test with no assertion fails. A browser lost after a click ends `outcome_unknown`.

## What Bun's entry teaches

- Speed got the click. The 1.0 post led with 4x startup, 4x HTTP and 13x over Jest.
- Drop-in and all-in-one kept people. State of JS 2024 put Bun at 79% retention and Deno at 41%.
- The cherry-picked benchmarks were called out, and are still being called out. The Jest comparison chose the slowest incumbent, and the hello-world HTTP gap vanishes in production write-ups.
- Where a lead was only tuning, the incumbent caught up. Yarn's speed lead over npm lasted about a year.

For Retest that means: publish the way esbuild does, a real workload and a script anyone can rerun, and keep the rows where Retest loses. Speed stays a line under "one runner for web, mobile and desktop, made for agents". A hidden or contrived number would contradict the README's "it says what happened, not what it hopes happened".

## Where the time goes today

Measured on 30 September 2026 on a 14-core MacBook, macOS, Google Chrome 154, the `fixtures/task-app` fixture in `ok` mode and the four-line test in `examples/task.retest.ts`. The same test was written for Playwright 1.63, installed in a folder outside the repo and pointed at the same Chrome. Three runs each unless noted. One machine, no CI, no network. Retest at commit 02314fd plus the milestone 3 work tree.

| | Retest | Playwright 1.63 |
| --- | --- | --- |
| One test, cold, wall time | 988 to 1501 ms, median about 1300 | 1618 to 2747 ms, median about 1650 |
| Test body, `test.started` to `test.finished` | 273 ms | 455 ms |
| 20 tests in one file, sequential | 5452 to 6125 ms | 5603 to 6484 ms, one worker |
| 20 tests, fully parallel | not available | 3556 to 5338 ms, seven workers, seven Chrome launches |
| Package on disk | 0 runtime dependencies | 18 MB, plus its own browsers unless pointed at Chrome |

Retest's single test, from its own `events.jsonl`:

| Phase | Time | Whose |
| --- | --- | --- |
| Node boot and CLI load, before `run.started` | 100 to 150 ms. `node -e ''` alone is 45 ms, `retest run --help` is 87 to 158 ms | Retest |
| Collection, a forked test process loading the file | 62 ms | Retest |
| Chrome launch, started only after collection | 302 ms | Chrome, started late by Retest |
| Navigation to the fixture | 125 ms | the app |
| `fill` | 32 ms | Retest, several round trips |
| `click` | 49 ms | Retest, several round trips |
| Assertion, two looks 52 ms apart | 53 ms | Retest, the poll delay |
| Teardown, `test.finished` to `run.finished` | 266 ms | Retest, a graceful `Browser.close` |
| Exit, after `run.finished` | 100 to 400 ms | Retest |

About 700 ms of a 1300 ms run is Retest's own. Chrome's launch could overlap other work. The app is 125 ms. On a real app the app's share is larger, so on a serial suite the same work shows as a smaller fraction of the total. Parallelism inside one browser is what makes it show at suite scale.

### First harness run, 1 October 2026

`npm run bench -- --sizes 1,20 --runs 3` on the same machine, Google Chrome 154, Playwright 1.63.0, both tools packed or installed into projects outside the repository and run from there, as a user runs them. Medians of three. Every cell passed every test. The 200-test row is one run each, from a separate check of the ten-file path. Milliseconds.

| Fixture | Tests | Retest wall | Playwright wall, 1 worker | Playwright wall, default workers | Per test, Retest | Per test, Playwright |
| --- | --- | --- | --- | --- | --- | --- |
| task-app | 1 | 1276 | 1309 | 1346 | 289 | 275 |
| task-app | 20 in 1 file | 5418 | 5545 | 5661 | 233 | 230 |
| task-app | 200 in 10 files, one run | 48740 | 47974 | 20211 | 230 | 229 |
| search-app | 1 | 2012 | 2011 | 1996 | 1078 | 955 |
| search-app | 20 in 1 file | 22650 | 19471 | 19585 | 1059 | 913 |

Startup and teardown for one task-app test: Retest 529 and 457, Playwright 405 and 646. Install: Retest 494 ms offline from the packed tarball, Playwright 3798 ms from the registry without its browsers.

What it says:

- On the runner-dominated app, per test is the same, 233 against 230. Retest's wall time is ahead by its shorter teardown and behind by its longer startup.
- On the app-dominated app, Retest is about 150 ms behind per test, and its events say why. After the fill, its looks came 51, 103, 252 and 503 ms apart, because `pollDelays` in `src/assertions/poll-locator.ts` is `[0, 50, 100, 250, 500]`. The status changed about 450 ms after the fill and was seen up to 500 ms later. S4, push then poll, removes that wait. It is the largest runner-controlled cost on a real app measured so far.
- At 200 tests across 10 files, Playwright's default seven workers finish in 20 s against 48 s for either tool on one worker. S8 is the lever, and until it lands a suite-level public benchmark shows Playwright ahead.
- Chrome's launch varied from 300 to 940 ms between runs on the same machine. F6 measures it by flag set before S2 or S7 claims a number.

### After S4, 2 October 2026

The same run, `npm run bench -- --sizes 1,20 --runs 3`, on the same machine, Chrome 154 and Playwright 1.63.0, with S4 built: the page tells Retest when its document changes, and every look after the first waits for the next change instead of sleeping. Medians of three, every cell valid. Milliseconds.

| Fixture | Tests | Retest per test, before | Retest per test, after | Playwright per test | Retest wall, before | Retest wall, after | Playwright wall, 1 worker |
| --- | --- | --- | --- | --- | --- | --- | --- |
| task-app | 1 | 289 | 283 | 271 | 1276 | 1244 | 1338 |
| task-app | 20 | 233 | 232 | 230 | 5418 | 5330 | 5647 |
| search-app | 1 | 1078 | 618 | 944 | 2012 | 1620 | 1999 |
| search-app | 20 | 1059 | 582 | 911 | 22650 | 12686 | 19470 |

What it says:

- On the app-dominated fixture, a test went from 1059 to 582 ms. The app's own waiting is about 450 ms, a 300 ms debounce and a 150 ms API, so what is left of Retest's share is the navigation and the actions. The poll latency is gone.
- Retest now finishes the 20-test search-app suite in 12.7 s against Playwright's 19.5 s on one worker: 1.5x, on the fixture where it was behind the day before.
- On the runner-dominated fixture nothing moved, which is the expected result: there was no waiting to remove. Enabling the Runtime domain on every page, which S4 needed (F7), cost nothing visible there either: startup 474 against 529 the day before.
- Startup and teardown are untouched and remain the next two items, S2 and S3.

### After S2 and S3, 2 October 2026

The same run again, with S2 and S3 built on top of S4: the browser launches once the schedule is known, while the first test process boots, and the close is asked for and the process group ended at once instead of waiting about half a second for Chrome's own shutdown. Medians of three, every cell valid. Milliseconds.

| Fixture | Tests | Retest wall, after S4 | Retest wall, after S2 and S3 | Playwright wall, 1 worker | Retest startup | Retest teardown, before and after | Playwright teardown |
| --- | --- | --- | --- | --- | --- | --- | --- |
| task-app | 1 | 1244 | 715 | 1343 | 474 to 422 | 499 to 26 | 697 |
| task-app | 20 | 5330 | 5263 | 5854 | 478 to 414 | 222 to 37 | 432 |
| search-app | 1 | 1620 | 1087 | 2037 | 488 to 414 | 507 to 37 | 691 |
| search-app | 20 | 12686 | 12316 | 19690 | 485 to 423 | 516 to 36 | 546 |

What it says:

- Teardown went from about 500 ms to under 40 ms, which is the whole of Chrome's own shutdown that the run no longer waits for. Playwright still waits: 430 to 700 ms.
- One cold test on the fast app now takes 715 ms against Playwright's 1343, 1.9x, and against 1276 the day before this work started. The plan's target of 650 ms or less is 65 ms away.
- Startup moved only from 474 to 422, because the launch now overlaps the first test process's boot and nothing else. Node's own boot, the CLI's load and collection are still in series, which is what S6 is for.
- Per test is unchanged, as it should be: nothing in these two steps touches a running test.

### After S6, 2 October 2026

The compile cache on both entry points, measured on the task app with one test, five runs, Retest only, since nothing else changed. Milliseconds.

| | After S2 and S3 | After S6 |
| --- | --- | --- |
| Wall | 715 | 646 |
| Startup | 422 | 365 |
| Tests | 267 | 261 |
| Teardown | 26 | 28 |

One cold test is under the plan's 650 ms target. What is left of startup is Node's own boot, about 40 ms, the CLI's modules, about 30, collection with a second Node boot, about 60, and Chrome's launch, about 250, which only a kept browser removes (S7).

### After S8, 2 October 2026

Files on workers, all contexts in one Chrome per target, default workers seven on this machine. Task app, medians of three. Milliseconds.

| 200 tests in 10 files | Retest, one file at a time | Retest, 7 workers | Playwright, 7 workers | Playwright, 1 worker |
| --- | --- | --- | --- | --- |
| Wall | 48740 | 26079 | 19531 | 48853 |
| Per test | 230 | 782 | 519 | 233 |

What it says:

- Workers nearly halved the suite, 48.7 s to 26.1 s, and Playwright's seven workers are still ahead at 19.5 s.
- A test takes 3.4 times longer under seven-way load in one Chrome, 782 ms against 230, where Playwright's takes 2.2 times longer with a browser per worker. A CPU profile of Retest's own process over the whole run shows it 96% idle, so the wait is inside the one shared browser, not in the runner.
- One browser for every worker starts cheaper and saturates. The next step for S8 is a small pool of browsers per target, sized against the workers, measured at 1, 2, 3 and 7 browsers for seven workers.

### The browser pool, 2 October 2026

Each target's tests are now spread over several browsers, each worker keeping to one: `--browsers <n>`, `RunOptions.browsers`, never more than the workers or the files. Measured on seven workers, 200 tests in 10 files on the task app, three runs each, every run 200 of 200 passed.

| Browsers | Wall, three runs | Median | Per test |
| --- | --- | --- | --- |
| 1 | 27285, 27459, 26784 | 27285 | 810 |
| 2 | 21583, 21071, 21306 | 21306 | 559 |
| 3 | 19729, 18726, 18857 | 18857 | 481 |
| 4 | 20378, 20057, 20028 | 20057 | 504 |
| 7 | 20804, 19182, 19332 | 19332 | 484 |

Three browsers for seven workers is the best measured and the cheapest in memory of the ones that work, so the default is one browser for every three workers that have a file to run. A target's browsers follow its load: one that carries a share of the run's tests, as each target of a matrix does, gets that share of the browsers, at least one, and never more than the files that use it. So a matrix of four targets on two files still starts one browser of each, which the matrix integration tests hold. Past three, nothing more is gained: a test still takes about 480 ms under seven-way load against 230 alone, with the machine's cores far from busy, which points at what every test pays in both tools, a new renderer process for its new context. That is the next thing to measure, not more browsers.

The harness, with the pool at its default of three browsers for seven workers, two rounds of three runs each. Wall time in milliseconds.

| 200 tests in 10 files | Round 1 | Round 2 |
| --- | --- | --- |
| Retest | 18697 | 19850 |
| Retest, on Playwright's own spec files | 19495 | 21168 |
| Playwright, default workers | 19065 | 20140 |

At suite scale Retest is level with Playwright, from 26.1 s with one browser and 48.7 s before workers. It is not ahead: both tools pay the same per test under load.

One thing workers surfaced that is not about speed. The example project's test "the server counts one save for one click" read a count of every save on the app's server, and with other files saving beside it the count rose by more than one: 9 failures in 16 runs under load. Files now share the app while they run, so a test that shares something outside the page with another can be disturbed by it. The fixture now counts saves by title and the example counts a title of its own, which passed 12 of 12 under the same load, and the guide says so beside `--workers`. `lock` [D23] is the designed answer for tests that cannot have a thing of their own, and it is not built.

### The same spec files on both tools, 2 October 2026

With the first compatibility slice built, the harness runs the Playwright project's own `.spec.ts` files through `retest run --playwright`, unchanged, beside Playwright itself. Medians of three, every cell valid. Wall time in milliseconds.

| Fixture | Tests | Retest, its own files | Retest, Playwright's files | Playwright, 1 worker |
| --- | --- | --- | --- | --- |
| task-app | 1 | 649 | 679 | 1424 |
| task-app | 20 | 5242 | 5211 | 5786 |
| search-app | 1 | 1019 | 1016 | 2131 |
| search-app | 20 | 12310 | 12227 | 19714 |

Compatibility costs nothing measurable over Retest's own files, and the same Playwright file runs 2.1 times faster on one cold test and 1.6 times faster on the app-dominated suite than on Playwright.

## Targets

Every target is read from the harness in S1, not from a stopwatch.

| Measure | Today | Target |
| --- | --- | --- |
| One test, cold, wall time, task-app | about 1300 ms, then 646 ms after S2, S3, S4 and S6 | 650 ms or less. Met |
| One test with a warm browser, task-app | not available | 300 ms or less |
| Retest's own time per action, task-app | 32 to 49 ms | 15 ms or less |
| Assertion latency after the DOM changes, task-app `delayed` mode | up to 52 ms, then up to 500 ms on the app-dominated fixture | 10 ms or less. S4 removed the wait: search-app per test went from 1059 to 582 ms, with about 450 ms of that the app itself |
| 20 tests in one file, 8 or more cores, task-app | about 5500 ms | 1500 ms or less |
| 200 tests across 10 files, both fixtures | not measured | at or under Playwright's defaults on the same machine |
| Process start to `run.started` | 100 to 150 ms | 60 ms or less |
| Install to first green, clean machine, Chrome present | not measured | published for both tools |

## Tier 1. The runner

Built first. Ordinary engineering with known mechanisms. Nothing in this tier changes what a test proves.

S1. **The benchmark harness comes before any optimisation.** A `benchmarks/` folder with a generator for N-test files, a driver that runs Retest and Playwright against the same fixture and the same Chrome, and a report of per-phase medians. The driver installs Playwright into a temporary folder outside the package on demand. It is never a dependency. Output is JSON with the machine, the versions, medians of five runs per phase, and a Markdown table. The harness runs two fixtures: `task-app`, which the runner dominates, and a new app-dominated fixture with a 150 ms API latency and a 300 ms debounce, added under `fixtures/`. Every later decision quotes its numbers from this harness. Built on 1 October 2026: `npm run bench`, with `benchmarks/README.md` for its flags and phases, and its first run is in "Where the time goes today".

S2. **Chrome launches at t=0.** The browser pool starts each launch as soon as the config and targets are known, in parallel with collection. Expected: the 62 ms of collection and the child's boot leave the critical path. **Built on 2 October 2026, at schedule time rather than t=0:** a run that will run no test, from a failed collection, an empty selection or a refused host check, must start no browser, and the unit suite holds that line. So the launch starts once the schedule is known, for exactly the app targets scheduled tests use, in the order they need them, and overlaps the first test process's boot and any app server start instead of collection. The browser line moved to the run's indent in the human report, since it can now come before any file.

S3. **Teardown is bounded.** The parent sends `Browser.close`, waits at most 100 ms, then kills the process group and removes the profile. F4 sets the wait. The exit code rules do not change [D21]: a profile that cannot be removed is still a cleanup failure. Expected: 266 ms to under 60 ms. **Built on 2 October 2026 with no wait at all:** F4 showed Chrome takes about 515 ms to exit on its own whatever is sent, so the close is asked for and the group ended at once, then waited for up to `closeGraceMs` and the profile removed. A probe measured close at 21 to 30 ms, from 507 to 535. The container rule stands: killed processes need an init to reap them, which the guide already requires.

S4. **Push, then poll.** Each document installs a page script with a `MutationObserver` that tells the parent through a CDP binding that the document changed, once per task however much changed in it. The page counts those changes, and an `observe` can carry `after: { changes, waitMs }`: the page then answers as soon as its count passes `changes`, or after `waitMs`. A locator assertion uses that for every look after its first, keeping the existing poll delays as the ceiling, so a page that changes without a mutation is still seen, and at least 50 ms apart, so a page in constant motion is not read on every frame. Observations stay whole, redacted and served by the parent [M3-3], and the `observation` event says how long the look waited in `waitedMs`. **Built on 2 October 2026**; the fact it rests on is F7. Measured: see "Where the time goes today".

S5. **One evaluate per action.** Locator resolution, the visible, still, enabled and not-covered checks, the centre point and the hit test run in one `Runtime.callFunctionOn`, and the input follows in one `Input` dispatch. The guard in the page stays exactly as milestones 2 and 3 define it. The two animation frames for "still" stay. Expected: `fill` and `click` from 32 to 49 ms to about 15 ms.

S6. **Cheaper boots.** `module.enableCompileCache()` in the CLI entry and in the child entry, so Node reuses compiled bytecode across runs. F5 measures it. `inspect`, `list`, `init`, `doctor` and the JSON Schemas load only when their command runs. No bundler is added, because build tools are a separate dependency decision. Expected: process start to `run.started` from 100 to 150 ms to about 60 ms, and the same again in the child. **Built on 2 October 2026, the cache half:** Node compiles a whole import graph before any module runs, so each entry became a bootstrap that imports nothing, turns the cache on and then loads the program, `src/cli/main.ts` into `program.ts` and `src/runner/child.ts` into `child-program.ts`. The lazy half was measured and left out: importing all five commands costs 15 ms against 11 ms for `run` alone, so 4 ms, and no schema work happens at load.

S7. **A warm browser for the inner loop.** `retest watch` keeps one Chrome per target alive between runs and gives each test a new context, as today. The test process stays disposable per file. The kept browser is keyed by executable path, flags and headless setting, and any change replaces it. `browser.started` says `reused: true`. When `CI` is set, nothing is kept. Expected: one test from about 1300 ms to under 300 ms.

S8. **One browser, many contexts.** Parallel execution [D23] runs N test processes at once, one per file, while the parent keeps one Chrome per target and gives each test its own context. Playwright launches one browser per worker. Retest does not need to, because the parent already owns every browser and every command passes through it. Leases stay per app [D11], `lock` stays [D23], and a test process that fails still stops only its file. `--workers` defaults to half the cores. **Built on 2 October 2026.** `--workers <n>` on the command line and `workers` in `RunOptions`, absent meaning half the cores and at least one; `run.started.options.workers` records it. The schedule's setup visits run first, one after another, so every saved state exists before a test starts from it, and a visit that mixed a file's setups with its tests is split into one of each. Then the test visits run on the workers, each file in a process of its own, all contexts in the one browser per target. The session now tracks every running test, so a browser lost or a run interrupted reaches each of them. Leases and `lock` are not built; nothing in the runner needs exclusive use of a Chromium target. Measured: see "Where the time goes today".

S9. **Tests of one file across processes.** A file whose `test.describe` or top-level options say `parallel: true` may be visited by several processes, each running a subset of its tests. The guide already says top-level code runs on every load. The 20-tests-in-one-file target depends on this. Default is off, so a file that shares module state between its tests keeps working. **Not built yet:** the file-level option it needs is an API decision, listed under the open questions, and the scheduler's visits already carry subsets of a file, so the change is in `scheduleRun` and the option's type alone.

S10. **A Retest-owned disk cache.** Chrome starts with `--disk-cache-dir` at `.retest/cache/<hash of the executable>`, so scripts, styles and V8's code cache survive across runs while the profile stays fresh per run. Cookies and storage stay in the per-run profile, so isolation is unchanged. `cache: false` turns it off. F1 decides whether contexts use it. Expected: repeat navigations of a real app measurably faster. The `task-app` fixture will not show it.

## Tier 2. Time and the network, as fast mode

Opt-in. Every piece changes what a test proves, so every piece is printed. Built after tier 1 is measured.

S11. **Fast mode is one switch and always visible.** `--fast` on the CLI and `fast` in `RunOptions`. `run.started.options.fast` records it, every `test.started` carries `fast: true`, and the summary line ends with `fast mode`. The agent reporter says the same. A host that wants part of it names the parts: `fast: { animations: true, virtualTime: false, replay: false }`.

S12. **Animations at 100x.** `Animation.setPlaybackRate(100)` on every context in fast mode. F2 shows what it does to CSS transitions, Web Animations and the "still" check. If "still" cannot be trusted under it, the check waits for the animation to end instead of for two equal frames.

S13. **Virtual time.** `Emulation.setVirtualTimePolicy` with `pauseIfNetworkFetchesPending`, granted a budget while a look or an action is waiting, so debounces and timers elapse without wall time passing. The domain is experimental, so F3 decides whether it ships. If it ships, each test's events say how much virtual time it consumed.

S14. **Response replay.** Only when a host asks. Recording through the `Fetch` domain into `<run>/replay/`, and replaying in a later run for apps marked `replay`. A replayed pass says `replayed: true` on every event and in the summary, `inspect` shows it, and it never counts as a live pass in a host's verdict [M3-2].

## Tier 3. Not planned

- **No Chromium fork.** Building takes hours, shipping takes hundreds of megabytes, which is the install tax Retest avoids, and users lose the Chrome they run. Revisited only if a per-action cost is measured that CDP cannot remove.
- **No agent browser.** Lightpanda and its kind skip CSS, layout, images and fonts. There are no coordinates, no visibility and no screenshots, so "visible, still, enabled and not covered" has no meaning there. A pass would prove a DOM query, not a user action.
- **No Rust in the runner.** Nothing CPU-bound has been measured. If image redaction or video encoding dominates one day, it goes in as Rust compiled to WebAssembly, after profiling, so the package stays one download.

## Facts to establish first

As milestone 3 does, each fact is shown in real Chrome before a decision rests on it, on macOS and in the Linux container, and written down with the probe that showed it.

| Fact | Question | Decides |
| --- | --- | --- |
| F1 | Do contexts made by `Target.createBrowserContext` read and write `--disk-cache-dir`, and does V8's code cache follow | S10 |
| F2 | What `Animation.setPlaybackRate` does to CSS transitions, Web Animations and the two-frame "still" check | S12 |
| F3 | How `Emulation.setVirtualTimePolicy` interacts with `fetch`, input dispatch and the guard | S13 |
| F4 | How long `Browser.close` takes against a kill, and what each leaves in the profile folder. **Shown on 2 October 2026 in Chrome 154: `Browser.close` to exit takes 507 to 535 ms, three runs of three; ending the group at once takes 21 to 30 ms to be gone. The profile is temporary and removed either way** | S3 |
| F5 | What `module.enableCompileCache()` saves on the CLI entry and on the child entry. **Shown on 2 October 2026, Node 24.12: `retest run --help` boots in 84 ms without the cache and 71 with, `--version` 75 and 73, the bare test process 49 and 47. Node alone boots in 36 to 43. The cache is Node's default folder under the temporary directory, 175 files and 924 KB for Retest, shared by the parent and the child** | S6 |
| F6 | Chrome's cold launch time by flag set and by `--headless` against the headless shell build, both platforms | S2, S7 |
| F7 | Whether `Runtime.bindingCalled` arrives without `Runtime.enable`. **Shown on 2 October 2026 in Chrome 154: it does not.** A binding added by `executionContextName` never reports a call until the Runtime domain is enabled, so S4 enables it on every page, as Playwright and Puppeteer do. Its other events have no listeners and are dropped | S4 |

## Benchmark methodology

What gets published, and the rules for publishing it.

- Two fixtures, one runner-dominated and one app-dominated. Both always published.
- 1, 20 and 200 tests. Cold and warm. Sequential and parallel. Both tools on their defaults. Retest fast mode is a separate row with its label.
- Median of five, with the machine, OS, Chrome and both versions named. The script lives in the repo and installs Playwright itself, outside the package.
- Per phase, never one number. Install to first green is its own row.
- The rows where Retest is slower stay in. If none is found on the two fixtures, the page says so and links the script.
- Never compared to Vitest. It is a unit runner.

## Acceptance checks

- Every target in the table is met, read from the harness, on macOS and in the Linux container.
- `npm test` passes. No integration test's expectations change.
- New tests show, under S4 and S5, that a covered element is still refused, that a click is still sent once, that an observation is still whole and redacted, and that a page changing without a mutation is still seen within the old poll ceiling.
- A run with `--fast` shows it in the human report, the agent report, `run.started`, every test's events, `result.json` and `inspect`.
- The published benchmark page includes the losing rows, or the statement that none was found with the script to check.

## Sequencing and open questions

- Starts after milestone 3 wave 2 passes its acceptance checks and an independent review.
- Milestone 4 owns the session API and a custom launcher for the test process. S6, S7, S8 and S9 touch the same runner code. Which goes first is a user decision.
- Whether S9 stays opt-in per file or becomes the default once module-state sharing is documented.
- Whether `--fast` exists on the CLI or only in `RunOptions` for hosts.
- Whether a kept browser on a developer machine fits "own the browser process used for testing", from `docs/architecture.md` section 6, or needs its own profile rules.

## Playwright compatibility

The aim, in one line: Retest is to Playwright what Bun is to Node. An existing Playwright suite runs on Retest unchanged, faster, and with Retest's verdict. The rule that makes it possible without giving up the verdict is **Playwright's API, Retest's judgement**: every Playwright call works, and the ones that weaken a test are counted and printed instead of refused.

Bun agreed with Node's semantics and only had to match them. Retest disagrees with several of Playwright's. This section is where those disagreements are settled one by one, so that a green suite stays green on day one and the report says what that green is worth.

Three rules hold throughout:

- No Playwright code is copied. The API is written from Playwright's public documentation and types. Playwright is never a dependency of the package [AGENTS.md]. Differential tests install it into a temporary folder outside the package, as the benchmark harness does [S1].
- No compatibility is claimed before it is implemented and tested, method by method, and the compatibility table is generated from those tests, never written by hand [architecture.md section 1].
- Nothing presents itself as Playwright. The report header says `retest <version>, playwright compatibility`.

### Decisions

C1. **One subpath and one import hook.** `@rehearsal-labs/retest/playwright` exports `test`, `expect`, `defineConfig`, `devices` and the types, in Playwright's shapes. `retest run --playwright` maps `@playwright/test` and `playwright` imports to that subpath in the test process, through the `module.registerHooks` resolve hook milestone 3 adds for the package's own resolution [M3-7]. A suite runs with no edits. Without the flag, the subpath is a plain import a user can choose. The hook never touches a file that does not import Playwright.

C2. **`playwright.config.ts` is read, and every key is accounted for.** `testDir`, `testMatch`, `testIgnore`, `timeout`, `expect.timeout`, `use.baseURL`, `use.headless`, `use.channel`, `use.launchOptions.executablePath`, `workers`, `fullyParallel`, `retries`, `reporter` and `projects` map to Retest's own config and options. A `project` becomes an app target [D4], and a `devices[...]` entry becomes labelled emulation [D6]. A key with no mapping is printed at the start of the run, by name, with "ignored" or "not yet". Nothing is dropped silently.

C3. **Three levels for every API member, and the table says which.**

| Level | Meaning | Examples |
| --- | --- | --- |
| Native | Same behaviour as Retest's own API | `goto`, `click`, `fill`, `press`, `check`, `selectOption`, `getByRole`, `getByLabel`, `getByText`, `getByTestId`, `toHaveText`, `toBeVisible`, `toHaveCount`, `toHaveValue` |
| Counted | Works as Playwright defines it, and adds a finding to the test | `force: true`, `waitForTimeout`, `dispatchEvent`, `evaluate` that writes to the page, `first()` and `nth()` when more than one element matched, a test that made no assertion, a promise not awaited |
| Not yet | Fails at the call with the member's name, the line and the nearest Retest equivalent | everything not in the table yet |

A "not yet" member never no-ops and never returns a placeholder.

C4. **Findings.** A finding is a fact about how a test passed. Each has a kind, a location and a count. Kinds in wave 1: `forced`, `slept`, `dispatched`, `wrote_page`, `picked_among_many`, `no_assertion`, `not_awaited`. A finding does not change the test's status in compatibility mode, so a suite that was green on Playwright is green here. Every finding is printed in the human card and the agent report, written as a `finding` event, and counted per test and per run in `result.json`. The summary line ends with the count: `20 passed, 7 with findings`. `--strict` turns findings into failures, which is Retest's native rule.

C5. **Retries are honoured, and named.** Playwright's `retries` reruns a failed test. In compatibility mode Retest does the same, each rerun a fresh attempt with its own id and its own isolation, and a test that passes on a rerun is reported `flaky`, never `passed` [D24]. `--strict` fails flaky tests. Outside compatibility mode nothing changes: Retest's own tests are never rerun.

C6. **Locators grow to Playwright's set, with Retest's matching rules.** `locator(css)`, `locator(xpath)`, `getByPlaceholder`, `getByTitle`, `getByAltText`, chaining, `filter`, `first`, `nth`, `and`, `or`. Role and label names still come from Chrome's accessibility tree, not from an injected name computation. Where Chrome and Playwright's own algorithm disagree, the differential tests find it and the table lists it, per role, with a fixture that shows it. Shadow DOM piercing is added, because Playwright pierces by default and common suites depend on it. Frames come with `frameLocator` in wave 2.

C7. **Actions keep the guard.** A native-level action runs exactly as Retest's own: checked, sent once, guarded in the page. `force: true` skips the checks and the guard for that one action, sends the input at the element's centre, and adds a `forced` finding. An action that ends `outcome_unknown` stays `outcome_unknown` in every mode.

C8. **Fixtures.** `page` is wave 1. `context`, `browser`, `browserName`, `request` and `test.extend` are wave 2, with handles that expose what Retest's parent can do: `context.newPage`, `addCookies`, `storageState`, `request.get` and friends through `fetch` in the parent. `storageState` files are read and written in Playwright's format so sign-in reuse carries over, and `test.setup` [D16] stays the native way.

C9. **Structure and control flow.** `test.describe`, `beforeEach`, `afterEach`, `step`, `skip`, `only`, `fixme`, `slow`, `test.info()` and `test.use` in wave 1, `beforeAll` and `afterAll` in wave 2. `skip` and `only` are reported as such, and `only` prints a warning line because a run with `only` checks less than the suite.

C10. **Reporters.** Playwright's built-in names `list`, `line`, `dot`, `json` and `junit` map to Retest's reporters in wave 1. `html` maps to `retest report` when that exists [D26] and is "not yet" until then. Custom reporter classes, which Allure, Currents and others plug into, get an adapter in wave 2 that feeds Playwright's `onBegin`, `onTestBegin`, `onTestEnd` and `onEnd` from Retest's events.

C11. **Browsers.** A `chromium` project runs on the installed Chrome or Chromium, and `channel: 'chrome'` or `'msedge'` picks that binary. `firefox` and `webkit` projects fail the run at the start, exit 2, naming the project and saying Retest has no driver for them yet. They are not skipped, because a skipped browser is a smaller suite than the author wrote. This changes when Firefox lands over WebDriver BiDi.

C12. **The differential harness.** Under `benchmarks/compat/`, a set of `.spec.ts` fixtures and a driver that runs each file under real Playwright and under Retest with `--playwright`, against the same app and the same Chrome, and compares statuses, the ordered list of actions, and each finding. The compatibility table on the docs page is generated from its last run: one row per API member, its level, and a link to the fixture that proves it. The benchmark gains a third column from this point: the identical `.spec.ts` on Playwright, on Retest in compatibility mode, and the same test in Retest's own API.

C13. **What stays out.** Trace files and the trace viewer, UI mode, codegen, component testing, Playwright's video format, `webServer` beyond what `start` [D7] covers, and Playwright's own MCP server and agents. A user who wants those keeps Playwright for them. The table says so.

### First slice, built on 2 October 2026

The open questions were not settled when this was built, so it takes the proposals above as its assumptions and is easy to turn: compatibility is entered with `--playwright`, and there are no findings yet, so what Retest does not have is refused, never softened.

What exists: the `/playwright` subpath with Playwright's `test`, `expect`, `defineConfig` and `devices` over Retest's API [C1]; the resolve hook that maps `@playwright/test` and `playwright/test` to it from any folder, and resolves relative imports written without an extension [C1]; `--playwright` on `retest run`, with Playwright's file endings and `.spec` discovery; the native level of C3 for the members Retest already has; the "not yet" level for everything else, as an `unsupported` failure located at the line that used the member; the run marked in `run.started` and in the human report's first line; and the benchmark's fourth runner, which runs the Playwright project's own spec files through Retest unchanged [C12].

What does not, of wave 1: `playwright.config.ts` [C2], the counted level and findings [C3, C4], `force` [C7], the wider locator set [C6], `skip`, `only`, `fixme`, `slow`, `test.info()` and `test.use` [C9], Playwright's reporter names [C10], project handling [C11], and the generated compatibility table [C12]. The `npm init playwright` demo file does not run yet: it needs `getByPlaceholder`, `nth`, `filter`, chained locators, `dblclick`, `toHaveClass`, `toBeChecked`, `toBeEmpty`, `.not`, `page.reload` and `page.waitForFunction`.

### Waves

| Wave | Scope | Done when |
| --- | --- | --- |
| C-wave 1 | C1, C2, C3, C4, C7, and the wave-1 parts of C6, C9, C10 and C11, plus the harness in C12 | The `demo-todo-app.spec.ts` that `npm init playwright` writes runs unchanged, with the same pass count as on Playwright, and the generated table has no hand-written rows |
| C-wave 2 | C5, C8, the rest of C6, C9 and C10, `frameLocator`, `route` and request mocking on the `Fetch` domain shared with S14, dialogs, uploads and downloads once milestone 3 wave 2 has them | Three public open-source Playwright suites, chosen in advance and named in the review, run with the same statuses, findings and all |
| Later | C11 for Firefox, custom reporters beyond the four lifecycle hooks, sharding | A driver exists |

### Facts to establish first

| Fact | Question | Decides |
| --- | --- | --- |
| CF1 | How `@playwright/test`, `playwright` and `playwright-core` resolve in a user project, in ESM and CommonJS spec files, and whether a resolve hook covers all three under Node's type stripping | C1 |
| CF2 | Where Chrome's accessible names differ from Playwright's own computation, on a fixture that covers every role Playwright documents | C6 |
| CF3 | What a `storageState` file holds in Playwright 1.63, and whether Retest's saved state can read and write it without loss | C8 |
| CF4 | Which `test.info()` fields and which config keys the three chosen public suites actually use | C2, C9 |

### Acceptance checks

- The wave-1 file and, in wave 2, the three named suites, run unchanged with the same statuses as on Playwright, from the differential harness, on macOS and in the Linux container.
- Every "not yet" member fails at the call with its name, the line and the nearest Retest equivalent. A test that finds none never passes because of it.
- Findings appear in the human card, the agent report, `finding` events, `result.json` and `inspect`, and `--strict` turns each kind into a failure with the same location.
- The package still has 0 runtime dependencies and no import of Playwright anywhere under `src/`.
- The compatibility table is generated, and every row links a fixture.
- Compatibility mode adds no measurable time to the native path: the benchmark's native column does not move.

### Open questions

- Whether findings leave a test `passed` by default, as proposed, or the default is `--strict` and compatibility mode opts out.
- Whether `--playwright` is needed at all, or a file that imports `@playwright/test` turns the hook on by itself.
- Which three public suites are the wave-2 acceptance set.
- Whether Playwright's own test files, which are Apache-2.0, are used as extra conformance fixtures with their attribution, or only Retest's own.
- Whether C-wave 1 starts before or after tier 1 of the speed plan. They share `benchmarks/` and the harness, and the third benchmark column needs both.

## Appendix. Playwright and Retest, side by side

Playwright 1.63 as of 1 October 2026, and Retest at the milestone 3 work tree. Both are a runner plus a browser driver speaking CDP over a pipe. Playwright is a decade of features with escape hatches. Retest is a year-one core with the escape hatches removed on purpose. The benchmark in this plan compares the shared part: launching, acting, checking and tearing down.

### Process model

| | Playwright | Retest |
| --- | --- | --- |
| Who drives the browser | The test worker itself. Client and driver run in one Node process | The parent process. The test process sends `goto`, `fill`, `click` and `observe` over IPC and never speaks CDP |
| Parallelism | Workers, each a process with its own browser. A file's tests share a worker unless `fullyParallel` | One file at a time today. S8 and S9: one browser, many contexts |
| Browsers | Its own patched builds of Chromium, Firefox and WebKit, downloaded on install. Chrome and Edge as channels | The installed Chrome or Chromium, stock. Firefox planned over WebDriver BiDi |
| Runtime dependencies | 3 packages, 18 MB | 0 |

### Finding elements

| | Playwright | Retest |
| --- | --- | --- |
| Locators | testId, role, label, text, placeholder, title, alt, CSS, XPath, chaining, `filter`, `nth`, `first` | testId, role, label, text. No chaining, no `nth`, no `first` |
| Role names | Computed by a script Playwright injects into every frame | Read from Chrome's own accessibility tree |
| Shadow DOM and frames | Yes, by default | No. Top-level document only |
| Two matches on a click | Strict mode violation, and `first()` gets past it | `ambiguous`, with no way past it |

### Acting

| | Playwright | Retest |
| --- | --- | --- |
| Checks before input | Attached, visible, stable, enabled, receives events. Retried until timeout | Visible, still, enabled, not covered |
| Escape hatches | `force: true`, `waitForTimeout`, `dispatchEvent`, `evaluate` to set values | None [D14]. A covered element is refused |
| Input that lands elsewhere | The click happens on whatever was there | A guard in the page cancels the event before any listener hears it, and the action fails `not_actionable` naming the element |
| Browser lost after a click was sent | The test errors | The test ends `outcome_unknown` |

### Checking

| | Playwright | Retest |
| --- | --- | --- |
| Locator assertions | Retry at 100, 250, 500 and 1000 ms, up to 5 s | Retry about every 50 ms, up to 5 s. S4 makes it push-driven |
| A test with no assertion | Passes | Fails |
| A forgotten `await` | Passes, or fails later somewhere else | Fails, naming both lines |
| Two commands at once | Allowed | Fails at once [D17] |
| Retries | `retries: n` reruns the test and marks it flaky | Never reruns a test |
| Who judges a pass | The worker's own report | From milestone 3, the parent re-judges every locator assertion on the observation it served [M3-3], and runs checks the test cannot write [M3-2] |

### Sign-in, secrets and isolation

| | Playwright | Retest |
| --- | --- | --- |
| Isolation | New context per test | New context per test, and a new process per file |
| Sign-in reuse | A `storageState` file the author manages | `test.setup` saves state in the run folder and deletes it when the run ends |
| Secrets | Environment variables in the test process | Never in the test process. The parent types them, and every text output reads `{{name}}` |

### Output and agents

| | Playwright | Retest |
| --- | --- | --- |
| Reports | List, HTML report, trace viewer, UI mode, JUnit, JSON | One failure card, the agent report, JSONL events with a JSON Schema, `inspect` |
| Exit codes | 0 or 1 | 0, 1, 2, 130, 143. A run cut off can never read as a pass |
| Agents | Planner, generator and healer agents since 1.56, production-ready in 1.60 in May 2026, and an MCP server that streams accessibility snapshots | Output shaped for the agent that runs it. No generation and no healing inside Retest; Rehearsal does that above it |

### What each has that the other does not

Playwright today: network mocking, HAR replay, a fake clock, dialogs, uploads, downloads, popups, video, tracing, visual comparison, component testing, three engines, mobile emulation on all of them, parallel workers, sharding, retries, watch and UI mode, codegen, a VS Code extension.

Retest today: a verdict the test code cannot fake, secrets the test process never holds, an input guard that refuses misdirected clicks, a no-assertion test that fails, exit codes that tell "failed" from "could not check", and nothing to download.

Sources for the agent row: [Playwright test agents guide](https://qaskills.sh/blog/playwright-test-agents-planner-generator-healer), [Playwright 1.60 release guide](https://qaskills.sh/blog/playwright-1-60-release-guide-2026), [State of the Playwright AI ecosystem in 2026](https://currents.dev/posts/state-of-playwright-ai-ecosystem-in-2026).
