// Pinned source files and notices of retest-supervisor. Regenerate together after a reviewed crate or lock change.
export const supervisorVersion: string = '0.1.0'
export const minimumSupervisorRust: string = '1.88.0'
/** Fixed limits for the built binary and each shipped source or notice file. */
export const maximumSupervisorBinaryBytes: number = 16 * 1024 * 1024
export const maximumSupervisorSourceBytes: number = 1024 * 1024
export const supervisorSourceDigest: string = '7790e5960f4247f8370a6b361d7f183b2b153f938c3a3fc091e723edd7f4e8a8'
export const supervisorSourceFiles: readonly { readonly path: string; readonly sha256: string }[] = [
  { path: 'supervisor/Cargo.toml', sha256: '8b21a215325f93ae556e4119cbf5e1161592bd9798aedb64e892b21b730fbf85' },
  { path: 'supervisor/Cargo.lock', sha256: '5b18a75f3d341cc37c4c0178195ab3b29888e46b205e4e7ae59cadc041b403c9' },
  { path: 'supervisor/build.rs', sha256: 'a1a635b6ace744ef9f0cadf8540f01daeefa0783d9789da0de0266ff3206cc82' },
  { path: 'supervisor/src/command.rs', sha256: 'f395868828e1d3dcf39e6deb1165af62150add2df90059753aa22f781bc89299' },
  { path: 'supervisor/src/jobs.rs', sha256: '2b78eea05a8037b2442290215c7ad12634f8ccd962f491dfdb0f1f5f9bb0d579' },
  { path: 'supervisor/src/main.rs', sha256: '7a4ac8c30bd4401bb2e3cbc4d6621ea15444f5ddf2820388b7d5faffe8bf7e83' },
  { path: 'supervisor/src/reply.rs', sha256: '97cca24d9a3a3d0403f37697b39aa6e134860aebb1a3345f0dfc19d07b95d3bd' },
  { path: 'supervisor/NOTICES', sha256: 'b78dcadcbc81915a91a475ff1a6603b1b5261bb23d83e0fd36919bf782af8a1d' },
  { path: 'LICENSE', sha256: 'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30' },
]

/** The one target the supervisor is for: Windows on x64. Windows on Arm comes in a later version. */
export type SupervisorTarget = 'x86_64-pc-windows-msvc'

/**
 * The supervisor's build target on this machine, or undefined where Retest needs no supervisor or has none yet.
 *
 * @example supervisorTarget('win32', 'x64') // 'x86_64-pc-windows-msvc'
 */
export function supervisorTarget(platform: NodeJS.Platform = process.platform, arch: string = process.arch): SupervisorTarget | undefined {
  return platform === 'win32' && arch === 'x64' ? 'x86_64-pc-windows-msvc' : undefined
}

/** The executable `cargo build` writes and the install keeps. */
export const supervisorExecutable: string = 'retest-supervisor.exe'
