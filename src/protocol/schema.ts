declare const output: unique symbol
declare const exact: unique symbol

type Literal = string | number | boolean | null
type Path = readonly (string | number)[]
// `variant` marks a literal that did not match: a sign the value belongs to another option.
type Found = { path: Path; message: string; variant: boolean }

// Flattening lets a type written as an intersection equal the single object the builder infers.
type Flat<T> = T extends object ? { [K in keyof T]: T[K] } : T

interface Typed<T> {
  readonly [output]?: T
  // Only an identical type satisfies this member, so optional keys cannot drift apart.
  readonly [exact]?: <X>() => X extends Flat<T> ? 1 : 2
}

interface StringNode {
  readonly kind: 'string'
}
interface NumberNode {
  readonly kind: 'number'
  readonly integer: boolean
  readonly min: number | undefined
}
interface BooleanNode {
  readonly kind: 'boolean'
}
interface LiteralNode {
  readonly kind: 'literal'
  readonly value: Literal
}
interface EnumNode {
  readonly kind: 'enum'
  readonly values: readonly string[]
}
interface ArrayNode {
  readonly kind: 'array'
  readonly item: SchemaNode
}
interface ObjectNode {
  readonly kind: 'object'
  readonly shape: Shape
}
interface OptionalNode {
  readonly kind: 'optional'
  readonly inner: SchemaNode
}
interface UnionNode {
  readonly kind: 'union'
  readonly options: readonly SchemaNode[]
}
interface DiscriminatedUnionNode {
  readonly kind: 'discriminated-union'
  readonly key: string
  readonly options: ReadonlyMap<unknown, ObjectNode>
}
interface RecordNode {
  readonly kind: 'record'
  readonly value: SchemaNode
}

type SchemaNode =
  | StringNode
  | NumberNode
  | BooleanNode
  | LiteralNode
  | EnumNode
  | ArrayNode
  | ObjectNode
  | UnionNode
  | DiscriminatedUnionNode
  | RecordNode
type Shape = { readonly [key: string]: SchemaNode | OptionalNode }

interface StringSchema extends StringNode, Typed<string> {}
interface NumberSchema extends NumberNode, Typed<number> {}
interface BooleanSchema extends BooleanNode, Typed<boolean> {}
interface LiteralSchema<V extends Literal> extends LiteralNode, Typed<V> {
  readonly value: V
}
interface EnumSchema<V extends string> extends EnumNode, Typed<V> {}
interface ArraySchema<T> extends ArrayNode, Typed<T[]> {}
interface ObjectSchema<S extends Shape> extends ObjectNode, Typed<ObjectOutput<S>> {
  readonly shape: S
}
interface OptionalSchema<T> extends OptionalNode, Typed<T> {}
interface UnionSchema<T> extends UnionNode, Typed<T> {}
interface DiscriminatedUnionSchema<T> extends DiscriminatedUnionNode, Typed<T> {}
interface RecordSchema<T> extends RecordNode, Typed<Record<string, T>> {}

type Discriminated<K extends string> = ObjectNode & { readonly shape: { readonly [P in K]: LiteralNode } }
type OptionalKeys<S extends Shape> = { [K in keyof S]: S[K] extends OptionalNode ? K : never }[keyof S]
type ObjectOutput<S extends Shape> = Flat<
  { -readonly [K in Exclude<keyof S, OptionalKeys<S>>]: Infer<S[K]> } & {
    -readonly [K in OptionalKeys<S>]?: Infer<S[K]>
  }
>

/**
 * A schema that accepts exactly `T`. Annotating a builder result with it fails to compile unless the
 * schema describes `T` key for key, including which keys are optional.
 *
 * @example const pointSchema: Schema<Point> = s.object({ x: s.number(), y: s.optional(s.number()) })
 */
export type Schema<T> = SchemaNode & {
  readonly [output]?: T
  // Written out, not `Typed<T>`: two references to one interface are compared by variance, which misses optional keys.
  readonly [exact]?: <X>() => X extends Flat<T> ? 1 : 2
}

/**
 * The type a schema accepts.
 *
 * @example type Point = Infer<typeof point>
 */
export type Infer<S> = S extends { readonly [output]?: infer T } ? T : never

export type Issue = { path: string; message: string }
export type ParseResult<T> = { ok: true; value: T } | { ok: false; issues: Issue[] }

export type JsonSchema = {
  $schema?: string
  type?: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object'
  const?: Literal
  enum?: string[]
  minimum?: number
  items?: JsonSchema
  properties?: Record<string, JsonSchema>
  required?: string[]
  additionalProperties?: false | JsonSchema
  anyOf?: JsonSchema[]
  oneOf?: JsonSchema[]
}

/**
 * Builds schemas that validate at run time and print as JSON Schema. Objects reject unknown keys.
 *
 * @example const pointSchema: Schema<Point> = s.object({ x: s.number(), y: s.optional(s.number()) })
 */
export const s = {
  string(): StringSchema {
    return { kind: 'string' }
  },
  number(options: { integer?: boolean; min?: number } = {}): NumberSchema {
    return { kind: 'number', integer: options.integer ?? false, min: options.min }
  },
  boolean(): BooleanSchema {
    return { kind: 'boolean' }
  },
  literal<const V extends Literal>(value: V): LiteralSchema<V> {
    return { kind: 'literal', value }
  },
  enum<const V extends readonly [string, ...string[]]>(values: V): EnumSchema<V[number]> {
    return { kind: 'enum', values }
  },
  array<T extends SchemaNode>(item: T): ArraySchema<Infer<T>> {
    return { kind: 'array', item }
  },
  object<S extends Shape>(shape: S): ObjectSchema<S> {
    return { kind: 'object', shape }
  },
  /** Marks an object key that may be absent. A present key must match; `undefined` does not. */
  optional<T extends SchemaNode>(inner: T): OptionalSchema<Infer<T>> {
    return { kind: 'optional', inner }
  },
  nullable<T extends SchemaNode>(inner: T): UnionSchema<Infer<T> | null> {
    return { kind: 'union', options: [inner, { kind: 'literal', value: null }] }
  },
  union<O extends readonly [SchemaNode, ...SchemaNode[]]>(options: O): UnionSchema<Infer<O[number]>> {
    return { kind: 'union', options }
  },
  /** Objects told apart by a literal at `key`. Throws when two options share a value. */
  discriminatedUnion<K extends string, O extends readonly [Discriminated<K>, ...Discriminated<K>[]]>(
    key: K,
    options: O,
  ): DiscriminatedUnionSchema<Infer<O[number]>> {
    return { kind: 'discriminated-union', key, options: indexOptions(key, options) }
  },
  /** An object with any keys, each holding a `value`. */
  record<T extends SchemaNode>(value: T): RecordSchema<Infer<T>> {
    return { kind: 'record', value }
  },
}

function indexOptions<K extends string>(key: K, options: readonly Discriminated<K>[]): Map<unknown, ObjectNode> {
  const index = new Map<unknown, ObjectNode>()
  for (const option of options) {
    const { value } = option.shape[key]
    if (index.has(value)) throw new TypeError(`Two options share ${key} ${JSON.stringify(value)}.`)
    index.set(value, option)
  }
  return index
}

/**
 * Checks a value against a schema. Returns the same value, typed, or every problem with its path.
 *
 * @example parse(pointSchema, JSON.parse(line))
 */
export function parse<S extends SchemaNode>(schema: S, value: unknown): ParseResult<Infer<S>> {
  const found: Found[] = []
  if (conforms(schema, value, found)) return { ok: true, value }
  return { ok: false, issues: found.map((issue) => ({ path: formatPath(issue.path), message: issue.message })) }
}

function conforms<S extends SchemaNode>(schema: S, value: unknown, found: Found[]): value is Infer<S> {
  check(schema, value, [], found)
  return found.length === 0
}

function check(node: SchemaNode, value: unknown, path: Path, found: Found[]): void {
  switch (node.kind) {
    case 'array':
      return checkArray(node, value, path, found)
    case 'object':
      return checkObject(node, value, path, found)
    case 'record':
      return checkRecord(node, value, path, found)
    case 'union':
      return checkUnion(node, value, path, found)
    case 'discriminated-union':
      return checkDiscriminated(node, value, path, found)
    default:
      if (!acceptsScalar(node, value)) found.push(mismatch(node, value, path))
  }
}

function acceptsScalar(node: StringNode | NumberNode | BooleanNode | LiteralNode | EnumNode, value: unknown): boolean {
  switch (node.kind) {
    case 'string':
      return typeof value === 'string'
    case 'boolean':
      return typeof value === 'boolean'
    case 'literal':
      return value === node.value
    case 'enum':
      return typeof value === 'string' && node.values.includes(value)
    case 'number':
      return (
        typeof value === 'number' &&
        Number.isFinite(value) &&
        (!node.integer || Number.isInteger(value)) &&
        (node.min === undefined || value >= node.min)
      )
  }
}

function checkArray(node: ArrayNode, value: unknown, path: Path, found: Found[]): void {
  if (!isArray(value)) {
    found.push(mismatch(node, value, path))
    return
  }
  for (const [index, item] of value.entries()) check(node.item, item, [...path, index], found)
}

function checkObject(node: ObjectNode, value: unknown, path: Path, found: Found[]): void {
  if (!isPlainObject(value)) {
    found.push(mismatch(node, value, path))
    return
  }
  for (const [key, field] of Object.entries(node.shape)) {
    const inner = field.kind === 'optional' ? field.inner : field
    if (Object.hasOwn(value, key)) check(inner, value[key], [...path, key], found)
    else if (field.kind !== 'optional') found.push(missing([...path, key]))
  }
  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(node.shape, key)) found.push(unknownKey([...path, key]))
  }
}

function checkRecord(node: RecordNode, value: unknown, path: Path, found: Found[]): void {
  if (!isPlainObject(value)) {
    found.push(mismatch(node, value, path))
    return
  }
  for (const [key, item] of Object.entries(value)) check(node.value, item, [...path, key], found)
}

function checkUnion(node: UnionNode, value: unknown, path: Path, found: Found[]): void {
  let closest: Found[] | undefined
  for (const option of node.options) {
    const attempt: Found[] = []
    check(option, value, path, attempt)
    if (attempt.length === 0) return
    if (closest === undefined || isCloser(attempt, closest)) closest = attempt
  }
  if (closest === undefined || depth(closest) === path.length) found.push(mismatch(node, value, path))
  else found.push(...closest)
}

// The option the value was meant to be got deepest before failing, then matched the most literals.
function isCloser(candidate: Found[], current: Found[]): boolean {
  const deeper = depth(candidate) - depth(current)
  if (deeper !== 0) return deeper > 0
  const variants = countVariants(candidate) - countVariants(current)
  if (variants !== 0) return variants < 0
  return candidate.length < current.length
}

function countVariants(found: Found[]): number {
  return found.filter((issue) => issue.variant).length
}

function depth(found: Found[]): number {
  return found.reduce((least, issue) => Math.min(least, issue.path.length), Number.POSITIVE_INFINITY)
}

function checkDiscriminated(node: DiscriminatedUnionNode, value: unknown, path: Path, found: Found[]): void {
  if (!isPlainObject(value)) {
    found.push(mismatch(node, value, path))
    return
  }
  const keyPath = [...path, node.key]
  if (!Object.hasOwn(value, node.key)) {
    found.push(missing(keyPath))
    return
  }
  const option = node.options.get(value[node.key])
  if (option === undefined) {
    const expected = describeChoices([...node.options.keys()])
    const message = `expected ${expected}, received ${describeValue(value[node.key])}`
    found.push({ path: keyPath, message, variant: true })
    return
  }
  checkObject(option, value, path, found)
}

function isArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function mismatch(node: SchemaNode, value: unknown, path: Path): Found {
  const message = `expected ${describe(node)}, received ${describeValue(value)}`
  return { path, message, variant: node.kind === 'literal' || node.kind === 'enum' }
}

function missing(path: Path): Found {
  return { path, message: 'missing required key', variant: false }
}

function unknownKey(path: Path): Found {
  return { path, message: 'unknown key', variant: false }
}

function describe(node: SchemaNode): string {
  switch (node.kind) {
    case 'string':
    case 'boolean':
    case 'array':
      return node.kind
    case 'number':
      return `${node.integer ? 'integer' : 'number'}${node.min === undefined ? '' : ` >= ${node.min}`}`
    case 'literal':
      return JSON.stringify(node.value)
    case 'enum':
      return describeChoices(node.values)
    case 'object':
    case 'record':
    case 'discriminated-union':
      return 'object'
    case 'union':
      return [...new Set(node.options.map(describe))].join(' or ')
  }
}

function describeChoices(values: readonly unknown[]): string {
  if (values.length === 1) return JSON.stringify(values[0])
  return `one of ${values.map((value) => JSON.stringify(value)).join(', ')}`
}

function describeValue(value: unknown): string {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (typeof value === 'string') return value.length <= 40 ? JSON.stringify(value) : 'string'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

const identifier = /^[A-Za-z_$][\w$]*$/

function formatPath(path: Path): string {
  let text = '$'
  for (const segment of path) {
    if (typeof segment === 'number') text += `[${segment}]`
    else text += identifier.test(segment) ? `.${segment}` : `[${JSON.stringify(segment)}]`
  }
  return text
}

/**
 * Writes a schema as a draft 2020-12 JSON Schema document.
 *
 * @example writeFile('point.schema.json', JSON.stringify(toJsonSchema(pointSchema)))
 */
export function toJsonSchema(schema: SchemaNode): JsonSchema {
  return { $schema: 'https://json-schema.org/draft/2020-12/schema', ...toJson(schema) }
}

function toJson(node: SchemaNode): JsonSchema {
  switch (node.kind) {
    case 'string':
    case 'boolean':
      return { type: node.kind }
    case 'number': {
      const type = node.integer ? 'integer' : 'number'
      return node.min === undefined ? { type } : { type, minimum: node.min }
    }
    case 'literal':
      return { const: node.value }
    case 'enum':
      return { type: 'string', enum: [...node.values] }
    case 'array':
      return { type: 'array', items: toJson(node.item) }
    case 'object':
      return objectToJson(node)
    case 'union':
      return { anyOf: node.options.map(toJson) }
    case 'discriminated-union':
      return { oneOf: [...node.options.values()].map(objectToJson) }
    case 'record':
      return { type: 'object', additionalProperties: toJson(node.value) }
  }
}

function objectToJson(node: ObjectNode): JsonSchema {
  const properties: Record<string, JsonSchema> = {}
  const required: string[] = []
  for (const [key, field] of Object.entries(node.shape)) {
    properties[key] = toJson(field.kind === 'optional' ? field.inner : field)
    if (field.kind !== 'optional') required.push(key)
  }
  const base: JsonSchema = { type: 'object', properties, additionalProperties: false }
  return required.length === 0 ? base : { ...base, required }
}
