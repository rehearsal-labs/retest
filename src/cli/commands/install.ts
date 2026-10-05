import type { BuildEngine, BuildPlatform } from '../../browser/builds.ts'
import type { Command } from '../command.ts'
import { buildEngines, buildPlatform, cacheFolders, describePlatform, findPin, inspectBuilds } from '../../browser/builds.ts'
import { createStyle } from '../../reporters/style.ts'
import { interruptedExitCode } from '../../runner/outcome.ts'
import { listWords } from '../../shared/list-words.ts'
import { flag, value, parseArguments } from '../arguments.ts'
import { CliError, UsageError } from '../errors.ts'
import { installArchive } from '../install/install-archive.ts'
import { installExecutor } from '../install/install-executor.ts'
import { describeResult, installLicenceText, licenceLines, mirrorProblem, mirrorVariable, renderInspections } from '../install/report.ts'
import { systemUnpackTools } from '../install/unpack.ts'
import { installMedia } from '../install/media-install.ts'
import { inspectMedia } from '../install/media-record.ts'
import { renderMediaInstall, renderMediaListing } from '../install/media-report.ts'
import { suggest } from '../suggest.ts'
import { shouldUseColor } from '../terminal.ts'

const installEngines: readonly (BuildEngine | 'media')[] = [...buildEngines, 'media']

const options = {
  'media-binary': value({ placeholder: '<path>', description: 'Install a prebuilt media binary only if its exact build has a pinned checksum' }),
  'media-mirror': value({ placeholder: '<url>', description: 'Install a pinned prebuilt media binary from this mirror; checksums still apply' }),
  offline: flag('Build media with cargo --offline, using already cached pinned crates'),
  list: flag('List the pinned builds for this machine and what the cache holds. Nothing is downloaded'),
  verify: flag('With --list, read every file of each installed build again and compare the whole with its pin, or with its record where the pin holds no checksum of the whole'),
  json: flag('With --list, print one JSON document'),
}

export const installCommand: Command = {
  name: 'install',
  usage: '<engine...> | --list [options]',
  summary: 'Install pinned browser builds, or list what this machine holds',
  description: [
    'Downloads the pinned build of each engine named, checks its size and SHA-256 against the pin before it unpacks',
    'anything, checks that the build carries every licence notice the pin names, and records it in the cache:',
    '~/Library/Caches/retest on macOS, $XDG_CACHE_HOME/retest or ~/.cache/retest on Linux.',
    'Nothing is downloaded unless an engine is named here: run, doctor and --list never download.',
    'A pin with no checksum, or a build published without the notices it must carry, is refused before anything is',
    'fetched. The native executors are built on this Mac from their pinned commits, from the checkouts a native run',
    'builds from; nothing is cloned. install media builds the shipped Rust crate with cargo --locked.',
    'Media needs Rust 1.88 or later and the host ffmpeg. --media-binary and --media-mirror refuse without an exact pin.',
    `${mirrorVariable} names a mirror to fetch from instead, with each publisher's host as its first folder. The`,
    'checksums still apply. A mirror address with a user name, password, query or fragment is refused, and only the',
    'origin and path of any address are printed or recorded.',
  ].join('\n'),
  options,
  notes: `Engines: ${installEngines.join(', ')}.\nExit codes: 0 every engine named is installed, 2 one is not, or --list found a build folder that does not match or that Retest did not install, 130 interrupted, 143 stopped by SIGTERM.`,
  async run(args, dependencies) {
    const parsed = parseArguments(options, args)
    const listing = parsed.flag('list')
    if (!listing && (parsed.flag('verify') || parsed.flag('json'))) throw new UsageError('--verify and --json go with --list.')
    if (listing && parsed.positionals.length > 0) throw new UsageError(`--list takes no engines, received ${parsed.positionals.join(' ')}.`)
    const engines = listing ? [] : readEngines(parsed.positionals)
    if ((parsed.value('media-binary') !== undefined || parsed.value('media-mirror') !== undefined || parsed.flag('offline')) && (listing || engines.length !== 1 || engines[0] !== 'media')) throw new UsageError('Media build options require install media alone.')
    const platform = thisPlatform()
    const folders = cacheFolders(dependencies.env)
    if (folders === undefined) throw new CliError('HOME is not set to an absolute folder, so Retest has no cache folder to install into or read.')
    const style = createStyle(shouldUseColor(dependencies.stdout, dependencies.env))
    if (listing) {
      const inspections = await inspectBuilds(platform, folders, { verify: parsed.flag('verify') })
      const media = await inspectMedia(dependencies.env, { verify: parsed.flag('verify') })
      dependencies.stdout.write(renderMediaListing(renderInspections({ platform, folders, inspections, json: parsed.flag('json'), style }), media, parsed.flag('json')))
      return media?.state === 'damaged' || media?.state === 'unverifiable' || inspections.some((inspection) => inspection.state === 'damaged' || inspection.state === 'unverifiable') ? 2 : 0
    }
    const mirror = dependencies.env[mirrorVariable]
    const problem = engines.every((engine) => engine === 'media') || mirror === undefined || mirror === '' ? undefined : mirrorProblem(mirror)
    if (problem !== undefined) throw new CliError(problem)
    const home = dependencies.env['HOME'] ?? ''
    let failed = false
    for (const engine of engines) {
      if (dependencies.signal.aborted) break
      if (engine === 'media') {
        const result = await installMedia({ env: dependencies.env, signal: dependencies.signal, version: dependencies.version, report: (line) => void dependencies.stdout.write(`  ${style.dim(line)}\n`), binary: parsed.value('media-binary'), mirror: parsed.value('media-mirror'), offline: parsed.flag('offline') })
        dependencies.stdout.write(renderMediaInstall(result))
        if (!result.ok) failed = true
        continue
      }
      const pin = findPin(engine, platform)
      if (pin === undefined) {
        failed = true
        dependencies.stdout.write(describeResult(engine, { ok: false, message: `Retest pins no ${engine} build for ${describePlatform(platform)}.`, stopped: false }, style))
        continue
      }
      const notices = installLicenceText(pin, folders)
      if (notices !== undefined) dependencies.stdout.write(`  ${notices}\n`)
      const detail = new Set(licenceLines(pin))
      const report = (line: string): void => {
        if (!detail.has(line)) dependencies.stdout.write(`  ${style.dim(line)}\n`)
      }
      const result = pin.kind === 'archive'
        ? await installArchive({ pin, folders, mirror: mirror === '' ? undefined : mirror, signal: dependencies.signal, tools: systemUnpackTools, platform: process.platform, version: dependencies.version, report })
        : await installExecutor({ pin, folders, home, signal: dependencies.signal, report })
      dependencies.stdout.write(describeResult(engine, result, style))
      if (!result.ok) failed = true
    }
    if (dependencies.signal.aborted) return interruptedExitCode(dependencies.signal)
    return failed ? 2 : 0
  },
}

function readEngines(names: readonly string[]): (BuildEngine | 'media')[] {
  if (names.length === 0) throw new UsageError(`Name the engines to install: ${listWords(installEngines, 'or')}. Or list them with --list.`)
  const engines: (BuildEngine | 'media')[] = []
  for (const name of names) {
    const engine = installEngines.find((candidate) => candidate === name)
    if (engine === undefined) {
      const guess = suggest(name, installEngines)
      throw new UsageError(`Unknown engine ${name}.${guess === undefined ? ` The engines are ${listWords(installEngines, 'and')}.` : ` Did you mean ${guess}?`}`)
    }
    if (!engines.includes(engine)) engines.push(engine)
  }
  return engines
}

function thisPlatform(): BuildPlatform {
  const platform = buildPlatform()
  if (platform === undefined) throw new CliError(`Retest pins builds for macOS arm64 and Linux x64, and this machine is ${process.platform} ${process.arch}.`)
  return platform
}
