# Roadmap, October 2026 to March 2027

2 October 2026. A proposal for review. Nothing here is approved, and the months are targets, not promises. It orders work the existing plans already describe, and cites them: the design in `docs/plans/developer-experience/design.md` as [D1] to [D42], milestone 3 in `docs/plans/milestone-3/build-plan.md` as [M3-1] onwards, and the speed and compatibility plan in `docs/plans/speed/plan.md` as [S1] to [S14] and [C1] to [C13]. Where things stand today is in `docs/plans/speed/handoff.md`.

## The aim

Retest is to Playwright what Bun is to Node. That is three things, in the order people meet them:

1. **It runs what they have.** A Playwright suite runs on Retest unchanged.
2. **It is faster, and a pass means more.** Measured, with the script published, and with Retest's judgement behind every pass.
3. **It goes where Playwright does not.** Native mobile and desktop apps, and AI checks, in the same test.

Three rules hold in every month. No speed claim before it is measured. Nothing loosens what a pass means. No browser, platform or compatibility is claimed before it is exercised and verified [AGENTS.md].

## Where Retest is

| | Today |
| --- | --- |
| Browsers | Chromium, Chrome and Edge. No Firefox, no WebKit |
| Platforms | macOS, and Linux in a container. No Windows |
| Speed | One cold test 663 ms against Playwright's 1478. 200 tests on seven workers level with it |
| Playwright files | The common subset runs through `--playwright`. About a tenth of Playwright's API by count |
| Native apps, AI checks, evals | Not built |
| Release | Not published. `private: true`, version 0.0.0 |

## Tracks

| Track | What it carries |
| --- | --- |
| Core | Milestones 3 and 4: what a host needs, and the agent session API |
| Compatibility | Playwright's API on Retest, stage by stage |
| Speed | What is left of the speed plan, and what workers made necessary |
| Reach | More browsers, then phones, then desktop apps |
| AI | Judged checks and evals |
| Proof | Releases, the benchmark page, the compatibility table |

The tracks touch different code, so separate sessions can run them side by side. What cannot be run in parallel is deciding: each month below lists the decisions it waits on.

## October 2026: a base people can try

| Item | Track | Done when |
| --- | --- | --- |
| Publish 0.1.0 | Proof | The gates pass on Linux and macOS on the chosen commit, `private` comes off, and the first version is published by hand as `docs/releasing.md` says |
| Milestone 3 wave 2: uploads and downloads, tabs, screencast frames and video, an inbox per app, proxy authentication [M3-8 to M3-11, M3-5] | Core | Its acceptance checks pass and an independent review is done |
| Compatibility stage A: the file `npm init playwright` writes runs unchanged [C6, C9] | Compatibility | Same pass count as on Playwright, from the differential harness, and the compatibility table is generated from it [C12] |
| `lock`, for tests that share something outside the page [D23] | Core | Two tests with one lock never overlap, shown under workers |
| Tests of one file across processes [S9] | Speed | 20 tests in one file meet the plan's 1500 ms target |
| What a fresh renderer process costs each test | Speed | Measured in real Chrome and written down as a fact, with what follows from it |
| The benchmark page | Proof | The full matrix, five runs, on macOS and in the Linux container, with the script and the rows where Retest loses |

Waits on: when 0.1.0 goes out, whether parallel stays the default, and what to do with `pnpm-lock.yaml`.

## November 2026: ordinary Playwright suites run

| Item | Track | Done when |
| --- | --- | --- |
| Compatibility stage B: `playwright.config.ts` [C2], `skip`, `only`, `fixme`, `slow`, `beforeAll`, `afterAll`, `test.info()`, `test.use` [C9], `{ timeout }` options, `toHaveURL`, `toHaveTitle` and the other common matchers, `storageState` [C8] | Compatibility | Three public Playwright suites, named in advance, run with the same statuses |
| Findings, `--strict` and `force` [C3, C4, C7] | Compatibility | A pass that used an escape hatch says so in every report, and `--strict` fails it |
| Retries, reported as flaky [C5, D24] | Core | A test that passes on a retry is never reported `passed` |
| Custom fixtures, `test.extend` [D15] | Core | Retest's own API and the compatibility layer share one implementation |
| `retest report`, an HTML file, and JUnit output [D26, D41] | Proof | One file a person can open, and a CI system can read the other |
| Watch mode with a kept browser [S7] | Speed | A warm rerun of one test in 300 ms or less |
| Windows | Reach | A decision first: what stops it today, and whether it is in or out |

Waits on: findings as `passed` or failed by default, `--playwright` as a flag or automatic, and the three suites.

## December 2026: the edges, and agents

| Item | Track | Done when |
| --- | --- | --- |
| Compatibility stage C: network mocking with `route`, the `request` fixture, dialogs, frames and shadow DOM | Compatibility | The compatibility table has no "not yet" row among the members the three suites use |
| Milestone 4: the session API that observes and acts by reference, and a custom launcher for the test process | Core | An agent can open a session, look, act and end it through finite commands, and an MCP adapter serves the same operations |
| Judged checks, `toMeet`, with judge providers [D31 to D33] | AI | A criterion is passed, failed or inconclusive, with the quote that decided it |
| Fast mode: animations and virtual time [S11 to S13] | Speed | Only what facts F2 and F3 allow, always printed in the report |
| Custom reporter adapter [C10] | Compatibility | One third-party Playwright reporter runs unchanged |

Waits on: which judge providers ship first, and whether fast mode is on the command line or for hosts only.

## January 2027: a second browser, and the first phone

| Item | Track | Done when |
| --- | --- | --- |
| Firefox over WebDriver BiDi | Reach | The browser integration tests pass on Firefox, with each unsupported operation refused by name |
| Android: Chrome on a device, then a native app [D5] | Reach | One test taps through a native screen on an emulator and on a real device, with no emulation called a phone |
| Evals, `test.eval`, with gates and baselines [D34 to D40] | AI | An eval over a dataset reports a rate with its interval, and a gate decides the exit code |
| `retest install` [D42] | Core | A pinned browser is fetched only when asked, and every run records its hash |

Waits on: which Android devices are in the lab, and how they are leased.

## February and March 2027: one test across web, mobile and desktop

| Item | Track | Done when |
| --- | --- | --- |
| iOS: Safari and a native app on a simulator [D5] | Reach | The same test file runs on the simulator, labelled as a simulator everywhere |
| Desktop: Electron, then a macOS app [D5] | Reach | A native menu or dialog is driven, which Playwright's Electron support cannot reach |
| One test across apps [D11] | Reach | The README's test runs: a task made on the phone shows on the web and on the desktop |
| WebKit and Safari on macOS | Reach | Safari is driven through Apple's own interface, on a Mac |
| What 1.0 means | Proof | The criteria are written down and agreed |

## Not on this roadmap

- A trace viewer, a UI mode, code generation and component testing. A team that needs them keeps Playwright for them, and the compatibility table says so.
- A Chromium fork, an agent browser, and Rust in the runner. The speed plan's tier 3 says why.
- Anything hosted. That is Rehearsal's, and Retest never imports it.

## What decides the order

- **A host comes first.** Milestone 3 wave 2 is what a host needs before it runs Retest for customers, so it leads October.
- **Running what people have comes before reaching further.** Until a Playwright suite runs, trying Retest costs a rewrite. Stages A to C are that cost coming down.
- **The reach is the reason.** Native apps are where Playwright does not go, and they are the README's promise. They sit in January to March because each platform is new driver work that tokens alone do not buy: devices, simulators, signing and leases.

If the headline matters more than Playwright suites, the first swap is Android from January into November, and compatibility stage B a month later. That is a decision for the founder, and the first one to make.

## Decisions this roadmap waits on

| Decision | Needed by |
| --- | --- |
| Compatibility first, or native first | Before November is planned |
| When 0.1.0 is published | October |
| Parallel by default, or `--workers 1` by default | October |
| A test with findings: `passed`, or failed | November |
| `--playwright` as a flag, or automatic | November |
| The three public Playwright suites | November |
| Windows in or out | November |
| Judge providers for `toMeet` | December |
| The device lab for Android and iOS | January |
