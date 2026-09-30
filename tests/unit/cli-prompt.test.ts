import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { describe, test } from 'node:test'
import { terminalPrompt } from '../../src/cli/prompt.ts'

function terminal() {
  const input = new PassThrough()
  const output = new PassThrough()
  let shown = ''
  output.on('data', (chunk: Buffer) => {
    shown += chunk.toString()
  })
  let interrupts = 0
  const prompt = terminalPrompt(input, output, () => interrupts++)
  return { input, prompt, shown: () => shown, interrupts: () => interrupts }
}

describe('terminalPrompt', () => {
  test('shows the question and resolves to the line typed', async () => {
    const { input, prompt, shown } = terminal()
    const answer = prompt.ask('  Which browser? › ')
    input.write('edge\n')
    assert.equal(await answer, 'edge')
    assert.match(shown(), /Which browser\? › /)
  })

  test('asks again on the same input', async () => {
    const { input, prompt } = terminal()
    const first = prompt.ask('first › ')
    input.write('one\n')
    assert.equal(await first, 'one')
    const second = prompt.ask('second › ')
    input.write('two\n')
    assert.equal(await second, 'two')
  })

  test('resolves to undefined when the input ends first', async () => {
    const { input, prompt } = terminal()
    const answer = prompt.ask('question › ')
    input.end()
    assert.equal(await answer, undefined)
  })

  test('passes Ctrl+C on as an interrupt and gives no answer', async () => {
    const { input, prompt, interrupts } = terminal()
    const answer = prompt.ask('question › ')
    input.write('\u0003')
    assert.equal(await answer, undefined)
    assert.equal(interrupts(), 1)
  })

  test('says whether a person is typing', () => {
    assert.equal(terminal().prompt.isTTY, false)
  })
})
