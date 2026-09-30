import type { SecretName } from '../config/register.ts'
import { inspect } from 'node:util'
import { secretPlaceholder } from '../protocol/secret.ts'
import { formatValue } from './format-value.ts'
import { misuse } from './misuse.ts'

/**
 * A secret from the config, named but never held: the process that runs Retest types its value. However it
 * is printed, it reads `{{name}}`.
 */
export class Secret {
  readonly #name: string

  static {
    // Node's inspect hook sits on the prototype, off the declared type, so the public type needs no Node types.
    Object.defineProperty(Secret.prototype, inspect.custom, {
      value(this: Secret): string {
        return this.toString()
      },
    })
  }

  constructor(name: string) {
    this.#name = name
  }

  /** The secret's name in the config. */
  get name(): string {
    return this.#name
  }

  toString(): string {
    return secretPlaceholder(this.#name)
  }

  toJSON(): string {
    return this.toString()
  }
}

/**
 * Names a secret from the config, for `fill`. The test's process never sees the value.
 *
 * @example await page.getByLabel('Password').fill(secret('password'))
 */
export function secret(name: SecretName): Secret {
  // Read as JavaScript passed it: a registered config narrows the type, not what arrives.
  const given: unknown = name
  if (typeof given !== 'string' || given === '') throw misuse(`secret() takes the name of a secret from the config, received ${formatValue(given)}.`)
  return new Secret(given)
}
