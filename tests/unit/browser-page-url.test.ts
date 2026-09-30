import assert from 'node:assert/strict'
import { test } from 'node:test'
import { originAndPath } from '../../src/browser/page-url.ts'

const cases: [url: string, expected: string][] = [
  ['https://app.test/tasks?page=2#top', 'https://app.test/tasks'],
  ['http://127.0.0.1:4173/', 'http://127.0.0.1:4173/'],
  ['http://127.0.0.1:4173', 'http://127.0.0.1:4173/'],
  ['https://app.test:443/a/b/', 'https://app.test/a/b/'],
  ['https://user:secret@app.test/private', 'https://app.test/private'],
  ['https://app.test/reset;token=1?code=2', 'https://app.test/reset;token=1'],
  ['http://[::1]:8080/x', 'http://[::1]:8080/x'],
  ['file:///Users/someone/page.html?x=1', 'file:///Users/someone/page.html'],
  ['about:blank', 'about:blank'],
  ['about:blank#frag', 'about:blank'],
  ['chrome-error://chromewebdata/', 'chrome-error://chromewebdata/'],
  ['data:text/html,<p>secret</p>', 'data:'],
  ['blob:https://app.test/0f6c', 'blob:'],
  ['javascript:alert(1)', 'javascript:'],
]

for (const [url, expected] of cases) {
  test(`${url} is recorded as ${expected}`, () => {
    assert.equal(originAndPath(new URL(url)), expected)
  })
}
