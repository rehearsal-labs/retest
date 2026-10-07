import type { EvaluationRecord, EvaluatorRecord, EvidenceRecord } from '../../protocol/evaluation.ts'
import type { ArtifactFiles } from './artifact-files.ts'
import type { Markup } from './markup.ts'
import { describeEvaluation } from '../../evaluation/report.ts'
import { formatLocation } from '../../protocol/location.ts'
import { failureLabel, formatDuration } from '../format.ts'
import { evaluationEvidenceReasons } from './evidence-status.ts'
import { missingFileView } from './artifact-files.ts'
import { html } from './markup.ts'
import { pictureView } from './screenshots-view.ts'

const verdictClasses = { pass: 'status-passed', fail: 'status-failed', inconclusive: 'status-inconclusive' } as const

/**
 * A test's AI checks, each with its verdict, mode, judge and model, then each criterion with what it requires, its
 * verdict and the evidence it cites, the judge's words, why it has no verdict, its warning or failure, every piece of
 * evidence by its id, and who judged: provider, model and revision, evaluator and prompt versions, sampling, time and
 * tokens. The judge's words and the requirements are data, shown as text.
 *
 * @example evaluationsView(test.evaluations ?? [], files)
 */
export function evaluationsView(records: readonly EvaluationRecord[], files: ArtifactFiles): Markup | undefined {
  if (records.length === 0) return undefined
  return html`${records.map((record) => evaluationView(record, files))}`
}

function evaluationView(record: EvaluationRecord, files: ArtifactFiles): Markup {
  const mark = record.verdict === 'pass' ? html`<span class="status status-passed">✓</span>` : record.mode === 'advisory' ? html`<span class="status status-error">!</span>` : html`<span class="status status-failed">✗</span>`
  const failure = record.failure === undefined ? undefined : html`<p><span class="check-name">${failureLabel(record.failure.class)}</span></p><pre class="words">${record.failure.message}</pre>`
  const warning = record.warning === undefined ? undefined : html`<p class="status-error words">Warning: ${record.warning}</p>`
  const said = record.justification === undefined ? undefined : html`<p class="small muted">The judge said</p><pre class="words">${JSON.stringify(record.justification)}</pre>`
  const reason = record.reason === undefined ? undefined : html`<p class="small words">Reason: ${record.reason}</p>`
  const context = record.context === undefined ? undefined : html`<p class="small muted words">Context given to the judge: ${record.context}</p>`
  const facts = [
    `criteria sha256 ${record.criteriaSha256}`,
    `took ${formatDuration(record.durationMs)}`,
    ...(record.location === undefined ? [] : [`at ${formatLocation(record.location)}`]),
  ]
  return html`<section class="part"><h4>${mark} <span class="words">AI check ${describeEvaluation(record)}</span></h4>${failure}${warning}${criteriaTable(record)}${said}${reason}${context}${evidenceView(record, files)}${judgeView(record.evaluator)}<p class="muted small words">${facts.join(' · ')}</p></section>`
}

function criteriaTable(record: EvaluationRecord): Markup {
  const rows = record.criteria.map((criterion) => {
    const verdict = criterion.verdict === undefined ? html`<td class="verdict muted">no verdict</td>` : html`<td class="verdict ${verdictClasses[criterion.verdict]}">${criterion.verdict}</td>`
    const cites = criterion.citations === undefined || criterion.citations.length === 0 ? '' : criterion.citations.join(', ')
    const judgeVerdict = criterion.judgeVerdict ?? (criterion.rule === undefined ? criterion.verdict ?? 'no verdict' : 'not recorded')
    return html`<tr><td><code class="words">${criterion.id}</code></td><td class="words">${criterion.requirement}</td>${verdict}<td class="words">${cites}</td><td>${judgeVerdict}</td><td class="words">${criterion.rule ?? 'none'}</td></tr>`
  })
  return html`<div class="table-wrap"><table class="criteria"><thead><tr><th scope="col">Criterion</th><th scope="col">Requirement</th><th scope="col">Verdict</th><th scope="col">Cites</th><th scope="col">Judge verdict</th><th scope="col">Parent rule</th></tr></thead><tbody>${rows}</tbody></table></div>`
}

function evidenceView(record: EvaluationRecord, files: ArtifactFiles): Markup | undefined {
  if (record.evidence.length === 0) return html`<p class="muted small">The judge was given no evidence.</p>`
  const items = record.evidence.map((evidence) => evidenceItem(evidence, record.checkId, files))
  return html`<p class="small muted">Evidence</p><div class="shots">${items}</div>`
}

function evidenceItem(evidence: EvidenceRecord, checkId: string, files: ArtifactFiles): Markup {
  const facts = [`${evidence.bytes} bytes`, `sha256 ${evidence.sha256}`, ...(evidence.source === undefined ? [] : [evidence.source]), ...(evidence.sessionId === undefined ? [] : [`session ${evidence.sessionId}`])]
  if (evidence.kind === 'text') {
    const label = evidence.label === undefined ? '' : ` ${JSON.stringify(evidence.label)}`
    return html`<p class="small words">${evidence.id}: text${label}, ${facts.join(' · ')}</p>`
  }
  if (evidence.kind === 'frames') {
    const subject = `Frames ${evidence.id} of ${evidence.app ?? 'the page'}`
    const reasons = evaluationEvidenceReasons(evidence, subject).map((reason) => html`<li class="words">${reason}</li>`)
    const frames = (evidence.frames ?? []).map((frame) => pictureView(files.picture(frame.path), `Frame ${frame.id} for AI check ${checkId}`, `${frame.path} · capture ${frame.captureUs} us · ${frame.fate ?? 'placement not recorded'} · frame ${frame.frameId} · ${frame.bytes} bytes · sha256 ${frame.sha256}`))
    return html`<section class="part"><p class="small words">${subject}: ${evidence.status ?? 'status not recorded'} · interval ${evidence.fromUs ?? '?'} to ${evidence.toUs ?? '?'} us${evidence.step === undefined ? '' : ` · step ${evidence.step}`} · ${facts.join(' · ')}</p>${reasons.length === 0 ? undefined : html`<ul>${reasons}</ul>`}${frames.length === 0 ? html`<div class="gap">No saved frames were given to the judge.</div>` : frames}</section>`
  }
  if (evidence.kind === 'diagnostics') {
    const subject = `Diagnostics ${evidence.id} of ${evidence.app ?? 'the page'}`
    const reasons = evaluationEvidenceReasons(evidence, subject).map((reason) => html`<li class="words">${reason}</li>`)
    const file = evidence.path === undefined ? undefined : files.evaluationDiagnostics(evidence.path)
    const content = file === undefined ? html`<div class="gap">The diagnostics evidence was not saved.</div>` : file.ok ? html`<p class="small">Artifact <a href="${file.link}"><code>${evidence.path}</code></a></p><pre class="words">${file.text}</pre>` : missingFileView(subject, file)
    return html`<section class="part"><p class="small words">${subject}: ${evidence.status ?? 'status not recorded'} · ${(evidence.include ?? []).join(', ')} · records ${(evidence.records ?? []).join(', ')} · ${facts.join(' · ')}</p>${reasons.length === 0 ? undefined : html`<ul>${reasons}</ul>`}${content}</section>`
  }
  const subject = `Screenshot ${evidence.id} of ${evidence.app ?? 'the page'}`
  if (evidence.path === undefined) return html`<div class="gap"><strong>${subject} was not saved.</strong> The run folder holds no copy of it. ${facts.join(' · ')}</div>`
  const size = evidence.width === undefined || evidence.height === undefined ? '' : ` · ${evidence.width}×${evidence.height}`
  return pictureView(files.picture(evidence.path), `${subject} for AI check ${checkId}`, `${evidence.path}${size} · ${facts.join(' · ')}`)
}

function judgeView(evaluator: EvaluatorRecord | undefined): Markup {
  if (evaluator === undefined) return html`<p class="muted small">No judge answered, so no provider or model is recorded.</p>`
  const rows: [string, string][] = [
    ['Provider', evaluator.provider],
    ['Model', evaluator.modelRevision === undefined ? evaluator.model : `${evaluator.model}, revision ${evaluator.modelRevision}`],
    ['Evaluator', `version ${evaluator.evaluatorVersion}, instructions version ${evaluator.promptVersion}`],
  ]
  const sampling = Object.entries(evaluator.sampling ?? {}).map(([setting, value]) => `${setting} ${String(value)}`)
  if (sampling.length > 0) rows.push(['Sampling', sampling.join(', ')])
  for (const unsent of evaluator.samplingNotSent ?? []) rows.push(['Not sent', `${unsent.setting}: ${unsent.reason}`])
  if (evaluator.latencyMs !== undefined) rows.push(['Answered in', formatDuration(evaluator.latencyMs)])
  rows.push(['Usage', describeUsage(evaluator.usage)])
  return html`<dl class="check-lines">${rows.map(([label, value]) => html`<dt>${label}</dt><dd class="words">${value}</dd>`)}</dl>`
}

function describeUsage(usage: EvaluatorRecord['usage']): string {
  if (usage === undefined) return 'the provider counted no tokens'
  const parts = [
    ...(usage.inputTokens === undefined ? [] : [`${usage.inputTokens} input tokens`]),
    ...(usage.outputTokens === undefined ? [] : [`${usage.outputTokens} output tokens`]),
    ...(usage.totalTokens === undefined ? [] : [`${usage.totalTokens} in total`]),
  ]
  return parts.length === 0 ? 'the provider counted no tokens' : parts.join(', ')
}
