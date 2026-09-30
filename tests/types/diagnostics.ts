export type Diagnostic = { file: string; line: number; column: number; code: string; message: string }
export type Marker = { file: string; line: number; code: string; fragment: string }
export type MalformedMarker = { file: string; line: number; text: string }
export type Mismatch = { unexpected: Diagnostic[]; unused: Marker[] }

const markerStart = '// type-error '
const diagnosticLine = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/
const markerBody = /^(TS\d+) (\S.*)$/

/**
 * Reads `tsc --pretty false` output. Indented lines continue the diagnostic above them; any other line
 * is returned as `unread` so that nothing the compiler said is dropped.
 */
export function parseDiagnostics(
  output: string,
  resolveFile: (file: string) => string,
): { diagnostics: Diagnostic[]; unread: string[] } {
  const diagnostics: Diagnostic[] = []
  const unread: string[] = []
  for (const line of output.split(/\r?\n/)) {
    const match = diagnosticLine.exec(line)
    const previous = diagnostics.at(-1)
    if (match) {
      const [, file = '', row = '', column = '', code = '', message = ''] = match
      diagnostics.push({ file: resolveFile(file), line: Number(row), column: Number(column), code, message })
    } else if (line.startsWith(' ') && previous) {
      previous.message += `\n${line.trim()}`
    } else if (line.trim() !== '') {
      unread.push(line)
    }
  }
  return { diagnostics, unread }
}

/** Finds `// type-error TSnnnn fragment` markers. One line may carry several; each takes the rest of its text. */
export function parseMarkers(file: string, source: string): { markers: Marker[]; malformed: MalformedMarker[] } {
  const markers: Marker[] = []
  const malformed: MalformedMarker[] = []
  for (const [index, text] of source.split(/\r?\n/).entries()) {
    for (const body of text.split(markerStart).slice(1)) {
      const match = markerBody.exec(body.trim())
      const [, code, fragment] = match ?? []
      if (code && fragment) markers.push({ file, line: index + 1, code, fragment })
      else malformed.push({ file, line: index + 1, text: `${markerStart}${body.trim()}` })
    }
  }
  return { markers, malformed }
}

/** A diagnostic is expected when a marker on its line has its code and a fragment of its message. */
export function matchDiagnostics(diagnostics: Diagnostic[], markers: Marker[]): Mismatch {
  const used = new Set<Marker>()
  const unexpected = diagnostics.filter((diagnostic) => {
    const claims = markers.filter((marker) => claimsDiagnostic(marker, diagnostic))
    for (const marker of claims) used.add(marker)
    return claims.length === 0
  })
  return { unexpected, unused: markers.filter((marker) => !used.has(marker)) }
}

function claimsDiagnostic(marker: Marker, diagnostic: Diagnostic): boolean {
  return (
    marker.file === diagnostic.file &&
    marker.line === diagnostic.line &&
    marker.code === diagnostic.code &&
    diagnostic.message.includes(marker.fragment)
  )
}
