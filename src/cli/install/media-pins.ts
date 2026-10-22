// Pinned source files and notices. Regenerate together after a reviewed crate or lock change.
export const mediaVersion: string = '0.1.0'
export const minimumRust: string = '1.88.0'
/** Fixed limits for the pinned media binary and each shipped source or notice file. */
export const maximumMediaBinaryBytes: number = 64 * 1024 * 1024
export const maximumMediaSourceBytes: number = 1024 * 1024
export const mediaSourceDigest: string = '1b5d0357a1fdf3e9f167131bfa25b95980016655134116dbf52b3ed67c8e9aa6'
export const mediaSourceFiles: readonly { readonly path: string; readonly sha256: string }[] = [
  { path: 'media/Cargo.toml', sha256: 'f16379ae5212da4cb4c0ae2c06df4562342ad95455e61a6b83e4b7c8bdb2d190' },
  { path: 'media/Cargo.lock', sha256: '43c003fc9a5581ad5439490efd4353fadb3eddd72902d863aa8f3adafcf90f9b' },
  { path: 'media/build.rs', sha256: 'fd8fac59c589459c46c32508f175ac47c60118612a7561c60e39ce2787d8bee2' },
  { path: 'media/src/allocations.rs', sha256: 'c752e4e7342e8886348da903854a624b2dbfcedfc0da087bc74ab80e4459434a' },
  { path: 'media/src/encoder.rs', sha256: '09090bdd70849d45970eabab8c9320a47a511c7d5f2d9a85cfcb54094283c7ef' },
  { path: 'media/src/frame.rs', sha256: 'ee2d6cfa4fd5f53a8cca08aecdd7504f5043b491c0d34de27e8caaf658a6c44a' },
  { path: 'media/src/jobs.rs', sha256: '3e8cef01fbda58e4ae5f306dd9301c24ec230380014cd17491c5727fe5011f0d' },
  { path: 'media/src/ledger.rs', sha256: 'f0e72a8a178deff760cfe6c768f2660966de5c3c25fdff4eac732bea0f96c2c9' },
  { path: 'media/src/live.rs', sha256: 'a195cd510988345ce66e1e1f6931cf72877007cc12763c94547cf01efa36f4b6' },
  { path: 'media/src/main.rs', sha256: '37adada6ca274c9c42463bf3d816acce31a9030c8c6ea02b1cc66d227ab18e0a' },
  { path: 'media/src/place.rs', sha256: 'a6e8270ec3f89b2fc277a550e5043af44406daf604e8890da3222ffe97d0d6e7' },
  { path: 'media/src/process_ownership.rs', sha256: '5f2913404de98e619166ed06b6c9830a2d07a3814fc263ee5b8ce20c21b55362' },
  { path: 'media/src/process_ownership_windows.rs', sha256: '759d1ee5ec8191a84522e791828a55a4b733e6829d0b51ddb75a1f875f5c2dad' },
  { path: 'media/src/protocol.rs', sha256: '3060fe05ca5d63d291dec05449a3fa9f79bcd114e4fbd26e487619fe62ab68be' },
  { path: 'media/src/queue.rs', sha256: '8c5993bc5d2fdbdb4e5684cad9236af6c4a03e711e658256fb4ed27e413cc7fa' },
  { path: 'media/src/recording.rs', sha256: '84b2437aa62f52239606cf2da0c7319eea358b8b870732327a85ee97a6da304f' },
  { path: 'media/src/replies.rs', sha256: '8fb2d312dc31a3090ae49a8e47f5697166a23dc9846c4788c7e61839f5746e17' },
  { path: 'media/src/server.rs', sha256: '01834e8a6ace6d7517d7c6d2f96bdb41cd1171ceadde561aca46133169031b66' },
  { path: 'media/src/store.rs', sha256: '48247649b875c2d508ebd860ec8492fdc9a0407cc803cbbc46a121d01378e9e9' },
  { path: 'media/src/timeline.rs', sha256: '48be1f8e08895a35a41c4bea2d99f59384523541fd024826f65acafdb9ac7310' },
  { path: 'LICENSE', sha256: 'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30' },
  { path: 'src/cli/install/media-notices.txt', sha256: '172209e5295f60ef284f33dec45bac36d00d4803a329cafba27cd6218d14834a' },
]

export type MediaTarget = 'aarch64-apple-darwin' | 'x86_64-unknown-linux-gnu' | 'x86_64-pc-windows-msvc'

export function mediaTarget(platform: NodeJS.Platform = process.platform, arch: string = process.arch): MediaTarget | undefined {
  if (platform === 'darwin' && arch === 'arm64') return 'aarch64-apple-darwin'
  if (platform === 'linux' && arch === 'x64') return 'x86_64-unknown-linux-gnu'
  if (platform === 'win32' && arch === 'x64') return 'x86_64-pc-windows-msvc'
  return undefined
}

/**
 * The media binary's file name for a target, the name Cargo builds it under.
 *
 * @example mediaExecutableName('x86_64-pc-windows-msvc') // 'retest-media.exe'
 */
export function mediaExecutableName(target: MediaTarget): string {
  return target === 'x86_64-pc-windows-msvc' ? 'retest-media.exe' : 'retest-media'
}

/** No publisher artifact has been released and checked. An absent checksum is a refusal, never trust on first use. */
export type MediaPrebuiltPin = { readonly target: MediaTarget; readonly version: string; readonly protocol: number; readonly sourceDigest: string; readonly sha256: string; readonly size: number; readonly url: string }
export const mediaPrebuiltPins: readonly MediaPrebuiltPin[] = []
