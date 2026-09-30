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
    assert.deepEqual(keyStroke(key(name), 'linux'), { down: { ...typed, ...base }, up: { type: 'keyUp', ...base } }, name)
  }
})

test('Shift and a named key hold Shift for the press and the release', () => {
  const { down, up } = keyStroke(key('Shift+Tab'), 'linux')
  assert.deepEqual(down, { type: 'rawKeyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, modifiers: 8 })
  assert.deepEqual(up, { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, modifiers: 8 })
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
      { down: { type: 'keyDown', ...base, text: character, unmodifiedText: character }, up: { type: 'keyUp', ...base } },
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
