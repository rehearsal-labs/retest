import { listWords } from '../shared/list-words.ts'
import { UsageError } from './errors.ts'
import { suggest } from './suggest.ts'

export type FlagOption = { kind: 'flag'; description: string }
export type ValueOption = { kind: 'value'; placeholder: string; description: string; choices?: readonly string[] }
/** An option that may be given several times, each with its own value. */
export type ListOption = { kind: 'list'; placeholder: string; description: string }
export type OptionSpec = FlagOption | ValueOption | ListOption
export type OptionSpecs = Readonly<Record<string, OptionSpec>>

type NamesOfKind<O extends OptionSpecs, Kind> = { [K in keyof O]: O[K] extends { kind: Kind } ? K : never }[keyof O] &
  string

export type ParsedArguments<O extends OptionSpecs> = {
  positionals: string[]
  value(name: NamesOfKind<O, 'value'>): string | undefined
  list(name: NamesOfKind<O, 'list'>): string[]
  flag(name: NamesOfKind<O, 'flag'>): boolean
}

/** @example flag('Print one JSON document') */
export function flag(description: string): FlagOption {
  return { kind: 'flag', description }
}

/** @example value({ placeholder: '<path>', description: 'Chromium executable' }) */
export function value(option: Omit<ValueOption, 'kind'>): ValueOption {
  return { kind: 'value', ...option }
}

/** @example list({ placeholder: '<app=name>', description: 'Run only this target of the app' }) */
export function list(option: Omit<ListOption, 'kind'>): ListOption {
  return { kind: 'list', ...option }
}

/**
 * Reads `--name value`, `--name=value` and `--flag` options and positional arguments. Anything unknown,
 * repeated (except a list option), missing its value or outside its choices throws a `UsageError`.
 *
 * @example parseArguments({ json: flag('JSON') }, ['a.retest.ts', '--json']).flag('json') // true
 */
export function parseArguments<O extends OptionSpecs>(specs: O, args: readonly string[]): ParsedArguments<O> {
  const values = new Map<string, string[] | true>()
  const positionals: string[] = []
  for (let index = 0; index < args.length; index++) {
    const argument = args[index] ?? ''
    if (!argument.startsWith('-') || argument === '-') {
      positionals.push(argument)
      continue
    }
    const [written = '', ...rest] = argument.split('=')
    const inline = rest.length === 0 ? undefined : rest.join('=')
    const name = written.slice(2)
    const spec = written.startsWith('--') && Object.hasOwn(specs, name) ? specs[name] : undefined
    if (spec === undefined) throw unknownOption(written, specs)
    const earlier = values.get(name)
    if (earlier !== undefined && spec.kind !== 'list') throw new UsageError(`${written} is given twice.`)
    if (spec.kind === 'flag') {
      if (inline !== undefined) throw new UsageError(`${written} takes no value.`)
      values.set(name, true)
      continue
    }
    const next = args[index + 1]
    const text = inline ?? (next === undefined || next.startsWith('-') ? undefined : next)
    if (inline === undefined && text !== undefined) index++
    if (text === undefined || text === '') {
      throw new UsageError(`${written} needs a value: ${written} ${spec.placeholder}.`)
    }
    if (spec.kind === 'value') checkChoice(written, spec, text)
    values.set(name, [...(Array.isArray(earlier) ? earlier : []), text])
  }
  const texts = (name: string): string[] => {
    const found = values.get(name)
    return Array.isArray(found) ? found : []
  }
  return {
    positionals,
    value: (name) => texts(name)[0],
    list: (name) => texts(name),
    flag: (name) => values.get(name) === true,
  }
}

function unknownOption(written: string, specs: OptionSpecs): UsageError {
  const guess = suggest(written.replace(/^-+/, ''), [...Object.keys(specs), 'help'])
  return new UsageError(`Unknown option ${written}.${guess === undefined ? '' : ` Did you mean --${guess}?`}`)
}

function checkChoice(written: string, spec: ValueOption, text: string): void {
  if (spec.choices === undefined || spec.choices.includes(text)) return
  const guess = suggest(text, spec.choices)
  const hint = guess === undefined ? '' : ` Did you mean ${guess}?`
  throw new UsageError(`${written} must be ${listWords(spec.choices)}, received ${JSON.stringify(text)}.${hint}`)
}

