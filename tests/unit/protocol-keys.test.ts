import type { Key } from '../../src/protocol/keys.ts'
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { keyStrokes, namedKeys, parseKey } from '../../src/protocol/keys.ts'

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
  'a named key (Enter, Tab, Escape, Backspace, Delete, Space, ArrowUp, ArrowDown, ArrowLeft, ArrowRight, Home, End, PageUp or PageDown), one character, such as a, 7 or é, or modifiers and a key, such as Control+A, Shift+Tab or Meta+Shift+Z'

describe('parseKey: what press takes', () => {
  test('every named key, on its own and with Shift held around it', () => {
    assert.equal(namedKeys.length, 14)
    for (const name of namedKeys) {
      assert.deepEqual(accepted(name), { kind: 'named', name, held: [] })
      assert.deepEqual(accepted(`Shift+${name}`), { kind: 'named', name, held: ['Shift'] })
    }
  })

  test('one character, typed with Shift only when it is an uppercase letter', () => {
    assert.deepEqual(accepted('a'), { kind: 'character', character: 'a', shift: false, held: [] })
    assert.deepEqual(accepted('A'), { kind: 'character', character: 'A', shift: true, held: [] })
    assert.deepEqual(accepted('7'), { kind: 'character', character: '7', shift: false, held: [] })
    assert.deepEqual(accepted('é'), { kind: 'character', character: 'é', shift: false, held: [] })
    assert.deepEqual(accepted('É'), { kind: 'character', character: 'É', shift: true, held: [] })
    assert.deepEqual(accepted('ж'), { kind: 'character', character: 'ж', shift: false, held: [] })
    for (const symbol of ['+', '!', '@', '/', '?', '€', '中']) assert.deepEqual(accepted(symbol), { kind: 'character', character: symbol, shift: false, held: [] })
  })

  test('modifiers and a key: held in the order written, a letter named by its key whatever its case, Shift pressed only when written', () => {
    assert.deepEqual(accepted('Control+a'), { kind: 'character', character: 'a', shift: false, held: ['Control'] })
    assert.deepEqual(accepted('Control+A'), { kind: 'character', character: 'a', shift: false, held: ['Control'] })
    assert.deepEqual(accepted('Meta+Shift+Z'), { kind: 'character', character: 'z', shift: false, held: ['Meta', 'Shift'] })
    assert.deepEqual(accepted('Shift+Meta+z'), { kind: 'character', character: 'z', shift: false, held: ['Shift', 'Meta'] })
    assert.deepEqual(accepted('Control+Alt+Delete'), { kind: 'named', name: 'Delete', held: ['Control', 'Alt'] })
    assert.deepEqual(accepted('ControlOrMeta+Enter'), { kind: 'named', name: 'Enter', held: ['ControlOrMeta'] })
    assert.deepEqual(accepted('Alt+ArrowLeft'), { kind: 'named', name: 'ArrowLeft', held: ['Alt'] })
    assert.deepEqual(accepted('Control++'), { kind: 'character', character: '+', shift: false, held: ['Control'] })
    assert.deepEqual(accepted('Control+/'), { kind: 'character', character: '/', shift: false, held: ['Control'] })
  })

  test('a press holds its modifiers and presses the key, each released once', () => {
    assert.equal(keyStrokes(accepted('Enter')), 1)
    assert.equal(keyStrokes(accepted('Shift+Tab')), 2)
    assert.equal(keyStrokes(accepted('Control+Alt+Delete')), 3)
    assert.equal(keyStrokes(accepted('A')), 1, 'an uppercase letter holds no Shift key of its own')
  })
})

describe('parseKey: what it refuses', () => {
  test('an unknown key is a usage failure that lists what press takes', () => {
    for (const text of ['Entr', 'enter', 'ENTER', 'Shift', 'Control', 'Meta', 'F5', 'ab', '', ' ', '\n', '\t', 'é', 'Control+', 'Control+ab', 'Control+F5']) {
      assert.deepEqual(refused(text), { class: 'usage', message: `press() takes ${forms}, received ${JSON.stringify(text)}.` }, JSON.stringify(text))
    }
  })

  test('a modifier press does not know, and one written twice, are usage failures', () => {
    for (const text of ['Ctrl+a', 'Cmd+a', 'Option+a', 'control+a', 'Super+Tab']) {
      assert.deepEqual(refused(text), { class: 'usage', message: `press() takes the modifiers Shift, Control, Alt, Meta or ControlOrMeta before a key, received ${JSON.stringify(text)}.` })
    }
    for (const text of ['Control+Control+a', 'Shift+Shift+Tab', 'ControlOrMeta+Meta+a', 'Control+ControlOrMeta+a']) {
      assert.deepEqual(refused(text), { class: 'usage', message: `press() takes each modifier once, received ${JSON.stringify(text)}.` })
    }
  })

  test('one character means one UTF-16 code unit that types something', () => {
    for (const text of ['\u{1F600}', '́', '​', '\u0000', ' ', 'Control+\u{1F600}']) assert.equal(refused(text).class, 'usage', JSON.stringify(text))
  })

  test('Shift alone goes only with a named key; with Control, Alt or Meta it may go with a character', () => {
    for (const text of ['Shift+a', 'Shift+A', 'Shift+7']) {
      assert.deepEqual(refused(text), {
        class: 'usage',
        message: `Shift+ goes with a named key, or with Control, Alt or Meta, received ${JSON.stringify(text)}. For an uppercase letter, press the letter itself, such as A.`,
      })
    }
    assert.equal(parseKey('Control+Shift+7').ok, true)
  })

  test('a long key is quoted cut short', () => {
    const text = 'x'.repeat(5000)
    const { message } = refused(text)
    assert.ok(message.length < 700, `${message.length} characters`)
    assert.match(message, /received "x{200}"…\.$/)
  })
})
