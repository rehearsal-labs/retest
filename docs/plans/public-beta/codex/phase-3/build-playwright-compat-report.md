# Build report: the Playwright subset and the compatibility table

Lane brief: `docs/plans/public-beta/codex/phase-3/build-playwright-compat.md`. Nothing was committed.

## 1. What was built

- `src/playwright/not-yet.ts`: `locator.selectOption({ label })` and `({ value })` map onto Retest's `select`, with `{ timeout }`; a bare string, a list, `{ index }`, `null`, an option named both ways and any other option (`force`, `noWaitAfter`) are refused by name. `getByRole('row', { name })` is refused by name on a page and on a locator (Chrome names no row from its cells, Playwright does; a `toHaveCount(0)` would otherwise pass falsely). What `goto`, `reload`, `goBack`, `goForward` and `selectOption` answer is now a value that fails by name when read, through a promise wrapper that keeps Retest's not-awaited detection.
- `src/playwright/page.ts` (new): Playwright-shaped `Page`, `Locator`, `Finders`, `Keyboard`, `SelectOptionChoice`, `Unanswered` types; `src/playwright/index.ts` exports them in place of Retest's own `Page`/`Locator`; `src/playwright/test.ts` types the `page` fixture with them.
- `fixtures/playwright-compat/` (new): `tests/*.spec.ts`, the corpus (the starter's two tests adapted from create-playwright 1.17.139 with attribution, and 37 workflow cases of families 1, 2, 4 to 10); `cases.ts`, declared outcome and support for each case plus the four family 3 cases kept in the count as not in the corpus; `playwright.config.ts`; `operations-reporter.ts`, a Playwright reporter that writes each step's category and line; `playwright-test.d.ts`, which types `@playwright/test` as Retest's compatibility subpath so the repository typechecks the corpus.
- `scripts/compare-playwright.ts` (new): packs `@playwright/test`, `playwright` and `playwright-core` 1.63.0 into `$TMPDIR/retest-playwright-compat/playwright-1.63.0` (checksums pinned, `--offline --ignore-scripts`), runs the corpus under Playwright and under `retest run --playwright` in the same Chrome against a fresh task app each, judges each case (outcome, step, line and class of an intended failure, same bytes, same sequence of steps, actions and checks by line), writes `docs/compatibility/playwright.md` with `--write`.
- `docs/compatibility/playwright.md` (new, generated).
- `tests/integration/playwright-compat-table.test.ts` (new): fails when a case declared supported differs, a declared gap has closed, Playwright did not do what a case declares, or the table's case list no longer matches the runs.
- `tests/unit/playwright-subset.test.ts`, `tests/unit/playwright-compare.test.ts` (new).
- `docs/plans/public-beta/proofs/playwright-compat.md` (new), the record.
- `docs/guide.md`: "Run Playwright test files" lists exactly what is mapped and what is refused, and what still differs.

## 2. Commands and results

- `lockf -t 0 /tmp/retest-heavy-gate.lock node --conditions=retest-source scripts/compare-playwright.ts --work /tmp/retest-pwcompat-logs/run-5 --write`: exit 0, wrote the table. Log `/tmp/retest-pwcompat-logs/compare-5.log`. Earlier runs `run-1` to `run-4` (`compare-1.log` to `compare-4.log`): `run-1` judged no case (a `/private` path mismatch, fixed); `run-2` to `run-4` the same 39 verdicts as `run-5`.
- `lockf -t 0 /tmp/retest-heavy-gate.lock node --conditions=retest-source --test tests/integration/playwright-compat-table.test.ts`: 1 of 1 passed. Log `/tmp/retest-pwcompat-logs/integ-table-3.log`. Earlier: `integ-table-1.log` 1 of 1 passed; `integ-table-2.log` cancelled when the orchestrator stopped the lanes.
- `lockf -t 0 /tmp/retest-heavy-gate.lock node --conditions=retest-source --test --test-concurrency=1 tests/integration/playwright-compat.test.ts tests/integration/browser-playwright-rules.test.ts`: 7 of 7 passed (the existing Playwright integration tests, unchanged). Log `/tmp/retest-pwcompat-logs/integ-compat-1.log`.
- `lockf -t 0 /tmp/retest-heavy-gate.lock npm run typecheck`: exit 2 with 6 errors, all in other lanes' in-flight files (`src/browser/webkit/connection.ts`, `storage.ts`, `target-session.ts`, `src/diagnostics/webkit-collector.ts`, `src/cli/install/doctor-rows.ts`), none in this lane's; TypeScript 7 and the examples project did not run after the first compiler failed. Log `/tmp/retest-pwcompat-logs/typecheck-1.log`. A scoped check of this lane's files (`src/playwright`, `fixtures/playwright-compat`, the script and the three test files, with the repository's compiler options) under the lock: clean on TypeScript 6.0.3 and 7.0.2 (`/tmp/retest-pwcompat-logs/tsc-scoped-4.log`).
- `node --conditions=retest-source --test tests/unit/playwright-compat.test.ts tests/unit/playwright-subset.test.ts tests/unit/playwright-compare.test.ts`: 36 of 36 passed. Log `/tmp/retest-pwcompat-logs/unit-pw-4.log`.
- `npm run test:unit`: 2769 of 2773 passed (`/tmp/retest-pwcompat-logs/unit-full-1.log`). The 4 failures are not this lane's: 2 in `tests/unit/playwright-resolve.test.ts` (the founder's resolve hook tries `.tsx` and `.jsx`; progress.md leaves that test to the founder, so I did not touch it) and 2 in `tests/unit/cli-help.test.ts` (the builds lane's new `install` command, in flight).
- `npm run test:types`: 234 of 234 markers matched on TypeScript 6.0.3 and 7.0.2 (`/tmp/retest-pwcompat-logs/types-1.log`).

## 3. Pinned Playwright and the table

- `@playwright/test` 1.63.0 `sha512-oxMK4vllB9RK5NQ2l1pq1IfOf2AvnEuj/vYGDj0H2nMtmtZpKtCwt/l00GEO6xjGfpBNAvjovvYdCm50dRQkpQ==`, `playwright` 1.63.0 `sha512-+7ziBLidS4NaNCdt57SUDT+wYmmd5fmiQejUic/kb+YsYSCPyOOE9sebzMjNmQrsnNpDJqd4WHvV/8lfKfUDUg==`, `playwright-core` 1.63.0 `sha512-rYCsBF/M5HjUch52bbtVONEFjv6Xu8sm8h72dNlR5bzIE1fvC/bxgspzkjSfU+MweEMmPM8KJebG6nnyxo5mCg==`, Apache-2.0. Installed at `/var/folders/cf/hbr10kkn105g2k3zchmt0w8w0000gn/T/retest-playwright-compat/playwright-1.63.0`. No Playwright browser downloaded; both runners used Google Chrome 154.0.8037.93.
- Table summary: 43 cases in the fixed list, 39 in the corpus, 4 (family 3) not in it. Collected 39 by each runner. Playwright as declared 39 of 39. Equivalent 38 of 39: 27 of 28 passing cases, 11 of 11 intended failures at the same line, step and class with the same operations. Declared supported 38, all equivalent; declared gap 1 (F8.1, `getByRole('row', { name })` refused), still a gap. No retries, no skips.

## 4. Artifacts

- `/tmp/retest-pwcompat-logs/run-5/`: both corpus copies, Playwright's step report `playwright-operations.json`, Playwright's output `playwright/` and `playwright-results/`, Retest's run folder `retest-run/` (events, result, failure screenshots), `comparison.json`, `playwright.md`.
- `/Users/dragon/Documents/Projects/Gruvi/Products/retest/docs/compatibility/playwright.md`.

## 5. Not verified, most important first

- Retest's own run ended `cleanup_failed` (exit 2, outside any test) in 2 of 5 comparison runs (`run-1`, `run-3`): the runner's process-identity check refused to close a Chrome process whose command reading changed; the process was gone afterwards. Runner code, outside this lane; per-case results were unaffected.
- Linux: the comparison and wrapper ran on macOS arm64 only; the wrapper needs the npm registry on first install.
- The published starter against `https://playwright.dev/` was not run; the corpus adapts it to the task app.
- A bare-string `selectOption('High')`, the most common form, stays refused: exact mapping needs a value-or-label option choice in `src/protocol` and the page matcher in `src/browser`.
- `playwright.config.ts`, `test.skip`/`test.only`/`test.use` and Playwright's default budgets are not mapped; the corpus did not need them.
- `npm run build` was not run (dist is shared with other lanes); the typecheck covers declaration emit.
- Firefox and WebKit: not in this lane.

## 6. Existing files changed, and environment

- Changed: `src/playwright/not-yet.ts`, `src/playwright/test.ts`, `src/playwright/index.ts`, `docs/guide.md` (the Playwright section only). `src/loader/resolve.ts`, `src/browser/**`, `src/runner/**`, `src/api/**`, `fixtures/task-app/**` and `package.json` untouched.
- No dependency, script or package change. Outside the repository: the pinned Playwright install above, my exploration folders there removed, logs under `/tmp/retest-pwcompat-logs/`.
- `docs/plans/public-beta/inventory.md` rows for the adapter (selectOption hint, defaults, same-case table missing) are now stale; it is not this lane's file.
