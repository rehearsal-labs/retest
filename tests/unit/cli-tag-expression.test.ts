import type { TagExpression } from '../../src/runner/contract.ts'
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { parseTagExpression, TagExpressionError } from '../../src/cli/tag-expression.ts'

const tag = (name: string): TagExpression => ({ kind: 'tag', tag: name })
const not = (operand: TagExpression): TagExpression => ({ kind: 'not', operand })
const and = (left: TagExpression, right: TagExpression): TagExpression => ({ kind: 'and', left, right })
const or = (left: TagExpression, right: TagExpression): TagExpression => ({ kind: 'or', left, right })

function mistake(text: string, knownTags?: readonly string[]): { message: string; index: number } {
  try {
    parseTagExpression(text, knownTags)
  } catch (error) {
    assert.ok(error instanceof TagExpressionError, String(error))
    return { message: error.message, index: error.index }
  }
  assert.fail(`expected ${JSON.stringify(text)} to be rejected`)
}

describe('parseTagExpression', () => {
  test('reads a tag, and the words and, or and not', () => {
    assert.deepEqual(parseTagExpression('smoke'), tag('smoke'))
    assert.deepEqual(parseTagExpression('smoke and not slow'), and(tag('smoke'), not(tag('slow'))))
    assert.deepEqual(parseTagExpression('smoke or slow'), or(tag('smoke'), tag('slow')))
    assert.deepEqual(parseTagExpression('not not smoke'), not(not(tag('smoke'))))
  })

  test('binds not, then and, then or, and joins from the left', () => {
    assert.deepEqual(parseTagExpression('a or b and c'), or(tag('a'), and(tag('b'), tag('c'))))
    assert.deepEqual(parseTagExpression('a and b or c'), or(and(tag('a'), tag('b')), tag('c')))
    assert.deepEqual(parseTagExpression('not a and b'), and(not(tag('a')), tag('b')))
    assert.deepEqual(parseTagExpression('a and b and c'), and(and(tag('a'), tag('b')), tag('c')))
    assert.deepEqual(parseTagExpression('a or b or c'), or(or(tag('a'), tag('b')), tag('c')))
  })

  test('parentheses group, with or without spaces around them', () => {
    assert.deepEqual(parseTagExpression('(a or b) and c'), and(or(tag('a'), tag('b')), tag('c')))
    assert.deepEqual(parseTagExpression('not(a or b)'), not(or(tag('a'), tag('b'))))
    assert.deepEqual(parseTagExpression('((a))'), tag('a'))
    assert.deepEqual(parseTagExpression('  a\tand\nb  '), and(tag('a'), tag('b')))
  })

  test('takes any tag a test may carry without a config, such as @smoke or p1', () => {
    assert.deepEqual(parseTagExpression('@smoke and p1'), and(tag('@smoke'), tag('p1')))
    assert.deepEqual(parseTagExpression('ui:login'), tag('ui:login'))
  })

  test('reports a missing tag at the exact character', () => {
    assert.deepEqual(mistake('smoke and'), { message: 'Expected a tag at character 10, but the expression ends there.', index: 9 })
    assert.deepEqual(mistake('and smoke'), { message: 'Expected a tag at character 1, but found "and".', index: 0 })
    assert.deepEqual(mistake('smoke or or slow'), { message: 'Expected a tag at character 10, but found "or".', index: 9 })
    assert.deepEqual(mistake('   '), { message: 'Expected a tag at character 4, but the expression ends there.', index: 3 })
    assert.deepEqual(mistake('()'), { message: 'Expected a tag at character 2, but found ")".', index: 1 })
  })

  test('reports two tags with nothing between them, and a stray parenthesis', () => {
    assert.deepEqual(mistake('smoke slow'), {
      message: 'Expected "and", "or" or the end at character 7, but found "slow".',
      index: 6,
    })
    assert.deepEqual(mistake('smoke (slow)').index, 6)
    assert.deepEqual(mistake('smoke)'), { message: 'The ")" at character 6 has no "(" to close.', index: 5 })
    assert.deepEqual(mistake('(smoke and (slow)'), { message: 'The "(" at character 1 is never closed.', index: 0 })
  })

  test('asks for words in place of symbols', () => {
    assert.deepEqual(mistake('smoke && slow'), { message: 'Unexpected "&" at character 7. Write and as a word.', index: 6 })
    assert.deepEqual(mistake('smoke || slow').message, 'Unexpected "|" at character 7. Write or as a word.')
    assert.deepEqual(mistake('!slow'), { message: 'Unexpected "!" at character 1. Write not as a word.', index: 0 })
  })

  test('with the config tags, an unknown tag is a mistake at its place, with a suggestion', () => {
    const tags = ['smoke', 'slow']
    assert.deepEqual(parseTagExpression('smoke and not slow', tags), and(tag('smoke'), not(tag('slow'))))
    assert.deepEqual(mistake('smoke and slwo', tags), {
      message: 'Unknown tag "slwo" at character 11. Did you mean slow? The config\'s tags are smoke and slow.',
      index: 10,
    })
    assert.equal(mistake('checkout', tags).message, 'Unknown tag "checkout" at character 1. The config\'s tags are smoke and slow.')
    assert.equal(mistake('smoke', []).message, 'Unknown tag "smoke" at character 1. The config lists no tags.')
  })

  test('keywords are lowercase words; any other spelling is a tag', () => {
    assert.deepEqual(parseTagExpression('AND'), tag('AND'))
    assert.equal(mistake('AND', ['smoke']).message, 'Unknown tag "AND" at character 1. The config\'s tags are smoke.')
  })
})
