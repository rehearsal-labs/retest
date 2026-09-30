import type { TagExpression } from '../runner/contract.ts'
import { tagOperators } from '../protocol/names.ts'
import { listWords } from '../shared/list-words.ts'
import { suggest } from './suggest.ts'

/** A mistake in a tag expression, at the character it was found, counted from 0. */
export class TagExpressionError extends Error {
  override readonly name: string = 'TagExpressionError'
  readonly index: number

  constructor(message: string, index: number) {
    super(message)
    this.index = index
  }
}

type Token = { kind: 'word' | '(' | ')' | 'end'; text: string; index: number }

const symbolWords: Readonly<Record<string, string>> = { '&': 'and', '|': 'or', '!': 'not' }

/**
 * Parses a `--tag` expression: tags joined by `and`, `or` and `not`, with parentheses. `not` binds tightest,
 * then `and`, then `or`. With `knownTags`, a tag outside the list is a mistake too.
 *
 * @example parseTagExpression('smoke and not slow') // { kind: 'and', left: smoke, right: { kind: 'not', operand: slow } }
 */
export function parseTagExpression(text: string, knownTags?: readonly string[]): TagExpression {
  const tokens = tokenize(text)
  let position = 0
  const peek = (): Token => tokens[position] ?? { kind: 'end', text: '', index: text.length }
  const take = (): Token => {
    const token = peek()
    position++
    return token
  }
  const isKeyword = (token: Token, keyword: string): boolean => token.kind === 'word' && token.text === keyword

  const parseOr = (): TagExpression => {
    let left = parseAnd()
    while (isKeyword(peek(), 'or')) {
      take()
      left = { kind: 'or', left, right: parseAnd() }
    }
    return left
  }
  const parseAnd = (): TagExpression => {
    let left = parseNot()
    while (isKeyword(peek(), 'and')) {
      take()
      left = { kind: 'and', left, right: parseNot() }
    }
    return left
  }
  const parseNot = (): TagExpression => {
    if (!isKeyword(peek(), 'not')) return parseOperand()
    take()
    return { kind: 'not', operand: parseNot() }
  }
  const parseOperand = (): TagExpression => {
    const token = take()
    if (token.kind === '(') {
      const inner = parseOr()
      const closing = take()
      if (closing.kind === ')') return inner
      if (closing.kind === 'end') throw new TagExpressionError(`The "(" at character ${token.index + 1} is never closed.`, token.index)
      throw expectedOperator(closing)
    }
    if (token.kind === 'word' && !tagOperators.has(token.text)) return { kind: 'tag', tag: checkTag(token, knownTags) }
    throw expectedTag(token)
  }

  const expression = parseOr()
  const rest = peek()
  if (rest.kind === 'end') return expression
  if (rest.kind === ')') throw new TagExpressionError(`The ")" at character ${rest.index + 1} has no "(" to close.`, rest.index)
  throw expectedOperator(rest)
}

function tokenize(text: string): Token[] {
  const tokens: Token[] = []
  for (let index = 0; index < text.length; ) {
    const character = text[index] ?? ''
    if (/\s/.test(character)) {
      index++
      continue
    }
    if (character === '(' || character === ')') {
      tokens.push({ kind: character, text: character, index })
      index++
      continue
    }
    const word = symbolWords[character]
    if (word !== undefined) {
      throw new TagExpressionError(`Unexpected "${character}" at character ${index + 1}. Write ${word} as a word.`, index)
    }
    const end = wordEnd(text, index)
    tokens.push({ kind: 'word', text: text.slice(index, end), index })
    index = end
  }
  return tokens
}

function wordEnd(text: string, start: number): number {
  let end = start
  while (end < text.length && !/[\s()&|!]/.test(text[end] ?? '')) end++
  return end
}

function checkTag(token: Token, knownTags: readonly string[] | undefined): string {
  if (knownTags === undefined || knownTags.includes(token.text)) return token.text
  const guess = suggest(token.text, knownTags)
  const hint = guess === undefined ? '' : ` Did you mean ${guess}?`
  const known = knownTags.length === 0 ? 'The config lists no tags.' : `The config's tags are ${listWords(knownTags, 'and')}.`
  throw new TagExpressionError(`Unknown tag "${token.text}" at character ${token.index + 1}.${hint} ${known}`, token.index)
}

function expectedTag(token: Token): TagExpressionError {
  const found = token.kind === 'end' ? 'the expression ends there' : `found "${token.text}"`
  return new TagExpressionError(`Expected a tag at character ${token.index + 1}, but ${found}.`, token.index)
}

function expectedOperator(token: Token): TagExpressionError {
  return new TagExpressionError(
    `Expected "and", "or" or the end at character ${token.index + 1}, but found "${token.text}".`,
    token.index,
  )
}
