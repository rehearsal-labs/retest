import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { keyActions, pressedStrokes, selectionProblem, typedKeys, typedStrokes, typingProblem, wholePoint } from '../../src/browser/firefox/input.ts'
import { parseKey } from '../../src/protocol/keys.ts'

// How Retest's keys and text become WebDriver BiDi key actions for Firefox, and what it refuses to type.

function key(text: string): Parameters<typeof keyActions>[0] {
  const parsed = parseKey(text)
  assert.ok(parsed.ok, text)
  return parsed.key
}

describe('Firefox key actions', () => {
  test('a named key is the key value WebDriver reserves for it, pressed and released', () => {
    assert.deepEqual(keyActions(key('Enter')), [{ type: 'keyDown', value: '' }, { type: 'keyUp', value: '' }])
    assert.deepEqual(keyActions(key('Space')), [{ type: 'keyDown', value: ' ' }, { type: 'keyUp', value: ' ' }])
  })

  test('modifiers go down in the order written and come up in reverse, ControlOrMeta being Meta on macOS only', () => {
    assert.deepEqual(keyActions(key('Control+Shift+T')).map((action) => `${action.type}:${action.value}`), [
      'keyDown:',
      'keyDown:',
      'keyDown:t',
      'keyUp:t',
      'keyUp:',
      'keyUp:',
    ])
    assert.equal(keyActions(key('ControlOrMeta+A'), 'darwin')[0]?.value, '')
    assert.equal(keyActions(key('ControlOrMeta+A'), 'linux')[0]?.value, '')
  })

  test('text is one press for each character a person sees, a line break as Enter, and empty text as Delete', () => {
    assert.deepEqual(typedKeys('a😀é').map((action) => action.value), ['a', 'a', '😀', '😀', 'é', 'é'])
    assert.deepEqual(typedKeys('a\r\nb\nc').filter((action) => action.type === 'keyDown').map((action) => action.value), ['a', '', 'b', '', 'c'])
    assert.deepEqual(typedKeys(''), [{ type: 'keyDown', value: '' }, { type: 'keyUp', value: '' }])
    assert.equal(typedStrokes('Release checklist'), 18, 'the R is typed with Shift, which is a key of its own')
    assert.equal(typedStrokes(''), 1)
  })

  test('an uppercase letter or a shifted symbol is pressed with Shift held, as a US keyboard types it, and counted', () => {
    const shift = '\uE008'
    const written = (actions: { type: string; value: string }[]) => actions.map((action) => `${action.type}:${action.value}`)
    assert.deepEqual(written(keyActions(key('A'))), [`keyDown:${shift}`, 'keyDown:A', 'keyUp:A', `keyUp:${shift}`])
    assert.deepEqual(written(keyActions(key('!'))), [`keyDown:${shift}`, 'keyDown:!', 'keyUp:!', `keyUp:${shift}`])
    assert.deepEqual(written(keyActions(key('a'))), ['keyDown:a', 'keyUp:a'])
    assert.deepEqual(written(keyActions(key('7'))), ['keyDown:7', 'keyUp:7'])
    assert.deepEqual(written(keyActions(key('é'))), ['keyDown:é', 'keyUp:é'], 'no US key types it, so no Shift is pressed for it')
    assert.deepEqual(written(keyActions(key('Control+Shift+T'))).filter((action) => action.endsWith(shift)).length, 2, 'a Shift already written is pressed once')
    assert.deepEqual(written(typedKeys('aB?')), ['keyDown:a', 'keyUp:a', `keyDown:${shift}`, 'keyDown:B', 'keyUp:B', `keyUp:${shift}`, `keyDown:${shift}`, 'keyDown:?', 'keyUp:?', `keyUp:${shift}`])
    assert.deepEqual([pressedStrokes(key('A')), pressedStrokes(key('a')), pressedStrokes(key('Control+Shift+T'))], [2, 1, 3])
  })

  test('text holding a code point Firefox reads as a named key is refused, naming the code point', () => {
    assert.equal(typingProblem('plain text'), undefined)
    assert.equal(typingProblem('ab'), 'it holds U+E007, which Firefox reads as a named key')
    assert.equal(typingProblem(''), undefined, 'only the code points WebDriver reserves')
  })

  test('a point is rounded to the whole pixels Firefox takes', () => {
    assert.deepEqual(wholePoint({ x: 100.5, y: 300.25 }), { x: 101, y: 300 })
  })

  test('a native multiple-select plan is refused before any unverified move or toggle, while single-select typing remains available', () => {
    for (const key of ['Home', 'ArrowDown', 'Space']) {
      assert.match(selectionProblem({ quietMs: 0, keys: [{ key, toggle: true }] }) ?? '', /Firefox cannot verify.*multiple-select keyboard input/)
    }
    assert.equal(selectionProblem({ quietMs: 0, keys: [{ key: 'C', toggle: false }] }), undefined)
  })
})
