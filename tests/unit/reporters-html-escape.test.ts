import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { artifactHref, escapeHtml, pageHref, scriptJson } from '../../src/reporters/html/escape.ts'

// Hostile text as an app, a test or a judge could hand the report: markup, attribute breakouts, entities, comments,
// script ends, scheme tricks, control characters and broken UTF-16.
const hostile = [
  '<script>alert(1)</script>',
  '<img src=x onerror=alert(1)>',
  '" onmouseover="alert(1)',
  "' onfocus='alert(1)' autofocus='",
  '`onclick=alert(1)`',
  '</textarea><svg onload=alert(1)>',
  '<!-- comment --> <![CDATA[ x ]]>',
  '&lt;script&gt; &amp; &#60; &#x3c;',
  '</title></head><body onload=alert(1)>',
  'a\u0000b',
  'lone \uD800 high and lone \uDC00 low',
  'pair \uD83D\uDE00 kept',
  '\u202Eevil\u202C right-to-left',
  'line\nbreak\r\ttab',
  '</script><script>alert(1)</script>',
  '\u2028\u2029',
]

const decodes: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&#96;': '`' }

function decode(text: string): string {
  return text.replace(/&(?:amp|lt|gt|quot|#39|#96);/g, (entity) => decodes[entity] ?? entity)
}

describe('escapeHtml', () => {
  test('no hostile string keeps a character that can end a text, a quoted attribute or start a tag', () => {
    for (const text of hostile) {
      const escaped = escapeHtml(text)
      assert.doesNotMatch(escaped, /[<>"'`\u0000]/, JSON.stringify(text))
      for (const ampersand of escaped.matchAll(/&/g)) {
        assert.match(escaped.slice(ampersand.index), /^&(?:amp|lt|gt|quot|#39|#96);/, `every & begins an entity it wrote: ${JSON.stringify(text)}`)
      }
    }
  })

  test('decoding what it wrote gives the text back, with NUL and lone surrogates as U+FFFD and nothing else changed', () => {
    for (const text of hostile) {
      const expected = text.replace(/\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD')
      assert.equal(decode(escapeHtml(text)), expected, JSON.stringify(text))
    }
    assert.equal(escapeHtml('pair \uD83D\uDE00 kept'), 'pair \uD83D\uDE00 kept')
    assert.equal(escapeHtml('a\u0000b'), 'a\uFFFDb')
    assert.equal(escapeHtml('&lt;'), '&amp;lt;', 'an entity in app text is shown as typed, never read')
  })

  test('the output is well-formed UTF-16', () => {
    for (const text of hostile) assert.equal(escapeHtml(text).isWellFormed(), true, JSON.stringify(text))
  })

  test('every one of 5000 random strings over the dangerous characters comes out with none of them raw', () => {
    const alphabet = ['<', '>', '"', "'", '`', '&', '\u0000', '\uD800', '\uDC00', 'a', ' ', '=', '/', ';', '#', 'x', '\n']
    let seed = 7
    const next = (): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648
      return seed
    }
    for (let round = 0; round < 5000; round++) {
      const text = Array.from({ length: next() % 24 }, () => alphabet[next() % alphabet.length] ?? '').join('')
      const escaped = escapeHtml(text)
      assert.doesNotMatch(escaped, /[<>"'`\u0000]/)
      assert.equal(escaped.isWellFormed(), true)
    }
  })
})

describe('pageHref', () => {
  test('an http or https address becomes a link, without its user name or password', () => {
    assert.equal(pageHref('https://app.example/tasks'), 'https://app.example/tasks')
    assert.equal(pageHref('http://127.0.0.1:4173/'), 'http://127.0.0.1:4173/')
    assert.equal(pageHref('https://user:hunter2@app.example/a'), 'https://app.example/a')
    assert.equal(pageHref('  https://app.example/padded  '), 'https://app.example/padded')
  })

  test('any other scheme, a scheme in disguise, or text that is not an absolute address never becomes a link', () => {
    for (const address of [
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      ' javascript:alert(1)',
      'java\tscript:alert(1)',
      'java\nscript:alert(1)',
      'jav&#x61;script:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox(1)',
      'file:///etc/passwd',
      'blob:https://app.example/1',
      'mailto:a@example.com',
      '//evil.example/x',
      '/tasks',
      'tasks/1',
      '',
      'https//missing-colon',
    ]) {
      assert.equal(pageHref(address), undefined, JSON.stringify(address))
    }
  })

  test('quotes and angle brackets in an address cannot leave the attribute', () => {
    for (const address of ['https://app.example/"onmouseover="alert(1)', "https://app.example/?q='><script>alert(1)</script>", 'https://app.example/#"><img src=x onerror=alert(1)>', 'https://app.example/`x`']) {
      const href = pageHref(address)
      assert.ok(href !== undefined, address)
      assert.doesNotMatch(href, /[<>"'`]/, address)
    }
  })
})

describe('artifactHref', () => {
  test('a portable reference becomes a relative link to the file in the run folder', () => {
    assert.equal(artifactHref('artifacts/k3v9q0x2mb/web-0123456789abc/screenshot-failure-1.png'), 'artifacts/k3v9q0x2mb/web-0123456789abc/screenshot-failure-1.png')
    assert.equal(artifactHref('diagnostics/k3v9q0x2mb.web-0123456789abc.jsonl'), 'diagnostics/k3v9q0x2mb.web-0123456789abc.jsonl')
  })

  test('a reference that could leave the run folder or carry a scheme never becomes a link', () => {
    for (const reference of ['../secret.png', 'artifacts/../../secret.png', '/etc/passwd', '//evil.example/x.png', 'javascript:alert(1)', 'artifacts\\..\\x.png', 'artifacts/%2e%2e/x.png', 'artifacts/"onerror="alert(1).png', 'artifacts/<x>.png', 'artifacts/./x.png', '', 'https://evil.example/x.png']) {
      assert.equal(artifactHref(reference), undefined, JSON.stringify(reference))
    }
  })
})

describe('scriptJson', () => {
  test('no app text can end the script element or open a comment, and the value reads back the same', () => {
    const value = { title: '</script><script>alert(1)</script>', comment: '<!-- x -->', amp: 'a&b', lines: '\u2028\u2029', nested: ['</SCRIPT>', { deep: '</script >' }], number: 1.5, empty: null, flag: true }
    const text = scriptJson(value)
    assert.doesNotMatch(text, /[<>&\u2028\u2029]/)
    assert.deepEqual(JSON.parse(text), value)
    for (const text of hostile) {
      const written = scriptJson(text)
      assert.doesNotMatch(written, /[<>&\u2028\u2029]/, JSON.stringify(text))
      assert.equal(JSON.parse(written), text)
    }
  })
})
