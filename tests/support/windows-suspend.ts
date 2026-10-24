import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, win32 } from 'node:path'

// Stalls a process on Windows, as SIGSTOP and SIGCONT do on macOS and Linux. Windows has no signal for it; ntdll's
// NtSuspendProcess suspends every thread of a process and NtResumeProcess lets them go on. A small program, compiled
// once per machine with the C# compiler of the .NET Framework every Windows carries, makes the call, as the stand-in
// programs in stand-in-program.ts are made.

const source = String.raw`using System;
using System.Diagnostics;
using System.Runtime.InteropServices;

static class Stall {
  [DllImport("ntdll.dll")] static extern int NtSuspendProcess(IntPtr process);
  [DllImport("ntdll.dll")] static extern int NtResumeProcess(IntPtr process);

  static int Main(string[] args) {
    using (Process target = Process.GetProcessById(int.Parse(args[1]))) {
      int status = args[0] == "suspend" ? NtSuspendProcess(target.Handle) : NtResumeProcess(target.Handle);
      Console.Out.Write(status);
      return status == 0 ? 0 : 1;
    }
  }
}
`

let compiled: string | undefined

// The compiled program, kept in the temporary folder under its source's checksum so each machine compiles it once.
function stallProgram(): string {
  if (compiled !== undefined) return compiled
  const folder = join(tmpdir(), `retest-stall-${createHash('sha256').update(source).digest('hex').slice(0, 16)}`)
  const program = join(folder, 'stall.exe')
  if (!existsSync(program)) {
    mkdirSync(folder, { recursive: true })
    const own = join(folder, `stall-${process.pid}`)
    writeFileSync(`${own}.cs`, source)
    const compiler = win32.join(process.env['SystemRoot'] ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')
    if (!existsSync(compiler)) throw new Error(`The Windows stall program is compiled with the .NET Framework C# compiler, and there is none at ${compiler}.`)
    execFileSync(compiler, ['/nologo', '/optimize', '/target:exe', `/out:${own}.exe`, `${own}.cs`], { stdio: 'pipe' })
    try {
      renameSync(`${own}.exe`, program)
    } catch (error) {
      // Another test process compiled the same source meanwhile; either is the same program.
      if (!existsSync(program)) throw error
    }
    rmSync(`${own}.exe`, { force: true })
    rmSync(`${own}.cs`, { force: true })
  }
  compiled = program
  return program
}

/**
 * Suspends every thread of process `pid` on Windows, as SIGSTOP stops it elsewhere; `resumeProcess` lets it go on.
 *
 * @example suspendProcess(encoder); try { await delay(2500) } finally { resumeProcess(encoder) }
 */
export function suspendProcess(pid: number): void {
  execFileSync(stallProgram(), ['suspend', String(pid)], { stdio: 'pipe', windowsHide: true })
}

/** Lets a process `suspendProcess` suspended go on. */
export function resumeProcess(pid: number): void {
  execFileSync(stallProgram(), ['resume', String(pid)], { stdio: 'pipe', windowsHide: true })
}
