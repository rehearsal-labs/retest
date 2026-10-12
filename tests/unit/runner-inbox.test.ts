import type { BrowserCommand } from '../../src/browser/contract.ts'
import type { LoadedInbox } from '../../src/config/loaded.ts'
import type { InboxContext } from '../../src/config/types.ts'
import type { ReceivedMessageRecord } from '../../src/protocol/inbox.ts'
import type { FillContext } from '../../src/runner/secrets.ts'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { ReceivedMessage } from '../../src/api/inbox.ts'
import { renderTimeline } from '../../src/cli/inspect/test-timeline.ts'
import { validateConfig } from '../../src/config/validate.ts'
import { retestEventSchema } from '../../src/protocol/events.ts'
import { failure } from '../../src/protocol/failures.ts'
import { childMessageSchema, parentMessageSchema } from '../../src/protocol/messages.ts'
import { parse } from '../../src/protocol/schema.ts'
import { AttemptInbox, checkMessages } from '../../src/runner/inbox.ts'
import { readLink } from '../../src/runner/inbox-links.ts'
import { createAgentReporter } from '../../src/reporters/agent.ts'
import { buildReport } from '../../src/reporters/html/build-report.ts'
import { markupText } from '../../src/reporters/html/markup.ts'
import { createHumanReporter } from '../../src/reporters/human.ts'
import { timelineView } from '../../src/reporters/html/timeline-view.ts'
import { recordEvents } from '../../src/reporters/run-record.ts'
import { createStyle } from '../../src/reporters/style.ts'
import { runTargets } from '../../src/reporters/targets.ts'
import { Redactor } from '../../src/runner/redactor.ts'
import { runProject, tempProject } from '../support/project.ts'
import { eventsOfType } from '../support/run-harness.ts'

// The values a mailbox gives that no test, event, report or file may hold: a one-time code, and the two tokens of a
// sign-in link, one in its path and one in its query.
const code = '482913'
const token = '9f8e7d6c5b4a39281706f5e4'
const key = 'sk-live-73a1'
const origin = 'http://127.0.0.1:4173'
const signIn = `${origin}/magic/${token}?key=${key}`
const help = `${origin}/help`

type MessageFields = { subject?: string; from?: string; text?: string; codes?: string[]; links?: { url: string; text: string }[]; receivedAt: number | string | Date }

function message(fields: MessageFields): Record<string, unknown> {
  return {
    subject: 'Your sign-in code',
    from: 'noreply@tasks.test',
    text: `Your code is ${code}. Sign in at ${signIn} or read ${help}.`,
    codes: [code],
    links: [
      { url: signIn, text: 'Sign in' },
      { url: help, text: 'Help' },
    ],
    ...fields,
  }
}

/** A mailbox the test scripts: each look calls `messages` with the look's context and how many looks came before. */
function mailbox(messages: (context: InboxContext, earlier: number) => unknown, origins: string[] = []): LoadedInbox {
  let looks = 0
  return { read: async (context) => messages(context, looks++), origins }
}

function attempt(inboxes: Record<string, LoadedInbox>, startedAt = Date.now()): { inbox: AttemptInbox; redactor: Redactor; startedAt: number } {
  const redactor = new Redactor()
  return { inbox: new AttemptInbox({ inboxes: new Map(Object.entries(inboxes)), redactor, startedAt }), redactor, startedAt }
}

const reading = (timeoutMs = 2000, signal = new AbortController().signal) => ({ timeoutMs, signal })

function given(read: { answer: { ok: true; message: ReceivedMessageRecord } | { ok: false } }): ReceivedMessageRecord {
  assert.ok(read.answer.ok, `the read gave a message: ${JSON.stringify(read.answer)}`)
  return read.answer.message
}

function onPage(pageUrl: string | undefined, extra: Partial<FillContext> = {}): FillContext {
  return { pageUrl, appOrigins: [origin], timeoutMs: 500, signal: new AbortController().signal, ...extra }
}

describe('reading an inbox', () => {
  test('looks again until a message arrives, and gives it with its code and the link that carries a token hidden', async () => {
    const started = Date.now()
    const { inbox } = attempt({ owner: mailbox((_, earlier) => (earlier < 2 ? [] : [message({ receivedAt: started + 10 })])) }, started)
    const read = await inbox.read({ inbox: 'owner' }, reading())
    const record = given(read)
    assert.deepEqual([read.looks, read.messages], [3, 1])
    assert.ok(read.waitedMs >= 300, `it paused between looks, ${read.waitedMs} ms`)
    assert.deepEqual({ ...record, receivedAt: undefined }, {
      id: 'm1',
      inbox: 'owner',
      subject: 'Your sign-in code',
      from: 'noreply@tasks.test',
      text: `Your code is {{code}}. Sign in at {{link:1}} or read ${help}.`,
      codes: 1,
      links: [
        { text: 'Sign in', origin, path: '/magic/{{link:1}}', token: true },
        { text: 'Help', origin, path: '/help', token: false },
      ],
      receivedAt: undefined,
    })
    assert.equal(record.receivedAt, new Date(started + 10).toISOString())
  })

  test('gives only a message received since the test started, then only one received since the last it gave, never twice', async () => {
    const started = Date.now()
    const messages = [message({ subject: 'Second', receivedAt: started + 5 }), message({ subject: 'Old', receivedAt: started - 60_000 }), message({ subject: 'First', receivedAt: started + 5 })]
    const { inbox } = attempt({ owner: mailbox(() => messages) }, started)
    const subjects: string[] = []
    for (let read = 0; read < 2; read++) subjects.push(given(await inbox.read({ inbox: 'owner' }, reading())).subject)
    // Two messages received in the same moment keep the mailbox's order, and neither is given twice.
    assert.deepEqual(subjects, ['Second', 'First'])
    const none = await inbox.read({ inbox: 'owner' }, reading(250))
    assert.ok(!none.answer.ok)
    assert.equal(none.answer.failure.class, 'timeout')
    assert.match(none.answer.failure.message, /^No message arrived in the inbox "owner" within 250 ms\. Retest looked \d+ times\. On the last look, the inbox held 3 messages, none received since the last message this test was given\.$/)
    assert.deepEqual({ ...none.answer.failure.details, looks: undefined }, { inbox: 'owner', looks: undefined, messages: 3, fresh: 0, timeoutMs: 250 })
  })

  test('once the newest message is given, an older one is not, though the test was never given it', async () => {
    const started = Date.now()
    const { inbox } = attempt({ owner: mailbox(() => [message({ subject: 'Earlier', receivedAt: started + 5 }), message({ subject: 'Later', receivedAt: new Date(started + 9) })]) }, started)
    assert.equal(given(await inbox.read({ inbox: 'owner' }, reading())).subject, 'Later')
    const earlier = await inbox.read({ inbox: 'owner', subject: 'Earlier' }, reading(150))
    assert.ok(!earlier.answer.ok)
    assert.equal(earlier.answer.failure.class, 'timeout')
  })

  test('a message received before the test started is never given', async () => {
    const started = Date.now()
    const { inbox } = attempt({ owner: mailbox(() => [message({ receivedAt: started - 1 })]) }, started)
    const read = await inbox.read({ inbox: 'owner' }, reading(150))
    assert.ok(!read.answer.ok)
    assert.match(read.answer.failure.message, /On the last look, the inbox held 1 message, none received since the test started\.$/)
  })

  test('picks by subject as the test reads it, so a code in the subject is hidden and matches nothing', async () => {
    const started = Date.now()
    const messages = [message({ subject: `Your code is ${code}`, receivedAt: started + 2 }), message({ subject: 'Welcome aboard', codes: [], links: [], text: 'Hello', receivedAt: started + 1 })]
    const { inbox } = attempt({ owner: mailbox(() => messages) }, started)
    assert.equal(given(await inbox.read({ inbox: 'owner', subject: 'WELCOME' }, reading())).subject, 'Welcome aboard')
    const probe = await inbox.read({ inbox: 'owner', subject: { pattern: code, flags: '' } }, reading(150))
    assert.ok(!probe.answer.ok)
    assert.match(probe.answer.failure.message, /1 received since the last message this test was given, and none of them has a subject matching \/482913\/\.$/)
    assert.equal(given(await inbox.read({ inbox: 'owner', subject: { pattern: 'is \\{\\{code\\}\\}$', flags: '' } }, reading())).subject, 'Your code is {{code}}')
  })

  test('a name the config does not declare, or a subject pattern that cannot be read, is refused before the mailbox is asked', async () => {
    let asked = 0
    const { inbox } = attempt({ owner: mailbox(() => ++asked && []) })
    const unknown = await inbox.read({ inbox: 'member' }, reading())
    assert.deepEqual([unknown.answer, unknown.looks], [{ ok: false, failure: failure('usage', 'inbox("member") is not one of the config\'s inboxes. The config\'s inboxes are "owner".') }, 0])
    const pattern = await inbox.read({ inbox: 'owner', subject: { pattern: '(', flags: '' } }, reading())
    assert.ok(!pattern.answer.ok)
    assert.match(pattern.answer.failure.message, /^latest\(\) received a subject RegExp Retest cannot read: /)
    assert.equal(asked, 0)
  })

  test('a mailbox that throws, gives what Retest cannot read, or gives a code too short to hide fails the read, naming the inbox', async () => {
    const started = Date.now()
    const { inbox: broken } = attempt({ owner: mailbox(() => Promise.reject(new Error('the mailbox is down'))) })
    assert.deepEqual((await broken.read({ inbox: 'owner' }, reading())).answer, { ok: false, failure: failure('setup_failed', 'Retest could not read the inbox "owner": the mailbox is down') })
    const { inbox: shapeless } = attempt({ owner: mailbox(() => [{ subject: 'Hi' }]) })
    assert.deepEqual((await shapeless.read({ inbox: 'owner' }, reading())).answer, { ok: false, failure: failure('setup_failed', 'The inbox "owner" gave messages Retest cannot read: message 1 has no from.') })
    const { inbox: short } = attempt({ owner: mailbox(() => [message({ codes: ['729'], receivedAt: started + 1 })]) }, started)
    const refused = await short.read({ inbox: 'owner' }, reading())
    assert.ok(!refused.answer.ok)
    assert.equal(refused.answer.failure.class, 'setup_failed')
    assert.equal(refused.answer.failure.message, 'The inbox "owner" gave a message with a code shorter than 4 characters, too short to redact safely, so Retest gave the test nothing.')
    assert.ok(!refused.answer.failure.message.includes('729'))
  })

  test('checks each message the mailbox gives, naming the message and the field and never a value', () => {
    const at = Date.now()
    assert.equal(checkMessages('mail'), 'expected a list of messages, received string')
    assert.equal(checkMessages([message({ receivedAt: at }), 'x']), 'message 2 is string, not an object')
    assert.equal(checkMessages([message({ receivedAt: at, subject: 7 as unknown as string })]), 'message 1 has a subject that is number, not text')
    assert.equal(checkMessages([message({ receivedAt: at, codes: [''] })]), 'message 1 has codes that are not a list of text')
    assert.equal(checkMessages([message({ receivedAt: at, links: [{ url: signIn } as { url: string; text: string }] })]), 'link 1 of message 1 is not { url, text }')
    assert.equal(checkMessages([message({ receivedAt: 'yesterday' })]), 'message 1 has no receivedAt that reads as a time')
    const read = checkMessages([message({ receivedAt: new Date(at).toISOString() })])
    assert.ok(typeof read !== 'string')
    assert.equal(read[0]?.receivedAt, at)
  })

  test('a read stopped while the mailbox answers tells the mailbox, and ends as the stop says', async () => {
    let signal: AbortSignal | undefined
    const { inbox } = attempt({ owner: mailbox((context) => {
      signal = context.signal as AbortSignal
      return new Promise(() => undefined)
    }) })
    const stop = new AbortController()
    const read = inbox.read({ inbox: 'owner' }, reading(5000, stop.signal))
    await new Promise((resolve) => setTimeout(resolve, 20))
    stop.abort(failure('interrupted', 'The run was stopped.'))
    const { answer } = await read
    assert.deepEqual(answer, { ok: false, failure: failure('interrupted', 'The run was stopped. Retest stopped reading the inbox "owner".') })
    assert.equal(signal?.aborted, true)
    assert.equal(signal?.reason instanceof DOMException && signal.reason.name, 'AbortError')
  })

  test('a mailbox that gives no answer in time is told so, and the read times out', async () => {
    let signal: AbortSignal | undefined
    const { inbox } = attempt({ owner: mailbox((context) => {
      signal = context.signal as AbortSignal
      return new Promise(() => undefined)
    }) })
    const { answer } = await inbox.read({ inbox: 'owner' }, reading(150))
    assert.ok(!answer.ok)
    assert.equal(answer.failure.class, 'timeout')
    assert.match(answer.failure.message, /^No message arrived in the inbox "owner" within 150 ms\. Retest looked \d+ times?\. The inbox gave no answer in that time\.$/)
    assert.equal(signal?.reason instanceof DOMException && signal.reason.name, 'TimeoutError')
  })
})

describe('what an inbox gives is hidden', () => {
  test('every code and every token a mailbox gives is hidden from the moment it arrives, in any form an address writes it', async () => {
    const started = Date.now()
    const older = message({ subject: 'Older', codes: ['771204'], links: [{ url: `${origin}/reset?token=old-token-1`, text: 'Reset' }], receivedAt: started - 5000 })
    const { inbox, redactor } = attempt({ owner: mailbox(() => [message({ receivedAt: started + 1 }), older]) }, started)
    given(await inbox.read({ inbox: 'owner' }, reading()))
    assert.equal(redactor.redact(`typed ${code} at ${origin}/magic/${token}`), `typed {{code}} at ${origin}/magic/{{link:1}}`)
    assert.equal(redactor.redact(`next=${encodeURIComponent(signIn)}`), `next=${encodeURIComponent(`${origin}/magic/`)}{{link:1}}${encodeURIComponent('?key=')}{{link:1}}`)
    // The older message was never given, and its code and token are hidden all the same.
    assert.equal(redactor.redact('771204 old-token-1'), '{{code}} {{link:1}}')
    const event = { schemaVersion: 1, runId: 'r', sequence: 1, time: 't', elapsedMs: 1, origin: 'parent', type: 'inbox.read', testId: 't', attemptId: 'a', inbox: 'owner', messages: 2, looks: 1, waitedMs: 3, subject: `Code ${code}`, wanted: key, failure: failure('timeout', `saw ${signIn}`) } as const
    assert.deepEqual(redactor.redactFields(retestEventSchema, event), { ...event, subject: 'Code {{code}}', wanted: '{{link:1}}', failure: failure('timeout', `saw ${origin}/magic/{{link:1}}?key={{link:1}}`) })
  })

  test('a link carries a token when a path segment, a query value or the fragment reads as one', () => {
    const tokens = (address: string, codes: string[] = []) => readLink(address, codes)?.tokens
    assert.deepEqual(tokens(`${origin}/magic/${token}?utm_source=mail`), [token])
    assert.deepEqual(tokens(`${origin}/verify?oobCode=Ab3&apikey=x7&X-Amz-Signature=s1g`), ['Ab3', 'x7', 's1g'])
    assert.deepEqual(tokens(`${origin}/done#access_token=fragment-token-1&state=a`), ['fragment-token-1'])
    assert.deepEqual(tokens(`${origin}/confirm?c=${code}`, [code]), [code])
    assert.deepEqual(tokens(`${origin}/confirm/${code}`, [code]), [code])
    assert.deepEqual(tokens(`${origin}/reset?t=aGVsbG8gd29ybGQgdG9rZW4x`), ['aGVsbG8gd29ybGQgdG9rZW4x'])
    assert.deepEqual(tokens(`${origin}/n?token=a%20b`), ['a%20b', 'a b'])
    assert.deepEqual(tokens('http://ada:pass%20word@127.0.0.1:4173/inbox'), ['pass%20word', 'pass word'])
    for (const plain of [help, `${origin}/blog/2026-10-11?utm_source=mail&ref=news`, `${origin}/assets/release-checklist.pdf`, `${origin}/keyword?design=wide`]) {
      assert.deepEqual(tokens(plain), [], plain)
    }
    assert.equal(readLink('mailto:help@tasks.test', []), undefined)
  })
})

describe('codes and links from an inbox', () => {
  async function received(inboxes: Record<string, LoadedInbox>): Promise<{ inbox: AttemptInbox; record: ReceivedMessageRecord }> {
    const { inbox } = attempt(inboxes, 0)
    const record = given(await inbox.read({ inbox: Object.keys(inboxes)[0] ?? 'owner' }, reading()))
    return { inbox, record }
  }

  test('a link opens by its number, and only on an origin of the test apps or of the inbox', async () => {
    const elsewhere = `https://login.elsewhere.test/verify/${token}`
    const { inbox, record } = await received({ owner: mailbox(() => [message({ links: [{ url: signIn, text: 'Sign in' }, { url: help, text: 'Help' }, { url: elsewhere, text: 'Verify' }, { url: 'mailto:help@tasks.test', text: 'Write' }], receivedAt: 5 })]) })
    const link = (number: number, isDefault = false) => ({ inbox: 'owner', message: record.id, link: number, ...(isDefault ? { default: true as const } : {}) })
    assert.deepEqual(inbox.resolveLink(link(1, true), { appOrigins: [origin] }), { ok: true, url: signIn })
    assert.deepEqual(inbox.resolveLink(link(2), { appOrigins: [origin] }), { ok: true, url: help })
    assert.deepEqual(inbox.resolveLink(link(3), { appOrigins: [origin] }), {
      ok: false,
      failure: {
        class: 'not_actionable',
        message: `Retest did not open {{link:3}} from the inbox "owner": it goes to https://login.elsewhere.test, and a link from this inbox may open only on ${origin}. Add the origin to the inbox's origins if it belongs there.`,
        details: { origin: 'https://login.elsewhere.test' },
      },
    })
    assert.deepEqual(inbox.resolveLink(link(4), { appOrigins: [origin] }), { ok: false, failure: failure('unsupported', '{{link:4}} from the inbox "owner" is not an http or https address, so Retest opened nothing.') })
    assert.deepEqual(inbox.resolveLink(link(5), { appOrigins: [origin] }), { ok: false, failure: failure('usage', 'The message "Your sign-in code" from the inbox "owner" holds no link 5, so Retest opened nothing.') })
    assert.deepEqual(inbox.resolveLink({ inbox: 'owner', message: 'm9', link: 1 }, { appOrigins: [origin] }), { ok: false, failure: failure('usage', 'This link belongs to no message the inbox "owner" gave this test, so Retest opened nothing.') })
    const { inbox: listed, record: again } = await received({ owner: mailbox(() => [message({ links: [{ url: elsewhere, text: 'Verify' }], receivedAt: 5 })], ['https://login.elsewhere.test']) })
    assert.deepEqual(listed.resolveLink({ inbox: 'owner', message: again.id, link: 1 }, { appOrigins: [origin] }), { ok: true, url: elsewhere })
  })

  test('a code is typed only on an origin of the test apps or of the inbox, and never into a native app', async () => {
    const { inbox, record } = await received({ owner: mailbox(() => [message({ receivedAt: 5 })]) })
    const locator = { by: 'testId', value: 'code' } as const
    const fill = { kind: 'fill', locator, value: { inbox: 'owner', message: record.id, code: 1 } } as const
    assert.deepEqual(await inbox.resolveCode(fill, onPage(`${origin}/verify`)), { ok: true, command: { kind: 'fill', locator, value: code, secret: 'code', allowedOrigins: [origin] } })
    assert.deepEqual(await inbox.resolveCode(fill, onPage('https://evil.test/verify')), {
      ok: false,
      failure: {
        class: 'not_actionable',
        message: `Retest did not type the code from the inbox "owner": the page is on https://evil.test, and it may be typed only on ${origin}. Add the origin to the inbox's origins if it belongs there.`,
        details: { origin: 'https://evil.test' },
      },
    })
    assert.deepEqual(await inbox.resolveCode(fill, onPage(undefined, { bundleId: 'dev.tasks.phone' })), {
      ok: false,
      failure: { class: 'unsupported', message: 'Retest types a code from an inbox only into a web page, and typed nothing into dev.tasks.phone.', details: { bundleId: 'dev.tasks.phone' } },
    })
    // An Electron app's window shows whatever origin it chooses, so only the inbox's own origins count there.
    const electron = await inbox.resolveCode(fill, onPage(`${origin}/verify`, { target: 'electron' }))
    assert.ok(!electron.ok)
    assert.equal(electron.failure.class, 'not_actionable')
    const { inbox: codeless, record: plain } = await received({ owner: mailbox(() => [message({ codes: [], receivedAt: 5 })]) })
    assert.deepEqual(await codeless.resolveCode({ ...fill, value: { ...fill.value, message: plain.id } }, onPage(`${origin}/verify`)), {
      ok: false,
      failure: failure('usage', 'The message "Your sign-in code" from the inbox "owner" holds no code, so Retest typed nothing.'),
    })
  })
})

describe('a received message in the test', () => {
  const record: ReceivedMessageRecord = {
    id: 'm1',
    inbox: 'owner',
    subject: 'Your sign-in code',
    from: 'noreply@tasks.test',
    text: 'Your code is {{code}}. Sign in at {{link:2}}.',
    codes: 1,
    links: [
      { text: 'Help', origin, path: '/help', token: false },
      { text: 'Sign in', origin, path: '/magic/{{link:2}}', token: true },
      { text: 'Verify', origin, path: '/verify/email', token: false },
    ],
    receivedAt: '2026-10-11T09:15:00.000Z',
  }
  const message = new ReceivedMessage(record)

  test('chooses the first link that carries a token by default, or a link by its number or its path', () => {
    assert.equal(String(message.link()), '{{link}}')
    assert.equal(JSON.stringify({ link: message.link(3) }), '{"link":"{{link:3}}"}')
    assert.equal(String(message.link({ path: '/magic' })), '{{link:2}}')
    assert.equal(String(message.link({ path: '/verify/email' })), '{{link:3}}')
    assert.throws(() => message.link(4), /link\(4\) takes a link's number from 1 to 3, the links of the message "Your sign-in code"\./)
    assert.throws(() => message.link({ path: '/verify/e' }), /link\(\{ path: "\/verify\/e" \}\) matches no link in the message "Your sign-in code"\. Its links go to \/help, \/magic\/\{\{link:2\}\}, \/verify\/email\./)
    assert.throws(() => message.link('2' as unknown as number), /link\(\) takes a link's number from 1/)
  })

  test('holds no code and no address: its code prints as a placeholder, and the message as JSON shows none', () => {
    assert.equal(String(message.code), '{{code}}')
    assert.equal(message.receivedAt.toISOString(), record.receivedAt)
    assert.deepEqual(JSON.parse(JSON.stringify(message)), { subject: record.subject, from: record.from, text: record.text, receivedAt: record.receivedAt, links: record.links, code: '{{code}}' })
  })
})

describe('inboxes in the config', () => {
  const apps = { web: { browser: 'chromium', baseUrl: origin } }

  test('takes a function, or one with the origins its links and codes may also go to', () => {
    const owner = async () => []
    const loaded = validateConfig({ apps, inboxes: { owner, member: { messages: owner, origins: ['https://login.elsewhere.test/'] } } }, 'retest.config.ts')
    assert.ok(loaded.ok, loaded.ok ? '' : loaded.failure.message)
    assert.deepEqual([...(loaded.config.inboxes?.entries() ?? [])].map(([name, inbox]) => [name, inbox.origins]), [['owner', []], ['member', ['https://login.elsewhere.test']]])
    const none = validateConfig({ apps }, 'retest.config.ts')
    assert.ok(none.ok)
    assert.equal(none.config.inboxes, undefined)
  })

  test('names every problem at its key, and never quotes what a source holds', () => {
    const loaded = validateConfig({ apps, inboxes: { owner: 'secret mail', '9x': async () => [], member: { messages: 'x', origins: ['login.elsewhere.test'], filter: true } } }, 'retest.config.ts')
    assert.ok(!loaded.ok)
    assert.equal(
      loaded.failure.message,
      [
        'retest.config.ts has 5 problems:',
        "  inboxes.owner: expected a function that returns the inbox's messages, or { messages, origins }, received string",
        '  inboxes["9x"]: expected a name of letters, digits, "_" and "-" that starts with a letter, received "9x"',
        '  inboxes.member.filter: unknown key, expected messages or origins',
        "  inboxes.member.messages: expected a function that returns the inbox's messages, received string",
        '  inboxes.member.origins[0]: expected an origin such as https://example.com, received "login.elsewhere.test"',
      ].join('\n'),
    )
  })
})

describe('the inbox on the wire', () => {
  test('a read, its answer and its event are version 1 messages and events', () => {
    const read = { type: 'inbox', testId: 't', attemptId: 'a', id: 3, request: { inbox: 'owner', subject: { pattern: 'code', flags: 'i' } }, timeoutMs: 5000 } as const
    assert.deepEqual(parse(childMessageSchema, read), { ok: true, value: read })
    const answer = { type: 'inbox-result', id: 3, answer: { ok: true, message: { id: 'm1', inbox: 'owner', subject: 'S', from: 'f', text: 't', codes: 0, links: [], receivedAt: 'now' } } } as const
    assert.deepEqual(parse(parentMessageSchema, answer), { ok: true, value: answer })
    const command = { type: 'command', testId: 't', attemptId: 'a', id: 4, app: 'web', command: { kind: 'goto', url: { inbox: 'owner', message: 'm1', link: 2 } }, timeoutMs: 5000 } as const
    assert.deepEqual(parse(childMessageSchema, command), { ok: true, value: command })
    const fill = { ...command, command: { kind: 'fill', locator: { by: 'testId', value: 'code' }, value: { inbox: 'owner', message: 'm1', code: 1 } } } as const
    assert.deepEqual(parse(childMessageSchema, fill), { ok: true, value: fill })
  })
})

describe('an inbox in a run', async () => {
  const config = `import { chromium, defineConfig } from '@rehearsal-labs/retest'

const message = (link: string) => ({
  subject: 'Your sign-in code',
  from: 'noreply@tasks.test',
  text: 'Your code is ${code}. Or open ' + link + ' to sign in.',
  codes: ['${code}'],
  links: [{ url: link, text: 'Sign in' }, { url: '${help}', text: 'Help' }],
  receivedAt: Date.now(),
})

export default defineConfig({
  apps: { web: chromium({ baseUrl: '${origin}', executablePath: '/fake/chromium' }) },
  inboxes: {
    owner: async () => [message('${signIn}')],
    stranger: { messages: async () => [message('https://login.elsewhere.test/verify/${token}')] },
  },
})
`
  const tests = `import { expect, inbox, test } from '@rehearsal-labs/retest'

test('signs in with the code and the link from the inbox', async ({ page }) => {
  const message = await inbox('owner').latest({ subject: 'sign-in code' })
  console.log('the message reads', message.text, String(message.code), String(message.link()), JSON.stringify(message))
  expect(message.text).toBe('Your code is {{code}}. Or open {{link:1}} to sign in.')
  expect(message.links.map((link) => link.path)).toEqual(['/magic/{{link:1}}', '/help'])
  await page.goto('/login')
  await page.getByTestId('password').fill(message.code)
  await expect(page.getByTestId('typed-value')).toHaveText('{{code}}')
  await page.goto(message.link())
  await expect(page).toHaveURL(/\\/magic\\/\\{\\{link:1\\}\\}$/)
  await page.goto(message.link({ path: '/help' }))
})

test('a link to an origin the test may not open is refused', async ({ page }) => {
  const message = await inbox('stranger').latest()
  await page.goto(message.link())
})

test('a read that finds nothing fails, naming the inbox', async () => {
  await inbox('owner').latest({ subject: 'nothing like this', timeout: 300 })
})
`
  const commands: BrowserCommand[] = []
  const printed: string[] = []
  const writer = { write: (text: string) => void printed.push(text) }
  const reporters = [createHumanReporter({ stdout: writer, stderr: writer, color: false, runFolder: 'run' }), createAgentReporter({ stdout: writer, runFolder: 'run' })]
  const record = await runProject(tempProject({ 'retest.config.ts': config, 'tests/inbox.retest.ts': tests }), {
    files: ['tests/inbox.retest.ts'],
    fake: { onCommand: (command) => void commands.push(command) },
    reporters,
  })
  const [signsIn, stranger, nothing] = record.result.files[0]?.tests ?? []

  test('the test signs in: the page types the code and opens the link, and the test holds neither', () => {
    assert.equal(signsIn?.status, 'passed', JSON.stringify(signsIn?.failure))
    assert.deepEqual(record.browsers[0]?.pages[0]?.typed, [{ value: code, secret: 'code', url: `${origin}/login` }])
    const gotos = commands.flatMap((command) => (command.kind === 'goto' ? [command.url] : []))
    assert.deepEqual(gotos, ['/login', signIn, help])
    const log = record.output.map((chunk) => chunk.text).join('')
    assert.match(log, /the message reads Your code is \{\{code\}\}\. Or open \{\{link:1\}\} to sign in\. \{\{code\}\} \{\{link\}\} \{"subject"/)
  })

  test('a link to another origin is refused, naming it, and nothing opens', () => {
    assert.equal(stranger?.status, 'failed')
    assert.deepEqual(stranger?.failure?.class, 'not_actionable')
    assert.match(stranger?.failure?.message ?? '', /^Retest did not open \{\{link\}\} from the inbox "stranger": it goes to https:\/\/login\.elsewhere\.test, and a link from this inbox may open only on http:\/\/127\.0\.0\.1:4173\./)
    const refused = eventsOfType(record.events, 'action.failed').filter((event) => event.testId === stranger?.testId)
    assert.deepEqual(refused.map((event) => [event.command, event.secret, event.inbox, event.failure.details]), [['goto', 'link', 'stranger', { origin: 'https://login.elsewhere.test' }]])
  })

  test('a read that finds nothing fails with a timeout that says what the inbox held', () => {
    assert.equal(nothing?.status, 'failed')
    assert.equal(nothing?.failure?.class, 'timeout')
    assert.match(nothing?.failure?.message ?? '', /^No message arrived in the inbox "owner" within 300 ms\. .*none of them has a subject matching 'nothing like this'\.$/)
  })

  test('each read is an event, with the subject as the test read it, and each code fill and link names the inbox', () => {
    const reads = eventsOfType(record.events, 'inbox.read')
    assert.deepEqual(
      reads.map((event) => [event.testId, event.inbox, event.messages, event.subject, event.wanted, event.codes, event.links, event.failure?.class, event.origin]),
      [
        [signsIn?.testId, 'owner', 1, 'Your sign-in code', 'sign-in code', 1, 2, undefined, 'parent'],
        [stranger?.testId, 'stranger', 1, 'Your sign-in code', undefined, 1, 2, undefined, 'parent'],
        [nothing?.testId, 'owner', 1, undefined, 'nothing like this', undefined, undefined, 'timeout', 'parent'],
      ],
    )
    const actions = eventsOfType(record.events, 'action.completed').filter((event) => event.testId === signsIn?.testId)
    assert.deepEqual(
      actions.map((event) => [event.command, event.secret, event.inbox, event.valueLength, event.pageUrl]),
      [
        ['goto', undefined, undefined, undefined, `${origin}/login`],
        ['fill', 'code', 'owner', undefined, `${origin}/login`],
        ['goto', 'link', 'owner', undefined, `${origin}/magic/{{link:1}}`],
        ['goto', 'link:2', 'owner', undefined, `${origin}/help`],
      ],
    )
    const navigations = eventsOfType(record.events, 'navigation').filter((event) => event.testId === signsIn?.testId).map((event) => event.url)
    assert.deepEqual(navigations, [`${origin}/login`, `${origin}/magic/{{link:1}}`, `${origin}/help`])
  })

  test('the timeline in inspect and in the HTML report shows each read, and a failed one as failed', () => {
    const run = recordEvents(record.events)
    const lines = (testId: string | undefined) => {
      const found = record.result.files[0]?.tests.find((each) => each.testId === testId)
      const events = [...run.tests.values()].find((each) => each.testId === testId)?.events
      assert.ok(found !== undefined && events !== undefined)
      const options = { style: createStyle(false), runFolder: record.folder, targets: runTargets(run) }
      return { text: renderTimeline(found, events, options), html: markupText(timelineView(found, events)) }
    }
    const given = lines(signsIn?.testId)
    assert.match(given.text, /inbox owner gave "Your sign-in code" after 1 look/)
    assert.match(given.html, /inbox owner gave &quot;Your sign-in code&quot; after 1 look/)
    const none = lines(nothing?.testId)
    assert.match(none.text, /✗ inbox owner gave no message after \d+ looks .*timeout/)
  })

  test('no code and no token is anywhere in the run folder, the output or a report', async () => {
    const files = readdirSync(record.folder, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile())
    assert.ok(files.length > 3)
    for (const file of files) {
      const text = readFileSync(join(file.parentPath, file.name), 'latin1')
      for (const value of [code, token, key]) assert.ok(!text.includes(value), `${file.name} holds ${value}`)
    }
    const terminal = printed.join('')
    assert.match(terminal, /Retest did not open \{\{link\}\} from the inbox "stranger"/, 'the reports print the refusal')
    const report = await buildReport({ directory: record.folder, shown: 'run', source: 'run', result: record.result, events: record.events, warnings: [] })
    assert.match(report, /inbox owner gave &quot;Your sign-in code&quot;/)
    for (const value of [code, token, key]) {
      assert.ok(!record.output.some((chunk) => chunk.text.includes(value)), `the output holds ${value}`)
      assert.ok(!terminal.includes(value), `the human or agent report holds ${value}`)
      assert.ok(!report.includes(value), `the HTML report holds ${value}`)
    }
  })
})

describe('a run whose config declares no inbox', async () => {
  const record = await runProject(
    tempProject({
      'retest.config.ts': `import { chromium, defineConfig } from '@rehearsal-labs/retest'
export default defineConfig({ apps: { web: chromium({ baseUrl: '${origin}', executablePath: '/fake/chromium' }) } })
`,
      'tests/inbox.retest.ts': `import { inbox, test } from '@rehearsal-labs/retest'

test('reads an inbox the config does not declare', async () => {
  await inbox('owner').latest()
})
`,
    }),
    { files: ['tests/inbox.retest.ts'] },
  )

  test('refuses the read, saying the run has no inboxes, and writes it down without asking any mailbox', () => {
    const [refused] = record.result.files[0]?.tests ?? []
    assert.deepEqual([refused?.status, refused?.failure?.class, refused?.failure?.message], ['failed', 'usage', 'inbox("owner") needs a config that declares it. This run has no inboxes.'])
    assert.deepEqual(
      eventsOfType(record.events, 'inbox.read').map((event) => [event.inbox, event.looks, event.messages, event.failure?.class]),
      [['owner', 0, 0, 'usage']],
    )
  })
})
