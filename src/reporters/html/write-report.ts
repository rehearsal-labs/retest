import { randomUUID } from 'node:crypto'
import { renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { artifactPath } from '../../store/artifacts.ts'

/** Where the report goes in the run folder, beside `events.jsonl`, so its links are the run folder's own paths. */
export const reportPath: string = artifactPath({ kind: 'report' })

/**
 * Writes a report into the run folder through a new temporary file renamed into place, so a reader never meets half a
 * report. An earlier report there is replaced: it holds nothing the events and the result do not. Returns its path.
 *
 * @example writeReport('/work/.retest/runs/latest', await buildReport(input)) // '/work/.retest/runs/latest/report.html'
 */
export function writeReport(directory: string, report: string): string {
  const target = join(directory, reportPath)
  const temporary = join(directory, `${reportPath}.${randomUUID()}.partial`)
  writeFileSync(temporary, report, { flag: 'wx' })
  try {
    renameSync(temporary, target)
  } catch (error) {
    rmSync(temporary, { force: true })
    throw error
  }
  return target
}
