import type { WorldArgument, WorldScope } from './isolated-world.ts'
import type { AriaRole } from '../protocol/aria-role.ts'
import type { Deadline } from '../protocol/deadline.ts'
import { s } from '../protocol/schema.ts'
import { CdpProtocolError } from './cdp/errors.ts'
import { request, sendOptions } from './cdp-results.ts'
import { matchesText } from './text-match.ts'

/** Which elements to ask Chrome's accessibility tree for: any of `roles`, with an accessible name that matches, if given. */
export type RoleQuery = { roles: readonly string[]; name?: string; exact: boolean }

/** The roles of the form controls a label names. */
export const labelledRoles: readonly AriaRole[] = [
  'textbox',
  'searchbox',
  'combobox',
  'listbox',
  'checkbox',
  'radio',
  'switch',
  'slider',
  'spinbutton',
]

// Chrome's tree names these roles its own way; every other role keeps its WAI-ARIA name.
const chromeRoles: Partial<Record<AriaRole, readonly string[]>> = {
  img: ['image'],
  math: ['math', 'MathMLMath'],
}

// A node that went away since the tree was read, or that belongs to another document, such as a frame's.
const goneNodeMessages = new Set(['No node with given id found', 'Node with given id does not belong to the document'])

// Resolving waits on the page, so a query with many matches sends its requests in batches.
const resolveBatch = 100

const documentSchema = s.object({ result: s.object({ objectId: s.string() }) })
const nameSchema = s.optional(s.object({ value: s.optional(s.string()) }))
const treeSchema = s.object({
  nodes: s.array(s.object({ ignored: s.boolean(), name: nameSchema, backendDOMNodeId: s.optional(s.number({ integer: true })) })),
})
const resolvedSchema = s.object({ object: s.object({ objectId: s.optional(s.string()) }) })

/**
 * The names to ask Chrome's tree for a WAI-ARIA role by.
 *
 * @example chromeRolesFor('img') // ['image']
 */
export function chromeRolesFor(role: AriaRole): readonly string[] {
  return chromeRoles[role] ?? [role]
}

/**
 * Asks Chrome's accessibility tree of the scope's document for the elements a query names, and makes each one an
 * object in the scope's world. Chrome computes every role and name. Nodes it marks as ignored are left out, such
 * as elements under `aria-hidden="true"`; elements that are not rendered or are inert are not in its tree at all.
 */
export async function elementsByRole(scope: WorldScope, query: RoleQuery, deadline: Deadline): Promise<WorldArgument[]> {
  const { session, context, objectGroup } = scope
  const evaluate = { expression: 'document', contextId: context, objectGroup }
  const document = await request(session, 'Runtime.evaluate', evaluate, documentSchema, sendOptions(deadline))
  const trees = await Promise.all(
    query.roles.map((role) => {
      const params = { objectId: document.result.objectId, role }
      return request(session, 'Accessibility.queryAXTree', params, treeSchema, sendOptions(deadline))
    }),
  )
  const found = new Set<number>()
  for (const node of trees.flatMap((tree) => tree.nodes)) {
    if (node.ignored || node.backendDOMNodeId === undefined) continue
    if (query.name === undefined || matchesText(node.name?.value ?? '', query.name, query.exact)) found.add(node.backendDOMNodeId)
  }
  const ids = [...found]
  const elements: WorldArgument[] = []
  for (let start = 0; start < ids.length; start += resolveBatch) {
    const objectIds = await Promise.all(ids.slice(start, start + resolveBatch).map((id) => resolve(scope, id, deadline)))
    elements.push(...objectIds.flatMap((objectId) => (objectId === undefined ? [] : [{ objectId }])))
  }
  return elements
}

async function resolve({ session, context, objectGroup }: WorldScope, backendNodeId: number, deadline: Deadline): Promise<string | undefined> {
  const params = { backendNodeId, executionContextId: context, objectGroup }
  try {
    const { object } = await request(session, 'DOM.resolveNode', params, resolvedSchema, sendOptions(deadline))
    return object.objectId
  } catch (error) {
    if (error instanceof CdpProtocolError && goneNodeMessages.has(error.protocolMessage)) return undefined
    throw error
  }
}
