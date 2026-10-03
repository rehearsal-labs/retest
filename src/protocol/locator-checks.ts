import type { Observation, PageLookPart, PageObservation } from './commands.ts'
import type { TextPattern } from './locator.ts'
import { observedItemLimit } from './commands.ts'
import { describeTextMatch, patternMatches, patternProblem, textPatternSchema } from './locator.ts'
import { titleReadLimit } from './page-facts.ts'
import { s, type Schema } from './schema.ts'
import { normalizeText, quoteText, textComparison } from './text.ts'

/** What a locator assertion looks for in each observation. */
export type LocatorCheck = {
  /** The matcher as the test wrote it: `not.` before it when negated. */
  readonly matcher: string
  readonly expected: string
  readonly comparison?: string
  /** A check about the one element that matches: none is `not_found`, and several `ambiguous`. */
  readonly single: boolean
  passes(observation: Observation): boolean
  actual(observation: Observation): string | null
  /** Why the elements that matched did not pass, as a sentence. */
  mismatch(observation: Observation, locator: string): string
}

/** A text, or a pattern searched for in it, as a list given to `toHaveText` holds them. */
export type ExpectedText = string | TextPattern

/** Marks a check the test negated with `.not`. */
type Negation = { not?: true }

/**
 * A locator matcher and its arguments, whole, and `not` when the test negated it. The test process sends it with
 * each locator assertion, and the parent rebuilds the check from it to judge the observation the assertion names.
 */
export type LocatorCheckRecord = Negation &
  (
    | { matcher: 'toBeVisible' | 'toBeHidden' | 'toBeChecked' | 'toBeEnabled' | 'toBeDisabled' }
    | { matcher: 'toHaveText'; text: string }
    | { matcher: 'toHaveText'; pattern: TextPattern }
    | { matcher: 'toHaveText'; texts: ExpectedText[] }
    | { matcher: 'toContainText'; text: string }
    | { matcher: 'toContainText'; pattern: TextPattern }
    | { matcher: 'toHaveCount'; count: number }
    | { matcher: 'toHaveValue'; value: string }
    | { matcher: 'toHaveValue'; pattern: TextPattern }
  )

/** A page matcher and its arguments, whole, and `not` when the test negated it. */
export type PageCheckRecord = Negation &
  (
    | { matcher: 'toHaveURL'; url: string }
    | { matcher: 'toHaveURL'; pattern: TextPattern }
    | { matcher: 'toHaveTitle'; title: string }
    | { matcher: 'toHaveTitle'; pattern: TextPattern }
  )

/** Any check an assertion that rests on a look carries: one about a locator's elements, or one about the page. */
export type CheckRecord = LocatorCheckRecord | PageCheckRecord

const not = s.optional(s.literal(true))
const expectedText = s.union([s.string(), textPatternSchema])

export const locatorCheckRecordSchema: Schema<LocatorCheckRecord> = s.union([
  s.object({ matcher: s.enum(['toBeVisible', 'toBeHidden', 'toBeChecked', 'toBeEnabled', 'toBeDisabled']), not }),
  s.object({ matcher: s.literal('toHaveText'), text: s.string(), not }),
  s.object({ matcher: s.literal('toHaveText'), pattern: textPatternSchema, not }),
  s.object({ matcher: s.literal('toHaveText'), texts: s.array(expectedText), not }),
  s.object({ matcher: s.literal('toContainText'), text: s.string(), not }),
  s.object({ matcher: s.literal('toContainText'), pattern: textPatternSchema, not }),
  s.object({ matcher: s.literal('toHaveCount'), count: s.number({ integer: true, min: 0 }), not }),
  s.object({ matcher: s.literal('toHaveValue'), value: s.string(), not }),
  s.object({ matcher: s.literal('toHaveValue'), pattern: textPatternSchema, not }),
])

export const pageCheckRecordSchema: Schema<PageCheckRecord> = s.union([
  s.object({ matcher: s.literal('toHaveURL'), url: s.string(), not }),
  s.object({ matcher: s.literal('toHaveURL'), pattern: textPatternSchema, not }),
  s.object({ matcher: s.literal('toHaveTitle'), title: s.string(), not }),
  s.object({ matcher: s.literal('toHaveTitle'), pattern: textPatternSchema, not }),
])

export const checkRecordSchema: Schema<CheckRecord> = s.union([locatorCheckRecordSchema, pageCheckRecordSchema])

/**
 * Whether a check is about the page rather than a locator's elements.
 *
 * @example isPageCheck({ matcher: 'toHaveTitle', title: 'Tasks' }) // true
 */
export function isPageCheck(record: CheckRecord): record is PageCheckRecord {
  return record.matcher === 'toHaveURL' || record.matcher === 'toHaveTitle'
}

const lookMatchers: ReadonlySet<string> = new Set([
  'toBeVisible',
  'toBeHidden',
  'toBeChecked',
  'toBeEnabled',
  'toBeDisabled',
  'toHaveText',
  'toContainText',
  'toHaveCount',
  'toHaveValue',
  'toHaveURL',
  'toHaveTitle',
])

/**
 * Whether a matcher, as an event writes it, `not.` included, is a locator or page matcher, whose pass only a look the
 * parent served can carry.
 *
 * @example decidedByLook('not.toHaveURL') // true
 */
export function decidedByLook(matcher: string): boolean {
  return lookMatchers.has(matcher.startsWith('not.') ? matcher.slice('not.'.length) : matcher)
}

/**
 * Why the parent cannot judge a check a test process sent, or undefined when it can: a pattern that is not a regular
 * expression. The test's own API never sends one.
 *
 * @example checkRecordProblem({ matcher: 'toHaveText', pattern: { pattern: '(', flags: '' } }) // 'Invalid regular expression: …'
 */
export function checkRecordProblem(record: CheckRecord): string | undefined {
  const patterns = 'pattern' in record ? [record.pattern] : 'texts' in record ? record.texts.filter((text) => typeof text !== 'string') : []
  for (const pattern of patterns) {
    const problem = patternProblem(pattern)
    if (problem !== undefined) return problem
  }
  return undefined
}

/**
 * A locator check with every text it compares with passed through `map`, patterns' sources included, as the parent
 * records what it judged with each secret value hidden.
 *
 * @example mapLocatorCheckText({ matcher: 'toHaveText', text: 'Hi hunter2' }, (text) => text.replaceAll('hunter2', '{{password}}'))
 */
export function mapLocatorCheckText(record: LocatorCheckRecord, map: (text: string) => string): LocatorCheckRecord {
  if ('pattern' in record) return { ...record, pattern: mapPattern(record.pattern, map) }
  if ('texts' in record) return { ...record, texts: record.texts.map((text) => (typeof text === 'string' ? map(text) : mapPattern(text, map))) }
  if ('text' in record) return { ...record, text: map(record.text) }
  if ('value' in record) return { ...record, value: map(record.value) }
  return record
}

/**
 * A page check with the address, title or pattern it compares with passed through `map`.
 *
 * @example mapPageCheckText({ matcher: 'toHaveTitle', title: 'Hi hunter2' }, (text) => text.replaceAll('hunter2', '{{password}}'))
 */
export function mapPageCheckText(record: PageCheckRecord, map: (text: string) => string): PageCheckRecord {
  if ('pattern' in record) return { ...record, pattern: mapPattern(record.pattern, map) }
  if ('url' in record) return { ...record, url: map(record.url) }
  return { ...record, title: map(record.title) }
}

function mapPattern(pattern: TextPattern, map: (text: string) => string): TextPattern {
  return { ...pattern, pattern: map(pattern.pattern) }
}

/**
 * The rule the test process polls with and the parent judges with.
 *
 * @example locatorCheck({ matcher: 'toHaveText', text: 'Saved' }).passes(observation)
 */
export function locatorCheck(record: LocatorCheckRecord): LocatorCheck {
  const negated = record.not === true
  switch (record.matcher) {
    case 'toBeVisible':
      return single(visibleRule, negated)
    case 'toBeHidden':
      return negated ? someVisibleCheck() : hiddenCheck()
    case 'toBeChecked':
      return single(checkedRule, negated)
    case 'toBeEnabled':
      return single(enabledRule, negated)
    case 'toBeDisabled':
      return single(disabledRule, negated)
    case 'toHaveText':
      if ('texts' in record) return textsCheck(record.texts, negated)
      return single('pattern' in record ? patternRule('toHaveText', record.pattern) : textRule(record.text), negated)
    case 'toContainText':
      return single('pattern' in record ? patternRule('toContainText', record.pattern) : containRule(record.text), negated)
    case 'toHaveCount':
      return countCheck(record.count, negated)
    case 'toHaveValue':
      return single('pattern' in record ? valuePatternRule(record.pattern) : valueRule(record.value), negated)
  }
}

const listComparison = `every match in order, each by ${textComparison}`
const containComparison = 'any part of the text, case-sensitive, ends trimmed, each run of spaces or line breaks read as one space'
const patternComparison = 'a RegExp search anywhere in the text, with the flags of the pattern, ends trimmed, each run of spaces or line breaks read as one space'
const valuePatternComparison = 'a RegExp search anywhere in the value, with the flags of the pattern'
const checkableKinds = 'a checkbox, a radio button or an element with a checkable role'

/**
 * A condition on the one element a locator matches. `holds` says whether the element meets it, or undefined when the
 * element cannot have it at all, as a value on something that is not a field. `unmet` says why it does not, and
 * `met` why it does, for a negated check. `absentIsFalse` marks a condition that no element at all leaves false.
 */
type SingleRule = {
  matcher: LocatorCheckRecord['matcher']
  expected: string
  negatedExpected?: string
  comparison?: string
  holds(observation: Observation): boolean | undefined
  actual(observation: Observation): string | null
  unmet(observation: Observation, locator: string): string
  met(observation: Observation, locator: string): string
  absentIsFalse?: true
}

/**
 * A check on the one element that matches. It passes when that element meets the rule, or, negated, when it does not,
 * and a negated check passes on no element only when the rule says so. An element that cannot have the condition
 * fails either way.
 */
function single(rule: SingleRule, negated: boolean): LocatorCheck {
  return {
    matcher: negated ? `not.${rule.matcher}` : rule.matcher,
    expected: negated ? (rule.negatedExpected ?? rule.expected) : rule.expected,
    ...(rule.comparison === undefined ? {} : { comparison: rule.comparison }),
    single: true,
    passes: (observation) => {
      if (negated && observation.count === 0) return rule.absentIsFalse === true
      return observation.count === 1 && rule.holds(observation) === !negated
    },
    actual: rule.actual,
    mismatch: (observation, locator) => (negated && rule.holds(observation) === true ? rule.met(observation, locator) : rule.unmet(observation, locator)),
  }
}

function known(value: boolean | null): boolean | undefined {
  return value === null ? undefined : value
}

// Playwright's semantics: no element is not visible, so `.not.toBeVisible()` passes on none.
const visibleRule: SingleRule = {
  matcher: 'toBeVisible',
  expected: 'visible',
  negatedExpected: 'not visible',
  holds: (observation) => known(observation.visible),
  actual: (observation) => (observation.visible === null ? null : observation.visible ? 'visible' : 'hidden'),
  unmet: (_observation, locator) => `${locator} is hidden.`,
  met: (_observation, locator) => `${locator} is visible.`,
  absentIsFalse: true,
}

const checkedRule: SingleRule = {
  matcher: 'toBeChecked',
  expected: 'checked',
  negatedExpected: 'unchecked',
  holds: (observation) => known(observation.checked),
  actual: (observation) => (observation.checked === null ? null : observation.checked ? 'checked' : 'unchecked'),
  unmet: (observation, locator) => (observation.checked === null ? `${locator} is not ${checkableKinds}.` : `${locator} is unchecked.`),
  met: (_observation, locator) => `${locator} is checked.`,
}

const enabledRule: SingleRule = {
  matcher: 'toBeEnabled',
  expected: 'enabled',
  negatedExpected: 'disabled',
  holds: (observation) => known(observation.enabled),
  actual: enabledActual,
  unmet: (_observation, locator) => `${locator} is disabled.`,
  met: (_observation, locator) => `${locator} is enabled.`,
}

const disabledRule: SingleRule = {
  matcher: 'toBeDisabled',
  expected: 'disabled',
  negatedExpected: 'enabled',
  holds: (observation) => (observation.enabled === null ? undefined : !observation.enabled),
  actual: enabledActual,
  unmet: (_observation, locator) => `${locator} is enabled.`,
  met: (_observation, locator) => `${locator} is disabled.`,
}

function enabledActual(observation: Observation): string | null {
  return observation.enabled === null ? null : observation.enabled ? 'enabled' : 'disabled'
}

/** Passes when exactly one element matches and its whole text equals `expected` under `textComparison`. */
function textRule(expected: string): SingleRule {
  const wanted = normalizeText(expected)
  return {
    matcher: 'toHaveText',
    expected,
    comparison: textComparison,
    holds: (observation) => (observation.text === null ? undefined : normalizeText(observation.text) === wanted),
    actual: (observation) => observation.text,
    unmet: (observation, locator) => `${locator} has text ${quoteText(observation.text ?? '')}, expected ${quoteText(expected)}. Compared ${textComparison}.`,
    met: (observation, locator) => `${locator} has text ${quoteText(observation.text ?? '')}, expected any other text. Compared ${textComparison}.`,
  }
}

/** Passes when exactly one element matches and its text holds `expected`, case-sensitive, under `containComparison`. */
function containRule(expected: string): SingleRule {
  const wanted = normalizeText(expected)
  return {
    matcher: 'toContainText',
    expected,
    comparison: containComparison,
    holds: (observation) => (observation.text === null ? undefined : normalizeText(observation.text).includes(wanted)),
    actual: (observation) => observation.text,
    unmet: (observation, locator) => `${locator} has text ${quoteText(observation.text ?? '')}, expected it to contain ${quoteText(expected)}. Compared ${containComparison}.`,
    met: (observation, locator) => `${locator} has text ${quoteText(observation.text ?? '')}, which contains ${quoteText(expected)}, expected it not to.`,
  }
}

/** Passes when exactly one element matches and the pattern finds a match in its text, read as `textComparison` reads it. */
function patternRule(matcher: 'toHaveText' | 'toContainText', pattern: TextPattern): SingleRule {
  const shown = describeTextMatch(pattern)
  return {
    matcher,
    expected: shown,
    comparison: patternComparison,
    holds: (observation) => (observation.text === null ? undefined : patternMatches(normalizeText(observation.text), pattern)),
    actual: (observation) => observation.text,
    unmet: (observation, locator) => `${locator} has text ${quoteText(observation.text ?? '')}, expected it to match ${shown}. Compared ${patternComparison}.`,
    met: (observation, locator) => `${locator} has text ${quoteText(observation.text ?? '')}, which matches ${shown}, expected it not to.`,
  }
}

/** Passes when exactly one element matches, it is a field, and its value is exactly `expected`. */
function valueRule(expected: string): SingleRule {
  return {
    matcher: 'toHaveValue',
    expected,
    comparison: 'the whole value, exactly',
    holds: (observation) => (observation.value === null ? undefined : observation.value === expected),
    actual: (observation) => observation.value,
    unmet: (observation, locator) =>
      observation.value === null ? `${locator} is not a field with a value.` : `${locator} has value ${quoteText(observation.value)}, expected ${quoteText(expected)}.`,
    met: (observation, locator) => `${locator} has value ${quoteText(observation.value ?? '')}, expected any other value.`,
  }
}

/** Passes when exactly one element matches, it is a field, and the pattern finds a match in its value as it is. */
function valuePatternRule(pattern: TextPattern): SingleRule {
  const shown = describeTextMatch(pattern)
  return {
    matcher: 'toHaveValue',
    expected: shown,
    comparison: valuePatternComparison,
    holds: (observation) => (observation.value === null ? undefined : patternMatches(observation.value, pattern)),
    actual: (observation) => observation.value,
    unmet: (observation, locator) =>
      observation.value === null ? `${locator} is not a field with a value.` : `${locator} has value ${quoteText(observation.value)}, expected it to match ${shown}.`,
    met: (observation, locator) => `${locator} has value ${quoteText(observation.value ?? '')}, which matches ${shown}, expected it not to.`,
  }
}

/** Passes when exactly one element matches and it is visible. */
export function visibleCheck(): LocatorCheck {
  return single(visibleRule, false)
}

/** Passes when nothing matches, or nothing that matches is visible. More matches than Retest reads cannot pass. */
export function hiddenCheck(): LocatorCheck {
  return {
    matcher: 'toBeHidden',
    expected: 'hidden',
    single: false,
    passes: (observation) => observation.count === 0 || (!observation.itemsTruncated && visibleCount(observation) === 0),
    actual: hiddenActual,
    mismatch: (observation, locator) => {
      if (observation.itemsTruncated) {
        return `${locator} matched ${observation.count} elements. Retest reads the first ${observedItemLimit}, so it cannot tell that all are hidden.`
      }
      if (observation.count === 1) return `${locator} is visible.`
      const visible = visibleCount(observation)
      return `${locator} matched ${observation.count} elements, and ${visible} of them ${visible === 1 ? 'is' : 'are'} visible.`
    },
  }
}

/**
 * `.not.toBeHidden()`: passes once the one element that matches is visible. No element is hidden, so none fails, and
 * several fail as they do every check on one element.
 */
function someVisibleCheck(): LocatorCheck {
  return { ...single(visibleRule, false), matcher: 'not.toBeHidden' }
}

function hiddenActual(observation: Observation): string {
  if (observation.count === 0) return 'no element'
  if (observation.count === 1) return observation.visible === true ? 'visible' : 'hidden'
  return `${visibleCount(observation)} of ${observation.count} visible`
}

/**
 * Passes when the matches, hidden ones included, have these texts in document order, or, negated, when what Retest
 * read shows they do not: another number of matches, or a text that differs. More matches than Retest reads cannot
 * pass either way unless one it read differs.
 */
export function textsCheck(expected: readonly ExpectedText[], negated = false): LocatorCheck {
  const differsAt = (observation: Observation): number => observation.items.findIndex((item, index) => !textMatches(item.text, expected[index]))
  const same = (observation: Observation): boolean => !observation.itemsTruncated && observation.count === expected.length && differsAt(observation) === -1
  const differs = (observation: Observation): boolean => observation.count !== expected.length || differsAt(observation) !== -1
  return {
    matcher: negated ? 'not.toHaveText' : 'toHaveText',
    expected: describeTexts(expected),
    comparison: listComparison,
    single: false,
    passes: negated ? differs : same,
    actual: (observation) => JSON.stringify(observation.items.map((item) => item.text)),
    mismatch: (observation, locator) => {
      if (negated) {
        if (!observation.itemsTruncated) return `${locator} has exactly these texts, expected any others. Compared ${listComparison}.`
        return `${locator} matched ${observation.count} elements. Retest reads the first ${observedItemLimit}, and they all match, so it cannot tell that the texts differ.`
      }
      if (observation.count !== expected.length) return `${locator} matched ${elements(observation.count)}, expected ${expected.length}.`
      if (observation.itemsTruncated) {
        return `${locator} matched ${observation.count} elements. Retest reads the first ${observedItemLimit}, so it cannot compare every text.`
      }
      const index = differsAt(observation)
      const item = observation.items[index]
      const wanted = expected[index]
      const shown = wanted === undefined ? '""' : typeof wanted === 'string' ? quoteText(wanted) : `to match ${describeTextMatch(wanted)}`
      return `Match ${index + 1} of ${locator} has text ${quoteText(item?.text ?? '')}, expected ${shown}. Compared ${textComparison}.`
    },
  }
}

function textMatches(text: string, wanted: ExpectedText | undefined): boolean {
  if (wanted === undefined) return false
  return typeof wanted === 'string' ? normalizeText(text) === normalizeText(wanted) : patternMatches(normalizeText(text), wanted)
}

// The list as the test wrote it: JSON for a list of strings, with each pattern written as a literal.
function describeTexts(expected: readonly ExpectedText[]): string {
  return `[${expected.map((text) => (typeof text === 'string' ? JSON.stringify(text) : describeTextMatch(text))).join(',')}]`
}

/** Passes when exactly `count` elements match, visible or not, or, negated, any other number. */
export function countCheck(count: number, negated = false): LocatorCheck {
  return {
    matcher: negated ? 'not.toHaveCount' : 'toHaveCount',
    expected: String(count),
    single: false,
    passes: (observation) => (observation.count === count) !== negated,
    actual: (observation) => String(observation.count),
    mismatch: (observation, locator) =>
      negated ? `${locator} matched ${elements(observation.count)}, expected any other number.` : `${locator} matched ${elements(observation.count)}, expected ${count}.`,
  }
}

/** Passes when exactly one element matches and its whole text equals `expected` under `textComparison`. */
export function textCheck(expected: string): LocatorCheck {
  return single(textRule(expected), false)
}

/** Passes when exactly one element matches, it is a field, and its value is exactly `expected`. */
export function valueCheck(expected: string): LocatorCheck {
  return single(valueRule(expected), false)
}

function visibleCount(observation: Observation): number {
  return observation.items.filter((item) => item.visible).length
}

function elements(count: number): string {
  if (count === 0) return 'no element'
  return count === 1 ? '1 element' : `${count} elements`
}

/** A look at the page as a page check reads it: what the page showed, and the app's base URL, origin and path. */
export type PageLook = PageObservation & { baseUrl?: string }

/** What a page assertion looks for in each look at the page. */
export type PageCheck = {
  readonly matcher: string
  readonly expected: string
  readonly comparison: string
  passes(look: PageLook): boolean
  actual(look: PageLook): string | null
  /** Why the page did not pass, as a sentence. */
  mismatch(look: PageLook): string
}

const urlComparison = "the page's whole address, exactly, a relative URL resolved against the app's base URL"
const urlPatternComparison = "a RegExp search anywhere in the page's whole address, with the flags of the pattern"
const titleComparison = 'whole title, ends trimmed, each run of spaces or line breaks read as one space'
const titlePatternComparison = 'a RegExp search anywhere in the title, with the flags of the pattern, ends trimmed, each run of spaces or line breaks read as one space'

/**
 * The rule the test process polls a page assertion with, and the parent judges it with, on the page's whole address,
 * query and fragment included, as Playwright compares it, or on its title. A title Retest has not read, as while
 * another document is on its way, passes neither way. Neither does a part the page held more of than Retest read, nor,
 * for a negation, a part that holds the placeholder of a secret, where Retest cannot tell what the page showed.
 *
 * @example pageCheck({ matcher: 'toHaveTitle', title: 'Tasks' }).passes({ url: 'http://127.0.0.1:4173/', title: 'Tasks' })
 */
export function pageCheck(record: PageCheckRecord): PageCheck {
  const negated = record.not === true
  const matcher = negated ? `not.${record.matcher}` : record.matcher
  const rule = pageRule(record)
  const part: PageLookPart = record.matcher === 'toHaveTitle' ? 'title' : 'url'
  const unjudged = (look: PageLook): string | undefined => {
    if (look.cut?.includes(part) === true) return `${partNames[part]} is longer than the ${titleReadLimit} characters Retest reads, so Retest could not judge it.`
    if (negated && look.hidden?.includes(part) === true) return `${partNames[part]} holds a secret Retest hides, so Retest could not judge that it is not the one expected.`
    return undefined
  }
  return {
    matcher,
    expected: rule.expected,
    comparison: rule.comparison,
    passes: (look) => unjudged(look) === undefined && rule.holds(look) === !negated,
    actual: rule.actual,
    mismatch: (look) => unjudged(look) ?? (negated && rule.holds(look) === true ? rule.met(look) : rule.unmet(look)),
  }
}

const partNames: Record<PageLookPart, string> = { url: "The page's address", title: "The page's title" }

type PageRule = {
  expected: string
  comparison: string
  holds(look: PageLook): boolean | undefined
  actual(look: PageLook): string | null
  unmet(look: PageLook): string
  met(look: PageLook): string
}

function pageRule(record: PageCheckRecord): PageRule {
  if (record.matcher === 'toHaveTitle') return 'pattern' in record ? titlePatternRule(record.pattern) : titleRule(record.title)
  return 'pattern' in record ? urlPatternRule(record.pattern) : urlRule(record.url)
}

function urlRule(expected: string): PageRule {
  const at = (look: PageLook): string => (look.url === null ? 'The page has no address yet' : `The page is at ${quoteText(look.url)}`)
  const resolved = (look: PageLook): string | undefined => URL.parse(expected, look.baseUrl)?.href
  return {
    expected,
    comparison: urlComparison,
    holds: (look) => {
      const wanted = resolved(look)
      return look.url === null || wanted === undefined ? undefined : look.url === wanted
    },
    actual: (look) => look.url,
    unmet: (look) => {
      const wanted = resolved(look)
      if (wanted === undefined) return `${quoteText(expected)} is not a full URL, and the app has no base URL to resolve it against.`
      return `${at(look)}, expected ${quoteText(wanted)}.`
    },
    met: (look) => `${at(look)}, expected any other address.`,
  }
}

function urlPatternRule(pattern: TextPattern): PageRule {
  const shown = describeTextMatch(pattern)
  return {
    expected: shown,
    comparison: urlPatternComparison,
    holds: (look) => (look.url === null ? undefined : patternMatches(look.url, pattern)),
    actual: (look) => look.url,
    unmet: (look) => (look.url === null ? 'The page has no address yet.' : `The page is at ${quoteText(look.url)}, expected it to match ${shown}.`),
    met: (look) => `The page is at ${quoteText(look.url ?? '')}, which matches ${shown}, expected it not to.`,
  }
}

function titleRule(expected: string): PageRule {
  const wanted = normalizeText(expected)
  return {
    expected,
    comparison: titleComparison,
    holds: (look) => (look.title === null ? undefined : normalizeText(look.title) === wanted),
    actual: (look) => look.title,
    unmet: (look) => (look.title === null ? titleUnread : `The page's title is ${quoteText(look.title)}, expected ${quoteText(expected)}. Compared ${titleComparison}.`),
    met: (look) => `The page's title is ${quoteText(look.title ?? '')}, expected any other title.`,
  }
}

function titlePatternRule(pattern: TextPattern): PageRule {
  const shown = describeTextMatch(pattern)
  return {
    expected: shown,
    comparison: titlePatternComparison,
    holds: (look) => (look.title === null ? undefined : patternMatches(normalizeText(look.title), pattern)),
    actual: (look) => look.title,
    unmet: (look) => (look.title === null ? titleUnread : `The page's title is ${quoteText(look.title)}, expected it to match ${shown}.`),
    met: (look) => `The page's title is ${quoteText(look.title ?? '')}, which matches ${shown}, expected it not to.`,
  }
}

const titleUnread = 'The page was opening another document, so Retest could not read its title.'

/**
 * A page address as Retest records one: origin and path, with no credentials, query or fragment, and only the
 * scheme of an address without a host. The browser's `originAndPath` writes the page's own address the same way.
 *
 * @example pageAddress(new URL('https://app.test/tasks?page=2#top')) // 'https://app.test/tasks'
 */
export function pageAddress(url: URL): string {
  if (url.host !== '') return `${url.protocol}//${url.host}${url.pathname}`
  if (url.protocol === 'file:') return `file://${url.pathname}`
  if (url.protocol === 'about:') return `about:${url.pathname}`
  return url.protocol
}
