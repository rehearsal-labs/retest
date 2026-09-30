import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CdpAbortedError, CdpProtocolError, CdpTimeoutError } from '../../src/browser/cdp/errors.ts'
import { IsolatedWorld } from '../../src/browser/isolated-world.ts'
import { Deadline } from '../../src/protocol/deadline.ts'
import { s } from '../../src/protocol/schema.ts'
import { count, never, protocolError, scriptedSession } from './browser-fixtures.ts'

const createWorld = 'Page.createIsolatedWorld'
const callFunction = 'Runtime.callFunctionOn'
const readValue = 'function () { return "seen" }'
const goneContext = 'Cannot find context with specified id'

function contextOf(params: unknown): unknown {
  return typeof params === 'object' && params !== null && 'executionContextId' in params ? params.executionContextId : undefined
}

function answered(value: unknown): Promise<unknown> {
  return Promise.resolve({ result: { type: typeof value, value } })
}

function created(executionContextId: number): Promise<unknown> {
  return Promise.resolve({ executionContextId })
}

function read(world: IsolatedWorld, budgetMs: number): Promise<string> {
  return world.call(readValue, [], s.string(), new Deadline(budgetMs))
}

test('calls made at once share one creation of the world', async () => {
  const creation = Promise.withResolvers<unknown>()
  const { session, sent } = scriptedSession((method) => (method === createWorld ? creation.promise : answered('seen')))
  const world = new IsolatedWorld(session, () => 'F1')
  const reading = Promise.all([read(world, 2000), read(world, 2000), read(world, 2000)])
  creation.resolve({ executionContextId: 7 })
  assert.deepEqual(await reading, ['seen', 'seen', 'seen'])
  assert.equal(count(sent, createWorld), 1)
  assert.deepEqual(
    sent.filter((command) => command.method === callFunction).map((command) => contextOf(command.params)),
    [7, 7, 7],
  )
})

test('after the document changes, calls made at once share one new creation', async () => {
  let next = 7
  const { session, sent } = scriptedSession((method) => (method === createWorld ? created(next++) : answered('seen')))
  const world = new IsolatedWorld(session, () => 'F1')
  await read(world, 2000)
  world.reset()
  await Promise.all([read(world, 2000), read(world, 2000)])
  assert.equal(count(sent, createWorld), 2)
})

test('a call never waits past its own deadline for a creation another call started', async () => {
  const creation = Promise.withResolvers<unknown>()
  const { session } = scriptedSession((method) => (method === createWorld ? creation.promise : answered('seen')))
  const world = new IsolatedWorld(session, () => 'F1')
  const patient = read(world, 5000)
  const started = performance.now()
  const hurried = await read(world, 50).then(
    () => 'answered',
    (error: unknown) => error,
  )
  const ms = performance.now() - started
  assert.ok(hurried instanceof CdpTimeoutError, String(hurried))
  assert.ok(ms < 250, `the hurried call should end at its own deadline, took ${ms} ms`)
  creation.resolve({ executionContextId: 7 })
  assert.equal(await patient, 'seen')
})

// Stops the call 20 ms in, unless the page stops it sooner, and returns what the call failed with.
async function stoppedRead(answer: (method: string, stop: AbortController) => Promise<unknown>): Promise<unknown> {
  const stop = new AbortController()
  const { session } = scriptedSession((method) => answer(method, stop))
  const world = new IsolatedWorld(session, () => 'F1')
  const reading = world.call(readValue, [], s.string(), new Deadline(5000, { signal: stop.signal })).catch((error: unknown) => error)
  setTimeout(() => stop.abort(), 20)
  const started = performance.now()
  const error = await reading
  assert.ok(performance.now() - started < 1000, 'the call ended when it was stopped')
  return error
}

test('a stopped call ends at once, whether it waits for the world, for its answer or between documents', async () => {
  const waitingForWorld = await stoppedRead((method) => (method === createWorld ? never() : answered('seen')))
  assert.ok(waitingForWorld instanceof CdpAbortedError && waitingForWorld.method === createWorld, String(waitingForWorld))
  const waitingForAnswer = await stoppedRead((method) => (method === createWorld ? created(7) : never()))
  assert.ok(waitingForAnswer instanceof CdpAbortedError && waitingForAnswer.method === callFunction, String(waitingForAnswer))
  const betweenDocuments = await stoppedRead((method, stop) => {
    if (method === createWorld) return created(7)
    stop.abort()
    return Promise.reject(protocolError(callFunction, goneContext))
  })
  assert.ok(betweenDocuments instanceof Error && betweenDocuments.name === 'AbortError', String(betweenDocuments))
})

test('a creation cut short by another call deadline is made again for a call with time left', async () => {
  let creations = 0
  // The second creation waits for the hurried call to settle, so a slow machine cannot hand it the new world.
  const hurriedSettled = Promise.withResolvers<void>()
  const { session } = scriptedSession((method) => {
    if (method !== createWorld) return answered('seen')
    creations += 1
    return creations === 1 ? never() : hurriedSettled.promise.then(() => created(8))
  })
  const world = new IsolatedWorld(session, () => 'F1')
  const hurried = read(world, 30)
  const patient = read(world, 2000)
  await assert.rejects(hurried, CdpTimeoutError)
  hurriedSettled.resolve()
  assert.equal(await patient, 'seen')
  assert.equal(creations, 2)
})

test('a call that fails for a reason other than a lost document keeps the world for the next call', async () => {
  let calls = 0
  const { session, sent } = scriptedSession((method) => {
    if (method === createWorld) return created(7)
    calls += 1
    return calls === 1 ? Promise.reject(protocolError(callFunction, 'Internal error')) : answered('seen')
  })
  const world = new IsolatedWorld(session, () => 'F1')
  await assert.rejects(read(world, 2000), CdpProtocolError)
  assert.equal(await read(world, 2000), 'seen')
  assert.equal(count(sent, createWorld), 1)
})

test('a call whose document went away runs again in the world of the next one', async () => {
  let next = 7
  const { session, sent } = scriptedSession((method, params) => {
    if (method === createWorld) return created(next++)
    return contextOf(params) === 7 ? Promise.reject(protocolError(callFunction, goneContext)) : answered('seen')
  })
  const world = new IsolatedWorld(session, () => 'F1')
  assert.equal(await read(world, 2000), 'seen')
  assert.equal(count(sent, createWorld), 2)
})

test('a call whose document keeps going away times out at its own deadline', async () => {
  let next = 7
  const { session } = scriptedSession((method) =>
    method === createWorld ? created(next++) : Promise.reject(protocolError(callFunction, goneContext)),
  )
  const world = new IsolatedWorld(session, () => 'F1')
  const started = performance.now()
  await assert.rejects(read(world, 100), CdpTimeoutError)
  assert.ok(performance.now() - started < 500)
})

test('enter names the context of the document it ran in, and callIn stays in that document', async () => {
  let next = 7
  const { session, sent } = scriptedSession((method, params) => {
    if (method === createWorld) return created(next++)
    return contextOf(params) === 7 ? answered('first') : answered('second')
  })
  const world = new IsolatedWorld(session, () => 'F1')
  const entered = await world.enter(readValue, [], s.string(), new Deadline(2000))
  assert.deepEqual(entered, { value: 'first', context: 7 })
  world.reset()
  assert.equal(await world.callIn(entered.context, readValue, [], s.string(), new Deadline(2000)), 'first')
  assert.equal(count(sent, createWorld), 1)
})

test('a call bound to a document fails once that document has gone, and never moves to the next one', async () => {
  const { session, sent } = scriptedSession((method) =>
    method === createWorld ? created(8) : Promise.reject(protocolError(callFunction, goneContext)),
  )
  const world = new IsolatedWorld(session, () => 'F1')
  await assert.rejects(world.callIn(7, readValue, [], s.string(), new Deadline(2000)), (error) => {
    assert.ok(error instanceof CdpProtocolError)
    assert.equal(error.protocolMessage, goneContext)
    return true
  })
  assert.equal(count(sent, createWorld), 0)
})

test('a page function that throws fails the call with its message', async () => {
  const { session } = scriptedSession((method) =>
    method === createWorld
      ? created(7)
      : Promise.resolve({ result: { type: 'object' }, exceptionDetails: { text: 'Uncaught', exception: { description: 'TypeError: boom' } } }),
  )
  const world = new IsolatedWorld(session, () => 'F1')
  await assert.rejects(read(world, 2000), /Retest's page script failed: TypeError: boom/)
})
