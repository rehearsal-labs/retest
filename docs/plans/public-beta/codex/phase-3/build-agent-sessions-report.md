# Agent sessions lane report

Phase 3 item 5. Built 5 October 2026 by an Opus builder. Nothing committed.

## What was built

- `src/agent/host.ts`: `AgentHost`. Named targets, each on one engine. A target's browser is launched once by that engine's own driver, and every session opens in a new context of it. `open` refuses a target on another engine, and closes and refuses a browser that states another engine. It acquires named locks and one session through `acquireResources`, with the same `SessionBudget` and `hostResources` a test run uses, and holds the lease. `stop(reason)` ends every session and withdraws waiting opens. `close()` ends sessions and closes every browser it launched, lost ones included. Options and open requests are validated whole.
- `src/agent/session.ts`: `AgentSession`.
  - Calls: `act` (the page commands a test sends, by `locator` or by a look's `ref`, answering with `input` from the driver's `dispatch`), `observe`, `observePage`, `recipe`, `check`, `saveState`, `frame`, `frameSource` and `end`.
  - Lanes: one action at a time, and no look while an action runs; frames run beside anything. Every call has a budget, cut by the session's `holdMs` (ten minutes by default).
  - Ending: a held-too-long, stopped or lost session stops the calls in flight, closes its context within the cleanup budget and gives its session back. A context that will not close keeps its session until its browser closes.
  - Every answer is redacted. Secret fills go through the runner's `SecretFiller`.
- `src/agent/looks.ts`: a session's looks and element references `{ sessionId, observationId, element }`. A reference is refused, and nothing is sent, when it belongs to another session, names a look never served or no longer kept (the last 32 are kept), was taken on an earlier document or names a place past the list. It is also refused when a fresh read of the look's locator lists other matches.
- `src/agent/recipes.ts`: a reference becomes a durable recipe only by naming what it matched. The recipe keeps no match by place, finds exactly one element with the same text and visibility, and no other element of the look shows the same.
- `src/agent/checks.ts`: a host's required check run on the session's page. Its identity comes from the runner's own `Requirements.forTest`, a frozen requirement refuses a changed check by name, and a late page read is looked at again.
- `src/agent/targets.ts`: `AgentTarget`, the drivers' own launchers (`driverLaunchers`) and the engine a browser states.
- `src/agent/index.ts`: the exports.
- Tests:
  - `tests/unit/agent-fakes.ts` (fake browser), `tests/unit/agent-looks.test.ts`, `agent-recipes.test.ts`, `agent-host.test.ts`, `agent-session.test.ts` and `agent-checks.test.ts`: 64 unit tests.
  - `tests/integration/agent-harness.ts`, `agent-sessions.test.ts`, `agent-participants.test.ts` and `agent-capacity.test.ts`: 16 cases on a real browser, one of them a host program that runs `runFiles` and an agent host on one budget.
  - `tests/integration/agent-firefox.test.ts` and `agent-webkit.test.ts`: the same suites through `tests/integration/engines.ts`.
- `docs/plans/public-beta/proofs/agent-sessions.md`: the record, with decisions, the gate table, driver findings and what is not done.
- The guide's `### Agent sessions` section in `docs/guide.md`.

## Commands and results

| Command | Result | Log |
| --- | --- | --- |
| `node --conditions=retest-source --test tests/unit/agent-*.test.ts` | 64 pass, 0 fail | `/tmp/retest-agent-unit.log` |
| `npm run test:unit` | 2984 pass, 2 fail (before the 64th agent test was added); both failures are the known `tests/unit/playwright-resolve.test.ts` ones, outside this lane | `/tmp/retest-agent-unit-full.log` |
| ten mutations of the rules, each against its unit file (`python3 /tmp/retest-agent-mutate.py`) | 10 of 10 caught, sources restored, 63 pass after (the 64th was added later) | `/tmp/retest-agent-unit-after-mutations.log` |
| `lockf -t 0 /tmp/retest-heavy-gate.lock` with `tsc -p /tmp/retest-agent-tsconfig.json` (the lane's files and their imports) on TypeScript 6.0.3 and 7.0.2 | lane files clean on both; the only error is `src/browser/webkit/select.ts(35,14)` TS2375, the WebKit lane's file | `/tmp/retest-agent-tsc.log` |
| `lockf -t 0 /tmp/retest-heavy-gate.lock npm run typecheck` (got the lock on the sixth try, a minute apart) | exit 0: TypeScript 6.0.3 and 7.0.2 on the whole project, and the examples, no errors | `/tmp/retest-agent-typecheck-full.log` |
| `node --conditions=retest-source --test --test-concurrency=1 tests/integration/agent-sessions.test.ts tests/integration/agent-participants.test.ts tests/integration/agent-capacity.test.ts` (Chrome) | 15 pass, 1 skipped (the refusal case: Chrome gives a frame source) | `/tmp/retest-agent-integration-chrome-final.log` |
| `node --conditions=retest-source --test tests/integration/agent-firefox.test.ts`, twice | 15 pass, 1 skipped (the Chrome screencast case), both runs | `/tmp/retest-agent-integration-firefox-final-1.log`, `-2.log` |
| `node --conditions=retest-source --test tests/integration/agent-webkit.test.ts` | 15 pass, 1 skipped | `/tmp/retest-agent-integration-webkit-final.log` |
| earlier Firefox runs, before the final ones | failures recorded in the record's findings: input lost across contexts, label and role looks throwing in the driver, a check's last read | `/tmp/retest-agent-integration-firefox.log`, `/tmp/retest-agent-integration-firefox-2.log`, `/tmp/retest-agent-participants-firefox.log` |

No `npm run test:integration`, `npm run test:types` or benchmark was run. Before the first full unit run, `pgrep -f benchmarks/run.ts` matched one process (pid 41949) that was gone a moment later and could not be identified; every later match was another session's shell whose command line held the pattern's text, and no benchmark process was seen.

## Item 5 verification bullets

| Bullet | Chrome | Firefox | WebKit |
| --- | --- | --- | --- |
| Distinct discovery and reproduction sessions | met | met | met |
| Saved-auth reuse | met | met | met |
| Two-account object handoff | met | met | met |
| Four-session isolation | met | met | met |
| Owner and host capacity (one budget with tests) | met | met | met |
| Stable required-check identity (across sessions, and equal to a test's) | met | met | met |
| Phase 3 bullet: real targets, stale refs refused, resources released under timeout, stop and disconnect | met | met | met |
| Frame access | frame and live source met | frame met; live source refused by name (the driver gives none) | frame met; live source refused by name (the driver's `webKitFrameSource` is outside the contract) |

Firefox's "met" rests on the final two runs. Earlier runs in this lane failed on Firefox driver defects that were being changed at the time; see below.

## What I could not verify

1. Whether Firefox's loss of typed input across contexts is fixed. Fills answered `sent` while the field stayed empty, in two probes and two test runs. The final two runs passed after the Firefox lane edited `input.ts`, which is not proof the cause is gone.
2. Firefox `getByLabel` and `getByRole('textbox')` threw in the driver during this lane (`/tmp/retest-agent-probe/role.ts`). The agent flows look for fields by test id, so the label rule is unverified through agent sessions on Firefox.
3. A live frame source on Firefox and WebKit. Neither driver gives one through the contract.
4. Package use. There is no `./agent` subpath, so the API was exercised from source only, never from a packed package or outside the checkout.
5. The gates on a quiet tree: other lanes were mid-edit while every gate here ran.
6. Linux. Everything ran on macOS arm64 only.
7. Rehearsal's own use of the API (Phase 5).

## Existing files changed

- `docs/guide.md`, two anchored edits: the new `### Agent sessions` section after `### Session limits`, and the line in "What Retest does not do yet" that said there is no agent session API.

Nothing else existing was changed. No dependency, script, `package.json` or environment change.

## Changes needed elsewhere

- `package.json`: add `"./agent": { "retest-source": "./src/agent/index.ts", "types": "./dist/agent/index.d.ts", "default": "./dist/agent/index.js" }` to `exports`, so the API is importable from the package.
- `src/protocol/events.ts` (optional): event types for agent operations, if agent sessions should leave a record in a run folder.
- `src/protocol/identity.ts`: a `webkit` capture source name, so the WebKit driver's screencast can be the contract's `frameSource` and an agent session can hand it out.
- Firefox driver (`src/browser/firefox/`):
  - `getByLabel` should find a labelled password field. It finds labelled fields through roles, and a password field has none.
  - The `Accessibility.queryAXTree` answer-shape error on label and role looks.
  - A `fill` must not answer `sent` for text that never arrived when several contexts are open.
- Chromium (`src/browser/chromium-process.ts` or `src/shared/process-ownership.ts`): `close()` after the main process was killed from outside throws "contains processes whose launch ownership could not be verified" while the group is empty. Reproduction: `/tmp/retest-agent-probe/chrome-close.ts`.
- A browser-level page survey command (role, accessible name and test id per element, in `src/browser/**`), if Rehearsal's discovery should read a page in one look rather than one locator at a time.
