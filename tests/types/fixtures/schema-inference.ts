import { parse, s, type Infer } from '../../../src/protocol/schema.ts'

const task = s.object({
  title: s.string(),
  done: s.boolean(),
  note: s.optional(s.string()),
  tags: s.array(s.enum(['home', 'work'])),
  due: s.nullable(s.number()),
})
type Task = Infer<typeof task>

export const complete: Task = { title: 'Release checklist', done: false, tags: ['work'], due: null }
export const withNote: Task = { title: 'Release checklist', done: true, note: 'Friday', tags: [], due: 3 }
export const wrongType: Task = { title: 1, done: false, tags: [], due: null } // type-error TS2322 Type 'number' is not assignable to type 'string'
export const unknownKey: Task = { title: 'Release checklist', done: false, tags: [], due: null, owner: 'Ana' } // type-error TS2353 'owner' does not exist in type
export const undefinedNote: Task = { title: 'Release checklist', done: false, note: undefined, tags: [], due: null } // type-error TS2375 Types of property 'note' are incompatible
export const missingDone: Task = { title: 'Release checklist', tags: [], due: null } // type-error TS2741 Property 'done' is missing
export const unknownTag: Task = { title: 'Release checklist', done: false, tags: ['garden'], due: null } // type-error TS2322 Type '"garden"' is not assignable

const event = s.discriminatedUnion('type', [
  s.object({ type: s.literal('saved'), id: s.number() }),
  s.object({ type: s.literal('failed'), reason: s.string() }),
])

export function read(input: unknown): string {
  const result = parse(event, input)
  if (!result.ok) return result.issues.map((issue) => `${issue.path}: ${issue.message}`).join('\n')
  if (result.value.type === 'saved') return String(result.value.id)
  return result.value.id // type-error TS2339 Property 'id' does not exist on type
}

export const optionalAlone = parse(s.optional(s.string()), 'text') // type-error TS2345 Argument of type 'OptionalSchema<string>'
export const optionalItem = s.array(s.optional(s.string())) // type-error TS2345 Argument of type 'OptionalSchema<string>'
export const looseKey = s.discriminatedUnion('type', [s.object({ type: s.string() })]) // type-error TS2322 not assignable to type 'Discriminated<
