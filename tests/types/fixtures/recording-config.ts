import { chromium, defineConfig } from '../../../src/index.ts'

export const recordingDefaults = defineConfig({ apps: { web: chromium() } })
export const nativeWithholding = defineConfig({ apps: { web: chromium() }, recording: { nativeWithholding: true } })
export const badNativeWithholding = defineConfig({ apps: { web: chromium() }, recording: { nativeWithholding: 'true' } }) // type-error TS2322 Type 'string' is not assignable to type 'boolean | undefined'
export const recordingOff = defineConfig({ apps: { web: chromium() }, recording: { record: false } })
export const recordingOneApp = defineConfig({ apps: { web: chromium() }, recording: { apps: { web: true }, required: true, keep: 'failures', fps: 10, size: { width: 800, height: 600 } }, pixels: { web: { screenshots: 'never', recordings: 'allowed' } } })
export const badRecordingFlag = defineConfig({ apps: { web: chromium() }, recording: { record: 'yes' } }) // type-error TS2322 Type 'string' is not assignable to type 'boolean | undefined'
export const badRetention = defineConfig({ apps: { web: chromium() }, recording: { keep: 'sometimes' } }) // type-error TS2322 Type '"sometimes"' is not assignable to type
export const badAppFlag = defineConfig({ apps: { web: chromium() }, recording: { apps: { web: 'yes' } } }) // type-error TS2322 Type 'string' is not assignable to type 'boolean'
export const badPixelPermission = defineConfig({ apps: { web: chromium() }, pixels: { web: { screenshots: 'masked' } } }) // type-error TS2322 Type '"masked"' is not assignable to type
export const badVideoSize = defineConfig({ apps: { web: chromium() }, recording: { size: { width: 800 } } }) // type-error TS2741 Property 'height' is missing
