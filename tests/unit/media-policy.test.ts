import type { AppPixelRules, FieldFact, PixelPolicyRecord, PixelUse } from '../../src/media/policy.ts'
import type { RecordIdentity } from '../../src/protocol/identity.ts'
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { appPixelRules, appPixelRulesSchema, defaultAppPixelRules, fieldMasking, PixelCapturePolicy } from '../../src/media/policy.ts'
import { parse } from '../../src/protocol/schema.ts'

const web: RecordIdentity = { testId: 'tests/login.retest.ts > signs in', attemptId: 'k3v9q0x2mb', app: 'web', sessionId: 'k3v9q0x2mb:web' }
const desk: RecordIdentity = { testId: 'tests/login.retest.ts > signs in', attemptId: 'k3v9q0x2mb', app: 'desk', sessionId: 'k3v9q0x2mb:desk' }
const otherTest: RecordIdentity = { testId: 'tests/other.retest.ts > runs', attemptId: 'p8n2c4d6fh', app: 'web', sessionId: 'p8n2c4d6fh:web' }
const textField: FieldFact = { kind: 'web', engine: 'chromium', element: 'input', inputType: 'text' }
const passwordField: FieldFact = { kind: 'web', engine: 'chromium', element: 'input', inputType: 'password' }

/** A policy on a clock the test moves, with every record it made. */
function policy(rules: Record<string, AppPixelRules> = {}): { policy: PixelCapturePolicy; records: PixelPolicyRecord[]; at: (us: number) => void } {
  let now = 0
  const records: PixelPolicyRecord[] = []
  const made = new PixelCapturePolicy({ rules: (app) => rules[app] ?? defaultAppPixelRules, clock: () => now, record: (record) => records.push(record) })
  return { policy: made, records, at: (us) => { now = us } }
}

describe('what the config allows', () => {
  test('both are allowed unless the config says never', () => {
    assert.deepEqual(defaultAppPixelRules, { screenshots: 'allowed', recordings: 'allowed' })
    assert.deepEqual(appPixelRules(undefined), defaultAppPixelRules)
    assert.deepEqual(appPixelRules({ recordings: 'never' }), { screenshots: 'allowed', recordings: 'never' })
    assert.equal(parse(appPixelRulesSchema, { screenshots: 'never' }).ok, true)
    assert.equal(parse(appPixelRulesSchema, { screenshots: 'blurred' }).ok, false)
    assert.equal(parse(appPixelRulesSchema, { videos: 'never' }).ok, false)
  })

  test('screenshots: never withholds failure, AI check and agent screenshots; recordings: never withholds saved and live frames', () => {
    const { policy: rules } = policy({ web: { screenshots: 'never', recordings: 'allowed' }, desk: { screenshots: 'allowed', recordings: 'never' } })
    const decide = (identity: RecordIdentity, use: PixelUse): string => {
      const decision = rules.decide({ identity, use, source: 'chromium' })
      return decision.capture ? 'capture' : decision.withheld
    }
    assert.deepEqual((['failure', 'evaluation', 'agent', 'recording', 'live'] as const).map((use) => decide(web, use)), ['app_rules', 'app_rules', 'app_rules', 'capture', 'capture'])
    assert.deepEqual((['failure', 'evaluation', 'agent', 'recording', 'live'] as const).map((use) => decide(desk, use)), ['capture', 'capture', 'capture', 'app_rules', 'app_rules'])
    const decision = rules.decide({ identity: web, use: 'failure', source: 'chromium' })
    assert.equal(decision.capture ? '' : decision.message, 'The config does not allow screenshots of web, so Retest took none.')
  })
})

describe('which fields mask a secret', () => {
  test('only a desktop browser password input and a macOS secure field mask every character', () => {
    const cases: [FieldFact, boolean, string?][] = [
      [passwordField, true],
      [{ kind: 'web', engine: 'firefox', element: 'input', inputType: 'password' }, true],
      [{ kind: 'web', engine: 'webkit', element: 'input', inputType: 'PASSWORD' }, true],
      [{ kind: 'native', platform: 'macos', elementType: 'SecureTextField' }, true],
      [textField, false, 'text'],
      [{ kind: 'web', engine: 'chromium', element: 'input', inputType: 'email' }, false, 'text'],
      [{ kind: 'web', engine: 'chromium', element: 'input', inputType: 'password ' }, false, 'text'],
      [{ kind: 'web', engine: 'firefox', element: 'textarea' }, false, 'text'],
      [{ kind: 'web', engine: 'webkit', element: 'editable' }, false, 'text'],
      [{ kind: 'web', engine: 'chromium', element: 'other' }, false, 'text'],
      [{ kind: 'native', platform: 'ios', elementType: 'SecureTextField' }, false, 'typed_characters'],
      [{ kind: 'native', platform: 'macos', elementType: 'TextField' }, false, 'text'],
      [{ kind: 'native', platform: 'ios', elementType: 'TextField' }, false, 'text'],
      [{ kind: 'unread', reason: 'the page did not answer' }, false, 'unknown'],
    ]
    for (const [fact, masks, shows] of cases) {
      const masking = fieldMasking(fact)
      assert.equal(masking.masks, masks, JSON.stringify(fact))
      if (!masking.masks) assert.equal(masking.shows, shows, JSON.stringify(fact))
    }
  })
})

describe('a secret typed into a field that shows its text', () => {
  test('capture of that session is withheld from just before the first key until the field is gone, and the stretch is recorded', () => {
    const { policy: rules, records, at } = policy()
    at(1000)
    assert.equal(rules.decide({ identity: web, use: 'recording', source: 'chromium' }).capture, true)
    const entry = rules.beginSecretEntry({ identity: web, secret: 'password', field: 'node-41', fact: textField })
    assert.equal(entry.masked, false)
    at(1500)
    const now = rules.decide({ identity: web, use: 'failure', source: 'chromium' })
    assert.equal(now.capture ? '' : now.withheld, 'secret_entry')
    assert.equal(now.capture ? '' : now.message, 'Retest withheld this capture of web by policy: the secret "password" was typed into a field that shows its text, and the field had not been seen to stop showing it.')
    rules.endSecretEntry(entry, { fact: textField, input: 'sent' })
    at(2000)
    assert.equal(rules.decide({ identity: web, use: 'live', source: 'chromium' }).capture, false, 'still withheld once the keys are in: the field shows the secret')
    rules.fieldChanged(web, 'node-41', 'gone')
    at(2100)
    assert.equal(rules.decide({ identity: web, use: 'recording', source: 'chromium' }).capture, true)
    assert.deepEqual(records, [
      { testId: web.testId, attemptId: web.attemptId, session: 'web', sessionId: web.sessionId, type: 'capture.withheld', secret: 'password', cause: 'text', fromUs: 1000 },
      { testId: web.testId, attemptId: web.attemptId, session: 'web', sessionId: web.sessionId, type: 'capture.resumed', secret: 'password', endedBy: 'field_gone', fromUs: 1000, untilUs: 2000 },
    ])
    assert.deepEqual(rules.stretches(), [
      { testId: web.testId, attemptId: web.attemptId, app: 'web', sessionId: web.sessionId, secret: 'password', field: 'node-41', cause: 'text', fromUs: 1000, untilUs: 2000, endedBy: 'field_gone', withheld: { screenshots: 1, frames: 1 } },
    ])
  })

  test('a capture is kept only when the time it could have been taken does not touch the stretch', () => {
    const { policy: rules, at } = policy()
    at(1000)
    rules.beginSecretEntry({ identity: web, secret: 'password', field: 'node-41', fact: textField })
    at(2000)
    rules.fieldChanged(web, 'node-41', 'empty')
    at(5000)
    const kept = (earliestUs: number, arrivedUs: number): boolean => rules.decide({ identity: web, use: 'recording', source: 'chromium', span: { earliestUs, arrivedUs } }).capture
    assert.equal(kept(100, 999), true, 'arrived before the first key could go')
    assert.equal(kept(100, 1000), false, 'arrived at the moment the stretch began')
    assert.equal(kept(1200, 1300), false, 'taken inside the stretch')
    assert.equal(kept(1900, 2100), false, 'asked for before the field was seen empty, back after')
    assert.equal(kept(0, 4000), false, 'a screencast frame whose capture began before the stretch, though it arrived after')
    assert.equal(kept(2000, 2100), true, 'asked for at the moment the stretch ended')
    assert.equal(kept(3000, 3100), true, 'a screencast started again after the stretch')
    assert.equal(kept(4000, 3000), true, 'an earliest moment after the arrival is moved back to the arrival, which is after the stretch')
    assert.equal(kept(1500, 1200), false, 'and one moved back into the stretch is withheld')
  })

  test('the page leaving or the session ending ends every stretch of that session and no other', () => {
    const { policy: rules, records, at } = policy()
    at(10)
    rules.beginSecretEntry({ identity: web, secret: 'user', field: 'node-1', fact: textField })
    rules.beginSecretEntry({ identity: web, secret: 'password', field: 'node-2', fact: { kind: 'unread', reason: 'the page did not answer' } })
    rules.beginSecretEntry({ identity: otherTest, secret: 'password', field: 'node-1', fact: textField })
    at(20)
    rules.fieldChanged(web, 'node-1', 'masked')
    assert.equal(rules.decide({ identity: web, use: 'recording', source: 'chromium' }).capture, false, 'the field Retest could not read still holds it')
    at(30)
    rules.pageLeft(web, 'new_document')
    assert.equal(rules.decide({ identity: web, use: 'recording', source: 'chromium' }).capture, true)
    assert.equal(rules.decide({ identity: otherTest, use: 'recording', source: 'chromium' }).capture, false, 'another session keeps its own stretch')
    rules.pageLeft(otherTest, 'session_ended')
    assert.deepEqual(records.filter((record) => record.type === 'capture.resumed').map((record) => [record.sessionId, record.secret, record.type === 'capture.resumed' ? record.endedBy : '']), [
      ['k3v9q0x2mb:web', 'user', 'field_masked'],
      ['k3v9q0x2mb:web', 'password', 'new_document'],
      ['p8n2c4d6fh:web', 'password', 'session_ended'],
    ])
    assert.deepEqual(rules.stretches().map((stretch) => stretch.cause), ['text', 'unknown', 'text'])
  })

  test('a fill that sent no key ends its stretch; one whose keys may have gone keeps it', () => {
    const { policy: rules, at } = policy()
    at(10)
    const notSent = rules.beginSecretEntry({ identity: web, secret: 'password', field: 'node-1', fact: textField })
    at(20)
    rules.endSecretEntry(notSent, { fact: textField, input: 'not_sent' })
    assert.equal(rules.decide({ identity: web, use: 'recording', source: 'chromium' }).capture, true)
    assert.equal(rules.stretches()[0]?.endedBy, 'nothing_typed')
    const unknown = rules.beginSecretEntry({ identity: web, secret: 'password', field: 'node-1', fact: textField })
    at(30)
    rules.endSecretEntry(unknown, { fact: textField, input: 'unknown' })
    rules.endSecretEntry(unknown, { fact: textField, input: 'not_sent' })
    assert.equal(rules.decide({ identity: web, use: 'recording', source: 'chromium' }).capture, false, 'a second end of the same fill changes nothing')
  })

  test('a native masking label without an owned field-type read remains withheld', () => {
    const { policy: rules } = policy()
    const phone: RecordIdentity = { ...web, app: 'phone', sessionId: 'k3v9q0x2mb:phone' }
    const ios = rules.beginSecretEntry({ identity: phone, secret: 'password', field: 'e1', fact: { kind: 'native', platform: 'ios', elementType: 'SecureTextField' } })
    assert.equal(ios.masked, false)
    const decision = rules.decide({ identity: phone, use: 'evaluation', source: 'simulator-display' })
    assert.equal(decision.capture ? '' : decision.message, 'Retest withheld this capture of phone by policy: the secret "password" was typed into a field that can show the characters typed, and the field had not been seen to stop showing it.')
  })

  test('a window cut from the shared display is withheld while any session of the run is withheld; a page capture of another session is not', () => {
    const { policy: rules, at } = policy()
    at(10)
    rules.beginSecretEntry({ identity: otherTest, secret: 'password', field: 'node-1', fact: textField })
    const crop = rules.decide({ identity: desk, use: 'failure', source: 'window-crop' })
    assert.equal(crop.capture ? '' : crop.message, 'Retest withheld this capture of desk by policy: the secret "password" was on screen in p8n2c4d6fh:web, and a Mac window capture waits while any session of the run has a secret on screen.')
    assert.equal(rules.decide({ identity: web, use: 'failure', source: 'chromium' }).capture, true)
    assert.equal(rules.decide({ identity: desk, use: 'failure', source: 'executor-screen' }).capture, true)
    at(20)
    rules.pageLeft(otherTest, 'new_document')
    assert.equal(rules.decide({ identity: desk, use: 'failure', source: 'window-crop' }).capture, true)
  })
})

describe('a secret typed into a field that masks it', () => {
  test('capture goes on, and the record says a secret was typed into a masked field', () => {
    const { policy: rules, records, at } = policy()
    at(500)
    const entry = rules.beginSecretEntry({ identity: web, secret: 'password', field: 'node-7', fact: passwordField })
    assert.equal(entry.masked, true)
    assert.equal(rules.decide({ identity: web, use: 'recording', source: 'chromium' }).capture, true)
    rules.endSecretEntry(entry, { fact: passwordField, input: 'sent' })
    assert.equal(rules.decide({ identity: web, use: 'failure', source: 'chromium' }).capture, true)
    assert.deepEqual(records, [{ testId: web.testId, attemptId: web.attemptId, session: 'web', sessionId: web.sessionId, type: 'capture.masked_entry', secret: 'password', atUs: 500 }])
    assert.deepEqual(rules.stretches(), [])
  })

  test('a field that no longer masks once the keys are in is withheld from then, and the stretch names when the first key went', () => {
    const { policy: rules, records, at } = policy()
    at(500)
    const entry = rules.beginSecretEntry({ identity: web, secret: 'password', field: 'node-7', fact: passwordField })
    at(800)
    rules.endSecretEntry(entry, { fact: textField, input: 'sent' })
    assert.equal(rules.decide({ identity: web, use: 'recording', source: 'chromium' }).capture, false)
    assert.deepEqual(records.at(-1), { testId: web.testId, attemptId: web.attemptId, session: 'web', sessionId: web.sessionId, type: 'capture.withheld', secret: 'password', cause: 'unmasked_while_typed', fromUs: 800, exposedFromUs: 500 })
    const decision = rules.decide({ identity: web, use: 'failure', source: 'chromium' })
    assert.match(decision.capture ? '' : decision.message, /a field that stopped masking it/)
  })

  test('a masked field read as unreadable after the keys is withheld too, and a fill that sent nothing is not', () => {
    const { policy: rules, at } = policy()
    at(1)
    const unread = rules.beginSecretEntry({ identity: web, secret: 'password', field: 'node-7', fact: passwordField })
    rules.endSecretEntry(unread, { fact: { kind: 'unread', reason: 'the field was gone' }, input: 'sent' })
    assert.equal(rules.stretches().length, 1)
    const nothing = rules.beginSecretEntry({ identity: otherTest, secret: 'password', field: 'node-7', fact: passwordField })
    rules.endSecretEntry(nothing, { fact: textField, input: 'not_sent' })
    assert.equal(rules.decide({ identity: otherTest, use: 'recording', source: 'chromium' }).capture, true)
  })
})

describe('the policy refuses what it cannot place', () => {
  test('an identity whose session is not its attempt\'s and app\'s is refused', () => {
    const { policy: rules } = policy()
    const wrong: RecordIdentity = { ...web, sessionId: 'k3v9q0x2mb:phone' }
    assert.throws(() => rules.decide({ identity: wrong, use: 'failure', source: 'chromium' }), RangeError)
    assert.throws(() => rules.beginSecretEntry({ identity: wrong, secret: 'password', field: 'n', fact: textField }), RangeError)
    assert.throws(() => rules.pageLeft(wrong, 'new_document'), RangeError)
  })

  test('a stretch never ends before it began, whatever the clock reads', () => {
    const { policy: rules, at } = policy()
    at(1000)
    rules.beginSecretEntry({ identity: web, secret: 'password', field: 'n', fact: textField })
    at(400)
    rules.pageLeft(web, 'session_ended')
    assert.equal(rules.stretches()[0]?.untilUs, 1000)
  })

  test('a snapshot cannot change what the policy holds', () => {
    const { policy: rules, at } = policy()
    at(1)
    rules.beginSecretEntry({ identity: web, secret: 'password', field: 'n', fact: textField })
    const [stretch] = rules.stretches()
    assert.ok(stretch !== undefined && Object.isFrozen(stretch) && Object.isFrozen(stretch.withheld))
    rules.decide({ identity: web, use: 'failure', source: 'chromium' })
    assert.equal(stretch.withheld.screenshots, 0)
    assert.equal(rules.stretches()[0]?.withheld.screenshots, 1)
  })
})
