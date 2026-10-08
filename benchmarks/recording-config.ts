import type { Engine } from './recording-options.ts'

export function recordingConfig(engine: Engine, path: string, baseUrl: string, record: boolean, diagnostics: boolean): string {
  return `import { defineConfig } from '@rehearsal-labs/retest'
export default defineConfig({
  apps: { web: { browser: ${JSON.stringify(engine)}, executablePath: ${JSON.stringify(path)}, baseUrl: ${JSON.stringify(baseUrl)}, headless: true, viewport: { width: 1280, height: 720 } } },
  diagnostics: { capture: ${diagnostics} },
${!diagnostics && !record ? "  pixels: { web: { screenshots: 'never', recordings: 'never' } },\n" : ''}  recording: { record: ${record}, required: ${record}, keep: 'all', fps: 10, size: { width: 1280, height: 720 } },
  timeouts: { test: 30000, action: 5000, assertion: 5000, navigation: 30000 },
})
`
}

export function matchedPlaywrightConfig(browser: string, baseUrl: string): string {
  return `import { defineConfig } from '@playwright/test'
export default defineConfig({
  testDir: './tests', workers: 1, retries: 0, timeout: 30000, expect: { timeout: 5000 },
  use: { baseURL: ${JSON.stringify(baseUrl)}, browserName: 'chromium', headless: true,
    viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1, actionTimeout: 5000, navigationTimeout: 30000,
    video: 'off', trace: 'off', screenshot: 'off', launchOptions: { executablePath: ${JSON.stringify(browser)} } },
})
`
}
