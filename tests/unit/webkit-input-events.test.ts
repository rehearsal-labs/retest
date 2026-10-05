import assert from 'node:assert/strict'
import { test } from 'node:test'
import { keyStroke } from '../../src/browser/keys.ts'
import { keyInput, mouseInput, textInput, webKitModifiers } from '../../src/browser/webkit/input-events.ts'
import { chromeRoleOf, doubtedRole, genericRefusal, roleRefusal, webKitRolesFor } from '../../src/browser/webkit/roles.ts'
import { defaultScreen, webKitScreen } from '../../src/browser/webkit/screen.ts'

test("CDP's modifier bits become the bits the WebKit build sets shiftKey, ctrlKey, altKey and metaKey for", { timeout: 10_000 }, () => {
  // CDP: Alt 1, Control 2, Meta 4, Shift 8. The build, as observed: Shift 1, Control 2, Alt 4, Meta 8.
  assert.deepEqual([1, 2, 4, 8].map(webKitModifiers), [4, 2, 8, 1])
  assert.equal(webKitModifiers(1 | 8), 4 | 1)
  assert.equal(webKitModifiers(0), 0)
})

test('a CDP mouse move, press and release go to the page proxy as WebKit names them, at whole pixels rounded down', { timeout: 10_000 }, () => {
  assert.deepEqual(mouseInput({ type: 'mouseMoved', x: 10.9, y: 20.1 }), { to: 'page proxy', method: 'Input.dispatchMouseEvent', params: { type: 'move', x: 10, y: 20, button: 'none', buttons: 0, modifiers: 0 } })
  assert.deepEqual(mouseInput({ type: 'mousePressed', x: 3.5, y: 4.5, button: 'left', buttons: 1, clickCount: 1 }).params, { type: 'down', x: 3, y: 4, button: 'left', buttons: 1, clickCount: 1, modifiers: 0 })
  assert.deepEqual(mouseInput({ type: 'mouseReleased', x: 3, y: 4, button: 'left', buttons: 0, clickCount: 1, modifiers: 8 }).params, { type: 'up', x: 3, y: 4, button: 'left', buttons: 0, clickCount: 1, modifiers: 1 })
})

test("the wheel goes as Input.dispatchWheelEvent, since WebKit's mouse event refuses a wheel", { timeout: 10_000 }, () => {
  assert.deepEqual(mouseInput({ type: 'mouseWheel', x: 400.5, y: 300.5, deltaX: 0, deltaY: 199.6 }), { to: 'page proxy', method: 'Input.dispatchWheelEvent', params: { x: 400, y: 300, deltaX: 0, deltaY: 200, modifiers: 0 } })
})

test('a mouse event WebKit has no counterpart for is refused by name', { timeout: 10_000 }, () => {
  assert.throws(() => mouseInput({ type: 'mouseDragged', x: 1, y: 1 }), /WebKit has no mouse event for CDP's mouseDragged/)
})

test('a raw key down is a key down with no text, its editing command goes as a selector with its colon, and a key up carries neither', { timeout: 10_000 }, () => {
  const backspace = keyStroke({ kind: 'named', name: 'Backspace', held: [] }, 'darwin')
  assert.deepEqual(keyInput(backspace.down).params, { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, modifiers: 0, macCommands: ['deleteBackward:'] })
  assert.deepEqual(keyInput(backspace.up).params, { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, modifiers: 0 })
})

test('a key that types sends its text, and a shifted letter carries the build’s Shift bit', { timeout: 10_000 }, () => {
  const capital = keyStroke({ kind: 'character', character: 'Z', shift: true, held: [] }, 'darwin')
  assert.deepEqual(keyInput(capital.down), { to: 'page proxy', method: 'Input.dispatchKeyEvent', params: { type: 'keyDown', key: 'Z', code: 'KeyZ', windowsVirtualKeyCode: 90, modifiers: 1, text: 'Z', unmodifiedText: 'Z' } })
  const selectAll = keyStroke({ kind: 'character', character: 'a', shift: false, held: ['Meta'] }, 'darwin')
  assert.deepEqual(keyInput(selectAll.down).params, { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 8, macCommands: ['selectAll:'] })
})

test('Return in a field ends the line by its command, which a one-line field leaves to its form, and Home and End move the caret as Chrome moves it', { timeout: 10_000 }, () => {
  const enter = keyStroke({ kind: 'named', name: 'Enter', held: [] }, 'darwin')
  assert.deepEqual(keyInput(enter.down).params, { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: 0, text: '\r', unmodifiedText: '\r', macCommands: ['insertNewline:'] })
  assert.equal(keyInput(enter.up).params['macCommands'], undefined)
  const home = keyStroke({ kind: 'named', name: 'Home', held: [] }, 'darwin')
  assert.deepEqual(keyInput(home.down).params['macCommands'], ['moveToBeginningOfDocument:'])
  const end = keyStroke({ kind: 'named', name: 'End', held: [] }, 'darwin')
  assert.deepEqual(keyInput(end.down).params['macCommands'], ['moveToEndOfDocument:'])
  const selectToStart = keyStroke({ kind: 'named', name: 'Home', held: ['Shift'] }, 'darwin')
  assert.deepEqual(keyInput(selectToStart.down).params['macCommands'], ['moveToBeginningOfDocumentAndModifySelection:'])
})

test("CDP's Input.insertText is WebKit's Page.insertText on the page target", { timeout: 10_000 }, () => {
  assert.deepEqual(textInput({ text: 'héllo' }), { to: 'target', method: 'Page.insertText', params: { text: 'héllo' } })
})

test("a role Chrome's tree names its own way is asked of WebKit by WebKit's name, and WebKit's names for a select and a number field are mapped back", { timeout: 10_000 }, () => {
  assert.deepEqual(webKitRolesFor('MathMLMath'), ['math'])
  assert.deepEqual(webKitRolesFor('image'), ['image'])
  assert.deepEqual(webKitRolesFor('button'), ['button'])
  assert.equal(chromeRoleOf('button', { select: true, numberField: false }), 'combobox')
  assert.equal(chromeRoleOf('button', { select: false, numberField: false }), 'button')
  assert.equal(chromeRoleOf('textbox', { select: false, numberField: true }), 'spinbutton')
  assert.equal(chromeRoleOf('listbox', { select: true, numberField: false }), 'listbox')
})

// Read beside Chrome on build 2359, kind by kind, in webkit-roles.test.ts: each mapping is the HTML element's own kind.
test("an input with a suggestion list, a date field, a plain editable element and a figure caption are named as Chrome's tree names them", { timeout: 10_000 }, () => {
  const plain = { select: false, numberField: false }
  assert.equal(chromeRoleOf('textbox', { ...plain, suggests: true }), 'combobox')
  assert.equal(chromeRoleOf('searchbox', { ...plain, suggests: true }), 'combobox')
  assert.equal(chromeRoleOf('textbox', { select: false, numberField: true, suggests: true }), 'combobox', 'a number field with a list is a combobox, not a spinbutton')
  assert.equal(chromeRoleOf('slider', { ...plain, suggests: true }), 'slider')
  assert.equal(chromeRoleOf('textbox', { ...plain, dateField: true }), '')
  assert.equal(chromeRoleOf('textbox', { ...plain, plainEditor: true }), '')
  assert.equal(chromeRoleOf('caption', { ...plain, figureCaption: true }), '')
  assert.equal(chromeRoleOf('caption', plain), 'caption', "a table's caption keeps its role")
  assert.equal(chromeRoleOf('textbox', plain), 'textbox')
})

// The refusals are now the page's own: a reading says what on the page makes a lookup differ, and only a lookup that
// doubt could change is refused. The cell and option messages are the ones the static refusals gave.
test("a lookup by a name WebKit's tree does not give is found as refused, in any step, and a role it names is not", { timeout: 10_000 }, () => {
  const cellNames = { role: 'cell', lookups: 'named', fewer: true, reason: "Chrome names a cell from its text, and WebKit's accessibility tree does not" } as const
  const headerNames = { ...cellNames, role: 'columnheader', reason: "Chrome names a columnheader from its text, and WebKit's accessibility tree does not" } as const
  assert.equal(doubtedRole({ by: 'role', role: 'cell', name: 'Grace Hopper' }, cellNames), 'cell')
  assert.equal(doubtedRole({ by: 'role', role: 'button', name: 'Save', within: [{ by: 'role', role: 'columnheader', name: 'Name' }] }, headerNames), 'columnheader')
  for (const role of ['gridcell', 'rowheader', 'tooltip'] as const) assert.equal(doubtedRole({ by: 'role', role, name: 'x' }, { ...cellNames, role }), role)
  assert.equal(doubtedRole({ by: 'role', role: 'cell' }, cellNames), undefined, 'cells counted without a name are what WebKit tells')
  assert.equal(doubtedRole({ by: 'role', role: 'heading', name: 'Tasks' }, cellNames), undefined)
  assert.equal(doubtedRole({ by: 'testId', value: 'cell' }, cellNames), undefined)
  const selectOptions = { role: 'option', lookups: 'unnamed', fewer: true, reason: "the page holds a select's options, which Chrome's tree counts and WebKit's leaves out of a closed select" } as const
  const optionNames = { role: 'option', lookups: 'names', names: ['Canada', 'Mexico '], fewer: true, reason: "Chrome names each option of a select from its text, and WebKit's accessibility tree names none and leaves out those of a closed select" } as const
  assert.equal(doubtedRole({ by: 'role', role: 'option', name: 'Canada' }, optionNames), 'option')
  assert.equal(doubtedRole({ by: 'role', role: 'option', name: 'can', exact: false }, optionNames), 'option', 'a part of a name, in any case, as the lookup matches')
  assert.equal(doubtedRole({ by: 'role', role: 'option', name: { pattern: '^mex', flags: 'i' } }, optionNames), 'option')
  assert.equal(doubtedRole({ by: 'role', role: 'option', name: 'Paris' }, optionNames), undefined, "a custom option no select's option could be named is answered")
  assert.equal(doubtedRole({ by: 'role', role: 'option', name: 'Paris' }, selectOptions), undefined)
  assert.equal(doubtedRole({ by: 'text', text: 'Canada', within: [{ by: 'role', role: 'option' }] }, selectOptions), 'option')
  assert.equal(doubtedRole({ by: 'role', role: 'listbox' }, selectOptions), undefined)
  assert.deepEqual(roleRefusal({ by: 'role', role: 'cell', name: 'Grace Hopper' }, 'cell', cellNames, false), {
    class: 'unsupported',
    message: "Could not look up getByRole('cell', { name: 'Grace Hopper' }): Chrome names a cell from its text, and WebKit's accessibility tree does not, so Retest refuses the lookup rather than find less on WebKit. Find it with getByText() or getByTestId(), or by its position with nth().",
    details: { role: 'cell' },
  })
  assert.deepEqual(roleRefusal({ by: 'role', role: 'option', name: 'Canada' }, 'option', optionNames, false), {
    class: 'unsupported',
    message: "Could not look up getByRole('option', { name: 'Canada' }): Chrome names each option of a select from its text, and WebKit's accessibility tree names none and leaves out those of a closed select, so Retest refuses the lookup rather than find less on WebKit. Choose an option with select(), or find it with getByText() or getByTestId().",
    details: { role: 'option' },
  })
})

test('a label lookup is doubted through every role a label names, a doubt of every role reaches any role step, and generic is refused before anything is sent', { timeout: 10_000 }, () => {
  const editor = { role: '*', lookups: 'all', fewer: false, reason: 'an editable heading' } as const
  const textboxes = { role: 'textbox', lookups: 'all', fewer: false, reason: 'a text box' } as const
  assert.equal(doubtedRole({ by: 'label', text: 'Email' }, textboxes), 'textbox')
  assert.equal(doubtedRole({ by: 'label', text: 'Email' }, editor), 'textbox', 'the first role a label names')
  assert.equal(doubtedRole({ by: 'role', role: 'heading' }, editor), 'heading')
  assert.equal(doubtedRole({ by: 'placeholder', text: 'Email' }, editor), undefined)
  const refused = roleRefusal({ by: 'role', role: 'img' }, 'img', { reason: 'the page holds an <svg> drawing with no role', fewer: false }, true)
  assert.match(refused.message, /rather than find a different set on WebKit\. .* Retest had already begun to act on it, and input it sent is not taken back\.$/)
  assert.deepEqual(refused.details, { role: 'img', inputSent: true })
  assert.equal(genericRefusal({ by: 'role', role: 'generic' })?.class, 'unsupported')
  assert.equal(genericRefusal({ by: 'text', text: 'x', within: [{ by: 'role', role: 'generic', name: 'Box' }] })?.details?.['role'], 'generic')
  assert.equal(genericRefusal({ by: 'role', role: 'button' }), undefined)
})

test('a WebKit page takes a viewport, a pixel ratio and a user agent, and refuses a mobile layout or a touch screen by name', { timeout: 10_000 }, () => {
  assert.deepEqual(webKitScreen(undefined), { ok: true, screen: defaultScreen })
  assert.deepEqual(webKitScreen({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, touch: false, isMobile: false, userAgent: 'Agent' }), { ok: true, screen: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, userAgent: 'Agent' } })
  const refused = webKitScreen({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, touch: true, isMobile: true })
  assert.deepEqual(refused, { ok: false, failure: { class: 'unsupported', message: "Retest's WebKit driver cannot emulate a mobile layout or a touch screen. Give this WebKit target a viewport, or a screen with isMobile and touch false." } })
})
