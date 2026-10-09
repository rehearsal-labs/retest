import type { ConformanceDifference, SuiteDifference } from './engine-expectations.ts'

// Every case Firefox or WebKit ends otherwise than Chrome, with the outcome it gives, exactly, why in one sentence, and
// the item of the engine's page in docs/compatibility that records it; engine-expectations.ts holds each case to it.
// Chrome declares nothing. A declaration that stops holding fails its case: remove it then, with its item on that page
// and its line in the guide's section for the engine.

const firefoxPhone = 'Firefox cannot emulate a touch screen, a mobile layout through WebDriver BiDi in the release Retest drives. A Firefox target takes a viewport, and no device.'
const webKitPhone = "Retest's WebKit driver cannot emulate a mobile layout or a touch screen. Give this WebKit target a viewport, or a screen with isMobile and touch false."
const firefoxToggle = 'Firefox cannot verify the native option holding keyboard focus before toggling it. A move can leave that focus unchanged, so Retest refuses multiple-select keyboard input before an unrequested option could be selected. Retest sent no input.'
const titleWithEscape = '\u009bBell tab \u001b[2J'

function refusedToggle(choice: string) {
  return { ok: false, failure: { class: 'unsupported', message: `Could not select ${choice} in getByTestId('toppings'): ${firefoxToggle}`, details: { inputSent: false } } }
}

/** The cases of the shared browser suites an engine ends otherwise. */
export const suiteDifferences: readonly SuiteDifference[] = [
  {
    engine: 'firefox',
    suite: 'browser-actions',
    case: ['fill stops the typing when the focus moves after Retest focused the field, and names where it went', 'Release checklist'],
    reason: 'Firefox types a fill key by key, so the first event the input guard stops is keydown rather than the beforeinput of text Chrome inserts.',
    documented: { item: 1, title: 'Typing is key by key, so a stopped fill names `keydown`.' },
    observed: { check: 'focused', focus: '<input data-testid="other">', event: 'keydown' },
  },
  {
    engine: 'firefox',
    suite: 'browser-actions',
    case: ['a character is typed with the key a person presses for it, and Shift for an uppercase letter or a shifted symbol', 'the page hears each key and its modifiers'],
    reason: 'WebDriver BiDi sets Shift only by pressing its key, so the page also hears Shift go down before an uppercase letter or a shifted symbol.',
    documented: { item: 2, title: 'Shift is a key of its own.' },
    observed: 'a:KeyA: Shift:ShiftLeft:shift A:KeyA:shift 7:Digit7: Shift:ShiftLeft:shift !:Digit1:shift é::',
  },
  {
    engine: 'firefox',
    suite: 'browser-actions',
    case: ['each editing key edits a field once', 'Home then X'],
    reason: "Firefox on macOS follows the system's key bindings, where Home leaves the caret at the end of a text field.",
    documented: { item: 3, title: 'Home moves no caret in a text field on macOS.' },
    observed: 'abcdX',
  },
  {
    engine: 'firefox',
    suite: 'browser-actions',
    case: ['a list chooses exactly those options of a select multiple and clears the others; one option chooses just that one'],
    reason: "Firefox's driver refuses keyboard input to a multiple select before any key, since Firefox shows no option holding the list's focus to check before Space toggles it.",
    documented: { item: 4, title: 'A multiple select that needs keyboard moves is refused.' },
    observed: {
      several: refusedToggle("['Basil', { value: 'olives' }]"),
      shownAfterSeveral: 'cheese',
      same: refusedToggle("['Olives', 'Basil']"),
      one: refusedToggle("'Garlic'"),
      shownAfterOne: 'cheese',
    },
  },
  {
    engine: 'firefox',
    suite: 'browser-actions',
    case: ['the wheel turned on the terms scrolls them to their end, which enables Accept'],
    reason: 'Firefox scrolls an element by at most one page for one wheel event, so a 2000 pixel turn moves the terms without reaching their end.',
    documented: { item: 5, title: 'One wheel event moves at most one page.' },
    observed: {
      scrolled: { ok: true, kind: 'scroll', page: { url: '{origin}/actions/scroll', title: 'Scroll' } },
      moved: true,
      accept: 'disabled',
      clicked: { ok: false, failure: { class: 'not_actionable', message: "Could not click getByTestId('accept') within 2000 ms: it is disabled.", details: { check: 'enabled', covering: null, waitedMs: 2000 } } },
    },
  },
  {
    engine: 'firefox',
    suite: 'browser-actions',
    case: ['a scroll delta is in CSS pixels, also on a phone page zoomed out to fit, where the wheel still scrolls'],
    reason: 'WebDriver BiDi in Firefox 133 offers no touch screen and no mobile layout, so a page asked to emulate a phone is refused as it opens.',
    documented: { item: 6, title: 'No phone or touch screen.' },
    observed: { plain: 'moved by 60', phone: { refused: { class: 'unsupported', message: firefoxPhone } } },
  },
  {
    engine: 'webkit',
    suite: 'browser-actions',
    case: ['a scroll delta is in CSS pixels, also on a phone page zoomed out to fit, where the wheel still scrolls'],
    reason: "Retest's WebKit driver has no mobile layout and no touch screen, so a page asked to emulate a phone is refused as it opens.",
    documented: { item: 6, title: 'No phone or touch screen.' },
    observed: { plain: 'moved by 60', phone: { refused: { class: 'unsupported', message: webKitPhone } } },
  },
  {
    engine: 'firefox',
    suite: 'browser-locators',
    case: ['role without a name finds every element with it, and a role Chrome names its own way is found by its WAI-ARIA name', 'img Logo'],
    reason: "Firefox's accessibility tree treats an image that did not load otherwise than Chrome's, so a lookup such an image could answer is refused by name.",
    documented: { item: 7, title: "Roles and names Firefox's tree computes its own way are refused by name." },
    observed: {
      ok: false,
      failure: {
        class: 'unsupported',
        message: "Could not look up getByRole('img', { name: 'Logo' }): an image that did not load has different accessibility membership. Retest cannot judge this lookup on Firefox. Use a test id or text.",
        details: { role: 'img' },
      },
    },
  },
  {
    engine: 'firefox',
    suite: 'browser-navigation',
    case: ['an address nobody answers fails with the browser navigation error'],
    reason: "Firefox names a refused connection by its error page's reason, connectionFailure, which the driver passes on.",
    documented: { item: 8, title: "A failed navigation is told in Firefox's words." },
    observed: 'Could not open {origin}/: connectionFailure.',
  },
  {
    engine: 'firefox',
    suite: 'browser-navigation',
    case: ["an address nobody answers names the address without its query and the browser's error in its details"],
    reason: "Firefox names a refused connection by its error page's reason, connectionFailure, which the driver passes on.",
    documented: { item: 8, title: "A failed navigation is told in Firefox's words." },
    observed: { url: '{origin}/', errorText: 'connectionFailure' },
  },
  {
    engine: 'webkit',
    suite: 'browser-navigation',
    case: ['an address nobody answers fails with the browser navigation error'],
    reason: 'WebKit tells a refused connection in its own words, which the driver passes on.',
    documented: { item: 1, title: "A failed navigation is told in WebKit's words." },
    observed: 'Could not open {origin}/: Could not connect to the server.',
  },
  {
    engine: 'webkit',
    suite: 'browser-navigation',
    case: ["an address nobody answers names the address without its query and the browser's error in its details"],
    reason: 'WebKit tells a refused connection in its own words, which the driver passes on.',
    documented: { item: 1, title: "A failed navigation is told in WebKit's words." },
    observed: { url: '{origin}/', errorText: 'Could not connect to the server.' },
  },
  {
    engine: 'firefox',
    suite: 'browser-navigation',
    case: ['a title reaches the parent as the page has it, a C1 control character and all', 'the goto hands over the title'],
    reason: "Firefox's document.title keeps an ESC character where Chrome's reads it as a space.",
    documented: { item: 9, title: 'A title keeps the control characters `document.title` keeps.' },
    observed: { ok: true, kind: 'goto', url: '{origin}/titles/echo', page: { url: '{origin}/titles/echo', title: titleWithEscape } },
  },
  {
    engine: 'firefox',
    suite: 'browser-navigation',
    case: ['a title reaches the parent as the page has it, a C1 control character and all', 'the navigation hands over the title'],
    reason: "Firefox's document.title keeps an ESC character where Chrome's reads it as a space.",
    documented: { item: 9, title: 'A title keeps the control characters `document.title` keeps.' },
    observed: [titleWithEscape],
  },
  {
    engine: 'webkit',
    suite: 'browser-navigation',
    case: ['a title reaches the parent as the page has it, a C1 control character and all', 'the goto hands over the title'],
    reason: "WebKit's document.title keeps an ESC character where Chrome's reads it as a space.",
    documented: { item: 2, title: 'A title keeps the control characters `document.title` keeps.' },
    observed: { ok: true, kind: 'goto', url: '{origin}/titles/echo', page: { url: '{origin}/titles/echo', title: titleWithEscape } },
  },
  {
    engine: 'webkit',
    suite: 'browser-navigation',
    case: ['a title reaches the parent as the page has it, a C1 control character and all', 'the navigation hands over the title'],
    reason: "WebKit's document.title keeps an ESC character where Chrome's reads it as a space.",
    documented: { item: 2, title: 'A title keeps the control characters `document.title` keeps.' },
    observed: [titleWithEscape],
  },
  {
    engine: 'webkit',
    suite: 'browser-navigation',
    case: ['goBack onto a response with no content fails at once, naming the navigation the browser gave up, and the history stays at the page that stayed'],
    reason: "WebKit's history stays at the entry it gave up, so the next move back goes to that entry, whose address now answers with no content again.",
    documented: { item: 3, title: "WebKit's history stays at an entry it gave up." },
    observed: {
      next: { ok: true, kind: 'goto', url: '{origin}/flip', page: { url: '{origin}/flip', title: 'Page' } },
      backAgain: {
        ok: false,
        failure: {
          class: 'not_actionable',
          message:
            'Could not go back to {origin}/flip: the browser sent the request and gave the navigation up without opening a document, as it does for a response with no content or a download. The page stayed on {origin}/flip.',
          details: { url: '{origin}/flip', inputSent: true },
        },
      },
      shown: '/flip?for=forward',
    },
  },
  {
    engine: 'firefox',
    suite: 'browser-secrets',
    case: ['a page that sets off for another origin as the field takes focus is kept where it is, and the secret is never typed', 'the page hears that its navigation was cancelled'],
    reason: 'Firefox 133 gives a page no Navigation API, so the page cannot listen for the navigation Retest cancelled and never reports it.',
    documented: { item: 10, title: "A page's script has no Navigation API." },
    observed: 0,
  },
  {
    engine: 'firefox',
    suite: 'browser-secrets',
    case: ['a fill bound to its origin still lets the page move within the document, and leave once the text has arrived', 'the page leaves after receiving the text once', 'the text reached one request'],
    reason: 'Firefox cancels the request a page sends just before it leaves for another document, so that request never reaches the server.',
    documented: { item: 11, title: 'A request the page starts as it leaves is cancelled.' },
    observed: 0,
  },
]

/** The conformance cases an engine ends otherwise. */
export const conformanceDifferences: readonly ConformanceDifference[] = [
  {
    engine: 'firefox',
    case: 'A5',
    reason: "Firefox's driver refuses keyboard input to a multiple select before any key, since Firefox shows no option holding the list's focus to check before Space toggles it.",
    documented: { item: 4, title: 'A multiple select that needs keyboard moves is refused.' },
    outcome: {
      status: 'error',
      class: 'unsupported',
      operation: 'select',
      at: { holding: "getByLabel('Toppings').select(['Olives', 'Basil'])" },
      message: `Could not select ['Olives', 'Basil'] in getByLabel('Toppings'): ${firefoxToggle}`,
    },
    facts: [
      { kind: 'detail', key: 'inputSent', value: false },
      { kind: 'at-once', withinMs: 1000 },
    ],
  },
  {
    engine: 'firefox',
    case: 'A7',
    reason: 'Firefox scrolls an element by at most one page for one wheel event, so a 2000 pixel turn moves the terms without reaching their end.',
    documented: { item: 5, title: 'One wheel event moves at most one page.' },
    outcome: {
      status: 'failed',
      class: 'check_failed',
      operation: 'toBeEnabled',
      at: { holding: 'toBeEnabled()' },
      message: "getByTestId('accept') is disabled. Looked {looks} times in 1500 ms.",
    },
    facts: [{ kind: 'deadline', ms: 1500 }],
  },
  {
    engine: 'firefox',
    case: 'F8.1a',
    reason: "Firefox's accessibility tree does not name a cell from its text, so the driver refuses a cell looked up by such a name.",
    documented: { item: 7, title: "Roles and names Firefox's tree computes its own way are refused by name." },
    outcome: {
      status: 'error',
      class: 'unsupported',
      operation: 'toBeVisible',
      at: { holding: "getByRole('cell', { name: 'Grace Hopper' })" },
      message: "Could not look up getByRole('cell', { name: 'Grace Hopper' }): Chrome names a cell from its text, and Firefox's accessibility tree does not, so Retest refuses the lookup rather than find less on Firefox. Find it with getByText() or getByTestId(), or by its position with nth().",
    },
    facts: [
      { kind: 'detail', key: 'role', value: 'cell' },
      { kind: 'at-once', withinMs: 1000 },
    ],
  },
  {
    engine: 'webkit',
    case: 'F8.1a',
    reason: "WebKit's accessibility tree does not name a cell from its text, so the driver refuses a cell looked up by such a name.",
    documented: { item: 4, title: "Roles and names WebKit's tree computes its own way." },
    outcome: {
      status: 'error',
      class: 'unsupported',
      operation: 'toBeVisible',
      at: { holding: "getByRole('cell', { name: 'Grace Hopper' })" },
      message: "Could not look up getByRole('cell', { name: 'Grace Hopper' }): Chrome names a cell from its text, and WebKit's accessibility tree does not, so Retest refuses the lookup rather than find less on WebKit. Find it with getByText() or getByTestId(), or by its position with nth().",
    },
    facts: [
      { kind: 'detail', key: 'role', value: 'cell' },
      { kind: 'at-once', withinMs: 1000 },
    ],
  },
]
