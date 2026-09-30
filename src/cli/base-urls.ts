import type { LoadedConfig } from '../config/loaded.ts'
import { isWebUrl } from '../protocol/url.ts'
import { checkApp, splitPair } from './app-pairs.ts'
import { UsageError } from './errors.ts'

/**
 * Reads `--base-url` without a config: one address for the one browser.
 *
 * @example singleBaseUrl(['http://127.0.0.1:4173']) // 'http://127.0.0.1:4173'
 */
export function singleBaseUrl(texts: readonly string[]): string | undefined {
  const [text, second] = texts
  if (second !== undefined) throw new UsageError('--base-url is given twice.')
  if (text === undefined) return undefined
  if (splitPair(text) !== undefined) {
    throw new UsageError('--base-url app=url needs a config. With --browser there is one app: give only the address.')
  }
  return checkUrl(text)
}

/**
 * Reads each `--base-url`, `url` for the default app or `app=url` for a named one, into the addresses that
 * replace the config's, by app. Undefined when none is given.
 *
 * @example configBaseUrls(['https://preview.example.com', 'admin=https://admin.example.com'], config)
 */
export function configBaseUrls(texts: readonly string[], config: LoadedConfig): Record<string, string> | undefined {
  if (texts.length === 0) return undefined
  const urls: Record<string, string> = {}
  for (const text of texts) {
    const pair = splitPair(text)
    const app = pair === undefined ? defaultApp(config) : checkApp('--base-url', pair.app, config).name
    if (Object.hasOwn(urls, app)) throw new UsageError(`--base-url names ${app} twice. Give one address for each app.`)
    urls[app] = checkUrl(pair?.value ?? text)
  }
  return urls
}

function defaultApp(config: LoadedConfig): string {
  if (config.defaultApp !== undefined) return config.defaultApp
  throw new UsageError(
    '--base-url needs an app name, since the config has several apps and no defaultApp, such as --base-url web=http://127.0.0.1:4173.',
  )
}

function checkUrl(text: string): string {
  if (isWebUrl(URL.parse(text))) return text
  throw new UsageError(
    `--base-url must be a full http or https address, such as http://127.0.0.1:4173, received ${JSON.stringify(text)}.`,
  )
}
