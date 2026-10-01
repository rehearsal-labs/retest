import type { Path } from '../protocol/schema.ts'
import type { LoadedSecret, LoadedSecretSource } from './loaded.ts'
import type { Problems } from './problems.ts'
import type { SecretContext } from './types.ts'
import { describeChoices, describeValue, isPlainObject, s } from '../protocol/schema.ts'
import { readOrigin } from '../protocol/url.ts'

const envName = /^[A-Za-z_][A-Za-z0-9_]*$/
const envSecretSchema = s.object({ env: s.string() })
const secretOriginsSchema = s.record(s.array(s.string()))

/** Reads `secrets` and `secretOrigins` together, since each origin list belongs to a declared secret. */
export function readSecrets(secrets: unknown, secretOrigins: unknown, problems: Problems): Map<string, LoadedSecret> {
  const loaded = new Map<string, LoadedSecret>()
  if (secrets !== undefined && !isPlainObject(secrets)) problems.add(['secrets'], `expected object, received ${kindOf(secrets)}`)
  const declared = isPlainObject(secrets) ? secrets : {}
  const origins = readSecretOrigins(secretOrigins, Object.keys(declared), problems)
  for (const [name, source] of Object.entries(declared)) {
    const path = ['secrets', name]
    if (!problems.checkName(path, name)) continue
    const read = readSource(name, source, path, problems)
    if (read !== undefined) loaded.set(name, { source: read, origins: origins.get(name) ?? [] })
  }
  return loaded
}

function readSource(name: string, source: unknown, path: Path, problems: Problems): LoadedSecretSource | undefined {
  if (typeof source === 'function') return { read: reader(name, source) }
  if (!isPlainObject(source)) {
    problems.add(path, `expected env("NAME") or a function that returns the secret, received ${kindOf(source)}`)
    return undefined
  }
  const parsed = problems.check(envSecretSchema, source, path)
  if (parsed === undefined) return undefined
  if (envName.test(parsed.env)) return { env: parsed.env }
  problems.add([...path, 'env'], `expected an environment variable name, received ${describeValue(parsed.env)}`)
  return undefined
}

// A value written where its source belongs may be the secret itself, so only its kind is named.
function kindOf(value: unknown): string {
  if (value === null) return 'null'
  return Array.isArray(value) ? 'array' : typeof value
}

// What a source gives back is checked here, once, and an error never shows it: it may be the secret itself.
function reader(name: string, source: Function): (context: SecretContext) => Promise<string> {
  return async (context) => {
    const value: unknown = await source(context)
    if (typeof value === 'string' && value !== '') return value
    const received = typeof value === 'string' ? 'an empty string' : kindOf(value)
    throw new TypeError(`The function for secret ${JSON.stringify(name)} returned ${received}, not the secret's text.`)
  }
}

function readSecretOrigins(value: unknown, secrets: readonly string[], problems: Problems): Map<string, string[]> {
  const origins = new Map<string, string[]>()
  if (value === undefined) return origins
  const parsed = problems.check(secretOriginsSchema, value, ['secretOrigins'])
  for (const [name, list] of Object.entries(parsed ?? {})) {
    const path = ['secretOrigins', name]
    if (!secrets.includes(name)) {
      const known = secrets.length === 0 ? 'the config declares no secrets' : `expected ${describeChoices(secrets)}`
      problems.add(path, `unknown secret, ${known}`)
      continue
    }
    origins.set(name, list.flatMap((text, index) => checkOrigin(text, [...path, index], problems)))
  }
  return origins
}

function checkOrigin(text: string, path: Path, problems: Problems): string[] {
  const origin = readOrigin(text)
  if (origin !== undefined) return [origin]
  problems.add(path, `expected an origin such as https://example.com, received ${describeValue(text)}`)
  return []
}
