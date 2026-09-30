import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { stillThereMessage } from '../../src/browser/chromium-process.ts'
import { closeGraceMs } from '../../src/browser/contract.ts'
import { onlyUnreaped, readProcessStat } from '../../src/shared/unreaped-group.ts'

// `/proc/<pid>/stat` lines as Linux writes them: pid, (command), state, parent, process group, and more.
const zombieZygote = '57 (chrome) Z 1 40 40 0 -1 4194380 0 0 0 0 0 0 0 0 20 0 1 0 1 0 0'
const zombieRenderer = '61 (chrome (render)) Z 1 40 40 0 -1 4194380 0 0 0 0 0 0 0 0 20 0 1 0 1 0 0'
const runningGpu = '58 (chrome) S 40 40 40 0 -1 4194560 0 0 0 0 0 0 0 0 20 0 7 0 1 0 0'
const otherGroup = '70 (node) S 1 70 70 0 -1 4194560 0 0 0 0 0 0 0 0 20 0 7 0 1 0 0'

describe('readProcessStat', () => {
  test('reads the state and group after the command, even one with spaces and parentheses', () => {
    assert.deepEqual(readProcessStat(zombieZygote), { state: 'Z', group: 40 })
    assert.deepEqual(readProcessStat(zombieRenderer), { state: 'Z', group: 40 })
    assert.deepEqual(readProcessStat(runningGpu), { state: 'S', group: 40 })
  })

  test('a line that is not a stat line reads as nothing', () => {
    for (const line of ['', 'no parentheses here', '12 (cut'] as const) assert.equal(readProcessStat(line), undefined, line)
  })
})

describe('onlyUnreaped', () => {
  test('is true when every process left in the group has exited and waits to be reaped', () => {
    assert.equal(onlyUnreaped(40, () => [zombieZygote, zombieRenderer, otherGroup]), true)
  })

  test('is false while any process of the group still runs, or when none is left', () => {
    assert.equal(onlyUnreaped(40, () => [zombieZygote, runningGpu]), false)
    assert.equal(onlyUnreaped(40, () => [otherGroup]), false)
    assert.equal(onlyUnreaped(40, () => []), false)
  })
})

describe('stillThereMessage', () => {
  const left = `The browser's process group 40 was still there ${closeGraceMs} ms after SIGKILL.`

  test('a group of processes that exited but were never reaped is told to start the container with an init', () => {
    assert.equal(
      stillThereMessage(40, () => [zombieZygote, zombieRenderer]),
      `${left} Its processes have exited, but nothing reaped them. In a container, the first process adopts them and must reap them: start the container with an init, such as docker run --init.`,
    )
  })

  test('a group with a process still running says only that it was still there', () => {
    assert.equal(stillThereMessage(40, () => [zombieZygote, runningGpu]), left)
    assert.equal(stillThereMessage(40, () => []), left)
  })
})
