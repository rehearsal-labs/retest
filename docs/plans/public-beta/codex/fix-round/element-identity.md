Lane "element-identity": node identity for agent references and recipes on all three browser engines. It follows from review findings A-1 and A-4 (docs/plans/public-beta/reviews/phase-3-review-install-agent.md): a reference or a recipe may be accepted only when the element is proven to be the same node, never because it shows the same text. The agent fix lane made the agent refuse by name wherever identity cannot be proven, which today is every engine: a reference acts only when its look listed that one element, and a recipe is only the look's own locator finding one element. Rehearsal's discovery acts by reference inside looks that list many elements, so this lane must land before Phase 5. Starts only after the runner fix lane, the WebKit fix lane and the Firefox fix lane have finished. Repository: /Users/dragon/Documents/Projects/Gruvi/Products/retest.

Read first: AGENTS.md; the "Architecture rules" and invariants list of docs/plans/public-beta/release-0.1.0.md and its Phase 3 item 5; the "Agent sessions" part of docs/plans/public-beta/releases.md; docs/plans/public-beta/proofs/agent-sessions.md and the agent fix lane's report (/tmp/retest-reviews/fix-agent-report.md, or its section in the record); src/agent/identity.ts (`ElementIdentity`, `hasElementIdentity`: the agent already consumes the two methods below, detected structurally on the page, proven on a fake only).

The contract the agent consumes:

```ts
readElements(locators: readonly LocatorRecipe[], timeoutMs: number, signal?: AbortSignal): Promise<
  { ok: true; reads: readonly { observation: Observation; keys: readonly string[] }[]; page?: PageFacts } | { ok: false; failure: Failure }>
// Reads each locator's matches exactly as `observe` does, all in one task of the current main-frame document, sends no input,
// and gives each listed element a key: the same key for the same node in every read of that document, never another node's key,
// and a key from an earlier document matches nothing. keys.length === observation.items.length.

dispatchTo(command: BrowserCommand, key: string, timeoutMs: number, signal?: AbortSignal, commandToken?: number): Promise<DispatchedCommand>
// As dispatch, but in the task that readies the element (the same task as the hit test) the locator's one match must be the
// node `key` names; otherwise refuse at once (no retry in the actionability wait) as not_actionable,
// details { refused: 'moved', inputSent: false }, input 'not_sent'.
```

Deliver, on Chrome, Firefox and WebKit:
1. src/browser/page-scripts.ts: a keyed observe (the same `resolve` helper as the plain observe, several queries in one call, keys from a WeakMap of elements on Retest's own world, prefixed with a per-document counter so a key from an earlier document matches nothing), and a prepare that takes the expected element and answers a new status `moved` before it focuses, scrolls or arms anything.
2. src/browser/locate.ts: the several-locator form of the locator arguments (role and label steps find their elements per locator in the same scope).
3. `readElements` and `dispatchTo` on each engine's page (src/browser/page.ts for Chromium through its own world, src/browser/firefox/page.ts through its sandbox realm, src/browser/webkit/page.ts through its isolated world), each mapping `moved`; and `ElementIdentity` added to src/browser/contract.ts so drivers implement it by name.
4. The agent's refusals lifted where identity is now proven: the integration cases that assert `session.pinsElements === false` fail by design on an engine that now pins; update each to assert the real behaviour on the real browser: a reference to one of several twins acts on exactly that node; after a re-sort of identical matches the action is refused as `moved` with no input sent; a recipe that names another element with the same text is refused; a key from an earlier document is refused.
5. Nothing loosens: an uncertain action is never sent again, the actionability checks and the input guard stay the shared code, and a driver that cannot prove identity keeps refusing by name.

Files you own: src/browser/page-scripts.ts, src/browser/locate.ts, the two methods and their mapping in src/browser/page.ts, src/browser/firefox/page.ts and src/browser/webkit/page.ts (small anchored additions; change nothing else in those files), src/browser/contract.ts (additive), the unit tests of these, tests/integration/agent-*.test.ts for point 4, the agent section of the guide and docs/plans/public-beta/proofs/agent-sessions.md. src/agent/** only where a refusal is lifted.

Rules: never commit, push, stash, checkout, reset or discard; never touch docs/roadmap.md, docs/plans/speed/handoff.md or pnpm-lock.yaml; `pgrep -f benchmarks/run.ts` before any test and never run `npm run bench`; heavy gates and anything that starts a real browser only through `lockf -t 0 /tmp/retest-heavy-gate.lock <command>`; unit files need no lock; capture gate output to a file and read it after; zero runtime npm dependencies; no `any`, no ts-ignore, no widening to unknown; never end a process your own code did not launch and record; plain words and no estimated dates, durations or plan codes in anything you write. Nothing may loosen what a passing test means; every behaviour is shown by a test on the real browser, and the shared suites and the conformance run are re-run on all three engines to show the shared page scripts changed nothing else.

Report: what was built by path; the tests and their results per engine; exact gate commands and results with log paths; what you could not verify, most important first; every file changed. Save the same report to /tmp/retest-reviews/element-identity-report.md. If your context is ever cut, this file is where your brief lives.
