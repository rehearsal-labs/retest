import type { RetestEvent } from '../../src/protocol/events.ts'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { linkSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { configFiles, configFolder, configRun, configScreenshot, configTest, diagnosticsArtifact, evaluationFramePath, evaluationDiagnosticsPath, extendedEvidenceRun, mp4, png, recordedRun, recordingPath, recordingRecord, reportOf, writeFolder } from './reporters-html-fixtures.ts'
import { projectFolder, resultOf } from './reporters-fixtures.ts'
import { jumpScript, jumpScriptHash } from '../../src/reporters/html/jump-script.ts'
import { styleSheet } from '../../src/reporters/html/style.ts'

// Everything a run records came from a test, a page, a browser or a model, so the report must show all of it as text.
// These runs carry markup, attribute breakouts, script and `javascript:` addresses in every place a run records text,
// and check that the page holds no element, attribute or link the report did not write itself.

const root = projectFolder()

const hostile = {
  title: '<script>alert("title")</script>" onmouseover="alert(1)',
  pageTitle: '</title><img src=x onerror=alert(3)>',
  pageUrl: 'javascript:alert(4)',
  actual: '"><svg onload=alert(5)>\u202egnp.exe',
  justification: '<a href="javascript:alert(8)">click</a> [here](javascript:alert(9)) </pre><script>alert(10)</script>',
  console: '</script><script>alert(6)</script><style>body{display:none}</style>',
  url: 'javascript:alert(7)//<b>',
  failure: '<b onclick="alert(11)">refused</b>',
}

const allowedTags = new Set([
  'html', 'head', 'meta', 'title', 'style', 'body', 'main', 'header', 'section', 'article', 'details', 'summary', 'div', 'p', 'span',
  'h1', 'h2', 'h3', 'h4', 'ul', 'li', 'dl', 'dt', 'dd', 'pre', 'code', 'strong', 'table', 'caption', 'thead', 'tbody', 'tr', 'th',
  'td', 'figure', 'figcaption', 'a', 'img', 'script', 'video', 'button',
])
const allowedAttributes = new Set(['lang', 'charset', 'http-equiv', 'content', 'name', 'class', 'id', 'href', 'src', 'alt', 'width', 'height', 'loading', 'decoding', 'aria-labelledby', 'aria-label', 'aria-live', 'role', 'scope', 'open', 'type', 'controls', 'preload'])
const dataBlockPattern = /<script type="application\/json" id="retest-outcome">([^<]*)<\/script>/g
const clocksBlockPattern = /<script type="application\/json" id="retest-recording-clocks">([^<]*)<\/script>/g
const fixedScriptHash = 'sha256-U7D3WVo/N0aKSN74mGWTy2vKCdyC74A8klat6F+HW+o='
const tagPattern = /<(!doctype html|\/?[a-z][a-z0-9]*)((?:\s+[a-z][a-z0-9-]*(?:="[^"<>]*")?)*)\s*>/g
const attributePattern = /\s+([a-z][a-z0-9-]*)(?:="([^"]*)")?/g

type Tag = { name: string; attributes: [string, string][] }

/** Every tag in a report, after checking that each `<` in it begins one, so nothing else can be markup. */
function tagsOf(html: string): Tag[] {
  const tags: Tag[] = []
  let covered = 0
  for (const match of html.matchAll(tagPattern)) {
    const [whole, name = '', attributes = ''] = match
    covered += 1
    const parsed = [...attributes.matchAll(attributePattern)].map(([, attribute = '', value = '']): [string, string] => [attribute, value])
    assert.equal(attributes.replace(attributePattern, '').trim(), '', `every part of ${whole} is an attribute`)
    tags.push({ name: name.toLowerCase(), attributes: parsed })
  }
  assert.equal(covered, html.split('<').length - 1, 'every "<" in the report begins a tag the report wrote')
  return tags
}

function assertOnlyOwnMarkup(html: string): void {
  const scriptsInFile = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)]
  assert.deepEqual(scriptsInFile.map(([whole]) => whole.slice(0, whole.indexOf('>') + 1)), [
    '<script type="application/json" id="retest-outcome">',
    '<script type="application/json" id="retest-recording-clocks">',
    '<script>',
  ], 'exactly two passive blocks and one attribute-free fixed script')
  const executable = scriptsInFile[2]?.[1] ?? ''
  assert.equal(`sha256-${createHash('sha256').update(executable).digest('base64')}`, fixedScriptHash, 'executable bytes are pinned independently of the implementation')
  assert.equal(jumpScriptHash, fixedScriptHash)
  assert.equal(executable, jumpScript)
  const policy = `default-src 'none'; img-src 'self' file:; media-src 'self' file:; style-src 'sha256-${createHash('sha256').update(styleSheet).digest('base64')}'; script-src '${fixedScriptHash}'; script-src-attr 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`
  assert.deepEqual([...html.matchAll(/<meta http-equiv="Content-Security-Policy" content="([^"]*)">/g)].map((match) => match[1]), [policy.replaceAll("'", '&#39;')], 'one exact CSP, no extra executable sources')
  assert.ok(html.indexOf('Content-Security-Policy') < html.indexOf('<style>'))
  // Check every markup character outside the constant executable bytes.
  const tags = tagsOf(html.replace(`<script>${executable}</script>`, '<script></script>'))
  for (const { name, attributes } of tags) {
    if (name === '!doctype html') continue
    assert.ok(allowedTags.has(name.replace(/^\//, '')), `an element the report never writes: <${name}>`)
    for (const [attribute, value] of attributes) {
      assert.ok(allowedAttributes.has(attribute) || attribute.startsWith('data-'), `an attribute the report never writes: ${attribute} on <${name}>`)
      // The fixed script reads step times and recording identities from specific data attributes, never as addresses or code.
      if (!attribute.startsWith('data-')) assert.doesNotMatch(value, /javascript:/i, `a script address in ${attribute}`)
      if (attribute === 'href' || attribute === 'src') assert.match(value, /^(#[a-z0-9-]+|[A-Za-z0-9_-][A-Za-z0-9._-]*(\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*)$/, `a link outside the run folder: ${value}`)
    }
  }
  // The only executable element is the fixed script. Both data blocks have exactly their JSON type and id.
  const scripts = tags.filter((tag) => tag.name === 'script')
  assert.deepEqual(scripts, [
    { name: 'script', attributes: [['type', 'application/json'], ['id', 'retest-outcome']] },
    { name: 'script', attributes: [['type', 'application/json'], ['id', 'retest-recording-clocks']] },
    { name: 'script', attributes: [] },
  ])
  for (const pattern of [dataBlockPattern, clocksBlockPattern]) {
    const blocks = [...html.matchAll(pattern)]
    assert.equal(blocks.length, 1, 'each data block holds no "<", so nothing in it can end it')
    assert.doesNotMatch(blocks[0]?.[1] ?? '', /[<>&\u2028\u2029]/)
    JSON.parse(blocks[0]?.[1] ?? '')
  }
  assert.equal(tags.filter((tag) => tag.name === 'style').length, 1, 'one style element, the report’s own')
}

/** The outcome data block, read back as `JSON.parse` reads it. */
function outcomeBlock(html: string): unknown {
  const [match] = [...html.matchAll(dataBlockPattern)]
  assert.ok(match?.[1] !== undefined, 'the report carries its outcome data block')
  return JSON.parse(match[1])
}

/** The report's text as a reader sees it, entities read back. */
function visible(html: string): string {
  return html
    .replace(/<style>[\s\S]*?<\/style>/, '')
    .replace(dataBlockPattern, '')
    .replace(clocksBlockPattern, '')
    .replace(`<script>${jumpScript}</script>`, '')
    .replace(/<[^>]+>/g, ' ')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&#96;', '`')
    .replaceAll('&amp;', '&')
}

describe('a report of hostile text', async () => {
  const html = await reportOf(configFolder(root, 'hostile', hostile))
  const text = visible(html)

  test('holds no element, attribute or link the report did not write', async () => {
    assertOnlyOwnMarkup(html)
  })

  test('shows the test title, the page title and its address as text', async () => {
    assert.ok(text.includes(hostile.title), 'the title is shown whole')
    assert.ok(html.includes('&lt;script&gt;alert(&quot;title&quot;)&lt;/script&gt;&quot; onmouseover=&quot;alert(1)'))
    assert.ok(text.includes('</title><img src=x onerror=alert(3)>'), 'the page title is shown whole')
    assert.ok(text.includes('javascript:alert(4)'), 'the page address is shown as text')
    assert.doesNotMatch(html, /<a [^>]*href="javascript/i)
  })

  test('shows a received value that tries to break out, and writes the direction override as its escape', async () => {
    assert.ok(text.includes('"\\"><svg onload=alert(5)>\\u202egnp.exe"'), text.slice(text.indexOf('Received'), text.indexOf('Received') + 120))
    assert.ok(!html.includes('\u202e'), 'no direction override reaches the page')
  })

  test('shows console text, network addresses and failure reasons as text', async () => {
    assert.ok(text.includes(hostile.console))
    assert.ok(text.includes(hostile.url))
    assert.ok(text.includes(hostile.failure))
  })

  test('shows the judge’s words as quoted text, never as a link or markup', async () => {
    assert.ok(text.includes(JSON.stringify(hostile.justification)))
    assert.doesNotMatch(html, /<a href="javascript/i)
  })

  test('puts no title text into the page’s own title element unescaped', async () => {
    const title = /<title>([\s\S]*?)<\/title>/.exec(html)?.[1] ?? ''
    assert.doesNotMatch(title, /</)
  })

  test('carries a title holding </script> in its data block, which it cannot end, and reads it back whole', async () => {
    assert.ok(hostile.title.includes('</script>'))
    const block = [...html.matchAll(dataBlockPattern)][0]?.[1] ?? ''
    assert.ok(block.includes('\\u003c/script\\u003e'), 'the end tag is written as JSON escapes')
    assert.doesNotMatch(block, /[<>&]/)
    assert.deepEqual(outcomeBlock(html), {
      version: 1,
      runId: 'run-1',
      status: 'failed',
      exitCode: 1,
      complete: true,
      source: 'result.json',
      counts: { passed: 0, failed: 1, error: 0, notRun: 0, inconclusive: 0 },
      tests: [{ testId: configTest, name: hostile.title, variantKey: 'web=chrome', status: 'failed', failureClass: 'check_failed', evidence: 'partial' }],
    })
  })
})

describe('recordings', async () => {
  test('hostile titles, paths and recording ids stay inert in both JSON blocks and never enter the fixed script', async () => {
    const recordingId = '</script><script>alert("recording")</script>" ] #test-1';
    const path = 'artifacts/</script><img src=x onerror=alert(2)>.mp4'
    const events = recordedRun(root, recordingRecord({ recordingId, path })).map((event): RetestEvent => event.type === 'test.started' ? { ...event, name: hostile.title } : event)
    const result = resultOf(events)
    for (const file of result.files) for (const test of file.tests) test.name = hostile.title
    const html = await reportOf(writeFolder(root, 'recording-hostile-blocks', { events, result, files: configFiles() }))
    assertOnlyOwnMarkup(html)
    const outcome = JSON.parse([...html.matchAll(dataBlockPattern)][0]?.[1] ?? '') as { tests: { name: string }[] }
    const clocks = JSON.parse([...html.matchAll(clocksBlockPattern)][0]?.[1] ?? '') as { tests: { name: string; recordings: { recordingId: string; path: string }[] }[] }
    assert.equal(outcome.tests[0]?.name, hostile.title)
    assert.equal(clocks.tests[0]?.name, hostile.title)
    assert.equal(clocks.tests[0]?.recordings[0]?.recordingId, recordingId)
    assert.equal(clocks.tests[0]?.recordings[0]?.path, path)
  })

  test('the safety contract rejects an added script, changed executable bytes, handler, data block or CSP', async () => {
    const events = recordedRun(root)
    const html = await reportOf(writeFolder(root, 'safety-mutants', { events, result: resultOf(events), files: { ...configFiles(), [recordingPath]: mp4() } }))
    assertOnlyOwnMarkup(html)
    for (const mutant of [
      html.replace('</body>', '<script>alert(1)</script></body>'),
      html.replace('<script>', '<script>/* changed */'),
      html.replace('<script>', '<script src="evil.js">'),
      html.replace('<video ', '<video onplay="alert(1)" '),
      html.replace('id="retest-recording-clocks"', 'id="another-block"'),
      html.replace(`script-src &#39;${fixedScriptHash}&#39;`, "script-src &#39;unsafe-inline&#39;"),
    ]) assert.throws(() => assertOnlyOwnMarkup(mutant))
  })
  test('a video is shown only by its portable path, and a recording whose path or gaps carry markup shows them as text', async () => {
    const shown = recordedRun(root)
    const fine = await reportOf(writeFolder(root, 'recording-fine', { events: shown, result: resultOf(shown), files: { ...configFiles(), [recordingPath]: mp4() } }))
    assertOnlyOwnMarkup(fine)
    assert.equal([...fine.matchAll(/<video\b/g)].length, 1)

    const path = 'artifacts/"><script>alert(1)</script>.mp4'
    const partialPath = '../../outside/<b onclick="alert(2)">.partial'
    const gap = { code: 'capture_unavailable' as const, message: '<img src=x onerror=alert(3)> javascript:alert(4)' }
    const hostileEvents = recordedRun(root, recordingRecord({ status: 'partial', path, partialPath, gaps: [gap] }))
    const html = await reportOf(writeFolder(root, 'recording-hostile', { events: hostileEvents, result: resultOf(hostileEvents), files: configFiles() }))
    assertOnlyOwnMarkup(html)
    assert.doesNotMatch(html, /<video/, 'no video from a path that is not a portable reference')
    assert.ok(html.includes('data-refusal="invalid_reference"><strong>Recording 1 of web cannot be shown</strong>'))
    const text = visible(html)
    assert.ok(text.includes(path) && text.includes(gap.message), 'the path and the gap are shown as text')
  })
})

describe('secrets', async () => {
  // The run writes `{{name}}` for a secret in every text it records, so the report shows the placeholder. The value can
  // still sit in files the report must never read: logs, saved sign-in state, a file no record names, and a file outside
  // the folder that a link inside it points at.
  const value = 'orchid-harbor-7731'

  test('a secret the events hold as its placeholder stays the placeholder, and no file that holds the value is read', async () => {
    const events = configRun(root, { actual: '{{password}}', pageTitle: 'Signed in as {{password}}' }).map((event): RetestEvent => {
      if (event.type !== 'action.completed' || event.command !== 'fill') return event
      const { valueLength: _length, ...typed } = event
      return { ...typed, secret: 'password' }
    })
    const folder = writeFolder(root, 'secrets', {
      events,
      result: resultOf(events),
      files: {
        [configScreenshot]: png(8, 8),
        'logs/web.log': `typed ${value}\n`,
        'states/signed-in.json': JSON.stringify({ cookies: [{ name: 'session', value }] }),
        'artifacts/notes.txt': value,
      },
    })
    writeFileSync(join(root, 'secret-value-outside.txt'), value)
    symlinkSync(join(root, 'secret-value-outside.txt'), join(folder, 'artifacts', 'linked.png'))
    const html = await reportOf(folder)
    assert.ok(!html.includes(value), 'the value appears nowhere in the report')
    const text = visible(html)
    assert.match(text, /fill getByTestId\('task-title'\), \{\{password\}\}/)
    assert.match(text, /\+ Received\s+"\{\{password\}\}"/, 'the received value is the placeholder')
    assert.match(text, /"Signed in as \{\{password\}\}" at http:\/\/127\.0\.0\.1:4173\//, 'the page title is the placeholder')
  })
})

describe('artifact paths a record should never hold', async () => {
  // A record's path is a portable reference inside the run folder; one that climbs out or carries a scheme is never
  // linked or read, and the report says why where the picture would have been.
  function withPaths(events: readonly RetestEvent[], paths: { screenshot: string; judged: string }): RetestEvent[] {
    return events.map((event) => {
      if (event.type === 'evidence.captured') return { ...event, path: paths.screenshot }
      if (event.type !== 'evaluation.finished' || event.evaluation.checkId !== 'task-saved') return event
      return { ...event, evaluation: { ...event.evaluation, evidence: event.evaluation.evidence.map((evidence) => ({ ...evidence, path: paths.judged })) } }
    })
  }

  for (const [label, paths] of [
    ['a path that climbs out of the folder', { screenshot: '../../../etc/passwd', judged: '../outside.png' }],
    ['an absolute path', { screenshot: '/etc/passwd', judged: '/tmp/outside.png' }],
    ['a script address', { screenshot: 'javascript:alert(1)', judged: 'data:image/png;base64,AAAA' }],
    ['a path with markup in it', { screenshot: 'artifacts/"><img src=x onerror=alert(1)>.png', judged: 'artifacts/a b.png' }],
  ] as const) {
    test(label, async () => {
      const events = withPaths(configRun(root), paths)
      const html = await reportOf(writeFolder(root, `paths-${label.replaceAll(' ', '-')}`, { events, result: resultOf(events), files: { [configScreenshot]: png(8, 8) } }))
      assertOnlyOwnMarkup(html)
      assert.doesNotMatch(html, /<img/, 'no picture is shown from a path outside the folder')
      const escaped = (reference: string): string => reference.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
      assert.ok(html.includes(`<div class="gap" data-reference="${escaped(paths.screenshot)}" data-refusal="invalid_reference"><strong>Failure screenshot of web cannot be shown</strong>`), 'the failure screenshot is named by its reference, refused')
      assert.ok(html.includes(`<div class="gap" data-reference="${escaped(paths.judged)}" data-refusal="invalid_reference"><strong>Screenshot e1 of web for AI check task-saved cannot be shown</strong>`), 'the judged screenshot is named by its reference, refused')
      assert.ok(visible(html).includes(paths.screenshot), 'the reference is shown as text')
    })
  }

  test('a link in the folder that leads out of it is refused, not followed', async () => {
    const events = configRun(root)
    const folder = writeFolder(root, 'linked', { events, result: resultOf(events) })
    writeFileSync(join(root, 'secret-outside.png'), png(4, 4))
    mkdirSync(join(folder, 'artifacts'), { recursive: true })
    symlinkSync(join(root, 'secret-outside.png'), join(folder, configScreenshot))
    const html = await reportOf(folder)
    assert.doesNotMatch(html, new RegExp(`<img src="${configScreenshot}"`))
    assert.ok(html.includes(`<div class="gap" data-reference="${configScreenshot}" data-refusal="outside_run_folder">`))
  })

  test('a file in the folder with a second name outside it is refused, not shown', async () => {
    const events = configRun(root)
    const folder = writeFolder(root, 'hard-linked', { events, result: resultOf(events) })
    writeFileSync(join(root, 'hard-outside.png'), png(4, 4))
    mkdirSync(join(folder, 'artifacts'), { recursive: true })
    linkSync(join(root, 'hard-outside.png'), join(folder, configScreenshot))
    const html = await reportOf(folder)
    assert.doesNotMatch(html, new RegExp(`<img src="${configScreenshot}"`))
    assert.ok(html.includes(`<div class="gap" data-reference="${configScreenshot}" data-refusal="hard_link">`))
  })
})

for (const kind of ['symlink', 'hard-link'] as const) {
  test(`refused diagnostics ${kind} has its name and refusal, with no clickable link`, async () => {
    const events = configRun(root)
    const folder = writeFolder(root, `diagnostics-${kind}`, { events, result: resultOf(events), files: { [configScreenshot]: png(8, 8) } })
    const outside = join(root, `outside-diagnostics-${kind}.jsonl`)
    writeFileSync(outside, 'synthetic private diagnostics')
    mkdirSync(join(folder, 'diagnostics'), { recursive: true })
    if (kind === 'symlink') symlinkSync(outside, join(folder, diagnosticsArtifact))
    else linkSync(outside, join(folder, diagnosticsArtifact))
    const html = await reportOf(folder)
    assertOnlyOwnMarkup(html)
    assert.ok(html.includes(diagnosticsArtifact), 'keep the refused artifact name')
    assert.ok(html.includes('data-refusal='), 'keep the safe-reader refusal')
    assert.ok(!html.includes(`href="${diagnosticsArtifact}"`), 'a refused file has no link')
    assert.ok(!html.includes('synthetic private diagnostics'), 'do not read the outside content')
  })
}

for (const kind of ['frames', 'diagnostics'] as const) {
  test(`hostile ${kind} evidence keeps the exact fixed script, CSP and two passive JSON blocks`, async () => {
    const events = extendedEvidenceRun(root, kind)
    const files = { ...configFiles(), [evaluationFramePath]: png(8, 8), [evaluationDiagnosticsPath]: JSON.stringify({ console: { records: [{ text: hostile.console }] } }) }
    const html = await reportOf(writeFolder(root, `hostile-evaluation-${kind}`, { events, result: resultOf(events), files }))
    assertOnlyOwnMarkup(html)
    assert.ok(visible(html).includes(kind === 'diagnostics' ? hostile.console : 'Frames frames-e1'))
  })
}
