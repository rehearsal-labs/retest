import type { Failure } from '../../src/protocol/failures.ts'
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  CdpClosedError,
  CdpDisconnectedError,
  CdpInvalidResponseError,
  CdpProtocolError,
  CdpTimeoutError,
} from '../../src/browser/cdp/errors.ts'
import { commandStopped, connectionEnded, dialogOpened, failureFromError } from '../../src/browser/command-failures.ts'
import { failureSchema } from '../../src/protocol/failures.ts'
import { parse } from '../../src/protocol/schema.ts'

const command = { method: 'Input.dispatchMouseEvent', sessionId: 'S1' }
const click = "click getByTestId('save-task')"

function attempt(inputSent: boolean) {
  return { command: click, timeoutMs: 500, inputSent }
}

describe('connectionEnded', () => {
  test('is a lost session when the input never left', () => {
    assert.deepEqual(connectionEnded(click, false, 'the browser closed the pipe'), {
      class: 'session_lost',
      message: "Retest lost the page before it could click getByTestId('save-task'): the browser closed the pipe.",
      details: { reason: 'the browser closed the pipe' },
    })
  })

  test('is an unknown outcome once the input may have arrived', () => {
    const failure = connectionEnded(click, true, 'the browser closed the pipe')
    assert.equal(failure.class, 'outcome_unknown')
    assert.equal(
      failure.message,
      "Retest lost the page after it began to click getByTestId('save-task'), so it cannot tell whether that took effect: the browser closed the pipe.",
    )
  })
})

describe('commandStopped', () => {
  const ranOut: Failure = { class: 'timeout', message: 'The test ran longer than its 400 ms budget.', details: { timeoutMs: 400 } }

  test('takes its class and first words from the reason, and says nothing was sent', () => {
    assert.deepEqual(commandStopped(click, false, ranOut), {
      class: 'timeout',
      message: "The test ran longer than its 400 ms budget. Retest stopped before it could click getByTestId('save-task'), and sent nothing.",
      details: { timeoutMs: 400, inputSent: false },
    })
  })

  test('says input that was already sent is not taken back', () => {
    const failure = commandStopped(click, true, { class: 'interrupted', message: 'The run was interrupted.' })
    assert.deepEqual(failure, {
      class: 'interrupted',
      message:
        "The run was interrupted. Retest had already begun to click getByTestId('save-task'). Input it sent is not taken back, so it may have taken effect.",
      details: { inputSent: true },
    })
  })

  test('a reason that is not a failure reads as the time running out', () => {
    for (const reason of [undefined, 'stop', new Error('stop'), { class: 'nonsense', message: 'x' }]) {
      const failure = commandStopped(click, false, reason)
      assert.equal(failure.class, 'timeout')
      assert.equal(failure.message, "The time to click getByTestId('save-task') ran out. Retest stopped before it could click getByTestId('save-task'), and sent nothing.")
      assert.equal(parse(failureSchema, failure).ok, true)
    }
  })
})

describe('dialogOpened', () => {
  test('names the dialog and whether the input had been sent', () => {
    assert.deepEqual(dialogOpened(click, 'alert', true), {
      class: 'unsupported',
      message:
        "The page opened an alert dialog while Retest tried to click getByTestId('save-task'). Retest does not answer dialogs yet, and the dialog blocks the page.",
      details: { dialog: 'alert', inputSent: true },
    })
    assert.match(dialogOpened(click, 'confirm', false).message, /^The page opened a confirm dialog/)
  })
})

describe('failureFromError', () => {
  test('a disconnect before the input is a lost session, and after it an unknown outcome', () => {
    const error = new CdpDisconnectedError(command, { reason: 'the browser closed the pipe', written: true })
    assert.equal(failureFromError(error, attempt(false)).class, 'session_lost')
    assert.equal(failureFromError(error, attempt(true)).class, 'outcome_unknown')
  })

  test('a command refused because the connection had ended counts the same way', () => {
    const error = new CdpClosedError(command, 'the target detached')
    assert.equal(failureFromError(error, attempt(false)).class, 'session_lost')
    assert.equal(failureFromError(error, attempt(true)).class, 'outcome_unknown')
  })

  test('a timeout says whether the input had been sent', () => {
    const error = new CdpTimeoutError(command, { timeoutMs: 500, written: true })
    assert.deepEqual(failureFromError(error, attempt(false)), {
      class: 'timeout',
      message: "The page did not answer within 500 ms while Retest tried to click getByTestId('save-task').",
      details: { inputSent: false },
    })
    assert.deepEqual(failureFromError(error, attempt(true)), {
      class: 'timeout',
      message:
        "Retest began to click getByTestId('save-task'), but the page did not confirm it within 500 ms. It may or may not have taken effect.",
      details: { inputSent: true },
    })
  })

  test('an error that says nothing about the page is thrown again before any input', () => {
    const protocol = new CdpProtocolError(command, { code: -32000, message: 'Something odd', data: undefined })
    const unreadable = new CdpInvalidResponseError(command, '$.result missing required key')
    const bug = new TypeError('a Retest bug')
    for (const error of [protocol, unreadable, bug]) assert.throws(() => failureFromError(error, attempt(false)), error)
  })

  test('the same error after input may have arrived is an unknown outcome, since the action is never repeated', () => {
    const error = new CdpProtocolError(command, { code: -32000, message: 'Something odd', data: undefined })
    const failure = failureFromError(error, attempt(true))
    assert.equal(failure.class, 'outcome_unknown')
    assert.match(failure.message, /Something odd/)
  })

  test('every failure fits the result schema', () => {
    const errors = [
      new CdpDisconnectedError(command, { reason: 'gone', written: true }),
      new CdpClosedError(command, 'gone'),
      new CdpTimeoutError(command, { timeoutMs: 1, written: false }),
    ]
    for (const error of errors) {
      for (const inputSent of [false, true]) {
        assert.equal(parse(failureSchema, failureFromError(error, attempt(inputSent))).ok, true)
      }
    }
  })
})
