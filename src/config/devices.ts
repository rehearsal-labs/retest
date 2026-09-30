import type { Emulation } from '../protocol/emulation.ts'

/** The devices a desktop target can emulate by name. */
export const deviceNames = ['Pixel 9', 'Galaxy S24', 'iPhone 17', 'iPad Pro 11'] as const

export type DeviceName = (typeof deviceNames)[number]

/** The named devices with a touch screen. Every device in the table has one, and a unit test keeps that true. */
export type TouchDeviceName = DeviceName

type DeviceProfile = Omit<Emulation, 'userAgent'> & { userAgent: (major: string) => string }

// Chrome's reduced user agent names neither the Android version nor the model.
const chromeOnAndroid = (major: string): string =>
  `Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Mobile Safari/537.36`
const safariOnIphone = (): string =>
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1'
// Safari on an iPad asks for desktop sites by default, so it says it is a Mac.
const safariOnIpad = (): string =>
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15'

const profiles: Readonly<Record<DeviceName, DeviceProfile>> = {
  'Pixel 9': {
    viewport: { width: 412, height: 923 },
    deviceScaleFactor: 2.625,
    touch: true,
    isMobile: true,
    userAgent: chromeOnAndroid,
  },
  'Galaxy S24': {
    viewport: { width: 360, height: 780 },
    deviceScaleFactor: 3,
    touch: true,
    isMobile: true,
    userAgent: chromeOnAndroid,
  },
  'iPhone 17': {
    viewport: { width: 402, height: 874 },
    deviceScaleFactor: 3,
    touch: true,
    isMobile: true,
    userAgent: safariOnIphone,
  },
  'iPad Pro 11': {
    viewport: { width: 834, height: 1210 },
    deviceScaleFactor: 2,
    touch: true,
    isMobile: true,
    userAgent: safariOnIpad,
  },
}

/**
 * What a page does to emulate a target: a named device, in portrait, or the target's own settings as they are.
 * A device's Chrome user agent carries the running browser's major version, so a site sees the engine it is
 * really talking to.
 *
 * @example emulationFor('Pixel 9', '154.0.7195.41').userAgent // '... Chrome/154.0.0.0 Mobile Safari/537.36'
 */
export function emulationFor(emulate: DeviceName | Emulation, browserVersion: string): Emulation {
  if (typeof emulate !== 'string') return { ...emulate, viewport: { ...emulate.viewport } }
  const { userAgent, viewport, ...profile } = profiles[emulate]
  const major = /^\d+/.exec(browserVersion)?.[0] ?? browserVersion
  return { ...profile, viewport: { ...viewport }, userAgent: userAgent(major) }
}

/** Whether a string names a device in the table. */
export function isDeviceName(name: string): name is DeviceName {
  return deviceNames.some((known) => known === name)
}
