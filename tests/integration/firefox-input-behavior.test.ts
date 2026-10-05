import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'
import { launchFirefox } from '../../src/browser/firefox/launch.ts'
import { byTestId, closeMs, observe, observeUntil, openPage, scratchFolder, servePages, setupMs } from './browser-harness.ts'
import { firefoxPath, testFirefoxRoute } from './engines.ts'

const skip = process.platform === 'darwin' && process.arch === 'arm64' ? false : 'Firefox requires macOS on Apple silicon'

const selectionPage = `<!doctype html><select data-testid="list" multiple size="4">
<option value="a">A</option><option value="b" selected>B</option><option value="c" selected>C</option><option value="d">D</option>
</select><p data-testid="selected">b,c</p><pre data-testid="events"></pre><script>
const list = document.querySelector('select');
const events = [];
for (const kind of ['keydown', 'keyup', 'input', 'change']) list.addEventListener(kind, (event) => {
  events.push({ kind, key: event.key, selected: [...list.selectedOptions].map((option) => option.value), trusted: event.isTrusted });
  document.querySelector('pre').textContent = JSON.stringify(events);
  document.querySelector('[data-testid=selected]').textContent = [...list.selectedOptions].map((option) => option.value).join(',');
});
</script>`

test('a Firefox multiple-select keyboard plan is refused before a key can toggle an unrequested option', { skip }, async (t) => {
  const folder = await scratchFolder(t)
  const browser = await launchFirefox({ executablePath: firefoxPath(), route: testFirefoxRoute(), headless: true, logFile: join(folder, 'browser.log') }, setupMs)
  t.after(() => browser.close(closeMs))
  const site = await servePages(t, { '/': selectionPage })
  const page = await browser.newPage({ baseUrl: site.url }, setupMs)
  t.after(() => page.dispose(closeMs))
  assert.ok((await page.execute({ kind: 'goto', url: '/' }, setupMs)).ok)
  const result = await page.dispatch({ kind: 'select', locator: byTestId('list'), choices: [{ value: 'b' }, { value: 'c' }, { value: 'd' }] }, setupMs)
  assert.ok(!result.result.ok)
  assert.equal(result.result.failure.class, 'unsupported')
  assert.match(result.result.failure.message, /multiple-select keyboard input/)
  assert.equal(result.input, 'not_sent')
  assert.equal((await observe(page, 'events')).text, '')
  assert.equal((await observe(page, 'selected')).text, 'b,c')
})

// A case that chose several options with the keyboard forty times and required success stood here. Firefox refuses
// that plan by name before any key (the case above asserts the refusal), so the success it required cannot happen
// while the refusal stands; it comes back with whatever route can choose several options without the hidden focus.

test('one Firefox scroll is one trusted wheel event carrying the whole requested delta, as on Chrome', { skip }, async (t) => {
  const folder = await scratchFolder(t)
  const browser = await launchFirefox({ executablePath: firefoxPath(), route: testFirefoxRoute(), headless: true, logFile: join(folder, 'browser.log') }, setupMs)
  t.after(() => browser.close(closeMs))
  const site = await servePages(t, { '/': `<!doctype html><div data-testid="terms" style="height:100px;width:300px;overflow:auto"><div style="height:1000px">Terms</div></div><pre data-testid="wheel"></pre><p data-testid="position">0</p><script>
const terms = document.querySelector('div'); terms.addEventListener('scroll', () => { document.querySelector('[data-testid=position]').textContent = terms.scrollTop; });
const turns = []; terms.addEventListener('wheel', (event) => {
  turns.push({ x:event.deltaX, y:event.deltaY, trusted:event.isTrusted });
  document.querySelector('pre').textContent = JSON.stringify(turns);
});</script>` })
  const page = await openPage(t, browser, site.url)
  assert.ok((await page.execute({ kind: 'goto', url: '/' }, setupMs)).ok)
  assert.ok((await page.execute({ kind: 'scroll', locator: byTestId('terms'), x: 0, y: 900 }, setupMs)).ok)
  await observeUntil(page, 'wheel', (seen) => (seen.text ?? '') !== '')
  assert.equal((await observe(page, 'wheel')).text, '[{"x":0,"y":900,"trusted":true}]')
  // Firefox moves at most one page of the terms for that one event, which the guide names as a difference from Chrome.
  t.diagnostic(`the terms scrolled to ${(await observe(page, 'position')).text}`)
})
