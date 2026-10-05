import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { errorPageReason, NavigationWatcher } from '../../src/browser/firefox/navigation.ts'
import { Deadline } from '../../src/protocol/deadline.ts'

// How a Firefox navigation is judged loaded from the events BiDi tells: a document's load, one that replaced it, an
// error page in its place, a move within the document, and a page that stops answering.

function watcher(): NavigationWatcher {
  return new NavigationWatcher(() => {})
}

describe('the Firefox navigation watcher', () => {
  test("a navigation is loaded when its document's load arrives", async () => {
    const watching = watcher()
    const waiting = watching.loaded('n1', new Deadline(1000))
    watching.onStarted('n1')
    watching.onCommitted('n1')
    watching.onLoaded('n1')
    assert.deepEqual(await waiting, { kind: 'done' })
  })

  test('a document a client redirect replaced counts as loaded once the document it sent the browser to loads', async () => {
    const watching = watcher()
    const waiting = watching.loaded('n1', new Deadline(1000))
    watching.onStarted('n1')
    watching.onCommitted('n1')
    watching.onFailed('n1')
    watching.onStarted('n2')
    // Firefox names the replaced document's content loaded with the new navigation's id; that load is not the one awaited.
    watching.onContentLoaded('n2', 'http://127.0.0.1/redirect')
    watching.onCommitted('n2')
    assert.equal(await Promise.race([waiting, new Promise((resolve) => setTimeout(() => resolve('waiting'), 30))]), 'waiting')
    watching.onLoaded('n2')
    assert.deepEqual(await waiting, { kind: 'done' })
  })

  test("Firefox's error page in place of the document ends the wait, and names Firefox's reason", async () => {
    const watching = watcher()
    const waiting = watching.loaded('n1', new Deadline(1000))
    watching.onStarted('n1')
    watching.onCommitted('n1')
    watching.onContentLoaded('n1', 'about:neterror?e=connectionFailure&u=http%3A//127.0.0.1%3A9/')
    assert.deepEqual(await waiting, { kind: 'done' })
    assert.equal(watching.unreachable, 'connectionFailure')
  })

  test('a move to a fragment of the document ends the wait for a navigation that opened no document', async () => {
    const watching = watcher()
    const waiting = watching.loaded('fragment', new Deadline(1000))
    watching.onMovedWithinDocument()
    assert.deepEqual(await waiting, { kind: 'done' })
  })

  test('a navigation that never loads times out, and a page that stops answering ends the wait with the reason', async () => {
    const timedOut = watcher()
    timedOut.onStarted('n1')
    assert.deepEqual(await timedOut.loaded('n1', new Deadline(20)), { kind: 'timeout' })
    const stopped = watcher()
    const waiting = stopped.loaded('n1', new Deadline(1000))
    stopped.onStopped('a JavaScript alert dialog holds the page')
    assert.deepEqual(await waiting, { kind: 'stopped', reason: 'a JavaScript alert dialog holds the page' })
  })

  test('a reload or a move through the history settles on the latest document committed since it began', async () => {
    const watching = watcher()
    const waiting = watching.settled(new Deadline(1000))
    watching.onStarted('n1')
    watching.onCommitted('n1')
    watching.onLoaded('n1')
    assert.deepEqual(await waiting, { kind: 'done' })
    assert.equal(watching.startedAny, true)
  })

  test('a navigation whose response opened no document ends the wait at once, naming the address it asked for', async () => {
    const opening = watcher()
    const loading = opening.loaded('n1', new Deadline(1000))
    opening.onStarted('n1')
    opening.onAbandoned('n1', 'http://127.0.0.1/flip')
    assert.deepEqual(await loading, { kind: 'done' })
    assert.equal(opening.abandoned, 'http://127.0.0.1/flip')
    const reloading = watcher()
    const settling = reloading.settled(new Deadline(1000))
    reloading.onStarted('n1')
    reloading.onAbandoned('n1', 'http://127.0.0.1/flip')
    assert.deepEqual(await settling, { kind: 'done' })
  })

  test('a navigation given up for no document is no longer the answer once a later one starts or its document commits', () => {
    const replaced = watcher()
    replaced.onStarted('n1')
    replaced.onAbandoned('n1', 'http://127.0.0.1/flip')
    replaced.onStarted('n2')
    assert.equal(replaced.abandoned, undefined)
    const committed = watcher()
    committed.onStarted('n1')
    committed.onAbandoned('n1', 'http://127.0.0.1/flip')
    committed.onCommitted('n1')
    assert.equal(committed.abandoned, undefined)
  })

  test("the reason Firefox's error page names in its address, and none for any other page", () => {
    assert.equal(errorPageReason('about:neterror?e=dnsNotFound&u=http%3A//nowhere.invalid/'), 'dnsNotFound')
    assert.equal(errorPageReason('about:certerror?e=nssFailure2'), 'nssFailure2')
    assert.equal(errorPageReason('http://127.0.0.1/about:neterror'), undefined)
  })
})
