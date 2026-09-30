import type { Failure } from './failures.ts'
import { s, type Schema } from './schema.ts'

/** Budgets in milliseconds. */
export type Timeouts = {
  collection: number
  setup: number
  action: number
  navigation: number
  assertion: number
  test: number
  cleanup: number
}

export type ParsedTimeouts = { ok: true; value: Partial<Timeouts> } | { ok: false; failure: Failure }

// Timers fire at once for delays above 2^31 - 1 milliseconds.
export const maxTimeout = 2_147_483_647

const milliseconds = s.number({ integer: true, min: 1 })
const budget = s.optional(milliseconds)

export const timeoutsSchema: Schema<Timeouts> = s.object({
  collection: milliseconds,
  setup: milliseconds,
  action: milliseconds,
  navigation: milliseconds,
  assertion: milliseconds,
  test: milliseconds,
  cleanup: milliseconds,
})

/** Some of the budgets, as a config or the command line gives them. */
export const partialTimeoutsSchema: Schema<Partial<Timeouts>> = s.object({
  collection: budget,
  setup: budget,
  action: budget,
  navigation: budget,
  assertion: budget,
  test: budget,
  cleanup: budget,
})

export const defaultTimeouts: Readonly<Timeouts> = Object.freeze({
  collection: 10_000,
  setup: 60_000,
  action: 10_000,
  navigation: 30_000,
  assertion: 5_000,
  test: 60_000,
  cleanup: 10_000,
})

/** Every budget's name, in the defaults' order. */
export const timeoutNames: readonly (keyof Timeouts)[] = Object.keys(defaultTimeouts).filter(isTimeoutName)

/**
 * Lays partial budgets over full ones, later ones winning: the defaults, then the config's, then the command
 * line's. Only budgets present with a value count; any other key is ignored.
 *
 * @example mergeTimeouts(defaultTimeouts, config.timeouts, { action: 500 }).action // 500
 */
export function mergeTimeouts(base: Readonly<Timeouts>, ...overrides: readonly Readonly<Partial<Timeouts>>[]): Timeouts {
  const merged = { ...base }
  for (const override of overrides) {
    for (const name of timeoutNames) {
      const value = override[name]
      if (value !== undefined) merged[name] = value
    }
  }
  return merged
}

/**
 * Reads `name=milliseconds` pairs separated by commas, as the command line takes them.
 *
 * @example parseTimeouts('action=500,test=3000') // { ok: true, value: { action: 500, test: 3000 } }
 */
export function parseTimeouts(text: string): ParsedTimeouts {
  const value: Partial<Timeouts> = {}
  for (const entry of text.split(',')) {
    const [name = '', amount, extra] = entry.split('=').map((part) => part.trim())
    if (amount === undefined || extra !== undefined) {
      return usage(`Write each timeout as name=milliseconds, received ${JSON.stringify(entry)}.`)
    }
    if (!isTimeoutName(name)) {
      return usage(`Unknown timeout ${JSON.stringify(name)}. Use one of ${timeoutNames.join(', ')}.`)
    }
    if (Object.hasOwn(value, name)) return usage(`The ${name} timeout is given twice.`)
    const duration = parseMilliseconds(amount)
    if (duration === undefined) {
      return usage(
        `The ${name} timeout must be a whole number of milliseconds from 1 to ${maxTimeout}, received ${JSON.stringify(amount)}.`,
      )
    }
    value[name] = duration
  }
  return { ok: true, value }
}

/**
 * Timeouts as the command line takes them: `name=milliseconds` pairs joined with commas, in the defaults' order.
 *
 * @example formatTimeouts({ test: 3000, action: 500 }) // 'action=500,test=3000'
 */
export function formatTimeouts(timeouts: Partial<Timeouts>): string {
  return timeoutNames.flatMap((name) => (timeouts[name] === undefined ? [] : [`${name}=${timeouts[name]}`])).join(',')
}

function isTimeoutName(name: string): name is keyof Timeouts {
  return Object.hasOwn(defaultTimeouts, name)
}

function parseMilliseconds(text: string): number | undefined {
  if (!/^\d+$/.test(text)) return undefined
  const value = Number(text)
  return value >= 1 && value <= maxTimeout ? value : undefined
}

function usage(message: string): ParsedTimeouts {
  return { ok: false, failure: { class: 'usage', message } }
}
