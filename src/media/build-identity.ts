import type { Hello } from './protocol.ts'
import { mediaTarget, mediaVersion } from '../cli/install/media-pins.ts'

/** One check for the install probe, doctor and the runner's live media greeting. */
export function mediaGreetingProblem(executable: string, hello: Hello, target: string | undefined = mediaTarget()): string | undefined {
  if (hello.version !== mediaVersion) return `${executable} is retest-media ${hello.version}, expected ${mediaVersion}. Run npx retest install media.`
  if (target === undefined) return `${executable} has no pinned media host target for ${process.platform} ${process.arch}.`
  if (hello.build.target !== target || hello.build.profile !== 'release') return `${executable} is built for ${hello.build.target} in ${hello.build.profile}, expected ${target} in release. Run npx retest install media.`
  return undefined
}
