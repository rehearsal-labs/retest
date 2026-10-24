import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, parse, win32 } from 'node:path'

// A stand-in for a program a case starts in place of a browser or an app. macOS and Linux run a script whose first
// line names its interpreter, and the cases there write one. Windows runs only programs, so there the stand-in is a
// small program, compiled once per machine with the C# compiler every Windows carries in its .NET Framework, that runs
// a Node script beside it with the arguments it was given, the environment it was started with and its own output.
// It does not pass on the extra pipes a browser is started with; a script that would read them waits instead.

const source = String.raw`using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading.Tasks;

static class StandIn {
  static int Main(string[] args) {
    string self = Process.GetCurrentProcess().MainModule.FileName;
    string[] named = File.ReadAllLines(Path.ChangeExtension(self, ".stand-in"));
    var command = new StringBuilder(Quote(named[1]));
    foreach (string argument in args) command.Append(' ').Append(Quote(argument));
    var start = new ProcessStartInfo(named[0], command.ToString()) { UseShellExecute = false, RedirectStandardOutput = true, RedirectStandardError = true };
    using (Process child = Process.Start(start)) {
      Task output = child.StandardOutput.BaseStream.CopyToAsync(Console.OpenStandardOutput());
      Task errors = child.StandardError.BaseStream.CopyToAsync(Console.OpenStandardError());
      child.WaitForExit();
      Task.WaitAll(output, errors);
      return child.ExitCode;
    }
  }

  // One argument as the C runtime reads a command line back into arguments.
  static string Quote(string argument) {
    if (argument.Length > 0 && argument.IndexOfAny(new[] { ' ', '\t', '"' }) < 0) return argument;
    var quoted = new StringBuilder("\"");
    int slashes = 0;
    foreach (char character in argument) {
      if (character == '\\') { slashes += 1; continue; }
      quoted.Append('\\', character == '"' ? slashes * 2 + 1 : slashes).Append(character);
      slashes = 0;
    }
    return quoted.Append('\\', slashes * 2).Append('"').ToString();
  }
}
`

let compiled: string | undefined

// The compiled program, kept in the temporary folder under its source's checksum so each machine compiles it once.
function standInProgram(): string {
  if (compiled !== undefined) return compiled
  const folder = join(tmpdir(), `retest-stand-in-${createHash('sha256').update(source).digest('hex').slice(0, 16)}`)
  const program = join(folder, 'stand-in.exe')
  if (!existsSync(program)) {
    mkdirSync(folder, { recursive: true })
    const own = join(folder, `stand-in-${process.pid}`)
    writeFileSync(`${own}.cs`, source)
    const compiler = win32.join(process.env['SystemRoot'] ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')
    if (!existsSync(compiler)) throw new Error(`The Windows stand-in program is compiled with the .NET Framework C# compiler, and there is none at ${compiler}.`)
    execFileSync(compiler, ['/nologo', '/optimize', '/target:exe', `/out:${own}.exe`, `${own}.cs`], { stdio: 'pipe' })
    try {
      renameSync(`${own}.exe`, program)
    } catch (error) {
      // Another test process compiled the same source meanwhile, and may be running it; either is the same program.
      if (!existsSync(program)) throw error
    }
    rmSync(`${own}.exe`, { force: true })
    rmSync(`${own}.cs`, { force: true })
  }
  compiled = program
  return program
}

/**
 * Makes `program` a Windows stand-in that runs `script`, a CommonJS script for Node, with whatever arguments it is
 * started with. The program's name must end in .exe.
 *
 * @example windowsStandIn(join(folder, 'electron.exe'), "require('node:fs').writeFileSync(process.argv[2], 'ran')")
 */
export function windowsStandIn(program: string, script: string): void {
  const { dir, name } = parse(program)
  const scriptPath = join(dir, `${name}.stand-in.js`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(scriptPath, script)
  writeFileSync(join(dir, `${name}.stand-in`), `${process.execPath}\r\n${scriptPath}\r\n`)
  copyFileSync(standInProgram(), program)
}
