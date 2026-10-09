/**
 * The fixed corpus of the Playwright comparison: each case as `scripts/compare-playwright.ts` runs it, once under a
 * pinned Playwright and once under Retest's compatibility, from the same file. A case is Playwright's starter test or
 * one of the basic workflow cases of docs/compatibility/workflow-cases.md, written as a Playwright test against
 * the task app. `outcome` is what the case is written to do: pass, or fail in its named step at the line of its named
 * check with an assertion failure. `support` is what Retest claims for it; a claimed case whose two runs differ fails
 * the comparison, and so does a case declared a gap that has stopped being one.
 */

/** What a case is written to do. A failing case names its step and the text of the check it fails at. */
export type DeclaredOutcome =
  | { readonly status: 'passed' }
  | { readonly status: 'failed'; readonly step: string; readonly operation: string; readonly failure: 'assertion' }

/** Whether Retest claims the case runs as Playwright runs it, or the gap that keeps it from doing so. */
export type Support = { readonly supported: true } | { readonly supported: false; readonly gap: string }

export type CompatibilityCase = {
  readonly id: string
  /** The spec file, from the corpus folder. */
  readonly file: string
  /** The test's title, which is the case's test name. */
  readonly name: string
  readonly outcome: DeclaredOutcome
  readonly support: Support
  /** For a case that writes another case again in a form Playwright takes and Retest refuses: that case's id. */
  readonly variantOf?: string
}

/** A case of the fixed list that the corpus does not hold, and why: it stays in the count. */
export type UnavailableCase = { readonly id: string; readonly name: string; readonly reason: string }

/** Where the corpus comes from, for the table's header. */
export const corpusSources = {
  starter: {
    corpusFile: 'tests/starter.spec.ts',
    package: 'create-playwright',
    version: '1.17.139',
    file: 'assets/example.spec.ts',
    sha256: 'a3cbab846a58843b6350e2cc96801b4b6c41e86880451a68c9a01b149708a042',
    license: 'Apache-2.0',
    change: "the task app's address and texts in place of playwright.dev's",
  },
  workflow: 'docs/compatibility/workflow-cases.md',
} as const

const passes: DeclaredOutcome = { status: 'passed' }
const supported: Support = { supported: true }

function failsAt(step: string, operation: string): DeclaredOutcome {
  return { status: 'failed', step, operation, failure: 'assertion' }
}

export const compatibilityCases: readonly CompatibilityCase[] = [
  { id: 'S.1', file: 'tests/starter.spec.ts', name: 'has title', outcome: passes, support: supported },
  { id: 'S.2', file: 'tests/starter.spec.ts', name: 'get started link', outcome: passes, support: supported },

  { id: 'F1.1', file: 'tests/navigation.spec.ts', name: 'opens pages by link, by a moved address and by an absolute address', outcome: passes, support: supported },
  { id: 'F1.2', file: 'tests/navigation.spec.ts', name: 'a reload keeps the saved name and loses the unsaved draft', outcome: passes, support: supported },
  { id: 'F1.3', file: 'tests/navigation.spec.ts', name: 'a section opened by a client-side route survives a reload', outcome: passes, support: supported },
  {
    id: 'F1.4',
    file: 'tests/navigation.spec.ts',
    name: 'a menu link that leads to the wrong page fails at the heading check',
    outcome: failsAt('open settings from the menu', "toHaveText('Settings')"),
    support: supported,
  },

  { id: 'F2.1', file: 'tests/sign-in.spec.ts', name: 'signs in with the password and lands on the account page', outcome: passes, support: supported },
  { id: 'F2.2', file: 'tests/sign-in.spec.ts', name: 'a wrong password shows an error and leaves the person signed out', outcome: passes, support: supported },
  { id: 'F2.3', file: 'tests/sign-in.spec.ts', name: 'signing out ends the session', outcome: passes, support: supported },
  {
    id: 'F2.4',
    file: 'tests/sign-in.spec.ts',
    name: 'a sign-out that keeps the session fails at the signed-out check',
    outcome: failsAt('the account page shows signed out', "toHaveText('Signed out')"),
    support: supported,
  },

  { id: 'F4.1', file: 'tests/create.spec.ts', name: 'adds a task with a title, notes and a priority', outcome: passes, support: supported },
  { id: 'F4.2', file: 'tests/create.spec.ts', name: 'Enter in the title field adds the task with the default priority', outcome: passes, support: supported },
  { id: 'F4.3', file: 'tests/create.spec.ts', name: 'refuses a second task with the same title and keeps what was typed', outcome: passes, support: supported },
  {
    id: 'F4.4',
    file: 'tests/create.spec.ts',
    name: 'a save that drops the last character fails at the listed title',
    outcome: failsAt('the new task is listed with its title', "toHaveText('Release checklist')"),
    support: supported,
  },

  { id: 'F5.1', file: 'tests/edit-delete.spec.ts', name: 'edits a task and the change survives a reload', outcome: passes, support: supported },
  { id: 'F5.2', file: 'tests/edit-delete.spec.ts', name: 'asks before deleting, keeps the task on cancel and removes it on confirm', outcome: passes, support: supported },
  {
    id: 'F5.3',
    file: 'tests/edit-delete.spec.ts',
    name: 'an edit the server never keeps fails after the reload',
    outcome: failsAt('the change survives a reload', "toHaveText(['Write release notes', 'Book venue', 'Order name badges'])"),
    support: supported,
  },
  {
    id: 'F5.4',
    file: 'tests/edit-delete.spec.ts',
    name: 'a delete that removes the wrong row fails at the remaining list',
    outcome: failsAt('only the deleted task is gone', "toHaveText(['Write release notes', 'Order badges'])"),
    support: supported,
  },

  { id: 'F6.1', file: 'tests/validation.spec.ts', name: 'a form with only a name shows the email, password and terms errors, and sends nothing', outcome: passes, support: supported },
  {
    id: 'F6.2',
    file: 'tests/validation.spec.ts',
    name: 'each wrong value gets its own message, fixing a field clears only its own, and a valid form is accepted',
    outcome: passes,
    support: supported,
  },
  { id: 'F6.3', file: 'tests/validation.spec.ts', name: 'an email the server knows is refused beside its field, and the typed values stay', outcome: passes, support: supported },
  {
    id: 'F6.4',
    file: 'tests/validation.spec.ts',
    name: 'a form that accepts a short password fails at the password error',
    outcome: failsAt('the short password is refused', "toHaveText('Use at least 8 characters')"),
    support: supported,
  },

  {
    id: 'F7.1',
    file: 'tests/selection.spec.ts',
    name: 'chooses a plan, ticks a box and picks a theme, and the saved choices come back after a reload',
    outcome: passes,
    support: supported,
  },
  { id: 'F7.2', file: 'tests/selection.spec.ts', name: 'unticks a ticked box, chooses by value, and a second radio replaces the first', outcome: passes, support: supported },
  { id: 'F7.3', file: 'tests/selection.spec.ts', name: 'the Business plan shows a seats choice that the other plans hide', outcome: passes, support: supported },
  {
    id: 'F7.4',
    file: 'tests/selection.spec.ts',
    name: 'a save that ignores a checkbox fails at the saved summary',
    outcome: failsAt('the saved preferences match the form', "toHaveText('Saved plan=free seats=none updates=on summary=on alerts=on theme=light')"),
    support: supported,
  },

  {
    id: 'F8.1',
    file: 'tests/lists.spec.ts',
    name: 'reads the table row by row and finds a member by name',
    outcome: passes,
    support: {
      supported: false,
      gap: "Retest refuses getByRole('row', { name }) by name: Chrome's accessibility tree gives a table row no name from its cells, where Playwright names it from them.",
    },
  },
  { id: 'F8.2', file: 'tests/lists.spec.ts', name: 'sorts the table by name one way and then the other', outcome: passes, support: supported },
  { id: 'F8.3', file: 'tests/lists.spec.ts', name: 'finds an invoice far down a long list and opens it', outcome: passes, support: supported },
  {
    id: 'F8.4',
    file: 'tests/lists.spec.ts',
    name: 'a sort that compares numbers as text fails at the sorted column',
    outcome: failsAt('the open tasks go from fewest to most', "toHaveText(['3', '4', '9', '10', '12', '25'])"),
    support: supported,
  },

  { id: 'F9.1', file: 'tests/search.spec.ts', name: 'a search lists only the matching books', outcome: passes, support: supported },
  { id: 'F9.2', file: 'tests/search.spec.ts', name: 'pages through every result and back', outcome: passes, support: supported },
  { id: 'F9.3', file: 'tests/search.spec.ts', name: 'a genre filter narrows a search, and a search with no match says so', outcome: passes, support: supported },
  {
    id: 'F9.4',
    file: 'tests/search.spec.ts',
    name: 'a search that ignores its words fails at the result count',
    outcome: failsAt('only the matching books are listed', "toHaveText('3 results')"),
    support: supported,
  },

  { id: 'F10.1', file: 'tests/async.spec.ts', name: 'shows a loading line, then the reports that arrive late, and hides the line', outcome: passes, support: supported },
  { id: 'F10.2', file: 'tests/async.spec.ts', name: 'waits for Export to be enabled, then for the export to finish', outcome: passes, support: supported },
  { id: 'F10.3', file: 'tests/async.spec.ts', name: 'offers to try again after a failed load, and loads on the second try', outcome: passes, support: supported },
  {
    id: 'F10.4',
    file: 'tests/async.spec.ts',
    name: 'a loading line that never goes away fails at the hidden check',
    outcome: failsAt('the loading line goes once the reports are in', 'toBeHidden()'),
    support: supported,
  },
  {
    id: 'F10.5',
    file: 'tests/async.spec.ts',
    name: 'reports that never arrive fail at the list check',
    outcome: failsAt('the reports arrive', 'toHaveCount(3)'),
    support: supported,
  },

  // The same cases as a Playwright test most often writes them, naming an option by its text alone. Playwright takes
  // the text as a value or a label; Retest refuses the bare string by name.
  ...(
    [
      ['F4.1', 'adds a task with a title, notes and a priority, naming the priority by its text'],
      ['F5.1', 'edits a task and the change survives a reload, naming the priority by its text'],
      ['F7.1', 'chooses a plan, ticks a box and picks a theme, naming the plan by its text'],
      ['F7.3', 'the Business plan shows a seats choice that the other plans hide, naming each option by its text'],
      ['F9.3', 'a genre filter narrows a search, naming the genre by its text'],
    ] as const
  ).map(
    ([id, name]): CompatibilityCase => ({
      id: `${id}-text`,
      file: 'tests/select-by-text.spec.ts',
      name,
      outcome: passes,
      support: {
        supported: false,
        gap: "Retest refuses selectOption with a bare string by name: Playwright matches the text against each option's value and its label at once, and Retest has to know which.",
      },
      variantOf: id,
    }),
  ),
]

// Family 3 reuses a signed-in state, which a Playwright suite does through its config and its context. Each of its
// cases is a declared gap, not run: the form Playwright gives it lives in playwright.config.ts, which Retest's
// compatibility does not read.
const savedState = "Playwright reuses a signed-in state through a setup project, storageState and project dependencies in playwright.config.ts, and page.context().storageState(); Retest's compatibility reads no playwright.config.ts and refuses test.use and page.context by name."

/** The cases of the fixed list that the corpus does not hold. Each is a declared gap and counts as one. */
export const unavailableCases: readonly UnavailableCase[] = [
  { id: 'F3.1', name: 'starts signed in from the saved state', reason: savedState },
  { id: 'F3.2', name: 'starts signed out without a state, after a test that was signed in', reason: savedState },
  { id: 'F3.3', name: 'pins a project while signed in; starts from the saved state, not from what the test before it changed', reason: savedState },
  { id: 'F3.4', name: 'admin (setup); opens the admin tools', reason: savedState },
]
