import { setSourceMapsSupport, stripTypeScriptTypes } from 'node:module'
import { errorCode } from '../shared/error-code.ts'

// The two errors Node's transformer throws for source it cannot turn into JavaScript.
const unreadable = new Set(['ERR_INVALID_TYPESCRIPT_SYNTAX', 'ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX'])
const transformerWarning = 'stripTypeScriptTypes is an experimental feature'
const decorator = /(?:^|[(,])[ \t]*@[A-Za-z_$][\w$.]*/m

/**
 * A project's TypeScript module as JavaScript, by Node's own transformer, in Retest's process and in each test file's.
 * Erasable syntax is only stripped, which keeps every position. A module with an enum, a namespace with values or a
 * parameter property is transformed with a source map, and source maps are turned on, so its stack traces name
 * TypeScript lines. Source the transformer cannot read is a SyntaxError that names the file and the line.
 *
 * @example transformTypeScript('enum Color { Red }', 'file:///work/color.ts', 'color.ts') // 'var Color = ...//# sourceMappingURL=...'
 */
export function transformTypeScript(source: string, url: string, shownPath: string): string {
  try {
    return quietly(() => stripTypeScriptTypes(source, { mode: 'strip', sourceUrl: url }))
  } catch (error) {
    if (errorCode(error) !== 'ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX') throw unreadableSource(error, shownPath)
  }
  setSourceMapsSupport(true)
  try {
    return quietly(() => stripTypeScriptTypes(source, { mode: 'transform', sourceMap: true, sourceUrl: url }))
  } catch (error) {
    throw unreadableSource(error, shownPath)
  }
}

/**
 * A hint for a TypeScript module that Node's transformer read but Node could not compile: the first line that starts a
 * decorator, which the transformer leaves in place and Node cannot run. It is found by a pattern on the source, not a
 * parse, so it says it may be the cause. Undefined when the source has no such line.
 *
 * @example decoratorHint('class A {\n  @logged\n  run() {}\n}', 'a.ts') // 'a.ts:2 has a decorator, which may be the cause: ...'
 */
export function decoratorHint(source: string, shownPath: string): string | undefined {
  const found = decorator.exec(source)
  if (found === null) return undefined
  const line = source.slice(0, found.index + found[0].indexOf('@')).split('\n').length
  return `${shownPath}:${line} has a decorator, which may be the cause: Node cannot run decorators, and Retest does not transform them.`
}

// Node warns once per process that stripTypeScriptTypes is experimental. That warning is about the transformer Retest
// chose, not about the project, so it alone is held back; every other warning passes through as it would.
function quietly<T>(call: () => T): T {
  const { emitWarning } = process
  process.emitWarning = (warning: string | Error, ...rest: unknown[]): void => {
    if (String(warning).startsWith(transformerWarning)) return
    Reflect.apply(emitWarning, process, [warning, ...rest])
  }
  try {
    return call()
  } finally {
    process.emitWarning = emitWarning
  }
}

// The transformer's error names the line in the first line of its stack, after the source URL it was given.
function unreadableSource(error: unknown, shownPath: string): Error {
  if (!(error instanceof Error) || !unreadable.has(errorCode(error) ?? '')) return error instanceof Error ? error : new Error(String(error))
  const line = /:(\d+)$/.exec(error.stack?.split('\n', 1)[0] ?? '')?.[1]
  const where = line === undefined ? shownPath : `${shownPath}:${line}`
  return new SyntaxError(`Node's TypeScript transformer cannot read ${where}: ${error.message.replace(/\.$/, '')}.`)
}
