# Playwright compatibility: the subset, the corpus and the same-case table

Phase 3 item 6 of [the 0.1.0 handoff](../release-0.1.0.md): the Playwright subset widened to what the starter test and the straightforward workflow cases need, and the compatibility table generated from same-case comparisons under pinned Playwright and Retest versions. Built and run on 5 October 2026 on macOS arm64 with Google Chrome 154.0.8037.93 and Node.js 24.12.0. The table is [docs/compatibility/playwright.md](../../../compatibility/playwright.md). The comparison was then made stricter after [the review of the conformance cases and the Playwright subset](../reviews/phase-3-review-conformance-playwright.md); the sections below describe it as it is now.

| File | What it holds |
| --- | --- |
| `src/playwright/not-yet.ts` | `selectOption` mapped onto Retest's `select`; a bare string, a list, `{ index }`, `null` and an option named both ways refused by name; `getByRole('row', { name })` refused by name; what `goto`, `reload`, `goBack`, `goForward` and `selectOption` answer refused by name when read |
| `src/playwright/page.ts` (new) | Playwright-shaped `Page`, `Locator`, `Finders` and `Keyboard` types for the members that run, which `@rehearsal-labs/retest/playwright` now exports in place of Retest's own `Page` and `Locator`; `getByRole` refuses a row with a name in its types (`RoleOptionsFor`), as the call is refused when it runs |
| `src/playwright/test.ts`, `src/playwright/index.ts` | The `page` fixture typed with that `Page`; the exports |
| `fixtures/playwright-compat/tests/*.spec.ts` (new) | The corpus: the starter's two tests, 37 workflow cases, and five of those written again with a bare string for `selectOption` (`select-by-text.spec.ts`), as Playwright tests against the task app |
| `fixtures/playwright-compat/cases.ts` (new) | Each case's declared outcome and whether Retest claims it; the four cases not in the corpus and why, each a declared gap |
| `fixtures/playwright-compat/playwright.config.ts`, `operations-reporter.ts`, `playwright-test.d.ts` (new) | The config Playwright runs the corpus with, the reporter that writes every step with its category and line, and the typing that lets the repository typecheck the corpus against the part of Playwright's own API it uses, with Playwright's signatures, not Retest's |
| `scripts/compare-playwright.ts` (new) | Installs the pinned Playwright outside the repository, runs the corpus under it and under `retest run --playwright`, judges every case, writes the table with `--write` |
| `tests/integration/playwright-compat-table.test.ts` (new) | Runs the comparison and fails when a case declared supported differs, when a declared gap has closed, or when Playwright did not do what a case declares |
| `tests/unit/playwright-subset.test.ts`, `tests/unit/playwright-compare.test.ts` (new) | The new mappings and refusals in process; the comparison's reading and judging on recorded inputs, the failure values each runner records, the two runs as wholes, the pinned tarballs' names and checksums |
| `tests/types/fixtures/playwright-finders.ts` (new) | Type markers: a row by name refused, a row by position, a cell by name and a role held in a variable not refused |
| `docs/guide.md` | "Run Playwright test files" brought in line |

## The pinned Playwright

`@playwright/test` 1.63.0, the registry's latest on the day, with `playwright` 1.63.0 and `playwright-core` 1.63.0, all Apache-2.0. The script packs the three with `npm pack --json` into `$TMPDIR/retest-playwright-compat/playwright-1.63.0/packs`, refuses a tarball whose registry checksum is not the pinned one, hashes each tarball itself against its pin, and installs them there with `npm install --offline --ignore-scripts`. The folder is reused while it is the script's own, its record names the same version and checksums, and each tarball in `packs` still hashes to its pinned checksum; its `node_modules` is then removed and installed again from those tarballs, with no network, so what runs is what the checksums cover, whatever was changed under `node_modules` since. A folder it did not make is never removed. No Playwright browser is downloaded: Playwright runs the installed Google Chrome through `launchOptions.executablePath`, the same executable Retest runs.

| Package | Integrity |
| --- | --- |
| `@playwright/test` 1.63.0 | `sha512-oxMK4vllB9RK5NQ2l1pq1IfOf2AvnEuj/vYGDj0H2nMtmtZpKtCwt/l00GEO6xjGfpBNAvjovvYdCm50dRQkpQ==` |
| `playwright` 1.63.0 | `sha512-+7ziBLidS4NaNCdt57SUDT+wYmmd5fmiQejUic/kb+YsYSCPyOOE9sebzMjNmQrsnNpDJqd4WHvV/8lfKfUDUg==` |
| `playwright-core` 1.63.0 | `sha512-rYCsBF/M5HjUch52bbtVONEFjv6Xu8sm8h72dNlR5bzIE1fvC/bxgspzkjSfU+MweEMmPM8KJebG6nnyxo5mCg==` |

Playwright stays out of `package.json` and out of the repository. Two facts were read from its published build, `playwright-core/lib/coreBundle.js` of 1.63.0, and nothing was copied: `selectOptions` matches a string against an option's value or its label, a `{ label }` against the label with spaces trimmed and folded (after dropping zero-width spaces and soft hyphens), takes the first matching option of a single select, and always sets the choice and fires `input` and `change`; `allowsNameFromContent` names a `row` from its content, as it names buttons, cells and links.

## The corpus

- The starter: `assets/example.spec.ts` of `create-playwright` 1.17.139 (Apache-2.0, sha256 `a3cbab846a58843b6350e2cc96801b4b6c41e86880451a68c9a01b149708a042`), the file `npm init playwright` writes. Its tests open `https://playwright.dev/`; the corpus copy opens the task app's `/workflow/site` and uses its texts (`/Home/` for the title, `Projects` for the link and the heading), with the starter's calls, comments and matchers kept and an attribution line at the top.
- The workflow cases of [workflow-cases.md](../workflow-cases.md), families 1, 2 and 4 to 10, each test written as Playwright writes it, with the same steps, checks and intended failures as the Retest integration files. Where Playwright's finders read a label differently, the spec says what Playwright needs: `getByLabel('Password', { exact: true })` on the sign-up form, since a part match also finds "Confirm password". Options are named `{ label }` or `{ value }`. The password comes from `process.env`, as a Playwright suite reads one. The export case releases the held export with `fetch`, as the Retest file does.
- The forms a Playwright test most often takes, which the corpus first left out: a select's option named by its text alone. F4.1, F5.1, F7.1, F7.3 and F9.3 are written again in `select-by-text.spec.ts` with `selectOption('High')` and its like, each a declared gap that Retest refuses by name at that line and Playwright passes. The specs are typed against Playwright's own signatures, so a form Playwright takes and Retest does not can be written, as F8.1's row by name is.
- Not in the corpus, each a declared gap counted among all the cases: family 3, saved sign-in state. Playwright does that through a setup project, `storageState` and project dependencies in `playwright.config.ts` and `page.context().storageState()`; Retest's compatibility reads no `playwright.config.ts` and refuses `test.use` and `page.context` by name, so no straightforward Playwright form of those cases can run.

In the first comparison, Playwright's half ran the specs as first written: 28 passed and the 11 intended failures failed, each in its named step at the line of its named check, as `expect(…) failed` (`/tmp/retest-pwcompat-logs/run-1/playwright/stdout.txt`). No spec changed after that run.

## How a case is judged

Each runner gets its own copy of the corpus folder and a fresh task app; the spec files are compared byte for byte. Playwright reads `playwright.config.ts` (one worker, no retries, a 1.5 second `expect` timeout, the task app as `baseURL`, the Chrome executable); Retest gets the same through `--browser`, `--base-url`, `--workers 1` and `--timeouts assertion=1500`, since it reads no Playwright config. A case is equivalent only when:

1. Playwright did what the case declares. A case Playwright does not end as declared is the corpus at fault, and the gate fails on it.
2. Retest did the same. A failing case counts only in its named step, at the line of its named check, as an assertion (`check_failed`). An `unsupported` refusal is never an equivalent failure.
3. For a failing case, both failed checks expected the same values and received the same values: Playwright's from the `Expected:` and `Received:` lines of its message, or for a list from the diff it prints, Retest's from its failure's `expected` and `received` details, each text trimmed with its runs of spaces read as one. A check that failed for another reason at the same line, such as on stale text, differs, and so does one whose values neither record says.
4. Both ran the same file and went through the same steps, actions and checks at the same lines, in the same order. Playwright's come from its reporter's step tree (`pw:api`, `expect`, `test.step`, hooks looked into, fixtures left out), Retest's from its events (`action.*`, `assertion.*`, `step.started`). A run that skipped a check, or sent an action the other did not, differs.

Whatever the cases, the comparison fails when Retest's run fails outside any test, such as a browser it could not close, when either runner is ended by a signal, or when the two exit with different codes. The integration wrapper fails on the same, when a case declared supported is not equivalent, when a case declared a gap has become equivalent, when Playwright did not do what a case declares, and when the case list of `docs/compatibility/playwright.md` no longer matches the runs, so neither the declarations nor the table can drift from what runs. The table's "with uncommitted changes" counts untracked source files too.

## What the runs showed

| Run | Command | Result | Log |
| --- | --- | --- | --- |
| Table | `lockf -t 0 /tmp/retest-heavy-gate.lock node --conditions=retest-source scripts/compare-playwright.ts --work /tmp/retest-pwcompat-logs/run-5 --write` | exit 0 | `/tmp/retest-pwcompat-logs/compare-5.log`, work folder `/tmp/retest-pwcompat-logs/run-5` |
| Wrapper | `lockf -t 0 /tmp/retest-heavy-gate.lock node --conditions=retest-source --test tests/integration/playwright-compat-table.test.ts` | 1 of 1 passed | `/tmp/retest-pwcompat-logs/integ-table-3.log` |

- 39 cases collected by each runner. Playwright did what each declares, 39 of 39. Retest matched Playwright in 38 of 39: every passing case but F8.1, and all 11 intended failures, each at the same line, step and class, with the same operations.
- F8.1, the declared gap: Playwright finds the row named "Grace Hopper grace@example.com Editor 12" and Retest refuses `getByRole('row', { name })` at line 24 as `unsupported`. Both runs went through the same nine operations before it.
- The first comparison, `run-1` under `/tmp/retest-pwcompat-logs/`, read Playwright's `/private/var/…` file names against `/var/…` and judged no case (`compare-1.log`); fixed by reading the copy's real path. The four comparisons after it, `run-2` to `run-5`, gave the same 39 verdicts each.
- In `run-1` and in `run-3`, Retest's run itself ended `cleanup_failed`, exit 2, outside any test: "Closing the run's browsers: Recorded process 86737 has a different identity (recorded descendant; command reading changed; host state S to S; original command differed from its recorded parent), so it was left alone." (99303 in `run-3`). Both processes were gone when looked for afterwards. It is the runner's process check when it closes Chrome, outside this lane. The comparison then judged `run-3` to hold, since it looked at the cases alone; it now fails such a run, and one whose two runners exit with different codes.

## The stricter comparison

Made after the review, under the same Playwright, Chrome and Node.js, with the tree at `b59eed5` and the other lanes' uncommitted work:

| Run | Command | Result | Log |
| --- | --- | --- | --- |
| 1 | `lockf -t 0 /tmp/retest-heavy-gate.lock node --conditions=retest-source scripts/compare-playwright.ts --work /tmp/retest-fix-k/pwcompare/run-1 --write` | exit 0 | `/tmp/retest-fix-k/pwcompare/compare-1.log` |
| 2 | the same with `--work /tmp/retest-fix-k/pwcompare/run-2`, without `--write` | exit 0 | `/tmp/retest-fix-k/pwcompare/compare-2.log` |
| 3 | the same with `--work /tmp/retest-fix-k/pwcompare/run-3 --write`, which wrote the table | exit 0 | `/tmp/retest-fix-k/pwcompare/compare-3.log` |
| Wrapper | `lockf -t 540 /tmp/retest-heavy-gate.lock node --conditions=retest-source --test tests/integration/playwright-compat-table.test.ts`, with its new checks of the two runs as wholes | 1 of 1 passed; an earlier attempt stopped at import while another lane was editing the Firefox driver | `/tmp/retest-fix-k/pwcompare/wrapper-2.log` |

- Each run reused the install after hashing its three tarballs, and installed `node_modules` again from them.
- 48 cases in the fixed list, 44 in the corpus, collected 44 by each runner. Playwright did what each declares, 44 of 44. 38 of 44 equivalent, the same 38 in all three runs: every passing case but F8.1 and the five bare-string forms, and all 11 intended failures, each at the same line, step and class and on the same expected and received values.
- Declared gaps: 10 of 48: F8.1, the five bare-string forms, each refused by name at its `selectOption` line, and the four family 3 cases not in the corpus. Each corpus gap still held.
- In every run both runners exited 1, and Retest's run did not fail outside a test. The case rows of the three tables are identical.
- `/tmp/retest-fix-k/c14-probe.ts`, on a copy of the install: a line added to `node_modules/playwright/index.js` after the install was gone after reuse, since the folder was installed again from its tarballs, and one byte added to a tarball made it fail its check (`/tmp/retest-fix-k/c14-probe.log`). The old reuse trusted the record and the manifests' versions alone.

## Mapping decisions

- `selectOption({ label })` and `selectOption({ value })` map exactly onto Retest's `select('…')` and `select({ value })`: the same option is chosen whenever exactly one option carries the label or the value, and labels are compared the same way. Where they part, Retest fails and Playwright passes, never the other way round: several options with the label (Playwright takes the first, Retest refuses it as ambiguous), a select covered by another element, and a `<label>` element given in place of its select. Retest also chooses with the keyboard, so the page hears key events, and sends nothing when the option is already chosen, where Playwright fires `input` and `change` again; the guide lists both.
- A bare string is refused: Playwright reads it as a value or a label, and a page where one option's value is another option's label would be chosen differently. Matching it exactly needs a value-or-label choice in the option protocol and its page matcher, in `src/protocol` and `src/browser`, which other lanes are editing now.
- `getByRole('row', { name })` is refused rather than found empty. Chrome gives a row no name from its cells, so `toHaveCount(0)` or `toBeHidden()` on a named row would pass on Retest and fail on Playwright. The guide used to list this as a difference "no check asks for"; it is now a refusal by name, as the shadow-root rule is.
- The response of `goto`, `reload`, `goBack` and `goForward` and the values of `selectOption` were `undefined` under Retest. They are now a value that fails by name when read. The call's promise is wrapped so that its own `then` still runs only when the test awaits it, which keeps Retest's not-awaited check working; a unit test holds that.

## What was not verified

- Linux: the comparison and the wrapper ran on macOS arm64 only. In the Linux container the wrapper needs the registry for its first install, and Playwright's Chrome launch there was not tried.
- The starter as published, against `https://playwright.dev/`: not run. The corpus runs the starter's calls and matchers against the task app instead.
- Firefox and WebKit: not in this lane; the comparison runs Chrome.
- Retest's default viewport against Playwright's 1280 by 720: not compared, and not recorded in the table.
- Families 1 to 10 beyond the cases listed, upstream Playwright browser tests and real product suites: none was run.
- `playwright.config.ts` is still not read, `test.skip`, `test.only` and `test.use` are still refused, and Retest's test and action budgets are still its own; none of the corpus needed them.
