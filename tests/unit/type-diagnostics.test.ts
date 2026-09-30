import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { matchDiagnostics, parseDiagnostics, parseMarkers, type Diagnostic, type Marker } from '../types/diagnostics.ts'

const resolveFile = (file: string): string => `/root/${file}`

function diagnostic(line: number, code: string, message: string): Diagnostic {
  return { file: '/root/fixture.ts', line, column: 1, code, message }
}

function marker(line: number, code: string, fragment: string): Marker {
  return { file: '/root/fixture.ts', line, code, fragment }
}

describe('parseDiagnostics', () => {
  test('reads each diagnostic and joins its indented continuation lines', () => {
    const output = [
      "fixture.ts(3,14): error TS2375: Type 'A' is not assignable to type 'B'.",
      "  Types of property 'note' are incompatible.",
      "    Type 'undefined' is not assignable to type 'string'.",
      "dir (copy)/other.ts(10,2): error TS2322: Type 'number' is not assignable to type 'string'.",
      '',
    ].join('\r\n')
    assert.deepEqual(parseDiagnostics(output, resolveFile), {
      diagnostics: [
        {
          file: '/root/fixture.ts',
          line: 3,
          column: 14,
          code: 'TS2375',
          message:
            "Type 'A' is not assignable to type 'B'.\nTypes of property 'note' are incompatible.\nType 'undefined' is not assignable to type 'string'.",
        },
        {
          file: '/root/dir (copy)/other.ts',
          line: 10,
          column: 2,
          code: 'TS2322',
          message: "Type 'number' is not assignable to type 'string'.",
        },
      ],
      unread: [],
    })
  })

  test('returns every line it cannot place', () => {
    const output = "error TS5023: Unknown compiler option 'x'.\n  orphan continuation\nFound 1 error.\n"
    assert.deepEqual(parseDiagnostics(output, resolveFile), {
      diagnostics: [],
      unread: ["error TS5023: Unknown compiler option 'x'.", '  orphan continuation', 'Found 1 error.'],
    })
  })
})

describe('parseMarkers', () => {
  test('finds markers with their line, code and fragment', () => {
    const source = [
      "const a: string = 1 // type-error TS2322 Type 'number' is not assignable",
      'const b = 2',
      "call() // type-error TS2345 first // type-error TS2554 Expected 0 arguments ",
    ].join('\n')
    assert.deepEqual(parseMarkers('/root/fixture.ts', source), {
      markers: [
        marker(1, 'TS2322', "Type 'number' is not assignable"),
        marker(3, 'TS2345', 'first'),
        marker(3, 'TS2554', 'Expected 0 arguments'),
      ],
      malformed: [],
    })
  })

  test('reports markers without a code or fragment', () => {
    const source = 'a // type-error TS2322\nb // type-error 2322 text\nc // type-error TS2322  '
    assert.deepEqual(parseMarkers('/root/fixture.ts', source).malformed, [
      { file: '/root/fixture.ts', line: 1, text: '// type-error TS2322' },
      { file: '/root/fixture.ts', line: 2, text: '// type-error 2322 text' },
      { file: '/root/fixture.ts', line: 3, text: '// type-error TS2322' },
    ])
  })
})

describe('matchDiagnostics', () => {
  test('a marker on the same line with the same code and a fragment of the message claims a diagnostic', () => {
    const errors = [diagnostic(3, 'TS2375', "Type 'A' is not assignable.\nTypes of property 'note' are incompatible.")]
    assert.deepEqual(matchDiagnostics(errors, [marker(3, 'TS2375', "property 'note'")]), { unexpected: [], unused: [] })
  })

  test('an unclaimed diagnostic is unexpected and an unclaiming marker is unused', () => {
    const errors = [diagnostic(1, 'TS2322', 'no marker'), diagnostic(2, 'TS2322', 'wrong code'), diagnostic(3, 'TS2322', 'text')]
    const markers = [marker(2, 'TS2345', 'wrong code'), marker(3, 'TS2322', 'other text'), marker(4, 'TS2322', 'text')]
    assert.deepEqual(matchDiagnostics(errors, markers), { unexpected: errors, unused: markers })
  })

  test('a marker in another file does not claim', () => {
    const elsewhere: Marker = { ...marker(1, 'TS2322', 'x'), file: '/root/other.ts' }
    assert.deepEqual(matchDiagnostics([diagnostic(1, 'TS2322', 'x')], [elsewhere]), {
      unexpected: [diagnostic(1, 'TS2322', 'x')],
      unused: [elsewhere],
    })
  })

  test('one marker may claim repeated diagnostics on its line', () => {
    const errors = [diagnostic(5, 'TS2322', 'same'), diagnostic(5, 'TS2322', 'same')]
    assert.deepEqual(matchDiagnostics(errors, [marker(5, 'TS2322', 'same')]), { unexpected: [], unused: [] })
  })
})
