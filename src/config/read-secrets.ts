import type { Path } from '../protocol/schema.ts'
import type { LoadedSecret, LoadedSecretSource } from './loaded.ts'
import type { Problems } from './problems.ts'
import type { SecretContext } from './types.ts'
import { describeChoices, describeValue, isPlainObject, s } from '../protocol/schema.ts'
import { readOrigin } from '../protocol/url.ts'

/** The origin of a base URL in the config, and the key of the app that has it, as messages name it. */
export type BaseUrlHost = { readonly app: string; readonly origin: string }

/**
 * How `secretOrigins` reads an entry that is not an origin. With `bundles`, as in a config with a native app, a
 * dotted name is a bundle id unless it is surely a host; `hosts` maps the hosts of the config's base URLs.
 */
export type SecretDestinations = { readonly bundles: boolean; readonly hosts: ReadonlyMap<string, BaseUrlHost> }

const envName = /^[A-Za-z_][A-Za-z0-9_]*$/
const envSecretSchema = s.object({ env: s.string() })
const secretOriginsSchema = s.record(s.array(s.string()))
const bundleShape = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/
const ipAddress = /^\d{1,3}(?:\.\d{1,3}){3}$/
const webOnly: SecretDestinations = { bundles: false, hosts: new Map() }

/** Reads `secrets` and `secretOrigins` together, since each origin list belongs to a declared secret. */
export function readSecrets(secrets: unknown, secretOrigins: unknown, problems: Problems, destinations: SecretDestinations = webOnly): Map<string, LoadedSecret> {
  const loaded = new Map<string, LoadedSecret>()
  if (secrets !== undefined && !isPlainObject(secrets)) problems.add(['secrets'], `expected object, received ${kindOf(secrets)}`)
  const declared = isPlainObject(secrets) ? secrets : {}
  const origins = readSecretOrigins(secretOrigins, { secrets: Object.keys(declared), destinations }, problems)
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

type OriginsContext = { readonly secrets: readonly string[]; readonly destinations: SecretDestinations }

// Each entry is checked at its own index. A secret's web origins come first and its bundle ids after them.
function readSecretOrigins(value: unknown, { secrets, destinations }: OriginsContext, problems: Problems): Map<string, string[]> {
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
    const web: string[] = []
    const bundles: string[] = []
    for (const [index, text] of list.entries()) {
      const origin = readOrigin(text)
      if (origin !== undefined) web.push(origin)
      else if (destinations.bundles && bundleShape.test(text)) bundles.push(...checkBundle(text, [...path, index], destinations.hosts, problems))
      else problems.add([...path, index], `expected an origin such as https://example.com, received ${describeValue(text)}`)
    }
    origins.set(name, [...web, ...bundles])
  }
  return origins
}

// A native app's destination is its bundle id, which has dots and no scheme, as a host name has: nothing in the letters
// tells `com.example.tasks` from `auth.example.com`, and an installed app's id is read only once a run opens it. So a
// dotted name is kept as a bundle id, which a native app takes only when its installed id is exactly that, and which a
// web page never takes. Two kinds of name are surely hosts, and are refused as origins written without their scheme:
// the host of one of the config's base URLs, and an IP address, four numbers, which no developer's domain reverses to.
function checkBundle(text: string, path: Path, hosts: ReadonlyMap<string, BaseUrlHost>, problems: Problems): string[] {
  const host = hosts.get(text.toLowerCase())
  const received = describeValue(text)
  const problem =
    host !== undefined ? `expected an origin such as ${host.origin}, received ${received}, the host of the base URL of ${host.app} rather than a bundle id`
    : ipAddress.test(text) ? `expected an origin such as http://${text}, received ${received}, an IP address rather than a bundle id`
    : undefined
  if (problem === undefined) return [text]
  problems.add(path, problem)
  return []
}
