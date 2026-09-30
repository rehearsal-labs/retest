import { s, type Schema } from './schema.ts'

/**
 * What a desktop browser does to pass for another screen: the viewport in CSS pixels, the pixel ratio, a touch
 * screen, mobile layout, and a user agent, when it replaces the browser's own. It is always reported as emulated.
 */
export type Emulation = {
  viewport: { width: number; height: number }
  deviceScaleFactor: number
  touch: boolean
  isMobile: boolean
  userAgent?: string
}

const pixels = s.number({ integer: true, min: 1 })

export const emulationSchema: Schema<Emulation> = s.object({
  viewport: s.object({ width: pixels, height: pixels }),
  deviceScaleFactor: s.number({ min: 0 }),
  touch: s.boolean(),
  isMobile: s.boolean(),
  userAgent: s.optional(s.string()),
})
