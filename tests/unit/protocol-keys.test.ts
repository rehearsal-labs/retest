import type { Key } from '../../src/protocol/keys.ts'
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { namedKeys, parseKey } from '../../src/protocol/keys.ts'

function accepted(text: string): Key {
  const parsed = parseKey(text)
  assert.ok(parsed.ok, `expected ${JSON.stringify(text)} to be a key`)
  return parsed.key
}

function refused(text: string): { class: string; message: string } {
  const parsed = parseKey(text)
  assert.equal(parsed.ok, false, `expected ${JSON.stringify(text)} to be refused`)
  return parsed.ok ? { class: '', message: '' } : parsed.failure
}

const forms =
  'a named key (Enter, Tab, Escape, Backspace, Delete, Space, ArrowUp, ArrowDown, ArrowLeft, ArrowRight, Home, End, PageUp or PageDown), Shift+ and a named key, such as Shift+Tab, or one character, such as a, 7 or é'

describe('parseKey: what press takes', () => {
  test('every named key, on its own and with Shift', () => {
    assert.equal(namedKeys.length, 14)
    for (const name of namedKeys) {
      assert.deepEqual(accepted(name), { kind: 'named', name, shift: false })
      assert.deepEqual(accepted(`Shift+${name}`), { kind: 'named', name, shift: true })
    }
  })

  test('one character, typed with Shift only when it is an uppercase letter', () => {
    assert.deepEqual(accepted('a'), { kind: 'character', character: 'a', shift: false })
    assert.deepEqual(accepted('A'), { kind: 'character', character: 'A', shift: true })
    assert.deepEqual(accepted('7'), { kind: 'character', character: '7', shift: false })
    assert.deepEqual(accepted('é'), { kind: 'character', character: 'é', shift: false })
    assert.deepEqual(accepted('É'), { kind: 'character', character: 'É', shift: true })
    assert.deepEqual(accepted('ж'), { kind: 'character', character: 'ж', shift: false })
    for (const symbol of ['+', '!', '@', '/', '?', '€', '中']) assert.deepEqual(accepted(symbol), { kind: 'character', character: symbol, shift: false })
  })
})

describe('parseKey: what it refuses', () => {
  test('Control, Alt and Meta, alone or in any combination, are unsupported and never sent', () => {
    for (const text of ['Control+a', 'Alt+Tab', 'Meta+Enter', 'Shift+Control+a', 'Control', 'Meta', 'Control++']) {
      const failure = refused(text)
      assert.equal(failure.class, 'unsupported', text)
      assert.equal(
        failure.message,
        `press() does not send Control, Alt or Meta, received ${JSON.stringify(text)}. An editing shortcut needs the platform's own command, and the platforms differ.`,
      )
    }
  })

  test('an unknown key is a usage failure that lists what press takes', () => {
    for (const text of ['Entr', 'enter', 'ENTER', 'Shift', 'Ctrl+a', 'Cmd+a', 'F5', 'ab', '', ' ', '\n', '\t', 'e\u0301']) {
      assert.deepEqual(refused(text), { class: 'usage', message: `press() takes ${forms}, received ${JSON.stringify(text)}.` }, JSON.stringify(text))
    }
  })

  test('one character means one UTF-16 code unit that types something', () => {
    for (const text of ['\u{1F600}', '\u0301', '\u200b', '\u0000', '\u00a0']) assert.equal(refused(text).class, 'usage', JSON.stringify(text))
  })

  test('Shift goes only with a named key', () => {
    for (const text of ['Shift+a', 'Shift+A', 'Shift+7', 'Shift+', 'Shift+Shift+Tab', 'Shift+enter']) {
      assert.deepEqual(refused(text), {
        class: 'usage',
        message: `Shift+ goes only with a named key, received ${JSON.stringify(text)}. For an uppercase letter, press the letter itself, such as A.`,
      })
    }
  })

  test('a long key is quoted cut short', () => {
    const text = 'x'.repeat(5000)
    const { message } = refused(text)
    assert.ok(message.length < 700, `${message.length} characters`)
    assert.match(message, /received "x{200}"…\.$/)
  })
})
