import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { readCorpus } from '../fixtures/evaluation-corpus/runner/cases.ts'
import { runCorpus } from '../fixtures/evaluation-corpus/runner/run.ts'
import { describeSummary, summarize } from '../fixtures/evaluation-corpus/runner/score.ts'
import { loadConfig } from '../src/config/load.ts'
import { Judges } from '../src/evaluation/judges.ts'
import { Redactor } from '../src/runner/redactor.ts'

// Runs the fixed evaluation corpus against one named judge of a Retest config, three times unless told otherwise, and
// prints the false passes, false failures, undecided and error rates, repeat agreement, latency and usage, and the two
// gates of the evaluation contract. The judge is loaded as a run loads it: its adapter from the config, its credentials
// from the environment this command runs in, never from a file. From the Retest root:
//
//   node --conditions=retest-source scripts/run-evaluation-corpus.ts --config fixtures/evaluation-corpus/judges/retest.config.ts --judge perfect
//
// Exit status: 0 when both gates are met, 1 when either is not, 2 when the corpus could not be run at all. A met gate
// is provisional while any label awaits the founder's review, and the summary says so.

const usage = 'Usage: node --conditions=retest-source scripts/run-evaluation-corpus.ts --config <retest.config.ts> --judge <name> [--repeats 3] [--cases <cases.json>] [--out <folder>]'

async function main(): Promise<number> {
  const { values } = parseArgs({ options: { config: { type: 'string' }, judge: { type: 'string' }, repeats: { type: 'string', default: '3' }, cases: { type: 'string' }, out: { type: 'string' } }, strict: true })
  if (values.config === undefined || values.judge === undefined) return fail(usage)
  const repeats = Number(values.repeats)
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > 10) return fail(`--repeats takes a whole number from 1 to 10, received ${values.repeats}.`)
  const loaded = await loadConfig(resolve(values.config))
  if (!loaded.ok) return fail(loaded.failure.message)
  const evaluation = loaded.config.evaluation
  if (evaluation === undefined) return fail(`${values.config} declares no judges under evaluation.judges.`)
  if (!evaluation.judges.has(values.judge)) return fail(`${values.config} has no judge ${JSON.stringify(values.judge)}. It has ${[...evaluation.judges.keys()].join(', ')}.`)
  const corpus = values.cases === undefined ? readCorpus() : readCorpus(resolve(values.cases))
  const out = values.out === undefined ? mkdtempSync(join(tmpdir(), 'retest-evaluation-corpus-')) : resolve(values.out)
  mkdirSync(out, { recursive: true })
  const redactor = new Redactor()
  const judges = new Judges({ evaluation, redactor, env: process.env })
  const stop = new AbortController()
  process.once('SIGINT', () => stop.abort(new DOMException('Interrupted.', 'AbortError')))
  try {
    const ran = await runCorpus({
      corpus,
      judges,
      judge: values.judge,
      repeats,
      limits: evaluation.limits,
      timeoutMs: evaluation.timeoutMs,
      redactor,
      folder: join(out, 'evidence'),
      signal: stop.signal,
      onJudgment: (judgment) => {
        writeFileSync(join(out, 'judgments.jsonl'), `${JSON.stringify(judgment)}\n`, { flag: 'a' })
      },
    })
    const summary = summarize(corpus.cases, ran, repeats)
    writeFileSync(join(out, 'summary.json'), `${JSON.stringify({ judge: values.judge, corpus: corpus.version, ...summary }, null, 2)}\n`)
    process.stdout.write(`${describeSummary(summary, values.judge).join('\n')}\n  written    ${out}\n`)
    return summary.gates.met ? 0 : 1
  } finally {
    await judges.close(5000)
  }
}

function fail(message: string): number {
  process.stderr.write(`${message}\n`)
  return 2
}

process.exitCode = await main()
