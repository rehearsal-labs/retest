import type { CommandResult } from '../../src/native/processes.ts'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { compilerErrorLines } from '../../src/cli/install/compiler-errors.ts'
import { installMedia } from '../../src/cli/install/media-install.ts'
import { inspectMedia } from '../../src/cli/install/media-record.ts'
import { mediaTarget } from '../../src/cli/install/media-pins.ts'
import { installSupervisor } from '../../src/cli/install/supervisor-install.ts'
import { inspectSupervisor } from '../../src/cli/install/supervisor-record.ts'
import { programFileName } from '../../src/media/host.ts'
import { windowsOnly } from '../support/platform-skip.ts'
import { unpinnedMedia } from '../support/unpinned-host.ts'

// What cargo prints on standard error when rustc refuses the crate: its progress, a warning, the error with its file,
// line, source and help, rustc's pointer to the explanation and cargo's closing line.
const typeError = [
  '   Compiling windows-link v0.2.1',
  '   Compiling windows-sys v0.61.2',
  '   Compiling retest-supervisor v0.1.0 (C:\\Users\\ada\\AppData\\Local\\retest\\supervisor\\source\\supervisor)',
  'warning: unused import: `HashSet`',
  '  --> src\\jobs.rs:10:33',
  '   |',
  '10 | use std::collections::{HashMap, HashSet};',
  '   |                                 ^^^^^^^',
  '   |',
  '   = note: `#[warn(unused_imports)]` on by default',
  '',
  'error[E0308]: mismatched types',
  '   --> src\\jobs.rs:412:24',
  '    |',
  '412 |     let count: usize = list.NumberOfProcessIdsInList;',
  '    |                -----   ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^ expected `usize`, found `u32`',
  '    |                |',
  '    |                expected due to this',
  '    |',
  "help: you can convert a `u32` to a `usize` and panic if the converted value doesn't fit",
  '    |',
  '412 |     let count: usize = list.NumberOfProcessIdsInList.try_into().unwrap();',
  '    |                                                     ++++++++++++++++++++',
  '',
  'For more information about this error, try `rustc --explain E0308`.',
  'warning: `retest-supervisor` (bin "retest-supervisor") generated 1 warning',
  'error: could not compile `retest-supervisor` (bin "retest-supervisor") due to 1 previous error; 1 warning emitted',
  '',
].join('\r\n')

const typeErrorLines = [
  'error[E0308]: mismatched types',
  '   --> src\\jobs.rs:412:24',
  '    |',
  '412 |     let count: usize = list.NumberOfProcessIdsInList;',
  '    |                -----   ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^ expected `usize`, found `u32`',
  '    |                |',
  '    |                expected due to this',
  '    |',
  "help: you can convert a `u32` to a `usize` and panic if the converted value doesn't fit",
  '    |',
  '412 |     let count: usize = list.NumberOfProcessIdsInList.try_into().unwrap();',
  '    |                                                     ++++++++++++++++++++',
]

// What cargo 1.100.0 printed on standard error for `retest install supervisor` on GitHub's Windows runner, word for word.
const linkerError = [
  '   Compiling windows-link v0.2.1',
  '   Compiling retest-supervisor v0.1.0 (C:\\Users\\runneradmin\\AppData\\Local\\retest\\supervisor\\supervisor-0.1.0-x86_64-pc-windows-msvc.staging-2484-c47f2a46-6b24-4ece-9145-0df1e5df7e9e\\source\\supervisor)',
  '   Compiling windows-sys v0.61.2',
  'error: linking with `link.exe` failed: exit code: 1104',
  '  |',
  '  = note: "C:\\\\Program Files\\\\Microsoft Visual Studio\\\\18\\\\Enterprise\\\\VC\\\\Tools\\\\MSVC\\\\14.52.37025\\\\bin\\\\HostX64\\\\x64\\\\link.exe" "/NOLOGO" "<1 object files omitted>" "C:\\\\Users\\\\runneradmin\\\\AppData\\\\Local\\\\retest\\\\supervisor\\\\supervisor-0.1.0-x86_64-pc-windows-msvc.staging-2484-c47f2a46-6b24-4ece-9145-0df1e5df7e9e\\\\target\\\\x86_64-pc-windows-msvc\\\\release\\\\build\\\\retest-supervisor/373eac92e6da5441\\\\out\\\\rustczSbTKe/{libwindows_sys-fa11dbc0912446d5,libstd-389636fd4dca543a}.rlib" "<sysroot>\\\\lib\\\\rustlib\\\\x86_64-pc-windows-msvc\\\\lib/libcompiler_builtins-*.rlib" "kernel32.lib" "kernel32.lib" "ntdll.lib" "userenv.lib" "ws2_32.lib" "dbghelp.lib" "synchronization.lib" "/defaultlib:msvcrt" "/NXCOMPAT" "/OUT:C:\\\\Users\\\\runneradmin\\\\AppData\\\\Local\\\\retest\\\\supervisor\\\\supervisor-0.1.0-x86_64-pc-windows-msvc.staging-2484-c47f2a46-6b24-4ece-9145-0df1e5df7e9e\\\\target\\\\x86_64-pc-windows-msvc\\\\release\\\\build\\\\retest-supervisor/373eac92e6da5441\\\\out\\\\retest_supervisor.exe" "/OPT:REF,ICF" "/DEBUG" "/PDBALTPATH:%_PDB%" "/NATVIS:<sysroot>\\\\lib\\\\rustlib\\\\etc\\\\intrinsic.natvis" "/NATVIS:<sysroot>\\\\lib\\\\rustlib\\\\etc\\\\liballoc.natvis" "/NATVIS:<sysroot>\\\\lib\\\\rustlib\\\\etc\\\\libcore.natvis" "/NATVIS:<sysroot>\\\\lib\\\\rustlib\\\\etc\\\\libstd.natvis"',
  '  = note: some arguments are omitted. use `--verbose` to show all linker arguments',
  '  = note: LINK : fatal error LNK1104: cannot open file \'C:\\Users\\runneradmin\\AppData\\Local\\retest\\supervisor\\supervisor-0.1.0-x86_64-pc-windows-msvc.staging-2484-c47f2a46-6b24-4ece-9145-0df1e5df7e9e\\target\\x86_64-pc-windows-msvc\\release\\build\\retest-supervisor\\373eac92e6da5441\\out\\rustczSbTKe\\libwindows_sys-fa11dbc0912446d5.rlib\'',
  '          ',
  '',
  'error: could not compile `retest-supervisor` (bin "retest-supervisor") due to 1 previous error',
].join('\n')

const linkerErrorLines = linkerError.split('\n').slice(3, 8)

function failedBuild(stderr: string): CommandResult {
  return { code: 101, signal: null, stdout: '', stderr, timedOut: false, stopped: false, started: true, cleanupProblems: [] }
}

const succeeded: CommandResult = { code: 0, signal: null, stdout: '', stderr: '', timedOut: false, stopped: false, started: true, cleanupProblems: [] }

test("a failed build's compiler errors are kept with their file, line and help, without progress, warnings or cargo's closing line", () => {
  assert.deepEqual(compilerErrorLines(typeError), typeErrorLines)
  assert.deepEqual(compilerErrorLines(typeError.replaceAll('\r\n', '\n')), typeErrorLines)
})

test("a linker's error keeps its notes, and the linker's command line is cut to a bounded line", () => {
  const [error, bar, command, omitted, link, ...rest] = compilerErrorLines(linkerError)
  assert.deepEqual([error, bar, omitted, link, rest], [linkerErrorLines[0], linkerErrorLines[1], linkerErrorLines[3], linkerErrorLines[4], []])
  assert.equal(command, `${(linkerErrorLines[2] ?? '').slice(0, 400)} ...`)
  const advised = linkerError.replace('          \n\n', '          \n\nnote: `link.exe` returned an unexpected error\n\n')
  assert.deepEqual(compilerErrorLines(advised).slice(-2), ['', 'note: `link.exe` returned an unexpected error'])
})

test("cargo's own error keeps the causes it gives, a build script's output included, and stops at cargo's progress", () => {
  const stderr = [
    '   Compiling retest-media v0.1.0 (/home/ada/.cache/retest/media/source/media)',
    'error: failed to run custom build command for `retest-media v0.1.0 (/home/ada/.cache/retest/media/source/media)`',
    '',
    'Caused by:',
    "  process didn't exit successfully: `/home/ada/.cache/retest/media/target/release/build/retest-media-1/build-script-build` (exit status: 101)",
    '  --- stdout',
    '  cargo:rerun-if-changed=build.rs',
    '',
    '  --- stderr',
    "  thread 'main' panicked at build.rs:12:5:",
    '  no revision',
    '',
    '    Building [=======================> ] 61/62: retest-media(build)',
    '   Compiling image v0.25.6',
  ].join('\n')
  assert.deepEqual(compilerErrorLines(stderr), [
    'error: failed to run custom build command for `retest-media v0.1.0 (/home/ada/.cache/retest/media/source/media)`',
    '',
    'Caused by:',
    "  process didn't exit successfully: `/home/ada/.cache/retest/media/target/release/build/retest-media-1/build-script-build` (exit status: 101)",
    '  --- stdout',
    '  cargo:rerun-if-changed=build.rs',
    '',
    '  --- stderr',
    "  thread 'main' panicked at build.rs:12:5:",
    '  no revision',
  ])
})

test('many errors print within the bound and say how many lines are left out; control characters are escaped', () => {
  const error = (index: number): string => [`error[E0425]: cannot find value \`value${index}\` in this scope`, `  --> src/main.rs:${index}:5`, '   |', `${index} |     value${index}`, '   |     ^^^^^^ not found in this scope', ''].join('\n')
  const lines = compilerErrorLines(`${Array.from({ length: 20 }, (_, index) => error(index + 1)).join('\n')}error: could not compile \`x\` (bin "x") due to 20 previous errors\n`)
  assert.equal(lines.length, 41)
  assert.equal(lines.at(-1), "79 more lines of the compiler's errors are not shown.")
  assert.deepEqual(compilerErrorLines('error: \u001b[2Jcleared\n'), ['error: \\u001b[2Jcleared'])
  assert.deepEqual(compilerErrorLines(''), [])
  assert.deepEqual(compilerErrorLines('warning: unused import\n  --> src/main.rs:1:5\n'), [])
})

test("retest install media prints the compiler's errors above the line that says nothing was installed", { skip: unpinnedMedia }, async (t) => {
  const target = mediaTarget() ?? assert.fail('a media target')
  const home = await mkdtemp(join(tmpdir(), 'retest-media-errors-')); t.after(() => rm(home, { recursive: true, force: true }))
  const tools = join(home, 'tools'); await mkdir(tools)
  for (const name of ['cargo', 'rustc']) await writeFile(join(tools, programFileName(name)), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  const env = { HOME: home, LOCALAPPDATA: home, PATH: tools }
  const reported: string[] = []
  const result = await installMedia({ env, signal: new AbortController().signal, version: '2.0.0', report: (line) => reported.push(line), run: async (_command, args) => {
    if (args[0] === '--version') return { ...succeeded, stdout: 'cargo 1.100.0 (abc 2026-11-09)' }
    if (args[0] === '-vV') return { ...succeeded, stdout: `rustc 1.100.0 (0ef1bc386 2026-11-09)\nhost: ${target}\n` }
    return failedBuild(typeError.replaceAll('retest-supervisor', 'retest-media'))
  } })
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.message, 'cargo build --release --locked ended with exit code 101: error: could not compile `retest-media` (bin "retest-media") due to 1 previous error; 1 warning emitted. Nothing was installed.')
  assert.match(reported[0] ?? '', /^Building retest-media .* with rustc 1\.100\.0/)
  assert.deepEqual(reported.slice(1), typeErrorLines)
  assert.equal((await inspectMedia(env))?.state, 'missing')
})

test("retest install supervisor prints the compiler's errors above the line that says nothing was installed", { skip: windowsOnly("retest-supervisor's cache folder is a Windows path") }, async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'retest-supervisor-errors-')); t.after(() => rm(home, { recursive: true, force: true }))
  const tools = join(home, 'tools'); await mkdir(tools)
  for (const name of ['cargo.exe', 'rustc.exe']) await writeFile(join(tools, name), '')
  const env = { LOCALAPPDATA: home, PATH: tools }
  const reported: string[] = []
  const result = await installSupervisor({ env, signal: new AbortController().signal, version: '2.0.0', target: 'x86_64-pc-windows-msvc', report: (line) => reported.push(line), run: async (_command, args) => {
    if (args[0] === '--version') return { ...succeeded, stdout: 'cargo 1.100.0 (abc 2026-11-09)' }
    if (args[0] === '-vV') return { ...succeeded, stdout: 'rustc 1.100.0 (0ef1bc386 2026-11-09)\r\nhost: x86_64-pc-windows-msvc\r\n' }
    return failedBuild(linkerError)
  } })
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.message, 'cargo build --release --locked ended with exit code 101: error: could not compile `retest-supervisor` (bin "retest-supervisor") due to 1 previous error. Nothing was installed.')
  assert.equal(reported[0], 'Building retest-supervisor 0.1.0 with rustc 1.100.0 (0ef1bc386 2026-11-09); Cargo.lock is pinned.')
  assert.deepEqual(reported.slice(1), compilerErrorLines(linkerError))
  assert.ok(reported.some((line) => line.includes('LNK1104: cannot open file')))
  assert.equal((await inspectSupervisor(env, { target: 'x86_64-pc-windows-msvc' }))?.state, 'missing')
})
