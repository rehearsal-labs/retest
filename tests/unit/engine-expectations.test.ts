import type { SuiteDifference } from '../integration/engine-expectations.ts'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { test } from 'node:test'
import { conformanceCases } from '../conformance/cases.ts'
import { repositoryRoot } from '../integration/cli-harness.ts'
import { conformanceDifferences, suiteDifferences } from '../integration/engine-differences.ts'
import {
  assertCaseOutcome,
  conformanceExpectation,
  conformanceMessageProblems,
  conformanceProblems,
  declarationProblems,
  filledIn,
  narrowedRun,
  readProofs,
  unconsulted,
} from '../integration/engine-expectations.ts'

// The rules of the per-engine expectations of tests/integration/engine-expectations.ts: a declared outcome is held
// exactly, a declaration that stops holding fails, Chrome declares nothing, and a declaration that names no case fails.

const proofs = readProofs()
const webKitFirst = { item: 1, title: "A failed navigation is told in WebKit's words." }

const refused: SuiteDifference = {
  engine: 'webkit',
  suite: 'browser-navigation',
  case: ['an address nobody answers fails with the browser navigation error'],
  reason: 'WebKit tells a refused connection in its own words.',
  documented: webKitFirst,
  observed: 'Could not open {origin}/: Could not connect to the server.',
}

const origin = 'http://127.0.0.1:61527'
const chromeMessage = `Could not open ${origin}/: net::ERR_CONNECTION_REFUSED.`
const webKitMessage = `Could not open ${origin}/: Could not connect to the server.`

function check(engine: 'chromium' | 'firefox' | 'webkit', observed: string, declarations: readonly SuiteDifference[] = [refused]) {
  return () => assertCaseOutcome(declarations, { engine, suite: 'browser-navigation', fullName: refused.case.join(' > '), observed, chrome: chromeMessage, values: { origin } })
}

test('a declared outcome is held exactly: the declared value passes, and one a character off, or another engine giving it, fails', () => {
  assert.equal(check('webkit', webKitMessage)(), refused)
  assert.throws(check('webkit', webKitMessage.replace('server.', 'server')), assert.AssertionError)
  assert.throws(check('webkit', `${webKitMessage} `), assert.AssertionError)
  // A declaration is the engine's own: Firefox, which declares nothing here, is held to Chrome's outcome.
  assert.throws(check('firefox', webKitMessage), assert.AssertionError)
  assert.equal(check('firefox', chromeMessage)(), undefined)
})

test('a suite declaration compares every nested field and ordered value, without accepting either outcome', () => {
  const declaration: SuiteDifference = { ...refused, observed: { ok: false, failure: { class: 'unsupported', message: 'refused', details: { inputSent: false } }, heard: ['one', 'two'] } }
  const chrome = { ok: true, heard: ['one', 'two'] }
  const assertObserved = (observed: SuiteDifference['observed']) => assertCaseOutcome([declaration], { engine: 'webkit', suite: declaration.suite, fullName: declaration.case.join(' > '), observed, chrome })
  assert.equal(assertObserved(declaration.observed), declaration)
  for (const observed of [chrome, { ok: false, failure: { class: 'not_actionable', message: 'refused', details: { inputSent: false } }, heard: ['one', 'two'] }, { ok: false, failure: { class: 'unsupported', message: 'refused', details: { inputSent: true } }, heard: ['one', 'two'] }, { ok: false, failure: { class: 'unsupported', message: 'refused', details: { inputSent: false } }, heard: ['two', 'one'] }]) {
    assert.throws(() => assertObserved(observed), assert.AssertionError)
  }
})

test('a declaration that stops holding fails: an engine that gives Chrome\'s outcome for its declared case fails, saying to remove it', () => {
  assert.throws(check('webkit', chromeMessage), (error: unknown) => {
    assert.ok(error instanceof assert.AssertionError)
    assert.match(error.message, /gave Chrome's outcome, so its declared difference no longer holds: remove the declaration/)
    return true
  })
})

test("a declaration of Chrome's own outcome is refused, since it would declare nothing", () => {
  const same: SuiteDifference = { ...refused, observed: 'Could not open {origin}/: net::ERR_CONNECTION_REFUSED.' }
  assert.throws(check('webkit', chromeMessage, [same]), /declares Chrome's own outcome/)
  const conformanceSame = { engine: 'firefox' as const, case: 'N1', reason: 'A stand-in.', documented: webKitFirst, outcome: { status: 'passed' as const } }
  const own = conformanceCases.find((each) => each.id === 'N1')
  assert.ok(own?.kind === 'test')
  assert.equal(conformanceProblems([{ ...conformanceSame, ...(own.facts === undefined ? {} : { facts: own.facts }) }], conformanceCases).length, 1)
})

test('Chrome declares nothing: a declaration for it is refused, it is always held to its own outcome, and the repository declares none for it', () => {
  const forChrome = { ...refused, engine: 'chromium' }
  assert.deepEqual(declarationProblems([forChrome], proofs), [
    'chromium browser-navigation › an address nobody answers fails with the browser navigation error declares a difference for chromium, the engine every other is compared with, which declares none.',
  ])
  assert.equal(declarationProblems([{ engine: 'chrome', case: 'F8.1a', reason: refused.reason, documented: refused.documented }], proofs).length, 1)
  assert.throws(check('chromium', webKitMessage), assert.AssertionError)
  assert.equal(check('chromium', chromeMessage)(), undefined)
  const fCase = conformanceCases.find((each) => each.id === 'F8.1a')
  assert.ok(fCase?.kind === 'test')
  const declared = conformanceDifferences.find((each) => each.engine === 'webkit')
  assert.ok(declared !== undefined)
  assert.equal(conformanceExpectation([declared], 'chrome', fCase).outcome, fCase.outcome)
  assert.equal(conformanceExpectation([declared], 'firefox', fCase).outcome, fCase.outcome)
  assert.equal(conformanceExpectation([declared], 'webkit', fCase).declaration, declared)
  // Every declaration in the repository is sound, and so names no Chrome engine either.
  assert.deepEqual(declarationProblems([...suiteDifferences, ...conformanceDifferences], proofs), [])
  assert.deepEqual(conformanceProblems(conformanceDifferences, conformanceCases), [])
})

test('a declaration that names no case fails: a conformance id that is not a test case, and a suite case that never asserted its outcome', () => {
  const missing = { engine: 'firefox' as const, case: 'F99.1', reason: 'A stand-in.', documented: webKitFirst, outcome: { status: 'passed' as const } }
  assert.deepEqual(conformanceProblems([missing], conformanceCases), ['firefox F99.1 names no conformance test case.'])
  assert.deepEqual(conformanceProblems([{ ...missing, case: 'R1' }], conformanceCases), ['firefox R1 names no conformance test case.'])
  assert.deepEqual(unconsulted([refused], 'browser-navigation', new Set()), [`webkit: ${refused.case.join(' > ')}`])
  assert.deepEqual(unconsulted([refused], 'browser-navigation', new Set([refused.case.join(' > ')])), [])
  assert.deepEqual(unconsulted([refused], 'browser-actions', new Set()), [])
})

test('a declaration cites an item of its engine\'s proof file and gives one sentence of reason', () => {
  assert.deepEqual(declarationProblems([refused], proofs), [])
  assert.deepEqual(declarationProblems([{ ...refused, documented: { item: 1, title: 'Something the proof never says.' } }], proofs), [
    'webkit browser-navigation › an address nobody answers fails with the browser navigation error cites item 1, "Something the proof never says.", which the "Engine differences" section of docs/plans/public-beta/proofs/webkit-driver.md does not hold.',
  ])
  assert.equal(declarationProblems([{ ...refused, documented: { item: 999, title: webKitFirst.title } }], proofs).length, 1)
  assert.equal(declarationProblems([{ ...refused, reason: 'Two sentences. Not one.' }], proofs).length, 1)
  assert.equal(declarationProblems([{ ...refused, reason: 'No full stop' }], proofs).length, 1)
  assert.equal(declarationProblems([refused, refused], proofs).length, 1)
})

test('an intentional Chrome refusal cannot be redeclared as an engine difference with literal message text', () => {
  const baseline = conformanceCases.find((each) => each.id === 'A11')
  assert.ok(baseline?.kind === 'test' && baseline.outcome.status === 'failed')
  const declaration = {
    engine: 'webkit' as const,
    case: baseline.id,
    reason: 'A stand-in.',
    documented: webKitFirst,
    outcome: {
      ...baseline.outcome,
      at: { holding: "getByTestId('tip').click({ timeout: 500 })" },
      // The literal refusal Chrome recorded in conformance round 6, with the same class, operation and facts.
      message: "Could not click getByTestId('tip') within 500 ms: it is not visible.",
    },
    facts: baseline.facts ?? [],
  }
  assert.deepEqual(conformanceProblems([declaration], conformanceCases), [
    'webkit A11 must normally pass on Chrome; an intentional Chrome failure or refusal cannot be redeclared as an engine difference.',
  ])
})

test('conformance declarations cannot skip a case or replace its message with a loose matcher', () => {
  const base = { engine: 'firefox' as const, case: 'A5', reason: 'A stand-in.', documented: webKitFirst }
  for (const status of ['skipped', 'absent', 'not_run', 'passed'] as const) {
    const outcome = status === 'not_run' ? { status, class: 'unsupported' as const } : { status }
    assert.ok(conformanceProblems([{ ...base, outcome }], conformanceCases).length > 0, status)
  }
  for (const message of [/unsupported/, /^either|outcome$/, /^.*$/]) {
    assert.ok(conformanceProblems([{ ...base, outcome: { status: 'error', class: 'unsupported', operation: 'select', at: { holding: 'select' }, message } }], conformanceCases).length > 0, String(message))
  }
})

test('a conformance refusal holds its literal words and class; a count is exactly the failing event count', () => {
  const refusal = conformanceDifferences.find((each) => each.case === 'A5')
  const wheel = conformanceDifferences.find((each) => each.case === 'A7')
  assert.ok(refusal !== undefined && wheel !== undefined)
  assert.deepEqual(conformanceMessageProblems(refusal, refusal.outcome.message, undefined), [])
  for (const message of [refusal.outcome.message.slice(1), `${refusal.outcome.message}\n`, 'passed']) {
    assert.equal(conformanceMessageProblems(refusal, message, undefined).length, 1)
  }
  const message = "getByTestId('accept') is disabled. Looked 7 times in 1500 ms."
  assert.deepEqual(conformanceMessageProblems(wheel, message, 7), [])
  for (const count of [undefined, 0, 6, 7.5]) assert.equal(conformanceMessageProblems(wheel, message, count).length, 1)
})

test('a word in braces is the value the case passes, and one it does not pass fails by name', () => {
  assert.deepEqual(filledIn({ message: 'Could not open {origin}/.', list: ['{origin}'], kept: '{{password}}', count: 1 }, { origin }), {
    message: `Could not open ${origin}/.`,
    list: [origin],
    kept: '{{password}}',
    count: 1,
  })
  assert.throws(() => filledIn('Could not open {origin}/.', {}), /names \{origin\}, and the case passes no value by that name/)
})

test('a run narrowed by a name pattern, a skip pattern or only is told from a whole run', () => {
  assert.equal(narrowedRun(['--test-name-pattern=titles']), true)
  assert.equal(narrowedRun(['--test-skip-pattern=titles']), true)
  assert.equal(narrowedRun(['--test-only']), true)
  assert.equal(narrowedRun(['--test-concurrency=0', '--test-isolation=process']), false)
})

type Ran = { code: number | null; output: string }

// Runs the miniature suite as a test process of its own on `engine`, as a shared suite runs on an engine.
function runSuite(engine: string, declaredCase: string, observed: string, extra: readonly string[] = [], catchMismatch = false, skipCase = false): Promise<Ran> {
  const file = join(repositoryRoot, 'tests/unit/engine-expectations-suite.ts')
  // Without this test process's own NODE_TEST_CONTEXT, which would make the child report to it rather than run.
  const { NODE_TEST_CONTEXT: _context, ...inherited } = process.env
  const env = { ...inherited, RETEST_TEST_ENGINE: engine, RETEST_EXPECTATIONS_CASE: declaredCase, RETEST_EXPECTATIONS_OBSERVED: observed, RETEST_EXPECTATIONS_CATCH: catchMismatch ? 'yes' : '', RETEST_EXPECTATIONS_SKIP: skipCase ? 'yes' : '' }
  return new Promise((resolve) => {
    execFile(process.execPath, ['--conditions=retest-source', '--test', ...extra, file], { env, timeout: 60_000 }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof error.code === 'number' ? error.code : null
      resolve({ code, output: `${stdout}${stderr}` })
    })
  })
}

test('a suite holds its declarations end to end: a declared case passes, a stale one fails, and one naming no case fails the suite', async (t) => {
  await t.test('the declared outcome on its engine passes', async () => {
    const ran = await runSuite('webkit', 'a case that asserts its outcome', 'webkit')
    assert.equal(ran.code, 0, ran.output)
  })
  await t.test('Chrome is held to its own outcome beside a WebKit declaration', async () => {
    assert.equal((await runSuite('chromium', 'a case that asserts its outcome', 'chrome')).code, 0)
    assert.equal((await runSuite('chromium', 'a case that asserts its outcome', 'webkit')).code, 1)
  })
  await t.test("the engine giving Chrome's outcome fails its declared case", async () => {
    const ran = await runSuite('webkit', 'a case that asserts its outcome', 'chrome')
    assert.equal(ran.code, 1)
    assert.match(ran.output, /no longer holds: remove the declaration/)
  })
  await t.test('a case cannot catch a stale declaration and pass the suite', async () => {
    for (const observed of ['chrome', 'neither outcome']) {
      const ran = await runSuite('webkit', 'a case that asserts its outcome', observed, [], true)
      assert.equal(ran.code, 1, ran.output)
    }
  })
  await t.test('a skipped case cannot pass its declaration as checked', async () => {
    const ran = await runSuite('webkit', 'a case that asserts its outcome', 'webkit', [], false, true)
    assert.equal(ran.code, 1, ran.output)
    assert.match(ran.output, /name a case that did not assert its outcome/)
  })
  await t.test('a declaration naming no case of the suite fails the suite, naming it, on its engine and on Chrome', async () => {
    for (const engine of ['webkit', 'chromium']) {
      const ran = await runSuite(engine, 'a case that is not there', 'chrome')
      assert.equal(ran.code, 1, engine)
      assert.match(ran.output, new RegExp(`1 declarations of browser-navigation name a case that did not assert its outcome in this run on ${engine}: webkit: a case that is not there`))
    }
  })
  await t.test('a declaration naming a case that asserts nothing through it fails the suite too', async () => {
    const ran = await runSuite('webkit', 'a case that asserts nothing through it', 'chrome')
    assert.equal(ran.code, 1)
    assert.match(ran.output, /name a case that did not assert its outcome in this run on webkit: webkit: a case that asserts nothing through it/)
  })
  await t.test('a narrowed run cannot hide a declaration naming no case', async () => {
    const ran = await runSuite('webkit', 'a case that is not there', 'chrome', ['--test-name-pattern=asserts its outcome'])
    assert.equal(ran.code, 1, ran.output)
    assert.match(ran.output, /name a case that did not assert its outcome in this run on webkit: webkit: a case that is not there/)
  })
})
