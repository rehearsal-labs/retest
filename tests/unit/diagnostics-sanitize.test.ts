import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { argumentText, consoleText } from '../../src/diagnostics/console-text.ts'
import { isTokenSegment, sanitizeText, sanitizeUrl } from '../../src/diagnostics/sanitize.ts'

describe('sanitizeUrl', () => {
  test('removes credentials, and replaces a query and a fragment with a mark that says one was there', () => {
    assert.equal(sanitizeUrl('https://ada:hunter2@shop.example/cart?session=abc123#pay'), 'https://shop.example/cart?…#…')
    assert.equal(sanitizeUrl('http://127.0.0.1:4173/api/tasks'), 'http://127.0.0.1:4173/api/tasks')
    assert.equal(sanitizeUrl('http://127.0.0.1:4173/'), 'http://127.0.0.1:4173/')
  })

  test('replaces each token-bearing path segment, and keeps names and short ids', () => {
    assert.equal(sanitizeUrl('https://app.example/reset/9f8e7d6c5b4a39281706f5e4/confirm'), 'https://app.example/reset/…/confirm')
    assert.equal(sanitizeUrl('https://app.example/u/550e8400-e29b-41d4-a716-446655440000'), 'https://app.example/u/…')
    assert.equal(sanitizeUrl('https://app.example/t/eyJhbGciOi.eyJzdWIiOiIx.SflKxwRJSM'), 'https://app.example/t/…')
    assert.equal(sanitizeUrl('https://app.example/tasks/42/settings'), 'https://app.example/tasks/42/settings')
  })

  test('keeps only the media type of a data address, the origin of a blob, and the scheme of anything else', () => {
    assert.equal(sanitizeUrl('data:text/html;base64,PGgxPmhpPC9oMT4='), 'data:text/html,…')
    assert.equal(sanitizeUrl('blob:http://127.0.0.1:4173/9ea7284b-70b7-436e-9a5e-cee901563b16'), 'blob:http://127.0.0.1:4173/…')
    assert.equal(sanitizeUrl('about:blank'), 'about:blank')
    assert.equal(sanitizeUrl('javascript:alert(document.cookie)'), 'javascript:…')
    assert.equal(sanitizeUrl('not a url'), '…')
  })

  test('hides a long run of digits and a long name with no extension, and keeps a file name, a version and a date', () => {
    for (const token of ['4829137465019283', 'kQzPwRtYxVbNmLsDfGhJ', 'AbCdEfGhIjKlMnOp', 'a1b2c3d4e5f6g7h8', '550e8400-e29b-41d4-a716-446655440000']) {
      assert.equal(isTokenSegment(token), true, token)
    }
    for (const name of ['jquery-3.7.1.min.js', 'index-D4f8sK2l.js', '2026-10-03T12-00-00', '2026-10-03', 'v1.2.3', 'settings', '42']) {
      assert.equal(isTokenSegment(name), false, name)
    }
    assert.equal(sanitizeUrl('https://app.example/reset/4829137465019283'), 'https://app.example/reset/…')
    assert.equal(sanitizeUrl('https://app.example/invite/kQzPwRtYxVbNmLsDfGhJ'), 'https://app.example/invite/…')
    assert.equal(sanitizeUrl('https://app.example/magic/AbCdEfGhIjKlMnOp'), 'https://app.example/magic/…')
    assert.equal(sanitizeUrl('https://cdn.example/jquery-3.7.1.min.js'), 'https://cdn.example/jquery-3.7.1.min.js')
    assert.equal(sanitizeUrl('https://app.example/assets/index-D4f8sK2l.js'), 'https://app.example/assets/index-D4f8sK2l.js')
    assert.equal(sanitizeUrl('https://app.example/backups/2026-10-03T12-00-00'), 'https://app.example/backups/2026-10-03T12-00-00')
  })

  test('reads percent-escapes before it judges a segment, and keeps a secret placeholder readable', () => {
    assert.equal(isTokenSegment('correct%20horse%20battery%20staple'), true, 'a slug of several words is hidden too')
    assert.equal(isTokenSegment('%E0%A4%A'), false, 'a broken escape is read as written')
    assert.equal(sanitizeUrl('http://app.test/echo/{{password}}?q=1'), 'http://app.test/echo/{{password}}?…')
  })
})

describe('sanitizeText', () => {
  test('cleans every address in free text and keeps a stack frame line and column', () => {
    const stack = 'Error: boom\n    at throwFromScript (http://127.0.0.1:4173/app.js?token=abc123:4:9)\n    at https://ada:pw@cdn.example/lib.js#v2:10:1'
    assert.equal(sanitizeText(stack), 'Error: boom\n    at throwFromScript (http://127.0.0.1:4173/app.js?…:4:9)\n    at https://cdn.example/lib.js#…:10:1')
  })

  test('never reads a port as a line', () => {
    assert.equal(sanitizeText('fetch http://127.0.0.1:5000 failed'), 'fetch http://127.0.0.1:5000/ failed')
  })

  test('takes brackets in a query and an IPv6 host as part of the address, and leaves out the bracket that closes it', () => {
    assert.equal(sanitizeText('GET http://app.test/items?ids[]=1&access_token=abc123 failed'), 'GET http://app.test/items?… failed')
    assert.equal(sanitizeText('at load (http://[::1]:4173/app.js?token=abc123:4:9)'), 'at load (http://[::1]:4173/app.js?…:4:9)')
    assert.equal(sanitizeText('at f (http://app.test/a.js?list[0]=a&token=t:1:2)'), 'at f (http://app.test/a.js?…:1:2)')
    assert.equal(sanitizeText('[see http://app.test/x?y=1].'), '[see http://app.test/x?…].')
  })
})

describe('console text', () => {
  test('writes strings as written and other values as the browser describes them, joined by a space', () => {
    const text = consoleText([
      { type: 'string', value: 'saved %s' },
      { type: 'number', value: 3, description: '3' },
      { type: 'number', unserializableValue: 'NaN', description: 'NaN' },
      { type: 'bigint', unserializableValue: '10n', description: '10n' },
      { type: 'boolean', value: false },
      { type: 'undefined' },
      { type: 'object', subtype: 'null', value: null },
      { type: 'symbol', description: 'Symbol(s)' },
    ])
    assert.equal(text, 'saved %s 3 NaN 10n false undefined null Symbol(s)')
  })

  test('shows an object and an array one level deep as previewed, and a getter without calling it', () => {
    assert.equal(
      argumentText({
        type: 'object',
        className: 'Object',
        description: 'Object',
        preview: { type: 'object', description: 'Object', overflow: false, properties: [{ name: 'a', type: 'number', value: '1' }, { name: 'title', type: 'string', value: 'x' }, { name: 'nested', type: 'object', value: 'Object' }, { name: 'fn', type: 'function', value: '' }] },
      }),
      '{a: 1, title: "x", nested: Object, fn: function}',
    )
    assert.equal(argumentText({ type: 'object', subtype: 'array', description: 'Array(3)', preview: { type: 'object', subtype: 'array', overflow: true, properties: [{ name: '0', type: 'number', value: '1' }] } }), '[1, …]')
    assert.equal(argumentText({ type: 'object', description: 'Object', preview: { type: 'object', overflow: false, properties: [{ name: 'danger', type: 'accessor' }] } }), '{danger: (...)}')
    assert.equal(argumentText({ type: 'object', className: 'Map', description: 'Map(1)', preview: { type: 'object', subtype: 'map', overflow: false, properties: [] } }), 'Map(1)')
  })

  test('writes an error with its stack, a node by its description and a function by its whole first line', () => {
    assert.equal(argumentText({ type: 'object', subtype: 'error', description: 'Error: boom\n    at x.js:1:2' }), 'Error: boom\n    at x.js:1:2')
    assert.equal(argumentText({ type: 'object', subtype: 'node', description: 'button#save.primary' }), 'button#save.primary')
    assert.equal(argumentText({ type: 'function', description: 'function save() {\n  secretWork()\n}' }), 'function save() {')
    const line = `() => "${'z'.repeat(63)}SECRETSECRETSECRET20"`
    assert.equal(argumentText({ type: 'function', description: line }), line, 'never cut before the redactor reads it')
  })

  test('keeps none of a value Chrome cut in a preview, and never escapes a string before the redactor reads it', () => {
    const cut = `${'L'.repeat(40)}SECRETSECR…${'y'.repeat(49)}`
    assert.equal(cut.length, 100)
    const text = argumentText({
      type: 'object',
      description: 'Object',
      preview: { type: 'object', overflow: false, properties: [{ name: 'long', type: 'string', value: cut }, { name: 'short', type: 'string', value: 'pa"ss\\word9' }, { name: 'n'.repeat(100), type: 'number', value: '1' }] },
    })
    assert.equal(text, '{long: (cut), short: "pa"ss\\word9", (cut): 1}')
    assert.equal(argumentText({ type: 'object', subtype: 'array', description: 'Array(1)', preview: { type: 'object', subtype: 'array', overflow: false, properties: [{ name: '0', type: 'string', value: cut }] } }), '[(cut)]')
  })
})
