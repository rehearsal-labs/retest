import type { RoleQuery } from '../../src/browser/accessibility.ts'
import type { WorldArgument } from '../../src/browser/isolated-world.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chromeRolesFor, elementsByRole, labelledRoles } from '../../src/browser/accessibility.ts'
import { Deadline } from '../../src/protocol/deadline.ts'
import { protocolError, scriptedSession, type SentCommand } from './browser-fixtures.ts'

type AxNode = { ignored: boolean; name?: string; backendDOMNodeId?: number }

function field(params: unknown, key: string): unknown {
  return typeof params === 'object' && params !== null && key in params ? Reflect.get(params, key) : undefined
}

/** A page whose accessibility tree holds `tree`, by role, and whose nodes resolve unless `resolve` says otherwise. */
function page(tree: Record<string, AxNode[]>, resolve: (id: number) => Promise<unknown> = (id) => Promise.resolve({ object: { objectId: `element-${id}` } })) {
  return scriptedSession((method, params) => {
    switch (method) {
      case 'Runtime.evaluate':
        return Promise.resolve({ result: { type: 'object', objectId: 'document' } })
      case 'Accessibility.queryAXTree': {
        const role = field(params, 'role')
        const nodes = (typeof role === 'string' ? (tree[role] ?? []) : []).map(({ name, ...node }) => ({
          ...node,
          nodeId: String(node.backendDOMNodeId),
          role: { type: 'role', value: role },
          ...(name === undefined ? {} : { name: { type: 'computedString', value: name, sources: [] } }),
        }))
        return Promise.resolve({ nodes })
      }
      case 'DOM.resolveNode': {
        const id = field(params, 'backendNodeId')
        return typeof id === 'number' ? resolve(id) : Promise.reject(new Error('no backendNodeId'))
      }
      default:
        return Promise.reject(new Error(`unexpected ${method}`))
    }
  })
}

async function find(session: ReturnType<typeof page>['session'], query: RoleQuery): Promise<WorldArgument[]> {
  return elementsByRole({ session, context: 7, objectGroup: 'retest-call-1' }, query, new Deadline(2000))
}

function sentWith(sent: SentCommand[], method: string): unknown[] {
  return sent.filter((command) => command.method === method).map((command) => command.params)
}

test('asks Chrome for the role in the document of the world, and makes each match an object there', async () => {
  const { session, sent } = page({ button: [{ ignored: false, name: 'Save', backendDOMNodeId: 11 }] })
  assert.deepEqual(await find(session, { roles: ['button'], exact: true }), [{ objectId: 'element-11' }])
  assert.deepEqual(sentWith(sent, 'Runtime.evaluate'), [{ expression: 'document', contextId: 7, objectGroup: 'retest-call-1' }])
  assert.deepEqual(sentWith(sent, 'Accessibility.queryAXTree'), [{ objectId: 'document', role: 'button' }])
  assert.deepEqual(sentWith(sent, 'DOM.resolveNode'), [{ backendNodeId: 11, executionContextId: 7, objectGroup: 'retest-call-1' }])
})

test('leaves out nodes Chrome marks as ignored, and nodes with no element', async () => {
  const { session } = page({
    button: [
      { ignored: true, name: 'Delete', backendDOMNodeId: 1 },
      { ignored: false, name: 'Delete' },
      { ignored: false, name: 'Delete', backendDOMNodeId: 3 },
    ],
  })
  assert.deepEqual(await find(session, { roles: ['button'], name: 'Delete', exact: true }), [{ objectId: 'element-3' }])
})

test('matches names by the locator rules, and a node without a name has an empty one', async () => {
  const buttons = [
    { ignored: false, name: ' Save  draft ', backendDOMNodeId: 1 },
    { ignored: false, name: 'save', backendDOMNodeId: 2 },
    { ignored: false, backendDOMNodeId: 3 },
  ]
  const { session } = page({ button: buttons })
  assert.deepEqual(await find(session, { roles: ['button'], name: 'Save draft', exact: true }), [{ objectId: 'element-1' }])
  assert.deepEqual(await find(session, { roles: ['button'], name: 'SAVE', exact: false }), [{ objectId: 'element-1' }, { objectId: 'element-2' }])
  assert.deepEqual(await find(session, { roles: ['button'], name: '', exact: true }), [{ objectId: 'element-3' }])
  assert.equal((await find(session, { roles: ['button'], exact: true })).length, 3)
})

test('asks for every role at once and keeps each element once', async () => {
  const { session, sent } = page({
    textbox: [{ ignored: false, name: 'Email', backendDOMNodeId: 1 }],
    combobox: [{ ignored: false, name: 'Email', backendDOMNodeId: 2 }, { ignored: false, name: 'Email', backendDOMNodeId: 1 }],
  })
  const found = await find(session, { roles: labelledRoles, name: 'Email', exact: true })
  assert.deepEqual(found, [{ objectId: 'element-1' }, { objectId: 'element-2' }])
  assert.deepEqual(
    sentWith(sent, 'Accessibility.queryAXTree').map((params) => field(params, 'role')),
    ['textbox', 'searchbox', 'combobox', 'listbox', 'checkbox', 'radio', 'switch', 'slider', 'spinbutton'],
  )
})

test('skips a node that went away or belongs to another document, and one that resolves to nothing', async () => {
  const gone = ['No node with given id found', 'Node with given id does not belong to the document']
  const { session } = page(
    { link: [1, 2, 3, 4].map((id) => ({ ignored: false, name: 'Docs', backendDOMNodeId: id })) },
    (id) => {
      const message = gone[id - 1]
      if (message !== undefined) return Promise.reject(protocolError('DOM.resolveNode', message))
      return Promise.resolve({ object: id === 3 ? { type: 'object', subtype: 'null', value: null } : { objectId: `element-${id}` } })
    },
  )
  assert.deepEqual(await find(session, { roles: ['link'], exact: true }), [{ objectId: 'element-4' }])
})

test('any other failure to resolve a node is thrown', async () => {
  const { session } = page({ link: [{ ignored: false, backendDOMNodeId: 1 }] }, () =>
    Promise.reject(protocolError('DOM.resolveNode', 'Cannot find context with specified id')),
  )
  await assert.rejects(find(session, { roles: ['link'], exact: true }), /Cannot find context with specified id/)
})

test('resolves many matches in batches, so the page never has more than a batch waiting', async () => {
  let waiting = 0
  let most = 0
  const { session } = page({ listitem: Array.from({ length: 250 }, (_, id) => ({ ignored: false, backendDOMNodeId: id })) }, async (id) => {
    waiting += 1
    most = Math.max(most, waiting)
    await new Promise((resolve) => setImmediate(resolve))
    waiting -= 1
    return { object: { objectId: `element-${id}` } }
  })
  const found = await find(session, { roles: ['listitem'], exact: true })
  assert.equal(found.length, 250)
  assert.deepEqual(found.at(-1), { objectId: 'element-249' })
  assert.equal(most, 100)
})

test('roles Chrome names its own way are asked for by its names', () => {
  assert.deepEqual(chromeRolesFor('img'), ['image'])
  assert.deepEqual(chromeRolesFor('math'), ['math', 'MathMLMath'])
  assert.deepEqual(chromeRolesFor('button'), ['button'])
})
