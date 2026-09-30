import type { BrowserName } from '../../config/types.ts'
import type { Prompt } from '../prompt.ts'
import type { InitAnswers } from './templates.ts'
import { browserNames } from '../../config/types.ts'
import { isWebUrl } from '../../protocol/url.ts'
import { listWords } from '../../shared/list-words.ts'
import { splitPair } from '../app-pairs.ts'
import { UsageError } from '../errors.ts'
import { suggest } from '../suggest.ts'

/** An app and the address the tests open. */
export type AppAddress = { app: string; url: string }

/** The answers the command line gave. Each question has one. */
export type AnswerFlags = { app?: AppAddress; start?: string; browser?: BrowserName; yes: boolean }

/** What each question offers when nothing is typed. `browserPath` is where the default browser was found. */
export type AnswerDefaults = { url: string; start?: string; browser: BrowserName; browserPath?: string }

export type AnswerContext = { flags: AnswerFlags; defaults: AnswerDefaults; prompt: Prompt; interactive: boolean }

const defaultAppName = 'web'
const noStart = 'none'
const urlExample = 'http://localhost:3000'

/**
 * The answers, from the flags and then from questions. Questions are asked only when `interactive`; otherwise
 * `--app` or `--yes` must be given, and a question without a flag takes its default only with `--yes`. Undefined
 * when the person stops answering.
 *
 * @example await gatherAnswers({ flags, defaults, prompt, interactive: false })
 */
export async function gatherAnswers(context: AnswerContext): Promise<InitAnswers | undefined> {
  const { flags, defaults } = context
  const given = flags.app
  if (!context.interactive) {
    if (given === undefined && !flags.yes) {
      throw new UsageError(
        `init asks questions only at a terminal. Pass --app web=${urlExample}, with --start and --browser if you need them, or --yes to take the defaults.`,
      )
    }
    const start = flags.start ?? (flags.yes ? defaults.start : undefined)
    return answers(given ?? { app: defaultAppName, url: defaults.url }, start, flags.browser ?? defaults.browser)
  }
  const app = given ?? (await askApp(context))
  if (app === undefined) return undefined
  const start = flags.start ?? (await askStart(context))
  if (start === undefined) return undefined
  const browser = flags.browser ?? (await askBrowser(context))
  if (browser === undefined) return undefined
  return answers(app, start === noStart ? undefined : start, browser)
}

/**
 * `--app name=url`, or an address alone for an app named web.
 *
 * @example readApp('admin=http://localhost:4000') // { app: 'admin', url: 'http://localhost:4000' }
 */
export function readApp(text: string): AppAddress {
  const app = appAddress(text)
  if (app !== undefined) return app
  throw new UsageError(`--app takes name=url with a full http or https address, such as web=${urlExample}, received ${JSON.stringify(text)}.`)
}

function appAddress(text: string): AppAddress | undefined {
  const pair = splitPair(text)
  const url = pair?.value ?? text
  return isWebUrl(URL.parse(url)) ? { app: pair?.app ?? defaultAppName, url } : undefined
}

function answers(app: AppAddress, start: string | undefined, browser: BrowserName): InitAnswers {
  return { ...app, ...(start === undefined ? {} : { start }), browser }
}

async function askApp(context: AnswerContext): Promise<AppAddress | undefined> {
  return ask(context, `What should the tests open? (${context.defaults.url})`, (answer) => {
    const app = appAddress(answer === '' ? context.defaults.url : answer)
    return app === undefined ? reject(`Write a full http or https address, such as ${urlExample}.`) : accept(app)
  })
}

async function askStart(context: AnswerContext): Promise<string | undefined> {
  const offered = context.defaults.start === undefined ? noStart : `${context.defaults.start}, or ${noStart}`
  return ask(context, `How do you start the app? (${offered})`, (answer) => accept(answer === '' ? (context.defaults.start ?? noStart) : answer))
}

async function askBrowser(context: AnswerContext): Promise<BrowserName | undefined> {
  const { browser, browserPath } = context.defaults
  const found = browserPath === undefined ? browser : `${browser}, found at ${browserPath}`
  return ask(context, `Which browser: ${listWords(browserNames)}? (${found})`, (answer) => {
    const name = answer === '' ? browser : answer.toLowerCase()
    const known = browserNames.find((candidate) => candidate === name)
    if (known !== undefined) return accept(known)
    const guess = suggest(name, browserNames)
    return reject(`Answer ${listWords(browserNames)}.${guess === undefined ? '' : ` Did you mean ${guess}?`}`)
  })
}

type Reading<T> = { ok: true; value: T } | { ok: false; problem: string }

function accept<T>(value: T): Reading<T> {
  return { ok: true, value }
}

function reject<T>(problem: string): Reading<T> {
  return { ok: false, problem }
}

// An answer that does not fit is explained, and the question is asked again.
async function ask<T>(context: AnswerContext, question: string, read: (answer: string) => Reading<T>): Promise<T | undefined> {
  let problem = ''
  for (;;) {
    const answer = await context.prompt.ask(`${problem}  ${question} › `)
    if (answer === undefined) return undefined
    const reading = read(answer.trim())
    if (reading.ok) return reading.value
    problem = `  ${reading.problem}\n`
  }
}
