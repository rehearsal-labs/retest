// Pinned source files and notices. Regenerate together after a reviewed crate or lock change.
export const mediaVersion: string = '0.1.0'
export const minimumRust: string = '1.88.0'
/** Fixed limits for the pinned media binary and each shipped source or notice file. */
export const maximumMediaBinaryBytes: number = 64 * 1024 * 1024
export const maximumMediaSourceBytes: number = 1024 * 1024
export const mediaSourceDigest: string = '3e967ac7cf0a0b9faaa40fbe9e761476103fddae3e8bfdb4606b32b9eaaf270b'
export const mediaSourceFiles: readonly { readonly path: string; readonly sha256: string }[] = [
  { path: 'media/Cargo.toml', sha256: '7d68b73873840d3968ba354b1d010186ef1df4b96ecdcc5a7b6a74e4696efbf4' },
  { path: 'media/Cargo.lock', sha256: 'ded3cee3c32d990f089b0e4fba70222b200d386482869dff46d9987854451ed5' },
  { path: 'media/build.rs', sha256: 'fd8fac59c589459c46c32508f175ac47c60118612a7561c60e39ce2787d8bee2' },
  { path: 'media/src/allocations.rs', sha256: 'c752e4e7342e8886348da903854a624b2dbfcedfc0da087bc74ab80e4459434a' },
  { path: 'media/src/encoder.rs', sha256: '675a7a7b299821af6e4e115ff8d7f30c6c12417284bd7027a573a337352d3768' },
  { path: 'media/src/frame.rs', sha256: '88642491694812d3028ea1431d2afe8664aa29ca106db48b49f9bbff868cea3e' },
  { path: 'media/src/jobs.rs', sha256: '3e8cef01fbda58e4ae5f306dd9301c24ec230380014cd17491c5727fe5011f0d' },
  { path: 'media/src/ledger.rs', sha256: 'f0e72a8a178deff760cfe6c768f2660966de5c3c25fdff4eac732bea0f96c2c9' },
  { path: 'media/src/live.rs', sha256: 'a195cd510988345ce66e1e1f6931cf72877007cc12763c94547cf01efa36f4b6' },
  { path: 'media/src/main.rs', sha256: 'f8746ab90a4b1aa87e904b0e9081ee474968f6d9c8316731c4e21b001328e220' },
  { path: 'media/src/place.rs', sha256: 'a47acbc1b52d3b4c4c4a89cd885e0986262f45d13b704f059e2aac3143af4b75' },
  { path: 'media/src/process_ownership.rs', sha256: '5f2913404de98e619166ed06b6c9830a2d07a3814fc263ee5b8ce20c21b55362' },
  { path: 'media/src/protocol.rs', sha256: '3060fe05ca5d63d291dec05449a3fa9f79bcd114e4fbd26e487619fe62ab68be' },
  { path: 'media/src/queue.rs', sha256: '8c5993bc5d2fdbdb4e5684cad9236af6c4a03e711e658256fb4ed27e413cc7fa' },
  { path: 'media/src/recording.rs', sha256: '2240e9871bf25ecfab249fb8535677a4498e07b68f574ef4440ee652253891ee' },
  { path: 'media/src/replies.rs', sha256: '82726ffed2e5097354575e3abee7850c97a005441497d1ed00dd42072c5c8547' },
  { path: 'media/src/server.rs', sha256: '74f62bd0c7242125bed264afa3c427431ceb83893f22e80cdae102145fcbb83a' },
  { path: 'media/src/store.rs', sha256: '397544b2f2237ca58b4cdb1378411040fb4d4eabd80179446ceca2b0a86c1c76' },
  { path: 'media/src/timeline.rs', sha256: '48be1f8e08895a35a41c4bea2d99f59384523541fd024826f65acafdb9ac7310' },
  { path: 'LICENSE', sha256: 'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30' },
  { path: 'src/cli/install/media-notices.txt', sha256: '26c332ecf5ecee82d4557f1d794cec952da08dd5c9f4c2b3a1f73fd75fb79172' },
]

export type MediaTarget = 'aarch64-apple-darwin' | 'x86_64-unknown-linux-gnu'

export function mediaTarget(platform: NodeJS.Platform = process.platform, arch: string = process.arch): MediaTarget | undefined {
  if (platform === 'darwin' && arch === 'arm64') return 'aarch64-apple-darwin'
  if (platform === 'linux' && arch === 'x64') return 'x86_64-unknown-linux-gnu'
  return undefined
}

/** No publisher artifact has been released and checked. An absent checksum is a refusal, never trust on first use. */
export type MediaPrebuiltPin = { readonly target: MediaTarget; readonly version: string; readonly protocol: number; readonly sourceDigest: string; readonly sha256: string; readonly size: number; readonly url: string }
export const mediaPrebuiltPins: readonly MediaPrebuiltPin[] = []
