import { readFileSync, statSync, type Stats } from 'node:fs'
import { errorMessage } from '../protocol/failures.ts'
import { isMissingFile } from '../shared/error-code.ts'
import { CliError } from './errors.ts'

/** The file's stats, or undefined when nothing is there. Any other problem is a `CliError`. */
export function statIfPresent(path: string): Stats | undefined {
  try {
    return statSync(path)
  } catch (error) {
    if (isMissingFile(error)) return undefined
    throw unreadable(path, error)
  }
}

/** The file's text, or undefined when nothing is there. Any other problem is a `CliError`. */
export function readTextIfPresent(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    if (isMissingFile(error)) return undefined
    throw unreadable(path, error)
  }
}

function unreadable(path: string, error: unknown): CliError {
  return new CliError(`${path} could not be read: ${errorMessage(error)}`)
}
