// The report's one style sheet. It loads nothing: no font, no image, no import, no url(). Colours follow the reader's
// system setting. Every outcome colour travels with a word or a mark, so nothing is told by colour alone. A dashed
// frame is the one device of its own: it stands where evidence would have been and says why it is not there.

/** The report's style sheet, hashed into its content security policy. */
export const styleSheet: string = `
:root {
  color-scheme: light dark;
  --background: #ffffff;
  --surface: #f4f5f7;
  --ink: #1c2027;
  --muted: #5b6370;
  --rule: #d8dce2;
  --failed: #b1261c;
  --failed-tint: #fcebe9;
  --passed: #17773a;
  --passed-tint: #e6f4ea;
  --error: #8f5a00;
  --error-tint: #fdf1d8;
  --undecided: #6a3fc0;
  --undecided-tint: #efe9fb;
  --quiet: #636b77;
  --focus: #0a5ec8;
  --sans: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
    --background: #121418;
    --surface: #1a1d22;
    --ink: #e3e6ea;
    --muted: #9ba3ae;
    --rule: #2d3239;
    --failed: #ff8a80;
    --failed-tint: #3a1e1c;
    --passed: #5fd07a;
    --passed-tint: #15301e;
    --error: #e9b949;
    --error-tint: #372b10;
    --undecided: #c1a1ff;
    --undecided-tint: #2a2040;
    --quiet: #8d96a1;
    --focus: #6aa8ff;
  }
}
* { box-sizing: border-box; }
html { background: var(--background); color: var(--ink); font: 15px/1.55 var(--sans); -webkit-text-size-adjust: 100%; }
body { margin: 0; }
main { max-width: 74rem; margin: 0 auto; padding: 28px 24px 64px; }
h1, h2, h3, h4 { line-height: 1.3; margin: 0; font-weight: 600; }
h1 { font-size: 22px; }
h2 { font-size: 17px; margin: 36px 0 12px; }
h3 { font-size: 15px; }
h4 { font-size: 13px; color: var(--muted); margin: 18px 0 6px; }
p { margin: 6px 0; }
a { color: inherit; text-underline-offset: 2px; }
:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; border-radius: 2px; }
code, pre, .mono { font-family: var(--mono); font-size: 13px; }
pre { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.muted { color: var(--muted); }
.small { font-size: 13px; }
.words { overflow-wrap: anywhere; unicode-bidi: plaintext; }
.run-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px 14px; }
.counts { display: flex; flex-wrap: wrap; gap: 6px 16px; margin: 10px 0 0; padding: 0; list-style: none; font-size: 14px; }
.facts { display: grid; grid-template-columns: max-content 1fr; gap: 3px 16px; margin: 14px 0 0; font-size: 13px; }
.facts dt { color: var(--muted); }
.facts dd { margin: 0; overflow-wrap: anywhere; }
.notice { margin: 14px 0 0; padding: 10px 14px; border-left: 3px solid var(--rule); background: var(--surface); border-radius: 0 4px 4px 0; }
.notice-failed { border-left-color: var(--failed); background: var(--failed-tint); }
.notice-error { border-left-color: var(--error); background: var(--error-tint); }
.status { font-weight: 600; white-space: nowrap; }
.status-passed { color: var(--passed); }
.status-failed { color: var(--failed); }
.status-error { color: var(--error); }
.status-inconclusive { color: var(--undecided); }
.status-skipped, .status-not-run { color: var(--quiet); }
.evidence { white-space: nowrap; }
.evidence-complete { color: var(--passed); }
.evidence-partial { color: var(--error); }
.evidence-unavailable { color: var(--failed); }
.evidence-none { color: var(--quiet); }
.table-wrap { overflow-x: auto; margin: 6px 0; }
table { border-collapse: collapse; width: 100%; font-size: 13px; }
th { text-align: left; font-weight: 600; color: var(--muted); padding: 4px 10px 4px 0; border-bottom: 1px solid var(--rule); white-space: nowrap; }
td { padding: 4px 10px 4px 0; border-bottom: 1px solid var(--rule); vertical-align: top; }
td.time, td.number { font-family: var(--mono); white-space: nowrap; text-align: right; color: var(--muted); }
td.app { white-space: nowrap; }
tr.row-failed td.what { color: var(--failed); }
.test { margin: 18px 0 0; border: 1px solid var(--rule); border-radius: 6px; }
.test > summary, .test > .test-head { padding: 12px 16px; }
.test > summary { cursor: pointer; }
.test > summary > h3 { display: inline; }
.test-body { padding: 0 16px 16px; }
.test-title { font-weight: 600; overflow-wrap: anywhere; }
.test-facts { display: flex; flex-wrap: wrap; gap: 4px 16px; font-size: 13px; margin-top: 4px; }
.failing { border-color: var(--failed); }
.check { margin: 4px 0 0; padding: 12px 14px; background: var(--surface); border-radius: 4px; }
.check-name { font-weight: 600; color: var(--failed); }
.check-lines { display: grid; grid-template-columns: max-content 1fr; gap: 3px 14px; margin: 8px 0 0; font-size: 13px; }
.check-lines dt { color: var(--muted); }
.check-lines dd { margin: 0; overflow-wrap: anywhere; }
.value { font-family: var(--mono); font-size: 13px; white-space: pre-wrap; overflow-wrap: anywhere; }
.expected { color: var(--passed); }
.received { color: var(--failed); }
.diff { margin: 8px 0 0; border: 1px solid var(--rule); border-radius: 4px; overflow-x: auto; }
.diff div { padding: 0 8px; font-family: var(--mono); font-size: 13px; white-space: pre-wrap; overflow-wrap: anywhere; }
.diff .diff-expected { background: var(--passed-tint); }
.diff .diff-received { background: var(--failed-tint); }
.code { margin: 8px 0 0; border: 1px solid var(--rule); border-radius: 4px; overflow-x: auto; }
.code div { padding: 0 8px; font-family: var(--mono); font-size: 13px; white-space: pre; }
.code .line-number { display: inline-block; min-width: 3.5em; color: var(--muted); user-select: none; }
.code .marked { background: var(--failed-tint); box-shadow: inset 3px 0 var(--failed); }
.shots { display: flex; flex-wrap: wrap; gap: 14px; margin: 10px 0 0; }
.shot { margin: 0; max-width: 100%; }
.shot img, .shot video { display: block; max-width: min(100%, 38rem); height: auto; border: 1px solid var(--rule); border-radius: 4px; }
.shot figcaption { font-size: 12px; color: var(--muted); margin-top: 4px; overflow-wrap: anywhere; }
.gap { margin: 10px 0 0; padding: 12px 14px; border: 1.5px dashed var(--muted); border-radius: 4px; color: var(--muted); font-size: 13px; overflow-wrap: anywhere; }
.gap strong { color: var(--ink); font-weight: 600; }
.part { margin: 14px 0 0; }
.part > summary { cursor: pointer; font-weight: 600; font-size: 14px; padding: 4px 0; }
.criteria td.verdict { white-space: nowrap; font-weight: 600; }
.depth-1 { padding-left: 16px; }
.depth-2 { padding-left: 32px; }
.depth-3 { padding-left: 48px; }
.depth-4 { padding-left: 64px; }
.depth-5 { padding-left: 80px; }
.depth-6 { padding-left: 96px; }
.detail { color: var(--muted); }
.jump-step { font: inherit; color: inherit; text-align: left; border: 0; padding: 0; background: none; cursor: pointer; text-decoration: underline; text-underline-offset: 3px; }
.jump-step:focus-visible { outline: 2px solid var(--ink); outline-offset: 3px; }
[data-jump-note]:empty { display: none; }
@media (max-width: 640px) {
  main { padding: 18px 14px 48px; }
  .facts, .check-lines { grid-template-columns: 1fr; gap: 0 0; }
  .facts dd, .check-lines dd { margin-bottom: 6px; }
  .test > summary, .test > .test-head { padding: 10px 12px; }
  .test-body { padding: 0 12px 12px; }
}
`
