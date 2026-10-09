import type { ExitCode } from '../../src/protocol/events.ts'
import type { FailureClass, FailureDetail } from '../../src/protocol/failures.ts'
import type { NavigationCause, NavigationDocument } from '../../src/protocol/page-facts.ts'
import type { Timeouts } from '../../src/protocol/timeouts.ts'

// The fixed list of conformance cases for the first release's browser scope, run on Chrome, Firefox and WebKit by
// `tests/conformance/run.ts` and checked by `tests/integration/conformance.test.ts`. Each case is a test in a
// `.retest.ts` file under `fixtures/conformance/` with the outcome it must end with, or a fact about a whole run.
// The workflow cases are the forty of docs/compatibility/workflow-cases.md, families 1 to 10, each with the facts
// its Chromium integration file checks, so a case means the same on every engine. A declared outcome is the
// contract: a driver that ends a case otherwise is fixed, and the outcome is never edited to match it.

/** The areas of the first release's browser scope that these cases cover. */
export type Area =
  | 'Navigation'
  | 'Locators'
  | 'Actions'
  | 'Assertions'
  | 'Test structure'
  | 'Basic configuration'
  | 'Authentication'
  | 'Web participants'
  | 'Scheduling'
  | 'Failure handling'

/**
 * Where a failure must be located, as a line of the case's file: the first line after the line holding `after` that
 * holds `holding`. Without `after`, the search starts at the line that opens the case's step, or else at the line that
 * declares the test.
 */
export type Anchor = { readonly holding: string; readonly after?: string }

/** A failure's message, or, for one that names the target the run started, the message for that target's name. */
export type Message = RegExp | ((target: string) => RegExp)

/**
 * What a test must end as. A failure names the operation that failed, an action's command or an assertion's matcher,
 * or `test` for a failure no single call explains, such as the test's own budget; `step` is the step it failed in,
 * which must itself have finished failed, when the case names one; `at` is the line its failure is located at, and
 * `message` what its message says. `absent` is a test the run left out, by a filter or `test.only`: it has no result
 * and never started.
 */
export type Declared =
  | { readonly status: 'passed' }
  | { readonly status: 'skipped' }
  | { readonly status: 'absent' }
  | {
      readonly status: 'failed' | 'error'
      readonly class: FailureClass
      readonly operation: string
      readonly step?: string
      readonly at?: Anchor
      readonly message?: Message
    }
  | { readonly status: 'not_run'; readonly class: FailureClass; readonly at?: Anchor; readonly message?: Message }

/** A navigation as the parent recorded it: its path, what started it, and whether it opened a new document. */
export type NavigationFact = readonly [path: string, cause: NavigationCause, document: NavigationDocument]

/**
 * A count the task app keeps, read before and after the case's run, so the difference is what that run did: the saves
 * of one title, the searches the actions page submitted, or the sign-ups under one name. Within a run, no test but the
 * case's own touches the count it names.
 */
export type AppCounter = { readonly of: 'saves'; readonly title: string } | { readonly of: 'searches' } | { readonly of: 'sign-ups'; readonly name: string }

/**
 * Something the run's own record must show about a test besides its outcome.
 *
 * - `deadline`: the failed operation looked or waited for at least `ms`, never less, and gave up within `lateMs` of it
 *   (by default a quarter of `ms`, and at least 250 ms); an operation that records its budget records `ms`; a failed
 *   assertion looked at least `looks` times (by default twice). For a failure at `test`, the test's own time is read.
 * - `at-once`: the failed operation failed within `withinMs`, without waiting out its time.
 * - `detail`: the failed operation's failure carries this detail.
 * - `polled`: a passing assertion with this matcher looked more than once.
 * - `commands`: the actions the test completed, in order, each `app:command` when `sessions` is set.
 * - `navigations`: the test's navigations, in order.
 * - `paths`: the paths of the test's navigations, in order.
 * - `opened-by-actions`: how many new documents the test's own actions opened.
 * - `observed`: a passing assertion on this test id read this text, as the parent judged it.
 * - `afterwards`: the assertions that passed after the failed operation, in order, each with the test id it read and
 *   the text the parent read there. An afterEach makes them, since it runs after a failure too.
 * - `secret-fill`: a fill was recorded by the name of this secret.
 * - `fills`: the test's completed fills, in order, each by the name of the secret it typed, or `null` for plain text.
 * - `choices`: each select, check and uncheck the test completed, in order, with whether it changed the control and
 *   how its input reached the page, `null` where the record leaves either out.
 * - `not-completed`: no action with this command completed.
 * - `sent-nothing`: no action of the test was started at all.
 * - `own-sessions`: every look names its app's session, and no look of one app shows another app's account.
 * - `steps`: the test's steps in order, each with how it finished; a hook's step is named by its hook.
 * - `saved`: the run saved this state at the end of this setup.
 * - `restored`: the run restored this state for this test, or, for `null`, restored none.
 * - `app-count`: the task app's count changed by this much during the case's run.
 */
export type Fact =
  | { readonly kind: 'deadline'; readonly ms: number; readonly lateMs?: number; readonly looks?: number }
  | { readonly kind: 'at-once'; readonly withinMs: number }
  | { readonly kind: 'detail'; readonly key: string; readonly value: FailureDetail }
  | { readonly kind: 'polled'; readonly matcher: string }
  | { readonly kind: 'commands'; readonly commands: readonly string[]; readonly sessions?: true }
  | { readonly kind: 'navigations'; readonly navigations: readonly NavigationFact[] }
  | { readonly kind: 'paths'; readonly paths: readonly string[] }
  | { readonly kind: 'opened-by-actions'; readonly count: number }
  | { readonly kind: 'observed'; readonly testId: string; readonly text: string }
  | { readonly kind: 'afterwards'; readonly reads: readonly (readonly [testId: string, text: string])[] }
  | { readonly kind: 'secret-fill'; readonly secret: string }
  | { readonly kind: 'fills'; readonly secrets: readonly (string | null)[] }
  | { readonly kind: 'choices'; readonly choices: readonly (readonly [command: string, changed: boolean | null, input: string | null])[] }
  | { readonly kind: 'not-completed'; readonly command: string }
  | { readonly kind: 'sent-nothing' }
  | { readonly kind: 'own-sessions'; readonly accounts: Readonly<Record<string, string>> }
  | { readonly kind: 'steps'; readonly steps: readonly (readonly [name: string, status: string])[] }
  | { readonly kind: 'saved'; readonly state: string }
  | { readonly kind: 'restored'; readonly state: string | null }
  | { readonly kind: 'app-count'; readonly counter: AppCounter; readonly count: number }

/** A value no file of a run and neither of its output streams may hold, by the name its run fact uses. */
export type HeldValue = 'password' | 'workflow-password' | 'workflow-session-cookie'

/**
 * What makes a held value's absence mean something: a fill the run completed by the name of this secret, or a state
 * the run saved, whose cookies the value would be among.
 */
export type Premise = { readonly filled: string } | { readonly saved: string }

/**
 * Something a whole run must show.
 *
 * - `browsers`: the run started this many browsers for its one target.
 * - `discovered`: discovery collected exactly the files the group's cases name.
 * - `server-stopped`: the run started the app's server, and nothing answers at its address once the run has ended.
 * - `server-failed`: the app's server failed as a setup failure, and none of its processes is left.
 * - `narrowed`: `test.only` kept this many of the tests collected.
 * - `run-failure`: the run failed with this class before any test started.
 * - `secret-absent`: no file of the run folder and neither output stream holds the value, and its premise happened in
 *   the run, so the absence is not that of a value the run never had.
 * - `lock-waited`: a test waited for a lock another test held.
 * - `sessions-waited`: an attempt waited for a session another attempt held.
 * - `app-saves`: the task app received this many saves during the run.
 * - `states`: the run saved exactly these states, and restored a state for exactly these cases' tests, in this order.
 */
export type RunFact =
  | { readonly kind: 'browsers'; readonly count: number }
  | { readonly kind: 'discovered' }
  | { readonly kind: 'server-stopped' }
  | { readonly kind: 'server-failed' }
  | { readonly kind: 'narrowed'; readonly kept: number; readonly collected: number }
  | { readonly kind: 'run-failure'; readonly class: FailureClass }
  | { readonly kind: 'secret-absent'; readonly value: HeldValue; readonly premise: Premise }
  | { readonly kind: 'lock-waited' }
  | { readonly kind: 'sessions-waited' }
  | { readonly kind: 'app-saves'; readonly count: number }
  | { readonly kind: 'states'; readonly saved: readonly string[]; readonly restoredFor: readonly string[] }

export type GroupName =
  | 'web'
  | 'workflow'
  | 'projects'
  | 'projects-narrow'
  | 'server'
  | 'server-fails'
  | 'participants'
  | 'limits'
  | 'locks'
  | 'only'
  | 'only-ci'
  | 'filter'
  | 'cancel-after-input'
  | 'lost-after-input'
  | 'lost-while-looking'

/**
 * A test case: a test in a file of its group's folder, and, for a test that runs once per target, its variant.
 * `requires` names the cases whose result gives this one its meaning, such as the signed-in test a signed-out test
 * must follow: each must end as declared, and its test must start before this one, or this case differs too.
 */
export type TestCase = {
  readonly kind: 'test'
  readonly id: string
  readonly area: Area
  readonly group: GroupName
  readonly file: string
  readonly test: string
  readonly variant?: string
  readonly outcome: Declared
  readonly facts?: readonly Fact[]
  readonly requires?: readonly string[]
}

/** A run case: a fact about a whole run of its group. */
export type RunCase = {
  readonly kind: 'run'
  readonly id: string
  readonly area: Area
  readonly group: GroupName
  readonly summary: string
  readonly fact: RunFact
}

export type ConformanceCase = TestCase | RunCase

/**
 * What the run's address serves: the task app as it is, in its frozen mode (a save button whose press is sent and
 * then never confirmed), or in its delayed mode (a save that answers after a minute); or an app server the run starts
 * itself, which answers or never does.
 */
export type GroupApp = 'task-app' | 'frozen-task-app' | 'delayed-task-app' | 'app-server' | 'silent-app-server'

/**
 * What the runner does to a run while it goes, and when: once the frozen task app has received the press, or once a
 * click has completed, it stops the run with SIGINT or ends the browser's process group the run reported.
 */
export type Interruption = { readonly when: 'press-received' | 'click-completed'; readonly then: 'stop' | 'end-browser' }

/**
 * One run of a folder under `fixtures/conformance/`, from its own config, with the CLI or, for `host`, a host
 * program of the folder that calls `runFiles` itself. Without `files`, discovery finds every test file in the folder.
 */
export type Group = {
  readonly name: GroupName
  readonly folder: string
  readonly app: GroupApp
  readonly exitCode: ExitCode
  readonly files?: readonly string[]
  readonly args?: readonly string[]
  readonly ci?: true
  readonly host?: string
  readonly budgets?: Partial<Timeouts>
  readonly interruption?: Interruption
}

const lifecycleBudgets: Partial<Timeouts> = { action: 20_000, assertion: 20_000, test: 30_000 }

/** Every run, in the order the runner makes them on each engine. */
export const groups: readonly Group[] = [
  { name: 'web', folder: 'web', app: 'task-app', exitCode: 1, args: ['--workers', '4', '--browsers', '2'] },
  { name: 'workflow', folder: 'workflow', app: 'task-app', exitCode: 1 },
  { name: 'projects', folder: 'projects', app: 'task-app', exitCode: 0 },
  { name: 'projects-narrow', folder: 'projects', app: 'task-app', exitCode: 0, args: ['--target', 'web=narrow'] },
  { name: 'server', folder: 'server', app: 'app-server', exitCode: 0 },
  { name: 'server-fails', folder: 'server-fails', app: 'silent-app-server', exitCode: 2 },
  { name: 'participants', folder: 'participants', app: 'task-app', exitCode: 0 },
  { name: 'limits', folder: 'limits', app: 'task-app', exitCode: 0, host: 'host.ts' },
  { name: 'locks', folder: 'locks', app: 'task-app', exitCode: 0, args: ['--workers', '3'] },
  { name: 'only', folder: 'only', app: 'task-app', exitCode: 0 },
  { name: 'only-ci', folder: 'only', app: 'task-app', exitCode: 2, ci: true },
  { name: 'filter', folder: 'filter', app: 'task-app', exitCode: 0, args: ['--grep', 'kept by the filter'] },
  {
    name: 'cancel-after-input',
    folder: 'lifecycle',
    app: 'frozen-task-app',
    exitCode: 130,
    files: ['cancel-after-input.retest.ts'],
    budgets: lifecycleBudgets,
    interruption: { when: 'press-received', then: 'stop' },
  },
  {
    name: 'lost-after-input',
    folder: 'lifecycle',
    app: 'frozen-task-app',
    exitCode: 2,
    files: ['lost-after-input.retest.ts'],
    budgets: lifecycleBudgets,
    interruption: { when: 'press-received', then: 'end-browser' },
  },
  {
    name: 'lost-while-looking',
    folder: 'lifecycle',
    app: 'delayed-task-app',
    exitCode: 2,
    files: ['lost-while-looking.retest.ts'],
    budgets: lifecycleBudgets,
    interruption: { when: 'click-completed', then: 'end-browser' },
  },
]

const passes: Declared = { status: 'passed' }
const skipped: Declared = { status: 'skipped' }
const absent: Declared = { status: 'absent' }

/** Where a failure is, and what it says, beyond its class and operation. */
type FailureFields = { readonly step?: string; readonly at?: Anchor; readonly message?: Message }

function fails(operation: string, failureClass: FailureClass, fields: FailureFields = {}): Declared {
  return { status: 'failed', class: failureClass, operation, ...fields }
}

function errs(operation: string, failureClass: FailureClass, fields: FailureFields = {}): Declared {
  return { status: 'error', class: failureClass, operation, ...fields }
}

function notRun(failureClass: FailureClass, fields: Omit<FailureFields, 'step'> = {}): Declared {
  return { status: 'not_run', class: failureClass, ...fields }
}

/**
 * A workflow case's intended failure, as docs/compatibility/workflow-cases.md fixes it: in its step, at the line
 * of its check, as `check_failed`, with its message.
 */
function failsAtCheck(operation: string, step: string, holding: string, message: RegExp): Declared {
  return fails(operation, 'check_failed', { step, at: { holding }, message })
}

type CaseFields = Omit<TestCase, 'kind' | 'id' | 'area' | 'group' | 'file'>

/** The test cases of one file, numbered from `first` under `prefix`. */
function inFile(area: Area, group: GroupName, file: string, prefix: string, cases: readonly CaseFields[], first = 1): TestCase[] {
  return cases.map((fields, index) => ({ kind: 'test', id: `${prefix}${first + index}`, area, group, file, ...fields }))
}

/**
 * The test cases of one workflow family, numbered as docs/compatibility/workflow-cases.md numbers them: one test
 * per case, or for a case of two tests, such as a setup and the test that starts from its state, `a` and `b`.
 */
function family(area: Area, number: number, file: string, cases: readonly CaseFields[], numbers?: readonly string[]): TestCase[] {
  return cases.map((fields, index) => ({ kind: 'test', id: `F${number}.${numbers?.[index] ?? String(index + 1)}`, area, group: 'workflow', file, ...fields }))
}

// The text the page shows for each check on the choices page before anything is clicked.
const choicesUntouched = 'agree=false newsletter=false locked=false small=true large=false covered=false remember=false'

const navigation: TestCase[] = inFile('Navigation', 'web', 'navigation.retest.ts', 'N', [
  {
    test: 'goto opens a relative address against the base URL, and an absolute address as it is',
    outcome: passes,
    facts: [
      {
        kind: 'navigations',
        navigations: [
          ['/lookup/history/one', 'goto', 'new'],
          ['/lookup/history/two', 'goto', 'new'],
        ],
      },
    ],
  },
  {
    test: 'reload, back and forward move through the history, and the page reads its address and title',
    outcome: passes,
    facts: [{ kind: 'commands', commands: ['goto', 'click', 'goBack', 'goForward', 'click', 'goBack', 'goto', 'reload'] }],
  },
  {
    test: 'a link, Enter in a form and a new path set by a click are each the action that caused them',
    outcome: passes,
    facts: [
      {
        kind: 'navigations',
        navigations: [
          ['/titles', 'goto', 'new'],
          ['/titles/next', 'action', 'new'],
          ['/titles', 'goto', 'new'],
          ['/titles/next', 'action', 'new'],
          ['/titles', 'goto', 'new'],
          ['/titles/pushed', 'action', 'same'],
        ],
      },
    ],
  },
  {
    test: 'goto follows a redirect from the server, and a check waits for the page the page itself moves to',
    outcome: passes,
    facts: [
      {
        kind: 'navigations',
        navigations: [
          ['/titles/redirect', 'goto', 'new'],
          ['/titles/next', 'page', 'new'],
        ],
      },
    ],
  },
  {
    test: 'toHaveURL fails naming both addresses',
    outcome: fails('toHaveURL', 'check_failed', {
      at: { holding: 'toHaveURL(' },
      message: /^The page is at "http:\/\/127\.0\.0\.1:\d+\/lookup\/history\/one", expected "http:\/\/127\.0\.0\.1:\d+\/lookup\/history\/two"\./,
    }),
    facts: [{ kind: 'deadline', ms: 300 }],
  },
  {
    test: 'goBack with no earlier entry fails and sends nothing',
    outcome: fails('goBack', 'not_actionable', { at: { holding: 'goBack()' }, message: /no earlier entry in its history, so Retest sent nothing\.$/ }),
    facts: [
      { kind: 'at-once', withinMs: 1000 },
      { kind: 'navigations', navigations: [] },
    ],
  },
  {
    test: 'a page that never finishes loading fails when its navigation time runs out',
    outcome: fails('goto', 'timeout', { at: { holding: "goto('/hang'" } }),
    facts: [{ kind: 'deadline', ms: 1000 }],
  },
])

const locators: TestCase[] = inFile('Locators', 'web', 'locators.retest.ts', 'L', [
  { test: 'each kind of locator finds its element: test id, role and name, label, text, placeholder and CSS', outcome: passes },
  { test: 'scoped lookups find inside an element, and first, last and nth pick among the matches', outcome: passes },
  { test: 'a name, a label, a text and a placeholder match exactly by default: case and the whole text count, spaces aside', outcome: passes },
  { test: 'exact: false matches any case and any part, and keeps only the innermost text', outcome: passes },
  { test: 'a regular expression matches a name, a label, a text and a placeholder with its own flags', outcome: passes },
  {
    test: 'an action on a locator that matches several elements fails at once as ambiguous, and clicks none of them',
    outcome: fails('click', 'ambiguous', { at: { holding: '.click()' } }),
    facts: [
      { kind: 'at-once', withinMs: 1000 },
      { kind: 'detail', key: 'count', value: 3 },
      { kind: 'afterwards', reads: [['last-deleted', 'none']] },
    ],
  },
  { test: 'a check that needs one element fails as ambiguous on several matches', outcome: fails('toBeChecked', 'ambiguous'), facts: [{ kind: 'deadline', ms: 1500 }] },
  {
    test: 'an action on a locator that matches nothing fails as not found when its time runs out',
    outcome: fails('click', 'not_found'),
    facts: [{ kind: 'deadline', ms: 1500 }],
  },
  { test: 'a CSS selector the page cannot read fails at once', outcome: fails('click', 'usage'), facts: [{ kind: 'at-once', withinMs: 1000 }] },
])

const actions: TestCase[] = inFile('Actions', 'web', 'actions.retest.ts', 'A', [
  {
    test: 'fill types into a field, a click saves once, and the saved title is read back',
    outcome: passes,
    facts: [
      { kind: 'commands', commands: ['goto', 'fill', 'click'] },
      { kind: 'app-count', counter: { of: 'saves', title: 'Release checklist' }, count: 1 },
    ],
  },
  { test: 'a click is a real press and release that the page hears once, as trusted input', outcome: passes },
  {
    test: 'hover moves the mouse onto an element, again at the same place, and onto a disabled one',
    outcome: passes,
    facts: [{ kind: 'commands', commands: ['goto', 'hover', 'hover', 'hover'] }],
  },
  {
    test: 'keys move the focus, Enter submits a form once, and shortcuts hold their modifiers',
    outcome: passes,
    facts: [{ kind: 'app-count', counter: { of: 'searches' }, count: 1 }],
  },
  { test: 'select chooses by label, by value and several options at once, and the page hears trusted input', outcome: passes },
  {
    test: 'check and uncheck work a checkbox, an element whose role is checkbox, a hidden checkbox through its label, and radios',
    outcome: passes,
  },
  { test: 'the wheel scrolls an element to its end and the page near its end, which each answer once', outcome: passes },
])

const actionability: TestCase[] = inFile(
  'Actions',
  'web',
  'actionability.retest.ts',
  'A',
  [
    {
      test: 'a click waits for a button that is enabled a moment after the page loads, and clicks it once',
      outcome: passes,
      facts: [
        { kind: 'commands', commands: ['goto', 'click'] },
        { kind: 'observed', testId: 'later-clicks', text: '1' },
      ],
    },
    {
      test: 'a click on a covered button is refused when its time runs out, naming what covers it',
      outcome: fails('click', 'not_actionable'),
      facts: [
        { kind: 'detail', key: 'check', value: 'hit-target' },
        { kind: 'detail', key: 'covering', value: '<span class="cover" data-testid="cover">' },
        { kind: 'deadline', ms: 500 },
      ],
    },
    {
      test: 'a click on a disabled button is refused when its time runs out',
      outcome: fails('click', 'not_actionable'),
      facts: [
        { kind: 'detail', key: 'check', value: 'enabled' },
        { kind: 'deadline', ms: 500 },
      ],
    },
    {
      test: 'a click on a hidden element is refused when its time runs out',
      outcome: fails('click', 'not_actionable'),
      facts: [
        { kind: 'detail', key: 'check', value: 'visible' },
        { kind: 'deadline', ms: 500 },
      ],
    },
    {
      test: 'a covered checkbox is not checked',
      outcome: fails('check', 'not_actionable'),
      facts: [
        { kind: 'detail', key: 'check', value: 'hit-target' },
        { kind: 'deadline', ms: 500 },
        {
          kind: 'afterwards',
          reads: [
            ['pointer-heard', ''],
            ['changes-heard', ''],
            ['checks-shown', choicesUntouched],
          ],
        },
      ],
    },
    {
      test: 'a checkbox covered as the pointer arrives takes no click, and the page hears no part of one',
      outcome: fails('check', 'not_actionable'),
      facts: [
        { kind: 'detail', key: 'check', value: 'hit-target' },
        { kind: 'detail', key: 'event', value: 'pointerdown' },
        {
          kind: 'afterwards',
          reads: [
            ['pointer-heard', ''],
            ['changes-heard', ''],
            ['checks-shown', choicesUntouched],
          ],
        },
      ],
    },
    {
      test: 'a covered list is not scrolled',
      outcome: fails('scroll', 'not_actionable'),
      facts: [
        { kind: 'detail', key: 'check', value: 'hit-target' },
        { kind: 'deadline', ms: 500 },
        { kind: 'afterwards', reads: [['wheels-heard', '']] },
      ],
    },
  ],
  8,
)

const assertions: TestCase[] = inFile('Assertions', 'web', 'assertions.retest.ts', 'S', [
  { test: 'state matchers and their negations pass on what the page shows', outcome: passes },
  { test: 'text, value and count compare the whole text with spaces read as one, and a list in order', outcome: passes },
  { test: 'regular expressions match text, a value, the address and the title', outcome: passes },
  { test: 'value assertions compare what the test holds, and poll reads again until it matches', outcome: passes, facts: [{ kind: 'polled', matcher: 'toBe' }] },
  { test: 'a check looks again until the page shows what it expects', outcome: passes, facts: [{ kind: 'polled', matcher: 'toBeEnabled' }] },
  {
    test: 'a soft check that fails lets the test go on, and the test fails at it',
    outcome: fails('toHaveText', 'check_failed', { at: { holding: 'expect.soft(' } }),
    facts: [
      { kind: 'commands', commands: ['goto', 'click'] },
      { kind: 'deadline', ms: 300 },
    ],
  },
  {
    test: 'toHaveText fails after looking for its whole time, naming what the page showed',
    outcome: fails('toHaveText', 'check_failed', { at: { holding: "toHaveText('Saved 4 tasks')" }, message: /^getByTestId\('summary'\) has text "Saved 3 tasks", expected "Saved 4 tasks"\./ }),
    facts: [{ kind: 'deadline', ms: 1500 }],
  },
  { test: 'a negation fails on what shows the condition true', outcome: fails('not.toContainText', 'check_failed'), facts: [{ kind: 'deadline', ms: 1500 }] },
  { test: 'a negation never passes on a missing element', outcome: fails('not.toBeChecked', 'not_found'), facts: [{ kind: 'deadline', ms: 1500 }] },
  { test: 'toBeDisabled fails on an enabled button within its own shorter time', outcome: fails('toBeDisabled', 'check_failed'), facts: [{ kind: 'deadline', ms: 300 }] },
  {
    test: 'a negated title check fails naming the title',
    outcome: fails('not.toHaveTitle', 'check_failed', { at: { holding: 'not.toHaveTitle(' }, message: /^The page's title is "One", which matches \/\^On\/, expected it not to\./ }),
    facts: [{ kind: 'deadline', ms: 300 }],
  },
])

const structure: TestCase[] = [
  ...inFile('Test structure', 'web', 'structure.retest.ts', 'T', [
    {
      test: 'starts from what its beforeEach opened, and runs its steps in order',
      outcome: passes,
      facts: [
        {
          kind: 'steps',
          steps: [
            ['beforeEach', 'passed'],
            ['delete the first task', 'passed'],
            ['the deleted task is named', 'passed'],
            ['afterEach', 'passed'],
          ],
        },
      ],
    },
    {
      test: 'a test whose afterEach check fails fails at that check',
      // The inner afterEach, which runs first, is the one that fails; the outer one still runs and passes.
      outcome: fails('toHaveText', 'check_failed', { at: { holding: "toHaveText('none'", after: "test.describe('with an afterEach of its own'" } }),
      facts: [
        {
          kind: 'steps',
          steps: [
            ['beforeEach', 'passed'],
            ['afterEach', 'failed'],
            ['afterEach', 'passed'],
          ],
        },
        { kind: 'afterwards', reads: [['summary', 'Saved 3 tasks']] },
      ],
    },
    { test: 'deletes Buy milk by its place in the inbox', outcome: passes },
    { test: 'deletes Pay rent by its place in the inbox', outcome: passes },
    { test: 'a skipped test never runs', outcome: skipped },
    { test: 'a test in a skipped block never runs', outcome: skipped },
  ]),
  ...inFile(
    'Test structure',
    'web',
    'test-budget.retest.ts',
    'T',
    [
      {
        test: 'a test that waits past its own budget fails as a timeout',
        outcome: fails('test', 'timeout'),
        // The run gives every test 20 seconds; this one gives itself 1.5. A timed out test's own time includes ending
        // its process, so its late bound is a second.
        facts: [
          { kind: 'detail', key: 'timeoutMs', value: 1500 },
          { kind: 'deadline', ms: 1500, lateMs: 1000 },
        ],
      },
      { test: 'a test after a timed out one in its file does not run', outcome: notRun('timeout'), requires: ['T7'] },
    ],
    7,
  ),
  ...inFile(
    'Test structure',
    'only',
    'focused.retest.ts',
    'T',
    [
      { test: 'a test marked only runs', outcome: passes },
      { test: 'a test beside one marked only is left out', outcome: absent },
      { test: 'runs the tests inside it', outcome: passes },
    ],
    9,
  ),
  ...inFile(
    'Test structure',
    'only-ci',
    'focused.retest.ts',
    'T',
    [
      { test: 'a test marked only runs', outcome: notRun('usage') },
      { test: 'a test beside one marked only is left out', outcome: notRun('usage') },
      { test: 'runs the tests inside it', outcome: notRun('usage') },
    ],
    12,
  ),
]

const configuration: TestCase[] = [
  ...inFile('Basic configuration', 'projects', 'viewport.retest.ts', 'C', [
    {
      test: 'the page opens at the size of its target, with no touch screen and a pixel ratio of 1',
      variant: 'web=wide',
      outcome: passes,
      facts: [{ kind: 'observed', testId: 'width', text: '1280' }],
    },
    {
      test: 'the page opens at the size of its target, with no touch screen and a pixel ratio of 1',
      variant: 'web=narrow',
      outcome: passes,
      facts: [{ kind: 'observed', testId: 'width', text: '600' }],
    },
  ]),
  ...inFile(
    'Basic configuration',
    'projects-narrow',
    'viewport.retest.ts',
    'C',
    [
      {
        test: 'the page opens at the size of its target, with no touch screen and a pixel ratio of 1',
        variant: 'web=narrow',
        outcome: passes,
        facts: [{ kind: 'observed', testId: 'width', text: '600' }],
      },
      { test: 'the page opens at the size of its target, with no touch screen and a pixel ratio of 1', variant: 'web=wide', outcome: absent },
    ],
    3,
  ),
  ...inFile('Basic configuration', 'server', 'served.retest.ts', 'C', [{ test: 'opens the page the app server serves once it answers', outcome: passes }], 5),
  ...inFile('Basic configuration', 'server-fails', 'never-ready.retest.ts', 'C', [{ test: 'a test whose app server never answers does not run', outcome: notRun('setup_failed') }], 6),
  ...inFile(
    'Basic configuration',
    'filter',
    'titles.retest.ts',
    'C',
    [
      { test: 'reads the summary, kept by the filter', outcome: passes },
      { test: 'reads a summary that is never there', outcome: absent },
      { test: 'reads the status, kept by the filter', outcome: passes },
      { test: 'reads a status that is never there', outcome: absent },
    ],
    7,
  ),
]

const authentication: TestCase[] = inFile('Authentication', 'web', 'isolation.retest.ts', 'U', [
  {
    test: 'a test saves to local storage and signs in with a cookie',
    outcome: passes,
    facts: [
      { kind: 'secret-fill', secret: 'password' },
      { kind: 'app-count', counter: { of: 'saves', title: 'Kept for later' }, count: 1 },
    ],
  },
  // Empty storage and no cookie mean something only after a test that saved and signed in, in the same process.
  { test: 'the next test starts with empty storage and no cookie', outcome: passes, requires: ['U1'] },
])

const participants: TestCase[] = [
  ...inFile('Web participants', 'participants', 'two-accounts.retest.ts', 'P', [
    { test: 'owner-account', outcome: passes, facts: [{ kind: 'secret-fill', secret: 'password' }] },
    { test: 'member-account', outcome: passes, facts: [{ kind: 'secret-fill', secret: 'password' }] },
    {
      test: 'the member reads the exact record the owner made',
      outcome: passes,
      requires: ['P1', 'P2'],
      facts: [
        { kind: 'commands', commands: ['owner:goto', 'owner:fill', 'owner:fill', 'owner:click', 'member:goto'], sessions: true },
        { kind: 'own-sessions', accounts: { owner: 'owner-a', member: 'member-b' } },
      ],
    },
  ]),
  ...inFile(
    'Web participants',
    'participants',
    'four-sessions.retest.ts',
    'P',
    [
      { test: 'alpha-signed-in', outcome: passes, facts: [{ kind: 'secret-fill', secret: 'password' }] },
      { test: 'beta-signed-in', outcome: passes, facts: [{ kind: 'secret-fill', secret: 'password' }] },
      { test: 'gamma-signed-in', outcome: passes, facts: [{ kind: 'secret-fill', secret: 'password' }] },
      { test: 'delta-signed-in', outcome: passes, facts: [{ kind: 'secret-fill', secret: 'password' }] },
      {
        test: 'four accounts stay apart in one test',
        outcome: passes,
        requires: ['P4', 'P5', 'P6', 'P7'],
        facts: [{ kind: 'own-sessions', accounts: { alpha: 'alpha-account', beta: 'beta-account', gamma: 'gamma-account', delta: 'delta-account' } }],
      },
    ],
    4,
  ),
  ...inFile('Web participants', 'limits', 'holds-one.retest.ts', 'P', [{ test: 'holder one keeps its session to itself under the limits', outcome: passes }], 9),
  ...inFile('Web participants', 'limits', 'holds-two.retest.ts', 'P', [{ test: 'holder two keeps its session to itself under the limits', outcome: passes }], 10),
]

const scheduling: TestCase[] = ['a', 'b', 'c'].flatMap((letter, index) =>
  inFile('Scheduling', 'locks', `holds-${letter}.retest.ts`, 'K', [{ test: `holder ${letter} keeps the inbox to itself while it holds the lock`, outcome: passes }], index + 1),
)

const failureHandling: TestCase[] = [
  ...inFile('Failure handling', 'cancel-after-input', 'cancel-after-input.retest.ts', 'X', [
    {
      test: 'a run stopped after a click pressed says the input was sent, and never completes the click',
      outcome: errs('click', 'interrupted'),
      facts: [
        { kind: 'detail', key: 'inputSent', value: true },
        { kind: 'not-completed', command: 'click' },
      ],
    },
    { test: 'a test after the stop does not run', outcome: notRun('interrupted'), requires: ['X1'] },
  ]),
  ...inFile(
    'Failure handling',
    'lost-after-input',
    'lost-after-input.retest.ts',
    'X',
    [
      {
        test: 'a browser lost after a click pressed leaves the outcome unknown, and never clicks again',
        outcome: errs('click', 'outcome_unknown'),
        facts: [{ kind: 'not-completed', command: 'click' }],
      },
      { test: 'a test after the browser is lost does not run', outcome: notRun('session_lost'), requires: ['X3'] },
    ],
    3,
  ),
  ...inFile(
    'Failure handling',
    'lost-while-looking',
    'lost-while-looking.retest.ts',
    'X',
    [
      { test: 'a browser lost while a check looks is a lost session, not a failed check', outcome: errs('toHaveText', 'session_lost') },
      { test: 'a test after the browser is lost does not run', outcome: notRun('session_lost'), requires: ['X5'] },
    ],
    5,
  ),
]

const workflow: TestCase[] = [
  ...family('Navigation', 1, 'f01-navigation.retest.ts', [
    {
      test: 'opens pages by link, by a moved address and by an absolute address',
      outcome: passes,
      facts: [
        {
          kind: 'navigations',
          navigations: [
            ['/workflow/site', 'goto', 'new'],
            ['/workflow/site/projects', 'action', 'new'],
            ['/workflow/site/projects/apollo', 'action', 'new'],
            ['/workflow/site/projects', 'action', 'new'],
            ['/workflow/site/projects', 'goto', 'new'],
            ['/workflow/site', 'goto', 'new'],
          ],
        },
      ],
    },
    {
      test: 'a reload keeps the saved name and loses the unsaved draft',
      outcome: passes,
      facts: [
        { kind: 'commands', commands: ['goto', 'fill', 'click', 'fill', 'reload'] },
        {
          kind: 'navigations',
          navigations: [
            ['/workflow/site/settings', 'goto', 'new'],
            ['/workflow/site/settings', 'goto', 'new'],
          ],
        },
      ],
    },
    {
      test: 'a section opened by a client-side route survives a reload',
      outcome: passes,
      facts: [
        {
          kind: 'navigations',
          navigations: [
            ['/workflow/site/settings', 'goto', 'new'],
            ['/workflow/site/settings/notifications', 'action', 'same'],
            ['/workflow/site/settings/notifications', 'goto', 'new'],
            ['/workflow/site/settings', 'action', 'same'],
          ],
        },
      ],
    },
    {
      test: 'a menu link that leads to the wrong page fails at the heading check',
      outcome: failsAtCheck('toHaveText', 'open settings from the menu', "toHaveText('Settings')", /^getByTestId\('heading'\) has text "Projects", expected "Settings"\./),
      facts: [
        {
          kind: 'navigations',
          navigations: [
            ['/workflow/site', 'goto', 'new'],
            ['/workflow/site/projects', 'action', 'new'],
          ],
        },
      ],
    },
  ]),
  ...family('Authentication', 2, 'f02-sign-in.retest.ts', [
    {
      test: 'signs in with the password and lands on the account page',
      outcome: passes,
      facts: [
        { kind: 'secret-fill', secret: 'password' },
        { kind: 'fills', secrets: [null, 'password'] },
        { kind: 'paths', paths: ['/workflow/sign-in', '/workflow/account'] },
      ],
    },
    {
      test: 'a wrong password shows an error and leaves the person signed out',
      outcome: passes,
      facts: [
        { kind: 'fills', secrets: [null, null] },
        { kind: 'paths', paths: ['/workflow/sign-in', '/workflow/account'] },
      ],
    },
    {
      test: 'signing out ends the session',
      outcome: passes,
      facts: [
        { kind: 'fills', secrets: [null, 'password'] },
        { kind: 'paths', paths: ['/workflow/sign-in', '/workflow/account', '/workflow/sign-in', '/workflow/account'] },
      ],
    },
    {
      test: 'a sign-out that keeps the session fails at the signed-out check',
      outcome: failsAtCheck('toHaveText', 'the account page shows signed out', "toHaveText('Signed out')", /^getByTestId\('account'\) has text "Signed in as alice", expected "Signed out"\./),
      facts: [{ kind: 'fills', secrets: [null, 'password'] }],
    },
  ]),
  ...family(
    'Authentication',
    3,
    'f03-saved-state.retest.ts',
    [
      {
        test: 'signed-in',
        outcome: passes,
        facts: [
          { kind: 'secret-fill', secret: 'password' },
          { kind: 'saved', state: 'signed-in' },
        ],
      },
      { test: 'starts signed in from the saved state', outcome: passes, requires: ['F3.1a'], facts: [{ kind: 'restored', state: 'signed-in' }] },
      { test: 'starts signed out without a state, after a test that was signed in', outcome: passes, requires: ['F3.1b'], facts: [{ kind: 'restored', state: null }] },
      { test: 'pins a project while signed in', outcome: passes, requires: ['F3.1a'], facts: [{ kind: 'restored', state: 'signed-in' }] },
      {
        test: 'starts from the saved state, not from what the test before it changed',
        outcome: passes,
        requires: ['F3.3a'],
        facts: [{ kind: 'restored', state: 'signed-in' }],
      },
      {
        test: 'admin',
        outcome: failsAtCheck('toHaveText', 'the account page names admin', "toHaveText('Signed in as admin')", /^getByTestId\('account'\) has text "Signed in as guest", expected "Signed in as admin"\./),
      },
      {
        test: 'opens the admin tools',
        outcome: notRun('check_failed', {
          at: { holding: "toHaveText('Signed in as admin')", after: "test.setup('admin'" },
          message: (target) =>
            new RegExp(`^Not run: the setup "admin" did not pass on ${target}\\. getByTestId\\('account'\\) has text "Signed in as guest", expected "Signed in as admin"\\.`),
        }),
        requires: ['F3.4a'],
        facts: [{ kind: 'sent-nothing' }],
      },
    ],
    ['1a', '1b', '2', '3a', '3b', '4a', '4b'],
  ),
  ...family('Actions', 4, 'f04-create.retest.ts', [
    {
      test: 'adds a task with a title, notes and a priority',
      outcome: passes,
      facts: [
        { kind: 'commands', commands: ['goto', 'fill', 'fill', 'select', 'click', 'reload'] },
        { kind: 'choices', choices: [['select', true, null]] },
      ],
    },
    {
      test: 'Enter in the title field adds the task with the default priority',
      outcome: passes,
      facts: [{ kind: 'commands', commands: ['goto', 'fill', 'press'] }],
    },
    { test: 'refuses a second task with the same title and keeps what was typed', outcome: passes },
    {
      test: 'a save that drops the last character fails at the listed title',
      outcome: failsAtCheck(
        'toHaveText',
        'the new task is listed with its title',
        "toHaveText('Release checklist')",
        /^getByTestId\('task-title'\) has text "Release checklis", expected "Release checklist"\./,
      ),
    },
  ]),
  ...family('Actions', 5, 'f05-edit-delete.retest.ts', [
    { test: 'edits a task and the change survives a reload', outcome: passes },
    { test: 'asks before deleting, keeps the task on cancel and removes it on confirm', outcome: passes },
    {
      test: 'an edit the server never keeps fails after the reload',
      outcome: failsAtCheck(
        'toHaveText',
        'the change survives a reload',
        "toHaveText(['Write release notes', 'Book venue', 'Order name badges'])",
        /^Match 3 of getByTestId\('item-title'\) has text "Order badges", expected "Order name badges"\./,
      ),
    },
    {
      test: 'a delete that removes the wrong row fails at the remaining list',
      outcome: failsAtCheck(
        'toHaveText',
        'only the deleted task is gone',
        "toHaveText(['Write release notes', 'Order badges'])",
        /^Match 2 of getByTestId\('item-title'\) has text "Book venue", expected "Order badges"\./,
      ),
    },
  ]),
  ...family('Assertions', 6, 'f06-validation.retest.ts', [
    {
      test: 'a form with only a name shows the email, password and terms errors, and sends nothing',
      outcome: passes,
      facts: [{ kind: 'app-count', counter: { of: 'sign-ups', name: 'Grace Hopper' }, count: 0 }],
    },
    {
      test: 'each wrong value gets its own message, fixing a field clears only its own, and a valid form is accepted',
      outcome: passes,
      facts: [
        // The first submit has no name, and the page refuses it, so the server hears nothing under no name.
        { kind: 'app-count', counter: { of: 'sign-ups', name: '' }, count: 0 },
        { kind: 'app-count', counter: { of: 'sign-ups', name: 'Ada Lovelace' }, count: 1 },
      ],
    },
    {
      test: 'an email the server knows is refused beside its field, and the typed values stay',
      outcome: passes,
      facts: [{ kind: 'app-count', counter: { of: 'sign-ups', name: 'Taken Person' }, count: 1 }],
    },
    {
      test: 'a form that accepts a short password fails at the password error',
      outcome: failsAtCheck('toHaveText', 'the short password is refused', "getByTestId('password-error')", /^getByTestId\('password-error'\) has text "", expected "Use at least 8 characters"\./),
      facts: [{ kind: 'app-count', counter: { of: 'sign-ups', name: 'Short Password' }, count: 1 }],
    },
  ]),
  ...family('Actions', 7, 'f07-selection.retest.ts', [
    {
      test: 'chooses a plan, ticks a box and picks a theme, and the saved choices come back after a reload',
      outcome: passes,
      facts: [
        {
          kind: 'choices',
          choices: [
            ['select', true, null],
            ['check', true, null],
            ['check', true, null],
          ],
        },
      ],
    },
    {
      test: 'unticks a ticked box, chooses by value, and a second radio replaces the first',
      outcome: passes,
      facts: [
        {
          kind: 'choices',
          choices: [
            ['uncheck', true, null],
            ['select', true, null],
            ['check', true, null],
            ['check', true, null],
          ],
        },
      ],
    },
    { test: 'the Business plan shows a seats choice that the other plans hide', outcome: passes },
    {
      test: 'a save that ignores a checkbox fails at the saved summary',
      outcome: failsAtCheck(
        'toHaveText',
        'the saved preferences match the form',
        "getByRole('status')",
        /^getByRole\('status'\) has text "Saved plan=free seats=none updates=on summary=off alerts=on theme=light", expected "Saved plan=free seats=none updates=on summary=on alerts=on theme=light"\./,
      ),
      facts: [{ kind: 'choices', choices: [['check', true, null]] }],
    },
  ]),
  ...family(
    'Locators',
    8,
    'f08-lists.retest.ts',
    [
      { test: 'reads the table row by row and finds a member by name', outcome: passes },
      {
        test: 'a table row found by its name is refused by name at once',
        outcome: errs('toBeVisible', 'unsupported', {
          at: { holding: "getByRole('row', { name: secondRow })" },
          message: /^getByRole\('row', \{ name \}\) finds no row on a web page: /,
        }),
        facts: [{ kind: 'at-once', withinMs: 1000 }],
      },
      { test: 'sorts the table by name one way and then the other', outcome: passes },
      {
        test: 'finds an invoice far down a long list and opens it',
        outcome: passes,
        facts: [
          {
            kind: 'navigations',
            navigations: [
              ['/workflow/invoices', 'goto', 'new'],
              ['/workflow/invoices/detail', 'action', 'new'],
            ],
          },
        ],
      },
      {
        test: 'a sort that compares numbers as text fails at the sorted column',
        outcome: failsAtCheck('toHaveText', 'the open tasks go from fewest to most', "getByTestId('member-tasks')", /^Match 1 of getByTestId\('member-tasks'\) has text "10", expected "3"\./),
      },
    ],
    ['1a', '1b', '2', '3', '4'],
  ),
  ...family('Actions', 9, 'f09-search.retest.ts', [
    { test: 'a search lists only the matching books', outcome: passes, facts: [{ kind: 'opened-by-actions', count: 1 }] },
    // Every page forward from the first, then one back: five pages the server sent.
    { test: 'pages through every result and back', outcome: passes, facts: [{ kind: 'opened-by-actions', count: 5 }] },
    { test: 'a genre filter narrows a search, and a search with no match says so', outcome: passes, facts: [{ kind: 'opened-by-actions', count: 3 }] },
    {
      test: 'a search that ignores its words fails at the result count',
      outcome: failsAtCheck('toHaveText', 'only the matching books are listed', "toHaveText('3 results')", /^getByTestId\('result-count'\) has text "23 results", expected "3 results"\./),
      facts: [{ kind: 'opened-by-actions', count: 1 }],
    },
  ]),
  ...family('Assertions', 10, 'f10-async.retest.ts', [
    { test: 'shows a loading line, then the reports that arrive late, and hides the line', outcome: passes, facts: [{ kind: 'polled', matcher: 'toHaveText' }] },
    { test: 'waits for Export to be enabled, then for the export to finish', outcome: passes, facts: [{ kind: 'commands', commands: ['goto', 'click'] }] },
    { test: 'offers to try again after a failed load, and loads on the second try', outcome: passes },
    {
      test: 'a loading line that never goes away fails at the hidden check',
      outcome: failsAtCheck('toBeHidden', 'the loading line goes once the reports are in', 'toBeHidden()', /^getByTestId\('loading'\) is visible\. Looked \d+ times in 1500 ms\.$/),
      facts: [{ kind: 'deadline', ms: 1500, looks: 3 }],
    },
    {
      test: 'reports that never arrive fail at the list check',
      outcome: failsAtCheck('toHaveCount', 'the reports arrive', 'toHaveCount', /^getByTestId\('report-row'\) matched no element, expected 3\. Looked \d+ times in 1500 ms\.$/),
      facts: [{ kind: 'deadline', ms: 1500, looks: 3 }],
    },
  ]),
]

const runs: RunCase[] = [
  { kind: 'run', id: 'R1', area: 'Scheduling', group: 'web', summary: 'the method cases ran in two browsers shared by four workers', fact: { kind: 'browsers', count: 2 } },
  { kind: 'run', id: 'R2', area: 'Scheduling', group: 'locks', summary: 'a holder waited for the lock another holder held', fact: { kind: 'lock-waited' } },
  { kind: 'run', id: 'R3', area: 'Web participants', group: 'limits', summary: 'a holder waited for the session the other holder held', fact: { kind: 'sessions-waited' } },
  { kind: 'run', id: 'R4', area: 'Basic configuration', group: 'web', summary: 'discovery found every method case file and nothing else', fact: { kind: 'discovered' } },
  { kind: 'run', id: 'R5', area: 'Basic configuration', group: 'workflow', summary: 'discovery found every workflow case file and nothing else', fact: { kind: 'discovered' } },
  { kind: 'run', id: 'R6', area: 'Basic configuration', group: 'server', summary: 'the run started the app server, waited for it, and stopped it at the end', fact: { kind: 'server-stopped' } },
  { kind: 'run', id: 'R7', area: 'Failure handling', group: 'server-fails', summary: 'a server that never answers is a setup failure, and is stopped', fact: { kind: 'server-failed' } },
  { kind: 'run', id: 'R8', area: 'Test structure', group: 'only', summary: 'test.only narrowed the run to 2 of its 3 tests', fact: { kind: 'narrowed', kept: 2, collected: 3 } },
  { kind: 'run', id: 'R9', area: 'Test structure', group: 'only-ci', summary: 'with CI set, test.only fails the run before any test starts', fact: { kind: 'run-failure', class: 'usage' } },
  {
    kind: 'run',
    id: 'R10',
    area: 'Authentication',
    group: 'web',
    summary: 'the password was typed, and no file of the run and no output holds it',
    fact: { kind: 'secret-absent', value: 'password', premise: { filled: 'password' } },
  },
  {
    kind: 'run',
    id: 'R11',
    area: 'Authentication',
    group: 'workflow',
    summary: 'the workflow password was typed, and no file of the run and no output holds it',
    fact: { kind: 'secret-absent', value: 'workflow-password', premise: { filled: 'password' } },
  },
  {
    kind: 'run',
    id: 'R12',
    area: 'Web participants',
    group: 'participants',
    summary: 'the password was typed, and no file of the run and no output holds it',
    fact: { kind: 'secret-absent', value: 'password', premise: { filled: 'password' } },
  },
  { kind: 'run', id: 'R13', area: 'Failure handling', group: 'cancel-after-input', summary: 'the app received the press once, and nothing sent it again', fact: { kind: 'app-saves', count: 1 } },
  { kind: 'run', id: 'R14', area: 'Failure handling', group: 'lost-after-input', summary: 'the app received the press once, and nothing sent it again', fact: { kind: 'app-saves', count: 1 } },
  { kind: 'run', id: 'R15', area: 'Failure handling', group: 'lost-while-looking', summary: 'the app received the save once, and nothing sent it again', fact: { kind: 'app-saves', count: 1 } },
  {
    kind: 'run',
    id: 'R16',
    area: 'Authentication',
    group: 'workflow',
    summary: 'the setup that passed saved its state once, and that state was restored for each test that names it and no other',
    fact: { kind: 'states', saved: ['signed-in'], restoredFor: ['F3.1b', 'F3.3a', 'F3.3b'] },
  },
  {
    kind: 'run',
    id: 'R17',
    area: 'Authentication',
    group: 'workflow',
    summary: 'a sign-in state was saved, and no file of the run holds its session cookie',
    fact: { kind: 'secret-absent', value: 'workflow-session-cookie', premise: { saved: 'signed-in' } },
  },
]

/** Every conformance case, in the order the table lists them. */
export const conformanceCases: readonly ConformanceCase[] = [
  ...navigation,
  ...locators,
  ...actions,
  ...actionability,
  ...assertions,
  ...structure,
  ...configuration,
  ...authentication,
  ...participants,
  ...scheduling,
  ...failureHandling,
  ...workflow,
  ...runs,
]

/** The group of this name. */
export function groupNamed(name: GroupName): Group {
  const found = groups.find((group) => group.name === name)
  if (found === undefined) throw new Error(`No conformance group is named ${name}`)
  return found
}
