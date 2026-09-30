const entities: Readonly<Record<string, string>> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

/** Writes text so that HTML reads it as text, in an element or a quoted attribute. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (character) => entities[character] ?? character)
}

/** A whole page: `title` as its title and heading, `main` as written, and `script` at the end of the body. */
export function htmlPage(title: string, main: string, script = ''): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<link rel="icon" href="data:,">
</head>
<body>
<main>
<h1>${escapeHtml(title)}</h1>
${main}
</main>
<script>${script}</script>
</body>
</html>
`
}
