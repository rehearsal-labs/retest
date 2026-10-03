import type { StepResult } from './proof.ts'
import { writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { errorMessage } from '../../src/protocol/failures.ts'
import { runWebKitProof } from './proof.ts'

/**
 * Runs the WebKit proof and prints what each step saw. Exit status 0 means every step passed, 1 that a step failed,
 * and 2 that the proof could not start, such as when the pinned build is not installed.
 *
 *   node --conditions=retest-source proofs/webkit/run.ts [--out <folder>] [--build <unpacked build>]
 */
const { values } = parseArgs({ options: { out: { type: 'string' }, build: { type: 'string' } } })
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const outputFolder = resolve(values.out ?? join(import.meta.dirname, '..', '..', '.retest', 'proofs', 'webkit', stamp))

try {
  const report = await runWebKitProof({
    outputFolder,
    ...(values.build === undefined ? {} : { buildDirectory: resolve(values.build) }),
    onStep: printStep,
  })
  const reportFile = join(outputFolder, 'report.json')
  await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`)
  const failed = report.steps.filter((step) => !step.ok)
  process.stdout.write(`\nWebKit build ${report.build.revision} at ${report.build.directory}\n`)
  process.stdout.write(`${report.protocol.commands.length} protocol commands and ${report.protocol.events.length} events used, listed in ${reportFile}\n`)
  process.stdout.write(`${report.steps.length - failed.length} of ${report.steps.length} steps passed${failed.length > 0 ? `; failed: ${failed.map((step) => step.name).join('; ')}` : ''}\n`)
  process.exitCode = report.ok ? 0 : 1
} catch (error) {
  process.stderr.write(`The WebKit proof could not start: ${errorMessage(error)}\n`)
  process.exitCode = 2
}

function printStep(step: StepResult): void {
  process.stdout.write(`${step.ok ? 'pass' : 'FAIL'}  ${step.name}\n`)
  for (const fact of step.facts) process.stdout.write(`      ${fact}\n`)
  if (step.failure !== undefined) process.stdout.write(`      failed: ${step.failure}\n`)
}
