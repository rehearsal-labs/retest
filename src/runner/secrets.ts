import type { ResolvedFill } from '../browser/contract.ts'
import type { LoadedConfig, LoadedSecret } from '../config/loaded.ts'
import type { Failure } from '../protocol/failures.ts'
import type { LocatorRecipe } from '../protocol/locator.ts'
import type { ResolvedSecret } from './contract.ts'
import type { Redactor } from './redactor.ts'
import { errorMessage, failure, failureSchema } from '../protocol/failures.ts'
import { parse } from '../protocol/schema.ts'
import { originOf } from '../protocol/url.ts'
import { bounded } from './bounded.ts'

export type ResolvedSecrets = { ok: true; secrets: Map<string, ResolvedSecret> } | { ok: false; failure: Failure }

/** A `fill` of a secret, as the test file's process sends it: the secret's name, never its value. */
export type SecretFill = { kind: 'fill'; locator: LocatorRecipe; value: { secret: string } }

export type FillContext = {
  /** The page's origin and path, as it stands now. */
  pageUrl: string | undefined
  /** The origins of the base URLs of the test's apps. */
  appOrigins: readonly string[]
  timeoutMs: number
  /** Aborted, with a `Failure` as its reason, when the fill is stopped, as when its test is. */
  signal: AbortSignal
}

export type FillResolution = { ok: true; command: ResolvedFill } | { ok: false; failure: Failure }

/** The shortest value a secret may have. A shorter one would turn up inside ordinary text, which then could not be read. */
const minSecretLength = 4

/**
 * Reads each of the config's `env` sources once, now, from `env`, and keeps each function source to call on
 * every use. A variable that is missing, empty or too short to redact safely is a setup failure that names every
 * such secret, before any test runs. No message ever quotes a value.
 *
 * @example resolveSecrets(config, process.env)
 */
export function resolveSecrets(config: LoadedConfig, env: Readonly<Record<string, string | undefined>>): ResolvedSecrets {
  const resolved = new Map<string, ResolvedSecret>()
  const missing: string[] = []
  const short: string[] = []
  for (const [name, { source }] of config.secrets) {
    if ('read' in source) {
      resolved.set(name, { read: source.read })
      continue
    }
    const value = Object.hasOwn(env, source.env) ? env[source.env] : undefined
    if (value === undefined || value === '') missing.push(`The secret ${JSON.stringify(name)} reads ${source.env}, which is ${value === undefined ? 'not set' : 'empty'}.`)
    else if (value.length < minSecretLength) short.push(tooShort(name, source.env))
    else resolved.set(name, { value })
  }
  if (missing.length === 0 && short.length === 0) return { ok: true, secrets: resolved }
  const hint = missing.length === 0 ? [] : [`Set ${missing.length === 1 ? 'it' : 'them'} in the environment that runs Retest.`]
  return { ok: false, failure: failure('setup_failed', [...missing, ...hint, ...short].join(' ')) }
}

/**
 * The problem with secret values given ready, as a service that resolves its own secrets gives them: any shorter
 * than `minSecretLength`, which could not be redacted safely. A setup failure before any test runs.
 */
export function secretValuesProblem(secrets: ReadonlyMap<string, ResolvedSecret>): Failure | undefined {
  const short = [...secrets].flatMap(([name, secret]) => ('value' in secret && secret.value.length < minSecretLength ? [tooShort(name)] : []))
  return short.length === 0 ? undefined : failure('setup_failed', short.join(' '))
}

/**
 * The environment variables `env` sources read. The test file's process never sees them.
 *
 * @example secretVariables(config.secrets) // ['TEST_PASSWORD']
 */
export function secretVariables(secrets: ReadonlyMap<string, LoadedSecret>): string[] {
  return [...secrets.values()].flatMap(({ source }) => ('env' in source ? [source.env] : []))
}

/**
 * Turns a secret fill into the text the page types. The page's origin is checked first, so a secret is never
 * read, let alone typed, for a page it does not belong to: the origins of the test's apps' base URLs, and the
 * ones `secretOrigins` lists for it. The page checks its origin again as it types, since a page can move after
 * its last navigation was seen, so the fill carries the same origins. Every value read is taught to the
 * redactor before it goes anywhere.
 */
export class SecretFiller {
  readonly #secrets: ReadonlyMap<string, ResolvedSecret>
  readonly #declared: ReadonlyMap<string, LoadedSecret>
  readonly #redactor: Redactor

  constructor(secrets: ReadonlyMap<string, ResolvedSecret>, declared: ReadonlyMap<string, LoadedSecret>, redactor: Redactor) {
    this.#secrets = secrets
    this.#declared = declared
    this.#redactor = redactor
    for (const [name, secret] of secrets) if ('value' in secret && secret.value.length >= minSecretLength) redactor.learn(name, secret.value)
  }

  async resolve(command: SecretFill, context: FillContext): Promise<FillResolution> {
    const name = command.value.secret
    const secret = this.#secrets.get(name)
    if (secret === undefined) return refused('usage', `secret(${JSON.stringify(name)}) is not one of the config's secrets.`)
    const allowedOrigins = [...new Set([...context.appOrigins, ...(this.#declared.get(name)?.origins ?? [])])]
    const origin = originOf(context.pageUrl)
    if (origin === undefined || !allowedOrigins.includes(origin)) return refused('not_actionable', wrongOrigin(name, origin, allowedOrigins), { origin: origin ?? null })
    const value = await this.#read(name, secret, context)
    if (typeof value !== 'string') return { ok: false, failure: value }
    return { ok: true, command: { kind: 'fill', locator: command.locator, value, secret: name, allowedOrigins } }
  }

  // A function source is told, through its signal, when Retest stops waiting for its value: the fill's time ran
  // out, or the fill was stopped.
  async #read(name: string, secret: ResolvedSecret, { timeoutMs, signal }: FillContext): Promise<string | Failure> {
    if ('value' in secret) return secret.value.length < minSecretLength ? failure('setup_failed', tooShort(name)) : secret.value
    const waiting = new AbortController()
    const stopped = Promise.withResolvers<void>()
    const stop = (): void => stopped.resolve()
    signal.addEventListener('abort', stop, { once: true })
    if (signal.aborted) stop()
    const read = await bounded(new Promise<string>((resolve) => resolve(secret.read({ signal: waiting.signal }))), timeoutMs, stopped.promise)
    signal.removeEventListener('abort', stop)
    if (read.status === 'stopped') {
      waiting.abort(new DOMException(`Retest stopped reading the secret ${JSON.stringify(name)}: its fill was stopped.`, 'AbortError'))
      return stoppedFill(name, signal.reason)
    }
    if (read.status === 'timed_out') {
      waiting.abort(new DOMException(`Retest stopped reading the secret ${JSON.stringify(name)}: it took longer than ${timeoutMs} ms.`, 'TimeoutError'))
    }
    if (read.status === 'done' && typeof read.value === 'string' && read.value.length >= minSecretLength) {
      this.#redactor.learn(name, read.value)
      return read.value
    }
    if (read.status === 'done' && typeof read.value === 'string' && read.value !== '') return failure('setup_failed', tooShort(name))
    const problem = read.status === 'failed' ? errorMessage(read.error) : read.status === 'done' ? 'it gave no text' : `it took longer than ${timeoutMs} ms`
    return failure('setup_failed', `Retest could not read the secret ${JSON.stringify(name)}: ${this.#redactor.redact(problem)}`)
  }
}

// A fill stopped while its secret was read ends as the reason it was stopped says, and types nothing.
function stoppedFill(name: string, reason: unknown): Failure {
  const parsed = parse(failureSchema, reason)
  const cause = parsed.ok ? parsed.value : failure('interrupted', 'The fill was stopped.')
  const message = `${cause.message} Retest stopped reading the secret ${JSON.stringify(name)}, and typed nothing.`
  return { class: cause.class, message, details: { ...cause.details, inputSent: false } }
}

function tooShort(name: string, variable?: string): string {
  const from = variable === undefined ? '' : `, read from ${variable},`
  return `The secret ${JSON.stringify(name)}${from} is shorter than ${minSecretLength} characters, too short to redact safely. Use a longer value.`
}

function refused(kind: Failure['class'], message: string, details?: Failure['details']): FillResolution {
  return { ok: false, failure: { ...failure(kind, message), ...(details === undefined ? {} : { details }) } }
}

function wrongOrigin(name: string, origin: string | undefined, allowed: readonly string[]): string {
  const where = origin === undefined ? 'the page has not opened a web address yet' : `the page is on ${origin}`
  const permitted = allowed.length === 0 ? 'no origin, since no app it uses has a base URL' : allowed.join(', ')
  return `Retest did not type the secret ${JSON.stringify(name)}: ${where}, and it may be typed only on ${permitted}. Add the origin to secretOrigins if it belongs there.`
}
