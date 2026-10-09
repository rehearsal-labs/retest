import type { TestContext } from 'node:test'
import type { Anchor, ConformanceCase, Declared, Fact } from '../conformance/cases.ts'
import type { EngineName } from './engines.ts'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { after } from 'node:test'
import { isDeepStrictEqual } from 'node:util'
import { repositoryRoot } from './cli-harness.ts'
import { suiteDifferences } from './engine-differences.ts'
import { engineUnderTest } from './engines.ts'

// How an engine says that it ends a case of the shared browser suites, or a conformance case, otherwise than Chrome
// does, and how the case holds it to exactly that. Chrome is the engine every other is compared with, so it declares
// nothing. An engine whose driver refuses an operation by name, or whose browser does something Chrome's does not,
// declares the outcome it gives, why in one sentence, and the item of its page in docs/compatibility that records it. A
// declared outcome is asserted as exactly as Chrome's: no skip, no choice of outcomes and no looser comparison. An
// engine that starts to give Chrome's outcome fails the case until its declaration is removed, and a declaration that
// names no case fails the suite. The declarations themselves are in engine-differences.ts.

/** An engine that may declare a difference: every engine but Chrome's. */
export type DeclaringEngine = Exclude<EngineName, 'chromium'>

/** The page in docs/compatibility whose engine differences each declaring engine cites, relative to the repository root. */
export const proofFiles: Readonly<Record<DeclaringEngine, string>> = {
  firefox: 'docs/compatibility/firefox.md',
  webkit: 'docs/compatibility/webkit.md',
}

/** The heading of the section of an engine's page whose numbered items a declaration cites. */
export const proofSection = '## Engine differences'

/** A numbered item of the "Engine differences" section of the engine's page: its number and the bold words it opens with. */
export type ProofItem = { readonly item: number; readonly title: string }

/** A value a case observes, as plain data, compared with a declaration by deep strict equality. */
export type DeclaredValue = string | number | boolean | null | readonly DeclaredValue[] | { readonly [key: string]: DeclaredValue }

/** What every declaration says besides its case and its outcome. */
export type Declaration = {
  readonly engine: DeclaringEngine
  /** Why the engine ends the case otherwise, in one sentence. */
  readonly reason: string
  readonly documented: ProofItem
}

/** A shared browser suite every engine runs unchanged, by its file's name without `.test.ts`. */
export type SharedSuite = 'browser-actions' | 'browser-locators' | 'browser-navigation' | 'browser-secrets'

/**
 * A case of a shared suite that an engine ends otherwise: the test's title and each subtest's down to the one that
 * asserts, as `TestContext.fullName` joins them, and what that case observes on the engine. A word in single braces,
 * such as `{origin}`, stands for the value the case passes under that name, such as the address of a server it started.
 */
export type SuiteDifference = Declaration & {
  readonly suite: SharedSuite
  readonly case: readonly [string, ...string[]]
  readonly observed: DeclaredValue
}

/**
 * A conformance case that an engine ends otherwise, by its id: the outcome it ends with and the facts its record must
 * show, which take the place of the case's own on that engine.
 */
export type ConformanceDifference = Declaration & {
  readonly case: string
  readonly outcome: Omit<Extract<Declared, { status: 'failed' | 'error' }>, 'at' | 'message'> & {
    readonly at: Anchor
    /** Literal text. Only {looks}, the recorded assertion count, may vary. */
    readonly message: string
  }
  readonly facts?: readonly Fact[]
}

type CheckedConformanceDifference = Declaration & {
  readonly case: string
  readonly outcome: Declared | ConformanceDifference['outcome']
  readonly facts?: readonly Fact[]
}

/**
 * A declaration as the checks read it, with an engine of any name, so a declaration for Chrome is refused when the
 * suites run too, not only kept out by the types.
 */
export type CheckedDeclaration = {
  readonly engine: string
  readonly reason: string
  readonly documented: ProofItem
  readonly case: string | readonly string[]
  readonly suite?: string
}

/** The name a case goes by: its titles joined as `TestContext.fullName` joins them, or a conformance case's id. */
export function caseName(declaration: Pick<CheckedDeclaration, 'case'>): string {
  return typeof declaration.case === 'string' ? declaration.case : declaration.case.join(' > ')
}

function label(declaration: CheckedDeclaration): string {
  return `${declaration.engine} ${declaration.suite === undefined ? '' : `${declaration.suite} › `}${caseName(declaration)}`
}

function isDeclaringEngine(engine: string): engine is DeclaringEngine {
  return engine === 'firefox' || engine === 'webkit'
}

/**
 * Every problem with a list of declarations, in words: one for Chrome, a reason that is not one sentence, an item the
 * engine's page does not hold, and two declarations for the same case on the same engine. `proofs` holds the text of
 * each declaring engine's page.
 *
 * @example declarationProblems(suiteDifferences, readProofs()) // []
 */
export function declarationProblems(declarations: readonly CheckedDeclaration[], proofs: Readonly<Record<DeclaringEngine, string>>): string[] {
  const problems: string[] = []
  const seen = new Set<string>()
  for (const declaration of declarations) {
    const name = label(declaration)
    if (seen.has(name)) problems.push(`${name} is declared twice.`)
    seen.add(name)
    const { engine } = declaration
    if (!isDeclaringEngine(engine)) {
      problems.push(`${name} declares a difference for ${engine}, the engine every other is compared with, which declares none.`)
      continue
    }
    if (!/^\S[^\n]*\.$/.test(declaration.reason) || /[.!?]\s+[A-Z]/.test(declaration.reason)) problems.push(`${name} gives its reason in other than one sentence: ${JSON.stringify(declaration.reason)}`)
    if (!holdsItem(proofs[engine], declaration.documented)) {
      problems.push(`${name} cites item ${declaration.documented.item}, "${declaration.documented.title}", which the "${proofSection.slice(3)}" section of ${proofFiles[engine]} does not hold.`)
    }
  }
  return problems
}

// Whether the page's "Engine differences" section has this item, opening with these bold words.
function holdsItem(proof: string, documented: ProofItem): boolean {
  const start = proof.indexOf(`\n${proofSection}\n`)
  if (start === -1) return false
  const next = proof.indexOf('\n## ', start + proofSection.length + 1)
  const section = proof.slice(start, next === -1 ? undefined : next)
  return section.includes(`\n${documented.item}. **${documented.title}**`)
}

/**
 * The text of each declaring engine's page.
 *
 * @example readProofs().firefox.startsWith('# Firefox') // true
 */
export function readProofs(): Record<DeclaringEngine, string> {
  return { firefox: readFileSync(join(repositoryRoot, proofFiles.firefox), 'utf8'), webkit: readFileSync(join(repositoryRoot, proofFiles.webkit), 'utf8') }
}

/**
 * Every problem with the conformance declarations besides those `declarationProblems` finds: one that names no test
 * case of `cases`, and one whose outcome and facts are the case's own, which would declare nothing.
 *
 * @example conformanceProblems(conformanceDifferences, conformanceCases) // []
 */
export function conformanceProblems(declarations: readonly CheckedConformanceDifference[], cases: readonly ConformanceCase[]): string[] {
  return declarations.flatMap((declaration) => {
    const found = cases.find((each) => each.id === declaration.case)
    if (found === undefined || found.kind !== 'test') return [`${label(declaration)} names no conformance test case.`]
    if (found.outcome.status !== 'passed') return [`${label(declaration)} must normally pass on Chrome; an intentional Chrome failure or refusal cannot be redeclared as an engine difference.`]
    const { outcome } = declaration
    if (outcome.status !== 'failed' && outcome.status !== 'error') return [`${label(declaration)} must assert a failure or refusal, never skip or leave a case unjudged.`]
    if (typeof outcome.message !== 'string' || outcome.message === '' || outcome.at === undefined) return [`${label(declaration)} must assert literal failure text and its source line, never a widened matcher.`]
    const words = [...outcome.message.matchAll(placeholder)].map((match) => match[1])
    if (words.some((word) => word !== 'looks')) return [`${label(declaration)} names a message value other than the recorded {looks}.`]
    const sameFacts = isDeepStrictEqual(declaration.facts ?? [], found.facts ?? [])
    return isDeepStrictEqual(declaration.outcome, found.outcome) && sameFacts ? [`${label(declaration)} declares the case's own outcome and facts.`] : []
  })
}

/** A refusal's exact words, with an assertion count taken from its failing event rather than matched loosely. */
export function conformanceMessageProblems(declaration: ConformanceDifference, message: string, looks: number | undefined): string[] {
  if (declaration.outcome.message.includes('{looks}') && (looks === undefined || !Number.isSafeInteger(looks) || looks < 1)) return [`${label(declaration)} has no recorded assertion count for {looks}.`]
  const expected = filledIn(declaration.outcome.message, looks === undefined ? {} : { looks: String(looks) })
  return message === expected ? [] : [`Its message is ${JSON.stringify(message)}, declared exactly ${JSON.stringify(expected)}.`]
}

/**
 * The outcome and facts a conformance case must end with on `engine`: the declaration's for that engine and case, or
 * else the case's own. Chrome is never declared for.
 *
 * @example conformanceExpectation(conformanceDifferences, 'firefox', fCase).outcome.status // 'error'
 */
export function conformanceExpectation(
  declarations: readonly ConformanceDifference[],
  engine: string,
  testCase: { readonly id: string; readonly outcome: Declared; readonly facts?: readonly Fact[] },
): { readonly outcome: Declared; readonly facts: readonly Fact[]; readonly declaration?: ConformanceDifference } {
  const declaration = declarations.find((each) => each.engine === engine && each.case === testCase.id)
  if (declaration === undefined) return { outcome: testCase.outcome, facts: testCase.facts ?? [] }
  // The judge compares the literal text separately, using the assertion count of the failing event.
  const { message: _message, ...outcome } = declaration.outcome
  return { outcome, facts: declaration.facts ?? [], declaration }
}

/** Values a case passes for the words in braces of a declared outcome, such as `{ origin: 'http://127.0.0.1:61527' }`. */
export type CaseValues = Readonly<Record<string, string>>

const placeholder = /(?<!\{)\{([A-Za-z]+)\}(?!\})/g

/**
 * A declared value with each word in single braces replaced by the value the case passes under that name. A word the
 * case passes no value for fails by name, so a declaration never compares a placeholder with what a page said.
 *
 * @example filledIn('Could not open {origin}/.', { origin: 'http://127.0.0.1:1' }) // 'Could not open http://127.0.0.1:1/.'
 */
export function filledIn(value: DeclaredValue, values: CaseValues): DeclaredValue {
  if (typeof value === 'string') {
    return value.replace(placeholder, (_whole, name: string) => {
      const given = values[name]
      if (given === undefined) throw new Error(`The declared outcome names {${name}}, and the case passes no value by that name.`)
      return given
    })
  }
  if (value === null || typeof value !== 'object') return value
  if (isList(value)) return value.map((each) => filledIn(each, values))
  return Object.fromEntries(Object.entries(value).map(([key, each]) => [key, filledIn(each, values)]))
}

function isList(value: readonly DeclaredValue[] | { readonly [key: string]: DeclaredValue }): value is readonly DeclaredValue[] {
  return Array.isArray(value)
}

/** One case of a suite asserting its outcome on an engine. */
export type OutcomeCheck<Observed extends DeclaredValue> = {
  readonly engine: EngineName
  readonly suite: SharedSuite
  /** The case's name as `TestContext.fullName` gives it. */
  readonly fullName: string
  readonly observed: Observed
  /** What Chrome gives, which every engine without a declaration for the case must give too. */
  readonly chrome: Observed
  readonly values?: CaseValues
}

/**
 * Asserts a case's outcome on an engine against `declarations`: Chrome's outcome, unless one declares a difference for
 * this engine and case; then the declared outcome, exactly, which must not be Chrome's. An engine that gives Chrome's
 * outcome for a case it declares a difference for fails, saying the declaration no longer holds. Gives the declaration
 * it held the case to, if any.
 *
 * @example assertCaseOutcome(suiteDifferences, { engine: 'firefox', suite: 'browser-navigation', fullName, observed, chrome })
 */
export function assertCaseOutcome<Observed extends DeclaredValue>(declarations: readonly SuiteDifference[], check: OutcomeCheck<Observed>): SuiteDifference | undefined {
  const declaration = declarations.find((each) => each.engine === check.engine && each.suite === check.suite && caseName(each) === check.fullName)
  if (declaration === undefined) {
    assert.deepStrictEqual(check.observed, check.chrome)
    return undefined
  }
  const declared = filledIn(declaration.observed, check.values ?? {})
  const where = `${proofFiles[declaration.engine]}, ${proofSection.slice(3)} ${declaration.documented.item}`
  assert.ok(!isDeepStrictEqual(declared, check.chrome), `${label(declaration)} declares Chrome's own outcome, which declares nothing.`)
  if (isDeepStrictEqual(check.observed, check.chrome)) {
    assert.fail(`${label(declaration)} gave Chrome's outcome, so its declared difference no longer holds: remove the declaration, and correct ${where} and the guide.`)
  }
  assert.deepStrictEqual(check.observed, declared, `${label(declaration)} gave neither Chrome's outcome nor the one declared for it (${declaration.reason} See ${where}.)`)
  return declaration
}

/**
 * The declarations of `suite`, for any engine, that no case asserted against, each by its engine and case. Every engine
 * runs the same cases of a shared suite, so a declaration whose case asserted nothing on whichever engine ran names a
 * case that did not run to its check, there and on its own engine.
 *
 * @example unconsulted(suiteDifferences, 'browser-navigation', new Set()) // ['firefox: an address nobody answers …', …]
 */
export function unconsulted(declarations: readonly SuiteDifference[], suite: SharedSuite, consulted: ReadonlySet<string>): string[] {
  return declarations.filter((each) => each.suite === suite && !consulted.has(caseName(each))).map((each) => `${each.engine}: ${caseName(each)}`)
}

/**
 * Whether a test process was started to run only some of its tests, by a name pattern, a skip pattern or `only`, so
 * a declaration whose case did not run may name a case that exists.
 *
 * @example narrowedRun(['--test-name-pattern=titles']) // true
 */
export function narrowedRun(execArgv: readonly string[]): boolean {
  return execArgv.some((argument) => argument.startsWith('--test-name-pattern') || argument.startsWith('--test-skip-pattern') || argument === '--test-only')
}

/** How a shared suite asserts the outcome of a case an engine may end otherwise. */
export type SuiteExpectations = {
  /**
   * Asserts what `observed` must be on the engine under test: `chrome`, unless the engine declares a difference for
   * this case, by `t.fullName`; then the declared outcome, exactly, with `values` filling its words in braces. Each
   * case asserts once.
   */
  assertOutcome<Observed extends DeclaredValue>(t: Pick<TestContext, 'fullName' | 'diagnostic'>, observed: Observed, chrome: Observed, values?: CaseValues): void
}

/**
 * The expectations of one shared suite on the engine under test, held to `declarations`, which are those of
 * engine-differences.ts but in the mechanism's own test. Called once, at the top of the suite's file. After its last
 * test the suite fails if one of its declarations is unsound, or if one, for any engine, names a case that never
 * asserted its outcome. A filtered run must still exercise all declared cases to validate this suite.
 *
 * @example const engineCase = engineExpectations('browser-navigation')
 */
export function engineExpectations(suite: SharedSuite, declarations: readonly SuiteDifference[] = suiteDifferences): SuiteExpectations {
  const attempted = new Set<string>()
  const consulted = new Set<string>()
  const rejected: string[] = []
  after(() => {
    const engine = engineUnderTest().name
    const unsound = declarationProblems(
      declarations.filter((each) => each.suite === suite),
      readProofs(),
    )
    assert.deepEqual(unsound, [], `The declarations of ${suite} do not hold`)
    assert.deepEqual(rejected, [], `Outcome checks of ${suite} failed; a case cannot catch or skip a failed check to clear it`)
    const missing = unconsulted(declarations, suite, consulted)
    if (missing.length === 0) return
    assert.fail(`${missing.length} declarations of ${suite} name a case that did not assert its outcome in this run on ${engine}: ${missing.join('; ')}`)
  })
  return {
    assertOutcome(t, observed, chrome, values) {
      try {
        assert.ok(!attempted.has(t.fullName), `${t.fullName} asserted its outcome on the engine twice; a case asserts it once.`)
        attempted.add(t.fullName)
        const engine = engineUnderTest()
        const declaration = assertCaseOutcome(declarations, { engine: engine.name, suite, fullName: t.fullName, observed, chrome, ...(values === undefined ? {} : { values }) })
        consulted.add(t.fullName)
        if (declaration !== undefined) t.diagnostic(`${engine.label} ends this case as declared: ${declaration.reason}`)
      } catch (error) {
        rejected.push(t.fullName)
        throw error
      }
    },
  }
}
