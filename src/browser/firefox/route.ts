/**
 * How Firefox is started. `spawn`, the default, makes it a child of this process, the leader of a new process group,
 * as Retest starts Chromium. `launch-services` asks macOS to start the app bundle with `open`, for one kind of host: a
 * macOS app that may not let its children read `~/Library/Application Support/Firefox`, which Firefox reads before
 * anything else even when given a profile, so a Firefox it spawns never starts. That route gives up the child
 * relationship, the inherited environment (only what Retest passes reaches Firefox) and the host's own privacy
 * grants, which is why it is never chosen for a host: the person running Retest chooses it.
 */
export type FirefoxRoute = 'spawn' | 'launch-services'

/** The variable that chooses the route, which belongs to the machine and its host app rather than to a project. */
export const firefoxRouteVariable = 'RETEST_FIREFOX_ROUTE'

/**
 * The route the environment chooses: `spawn` when RETEST_FIREFOX_ROUTE is unset or empty, `launch-services` only on
 * macOS, and anything else refused by name.
 *
 * @example firefoxRoute({ RETEST_FIREFOX_ROUTE: 'launch-services' }) // { ok: true, route: 'launch-services' } on macOS
 */
export function firefoxRoute(environment: Readonly<Record<string, string | undefined>>, platform: NodeJS.Platform = process.platform): { ok: true; route: FirefoxRoute } | { ok: false; message: string } {
  const configured = environment[firefoxRouteVariable]
  if (configured === undefined || configured === '' || configured === 'spawn') return { ok: true, route: 'spawn' }
  if (configured !== 'launch-services') return { ok: false, message: `${firefoxRouteVariable} must be spawn or launch-services, received ${JSON.stringify(configured)}.` }
  if (platform !== 'darwin') return { ok: false, message: `${firefoxRouteVariable}=launch-services needs macOS, which starts the app through Launch Services. Leave it unset to spawn Firefox.` }
  return { ok: true, route: 'launch-services' }
}
