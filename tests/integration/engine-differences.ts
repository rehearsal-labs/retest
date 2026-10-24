import type { ConformanceDifference, SuiteDifference } from './engine-expectations.ts'

// Every case Firefox or WebKit ends otherwise than Chrome, with the outcome it gives, exactly, why in one sentence, and
// the item of the engine's page in docs/compatibility that records it; engine-expectations.ts holds each case to it.
// Chrome declares nothing. A declaration that stops holding fails its case: remove it then, with its item on that page
// and its line in the guide's section for the engine.

const firefoxPhone = 'Firefox cannot emulate a touch screen, a mobile layout through WebDriver BiDi in the release Retest drives. A Firefox target takes a viewport, and no device.'
const webKitPhone = "Retest's WebKit driver cannot emulate a mobile layout or a touch screen. Give this WebKit target a viewport, or a screen with isMobile and touch false."
const firefoxToggle = 'Firefox cannot verify the native option holding keyboard focus before toggling it. A move can leave that focus unchanged, so Retest refuses multiple-select keyboard input before an unrequested option could be selected. Retest sent no input.'
const titleWithEscape = '\u009bBell tab \u001b[2J'

// The failure of a command an alert nothing waited for holds the page during, on an engine that does not answer it.
function heldDialog(command: string): string {
  return `The page opened an alert dialog while Retest tried to ${command}. Retest does not answer dialogs yet, and the dialog blocks the page.`
}

function refusedToggle(choice: string) {
  return { ok: false, failure: { class: 'unsupported', message: `Could not select ${choice} in getByTestId('toppings'): ${firefoxToggle}`, details: { inputSent: false } } }
}

// A role or label lookup refused on an engine whose tree, as Retest reads it, stops at shadow roots, naming the host of
// the first open root in its search that could hold a match.
function shadowRefusal(engine: string, command: string, host = '<checkout-panel>') {
  return {
    class: 'unsupported',
    message: `Could not ${command}: on ${engine}, Retest finds by role or label outside shadow roots only, and the open shadow root of ${host} could hold a match. Find the element by test id, text or CSS.`,
  }
}

// The shadow checkout's lookups on such an engine. A root holding no element of the role, or none of the words of the
// name, is left alone: the sealed button is looked for, and is not found, as on Chrome.
function shadowLookups(engine: string) {
  return {
    buttons: shadowRefusal(engine, "read getByRole('button')"),
    ariaLabel: shadowRefusal(engine, "read getByRole('button', { name: 'Close panel' })"),
    labelFor: shadowRefusal(engine, "read getByLabel('Coupon')"),
    twoDeep: shadowRefusal(engine, "read getByLabel('Card number')", '<card-field>'),
    acrossRoots: shadowRefusal(engine, "read getByLabel('Outside name')"),
    closed: [],
    scoped: shadowRefusal(engine, "read getByTestId('panel').getByRole('button', { name: 'Pay' })"),
  }
}

function slottedClicks(engine: string) {
  return {
    payNow: shadowRefusal(engine, "click getByRole('button', { name: 'Pay now' })", '<my-button>'),
    refund: shadowRefusal(engine, "click getByRole('button', { name: 'Refund' })", '<my-button>'),
  }
}

function treeLookups(engine: string) {
  return {
    trees: shadowRefusal(engine, "read getByRole('button', { name: 'tree', exact: false })", '<div>'),
    inRoot: shadowRefusal(engine, "read getByRole('button', { name: 'Tree two' })", '<div>'),
  }
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
    platforms: ['darwin'],
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
    case: ['a scroll delta is in CSS pixels, also on a phone page zoomed out to fit, where the wheel still scrolls'],
    reason: 'WebDriver BiDi in Firefox 158 offers no touch screen and no mobile layout, so a page asked to emulate a phone is refused as it opens.',
    documented: { item: 5, title: 'No phone or touch screen.' },
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
    documented: { item: 6, title: "Roles and names Firefox's tree computes its own way are refused by name." },
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
    documented: { item: 7, title: "A failed navigation is told in Firefox's words." },
    observed: 'Could not open {origin}/: connectionFailure.',
  },
  {
    engine: 'firefox',
    suite: 'browser-navigation',
    case: ["an address nobody answers names the address without its query and the browser's error in its details"],
    reason: "Firefox names a refused connection by its error page's reason, connectionFailure, which the driver passes on.",
    documented: { item: 7, title: "A failed navigation is told in Firefox's words." },
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
    documented: { item: 8, title: 'A title keeps the control characters `document.title` keeps.' },
    observed: { ok: true, kind: 'goto', url: '{origin}/titles/echo', page: { url: '{origin}/titles/echo', title: titleWithEscape } },
  },
  {
    engine: 'firefox',
    suite: 'browser-navigation',
    case: ['a title reaches the parent as the page has it, a C1 control character and all', 'the navigation hands over the title'],
    reason: "Firefox's document.title keeps an ESC character where Chrome's reads it as a space.",
    documented: { item: 8, title: 'A title keeps the control characters `document.title` keeps.' },
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
    case: ['a fill bound to its origin still lets the page move within the document, and leave once the text has arrived', 'the page leaves after receiving the text once', 'the text reached one request'],
    reason: 'Firefox cancels the request a page sends just before it leaves for another document, so that request never reaches the server.',
    documented: { item: 9, title: 'A request the page starts as it leaves is cancelled.' },
    observed: 0,
  },
  {
    engine: 'firefox',
    suite: 'browser-actions',
    case: ['a click that opens an alert nothing waited for fails at once, and the next command and a screenshot do not wait on it'],
    reason: 'Retest hands dialogs to a test and answers those nothing waited for on Chrome and Chromium only, so on Firefox the alert holds the page and every command fails at once.',
    documented: { item: 10, title: 'A JavaScript dialog holds the page.' },
    observed: {
      click: { class: 'unsupported', message: heldDialog("click getByTestId('warn')"), details: { dialog: 'alert', inputSent: true } },
      next: { dialog: 'alert', inputSent: false },
      screenshot: 'unsupported',
    },
  },
  {
    engine: 'firefox',
    suite: 'browser-secrets',
    case: ['a dialog that opens while a secret is typed names the secret by its label'],
    reason: 'Retest hands dialogs to a test and answers those nothing waited for on Chrome and Chromium only, so on Firefox the alert holds the page and the fill fails as unsupported.',
    documented: { item: 10, title: 'A JavaScript dialog holds the page.' },
    observed: { class: 'unsupported', message: heldDialog("fill getByTestId('field') with {{password}}") },
  },
  {
    engine: 'webkit',
    suite: 'browser-actions',
    case: ['a click that opens an alert nothing waited for fails at once, and the next command and a screenshot do not wait on it'],
    reason: 'Retest hands dialogs to a test and answers those nothing waited for on Chrome and Chromium only, so on WebKit the alert holds the page and every command fails at once.',
    documented: { item: 11, title: 'A JavaScript dialog holds the page.' },
    observed: {
      click: { class: 'unsupported', message: heldDialog("click getByTestId('warn')"), details: { dialog: 'alert', inputSent: true } },
      next: { dialog: 'alert', inputSent: false },
      screenshot: 'unsupported',
    },
  },
  {
    engine: 'webkit',
    suite: 'browser-secrets',
    case: ['a dialog that opens while a secret is typed names the secret by its label'],
    reason: 'Retest hands dialogs to a test and answers those nothing waited for on Chrome and Chromium only, so on WebKit the alert holds the page and the fill fails as unsupported.',
    documented: { item: 11, title: 'A JavaScript dialog holds the page.' },
    observed: { class: 'unsupported', message: heldDialog("fill getByTestId('field') with {{password}}") },
  },
  {
    engine: 'firefox',
    suite: 'browser-navigation',
    case: ['a page that opens a dialog while loading fails its goto at once, naming the dialog, rather than as slow'],
    reason: 'Retest hands dialogs to a test and answers those nothing waited for on Chrome and Chromium only, so on Firefox the confirm holds the page and the goto fails as unsupported.',
    documented: { item: 10, title: 'A JavaScript dialog holds the page.' },
    observed: {
      class: 'unsupported',
      message: 'The page opened a confirm dialog while Retest tried to open {origin}/. Retest does not answer dialogs yet, and the dialog blocks the page.',
      details: { dialog: 'confirm', inputSent: true },
    },
  },
  {
    engine: 'webkit',
    suite: 'browser-navigation',
    case: ['a page that opens a dialog while loading fails its goto at once, naming the dialog, rather than as slow'],
    reason: 'Retest hands dialogs to a test and answers those nothing waited for on Chrome and Chromium only, so on WebKit the confirm holds the page and the goto fails as unsupported.',
    documented: { item: 11, title: 'A JavaScript dialog holds the page.' },
    observed: {
      class: 'unsupported',
      message: 'The page opened a confirm dialog while Retest tried to open {origin}/. Retest does not answer dialogs yet, and the dialog blocks the page.',
      details: { dialog: 'confirm', inputSent: true },
    },
  },
  {
    engine: 'firefox',
    suite: 'browser-shadow-dom',
    case: ['role and label find through open shadow roots, two deep, and never into a closed one'],
    reason: "Firefox's accessibility locator does not look inside shadow roots, so a role or label lookup whose search holds an open root that could hold a match is refused by name.",
    documented: { item: 11, title: 'Role and label lookups stop at shadow roots.' },
    observed: shadowLookups('Firefox'),
  },
  {
    engine: 'firefox',
    suite: 'browser-shadow-dom',
    case: ['an action by label on a field inside a shadow root'],
    reason: "Firefox's accessibility locator does not look inside shadow roots, so a fill found by label whose search holds an open root that could hold the field is refused by name and types nothing.",
    documented: { item: 11, title: 'Role and label lookups stop at shadow roots.' },
    observed: shadowRefusal('Firefox', "fill getByLabel('Card number')", '<card-field>'),
  },
  {
    engine: 'firefox',
    suite: 'browser-shadow-dom',
    case: ['a button that shows its host’s text or element through a slot takes a click found by its role'],
    reason: "Firefox's accessibility locator does not look inside shadow roots, so a click found by role whose search holds an open root that could hold the button is refused by name and sends nothing.",
    documented: { item: 11, title: 'Role and label lookups stop at shadow roots.' },
    observed: slottedClicks('Firefox'),
  },
  {
    engine: 'firefox',
    suite: 'browser-locators',
    case: ['role finds through an open shadow root, in the order the page shows, and stays out of frames, as test id and text do'],
    reason: "Firefox's accessibility locator does not look inside shadow roots, so a role lookup whose search holds an open root that could hold a match is refused by name.",
    documented: { item: 11, title: 'Role and label lookups stop at shadow roots.' },
    observed: treeLookups('Firefox'),
  },
  {
    engine: 'webkit',
    suite: 'browser-shadow-dom',
    case: ['role and label find through open shadow roots, two deep, and never into a closed one'],
    reason: "Retest's reading of WebKit's accessibility tree does not look inside shadow roots, so a role or label lookup whose search holds an open root that could hold a match is refused by name.",
    documented: { item: 12, title: 'Role and label lookups stop at shadow roots.' },
    observed: shadowLookups('WebKit'),
  },
  {
    engine: 'webkit',
    suite: 'browser-shadow-dom',
    case: ['an action by label on a field inside a shadow root'],
    reason: "Retest's reading of WebKit's accessibility tree does not look inside shadow roots, so a fill found by label whose search holds an open root that could hold the field is refused by name and types nothing.",
    documented: { item: 12, title: 'Role and label lookups stop at shadow roots.' },
    observed: shadowRefusal('WebKit', "fill getByLabel('Card number')", '<card-field>'),
  },
  {
    engine: 'webkit',
    suite: 'browser-shadow-dom',
    case: ['a button that shows its host’s text or element through a slot takes a click found by its role'],
    reason: "Retest's reading of WebKit's accessibility tree does not look inside shadow roots, so a click found by role whose search holds an open root that could hold the button is refused by name and sends nothing.",
    documented: { item: 12, title: 'Role and label lookups stop at shadow roots.' },
    observed: slottedClicks('WebKit'),
  },
  {
    engine: 'webkit',
    suite: 'browser-locators',
    case: ['role finds through an open shadow root, in the order the page shows, and stays out of frames, as test id and text do'],
    reason: "Retest's reading of WebKit's accessibility tree does not look inside shadow roots, so a role lookup whose search holds an open root that could hold a match is refused by name.",
    documented: { item: 12, title: 'Role and label lookups stop at shadow roots.' },
    observed: treeLookups('WebKit'),
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
    case: 'F8.1a',
    reason: "Retest's Firefox driver refuses a cell looked up by name, since Firefox's cell names have not been compared with Chrome's across the role pages.",
    documented: { item: 6, title: "Roles and names Firefox's tree computes its own way are refused by name." },
    outcome: {
      status: 'error',
      class: 'unsupported',
      operation: 'toBeVisible',
      at: { holding: "getByRole('cell', { name: 'Grace Hopper' })" },
      message: "Could not look up getByRole('cell', { name: 'Grace Hopper' }): on Firefox, Retest does not look up a cell by its name, since it has not checked that Firefox names cells as Chrome does. Find it with getByText() or getByTestId(), or by its position with nth().",
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
