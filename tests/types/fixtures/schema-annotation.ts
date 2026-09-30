import { s, type Schema } from '../../../src/protocol/schema.ts'

type Point = { x: number; y?: number }
type Shape = { kind: 'circle'; radius: number } | { kind: 'square'; side: number; label?: string }
type Labelled = { label: string }

export const point: Schema<Point> = s.object({ x: s.number(), y: s.optional(s.number()) })
export const reordered: Schema<Point> = s.object({ y: s.optional(s.number()), x: s.number() })
export const intersection: Schema<Labelled & Point> = s.object({ label: s.string(), x: s.number(), y: s.optional(s.number()) })

export const missingOptional: Schema<Point> = s.object({ x: s.number() }) // type-error TS2375 not assignable to type 'Schema<Point>'
export const requiredInstead: Schema<Point> = s.object({ x: s.number(), y: s.number() }) // type-error TS2375 not assignable to type 'Schema<Point>'
export const extraOptional: Schema<Point> = s.object({ x: s.number(), y: s.optional(s.number()), z: s.optional(s.number()) }) // type-error TS2375 not assignable to type 'Schema<Point>'
export const widerValue: Schema<{ kind: 'circle' }> = s.object({ kind: s.string() }) // type-error TS2375 not assignable to type 'Schema<
export const narrowerValue: Schema<{ kind: string }> = s.object({ kind: s.literal('circle') }) // type-error TS2375 not assignable to type 'Schema<
export const nested: Schema<{ at: Point }> = s.object({ at: s.object({ x: s.number() }) }) // type-error TS2375 not assignable to type 'Schema<

export const shape: Schema<Shape> = s.discriminatedUnion('kind', [
  s.object({ kind: s.literal('circle'), radius: s.number() }),
  s.object({ kind: s.literal('square'), side: s.number(), label: s.optional(s.string()) }),
])
export const memberMissingOptional: Schema<Shape> = s.discriminatedUnion('kind', [ // type-error TS2375 not assignable to type 'Schema<Shape>'
  s.object({ kind: s.literal('circle'), radius: s.number() }),
  s.object({ kind: s.literal('square'), side: s.number() }),
])
