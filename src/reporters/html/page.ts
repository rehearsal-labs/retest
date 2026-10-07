import type { Markup } from './markup.ts'
import { createHash } from 'node:crypto'
import { constant, html, markupText } from './markup.ts'
import { styleSheet } from './style.ts'
import { jumpScript, jumpScriptHash } from './jump-script.ts'

/**
 * A whole report page: its title, its body, its data blocks (built by `dataBlock`, never run), and the report's own
 * fixed seek script.
 */
export type PageParts = { title: string; body: Markup; data: readonly [Markup, Markup] }

/**
 * The page's content security policy. Nothing is fetched, framed or posted; the one style sheet and the one script run
 * only because their hashes are named, so markup that was never meant to be there could not style or script anything.
 * Images and video load from the report's own place: `'self'` for a report served from a web address, and `file:`
 * for one opened from disk, where Chrome already reads `'self'` as any file address. That is why the policy alone
 * does not keep loads inside the run folder; the report keeps them there by linking only to paths inside it.
 *
 * @example contentSecurityPolicy() // the report's fixed script and style hashes
 */
export function contentSecurityPolicy(): string {
  return [
    "default-src 'none'",
    "img-src 'self' file:",
    "media-src 'self' file:",
    `style-src '${hashSource(styleSheet)}'`,
    `script-src '${jumpScriptHash}'`,
    "script-src-attr 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ')
}

/**
 * A whole page as one HTML document. The policy comes first in the head, before anything it governs.
 *
 * @example writeFileSync('report.html', page({ title, body, data: [outcomeBlock, clocksBlock] }))
 */
export function page(parts: PageParts): string {
  return markupText(html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy()}">
<meta name="referrer" content="no-referrer">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${parts.title}</title>
<style>${constant(styleSheet)}</style>
</head>
<body>
${parts.body}
${parts.data}
<script>${constant(jumpScript)}</script>
</body>
</html>
`)
}

function hashSource(text: string): string {
  return `sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}`
}
