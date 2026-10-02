import { notYet } from './not-yet.ts'

/**
 * Playwright's `defineConfig`: the config as written. Retest does not read `playwright.config.ts` yet; the run
 * takes its browser and base URL from the command line.
 *
 * @example export default defineConfig({ testDir: './tests' })
 */
export function defineConfig<Config extends object>(config: Config): Config {
  return config
}

/** Playwright's device list. Retest names its own devices in its config, so reading one here fails by name. */
export const devices: Readonly<Record<string, never>> = new Proxy(
  {},
  {
    get(_object, property) {
      if (typeof property === 'symbol') return undefined
      throw notYet(`devices[${JSON.stringify(property)}]`)
    },
  },
)
