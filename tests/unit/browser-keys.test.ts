import type { Key } from '../../src/protocol/keys.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { keyStroke } from '../../src/browser/keys.ts'
import { namedKeys, parseKey } from '../../src/protocol/keys.ts'

function key(text: string): Key {
  const parsed = parseKey(text)
  assert.ok(parsed.ok, text)
  return parsed.key
}

test('each named key sends its key, code and virtual key code, as a raw key down unless it types', () => {
  const expected = {
    Enter: ['Enter', 'Enter', 13, '\r'],
    Tab: ['Tab', 'Tab', 9, undefined],
    Escape: ['Escape', 'Escape', 27, undefined],
    Backspace: ['Backspace', 'Backspace', 8, undefined],
    Delete: ['Delete', 'Delete', 46, undefined],
    Space: [' ', 'Space', 32, ' '],
    ArrowUp: ['ArrowUp', 'ArrowUp', 38, undefined],
    ArrowDown: ['ArrowDown', 'ArrowDown', 40, undefined],
    ArrowLeft: ['ArrowLeft', 'ArrowLeft', 37, undefined],
    ArrowRight: ['ArrowRight', 'ArrowRight', 39, undefined],
    Home: ['Home', 'Home', 36, undefined],
    End: ['End', 'End', 35, undefined],
    PageUp: ['PageUp', 'PageUp', 33, undefined],
    PageDown: ['PageDown', 'PageDown', 34, undefined],
  } as const
  assert.deepEqual(Object.keys(expected), [...namedKeys], 'every named key is covered')
  for (const name of namedKeys) {
    const [keyName, code, windowsVirtualKeyCode, text] = expected[name]
    const base = { key: keyName, code, windowsVirtualKeyCode, modifiers: 0 }
    const typed = text === undefined ? { type: 'rawKeyDown' } : { type: 'keyDown', text, unmodifiedText: text }
    assert.deepEqual(keyStroke(key(name), 'linux'), { held: [], down: { ...typed, ...base }, up: { type: 'keyUp', ...base }, released: [] }, name)
  }
})

test('Shift and a named key press Shift first, hold it for the key, and release it last', () => {
  const { held, down, up, released } = keyStroke(key('Shift+Tab'), 'linux')
  assert.deepEqual(held, [{ type: 'rawKeyDown', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16, modifiers: 8, location: 1 }])
  assert.deepEqual(down, { type: 'rawKeyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, modifiers: 8 })
  assert.deepEqual(up, { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, modifiers: 8 })
  assert.deepEqual(released, [{ type: 'keyUp', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16, modifiers: 0, location: 1 }])
})

test('a shortcut presses each modifier in the order written, types nothing, and releases them in reverse', () => {
  const { held, down, up, released } = keyStroke(key('Control+Alt+Delete'), 'linux')
  assert.deepEqual(
    held.map(({ type, key: name, modifiers }) => [type, name, modifiers]),
    [
      ['rawKeyDown', 'Control', 2],
      ['rawKeyDown', 'Alt', 3],
    ],
  )
  assert.deepEqual(down, { type: 'rawKeyDown', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46, modifiers: 3 })
  assert.equal(up.modifiers, 3)
  assert.deepEqual(
    released.map(({ type, key: name, modifiers }) => [type, name, modifiers]),
    [
      ['keyUp', 'Alt', 2],
      ['keyUp', 'Control', 0],
    ],
  )
  const select = keyStroke(key('Control+a'), 'linux').down
  assert.deepEqual(select, { type: 'rawKeyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 }, 'a shortcut sends no text')
  assert.deepEqual(keyStroke(key('Control+Shift+t'), 'linux').down, { type: 'rawKeyDown', key: 'T', code: 'KeyT', windowsVirtualKeyCode: 84, modifiers: 10 })
})

test('ControlOrMeta is Meta on macOS and Control elsewhere', () => {
  assert.deepEqual(keyStroke(key('ControlOrMeta+a'), 'darwin').held.map((event) => event.key), ['Meta'])
  assert.equal(keyStroke(key('ControlOrMeta+a'), 'darwin').down.modifiers, 4)
  assert.deepEqual(keyStroke(key('ControlOrMeta+a'), 'linux').held.map((event) => event.key), ['Control'])
})

test("on macOS a shortcut in Retest's table carries the editing command macOS binds to it, and others carry none", () => {
  const cases = [
    ['Meta+a', 'selectAll'],
    ['Meta+Z', 'undo'],
    ['Meta+Shift+z', 'redo'],
    ['Shift+Meta+z', 'redo'],
    ['Meta+ArrowLeft', 'moveToBeginningOfLine'],
    ['Meta+Shift+ArrowRight', 'moveToEndOfLineAndModifySelection'],
    ['Alt+ArrowLeft', 'moveWordLeft'],
    ['Alt+Shift+ArrowRight', 'moveWordRightAndModifySelection'],
    ['Alt+Backspace', 'deleteWordBackward'],
    ['Meta+Backspace', 'deleteToBeginningOfLine'],
  ] as const
  for (const [text, command] of cases) {
    assert.deepEqual(keyStroke(key(text), 'darwin').down.commands, [command], text)
    assert.equal(keyStroke(key(text), 'linux').down.commands, undefined, `${text} on Linux`)
  }
  for (const text of ['Control+a', 'Meta+k', 'Alt+Enter', 'Control+ArrowLeft']) assert.equal(keyStroke(key(text), 'darwin').down.commands, undefined, text)
})

test('a character is typed with the US key a person presses for it, and Shift where that key needs it', () => {
  const cases = [
    ['a', 'KeyA', 65, 0],
    ['z', 'KeyZ', 90, 0],
    ['A', 'KeyA', 65, 8],
    ['7', 'Digit7', 55, 0],
    ['0', 'Digit0', 48, 0],
    ['!', 'Digit1', 49, 8],
    ['?', 'Slash', 191, 8],
    ['/', 'Slash', 191, 0],
    ['.', 'Period', 190, 0],
    ['"', 'Quote', 222, 8],
    ['\\', 'Backslash', 220, 0],
  ] as const
  for (const [character, code, windowsVirtualKeyCode, modifiers] of cases) {
    const base = { key: character, code, windowsVirtualKeyCode, modifiers }
    assert.deepEqual(
      keyStroke(key(character), 'linux'),
      { held: [], down: { type: 'keyDown', ...base, text: character, unmodifiedText: character }, up: { type: 'keyUp', ...base }, released: [] },
      character,
    )
  }
})

test('a character no US key types is sent as its text alone, with Shift for an uppercase letter', () => {
  assert.deepEqual(keyStroke(key('é'), 'linux').down, { type: 'keyDown', key: 'é', code: '', windowsVirtualKeyCode: 0, modifiers: 0, text: 'é', unmodifiedText: 'é' })
  assert.deepEqual(keyStroke(key('É'), 'linux').down, { type: 'keyDown', key: 'É', code: '', windowsVirtualKeyCode: 0, modifiers: 8, text: 'É', unmodifiedText: 'É' })
  assert.deepEqual(keyStroke(key('€'), 'linux').up, { type: 'keyUp', key: '€', code: '', windowsVirtualKeyCode: 0, modifiers: 0 })
})

test('on macOS an editing key carries the command a headed browser edits by, alone and with Shift', () => {
  const cases = [
    ['Backspace', 'deleteBackward'],
    ['Delete', 'deleteForward'],
    ['ArrowLeft', 'moveLeft'],
    ['Shift+ArrowLeft', 'moveLeftAndModifySelection'],
    ['ArrowUp', 'moveUp'],
    ['Shift+ArrowDown', 'moveDownAndModifySelection'],
    ['ArrowRight', 'moveRight'],
    ['Home', 'scrollToBeginningOfDocument'],
    ['Shift+Home', 'moveToBeginningOfDocumentAndModifySelection'],
    ['End', 'scrollToEndOfDocument'],
    ['Shift+End', 'moveToEndOfDocumentAndModifySelection'],
    ['PageUp', 'scrollPageUp'],
    ['Shift+PageDown', 'pageDownAndModifySelection'],
  ] as const
  for (const [text, command] of cases) {
    const { down, up } = keyStroke(key(text), 'darwin')
    assert.deepEqual(down.commands, [command], text)
    assert.equal(up.commands, undefined, `${text}: the release carries no command`)
    assert.equal(keyStroke(key(text), 'linux').down.commands, undefined, `${text} on Linux`)
  }
})

test('on macOS a key that types or moves the focus carries no command, so the page still hears its keypress', () => {
  for (const text of ['Enter', 'Shift+Enter', 'Tab', 'Shift+Tab', 'Space', 'Escape', 'a', 'A', '!']) {
    assert.equal(keyStroke(key(text), 'darwin').down.commands, undefined, text)
  }
})
