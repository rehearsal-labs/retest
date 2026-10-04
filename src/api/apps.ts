import type { AppHasTouch, AppKind, AppName, DefaultAppName, IsRegistered, RetestTypeError } from '../config/register.ts'
import type { ElectronPage, NativePage, Page } from './page.ts'

/**
 * A test's handle on one app, which offers only what the app's targets can do: a web page for browsers, with `tap()`
 * when every target has a touch screen, an Electron app's page, a web page with no `goto`, and a native app's handle
 * for an iOS simulator or macOS app, with no `goto`. An app whose targets mix kinds, which the loader refuses, has no
 * handle.
 */
export type AppHandle<Name extends AppName> = [AppKind<Name>] extends ['web']
  ? Page<AppHasTouch<Name>>
  : [AppKind<Name>] extends ['electron']
    ? ElectronPage
    : [AppKind<Name>] extends ['ios-simulator']
      ? NativePage<'ios-simulator'>
      : [AppKind<Name>] extends ['macos']
        ? NativePage<'macos'>
        : 'electron' extends AppKind<Name>
          ? RetestTypeError<"This app's targets mix an Electron app with another kind. Give each kind an app of its own.">
          : RetestTypeError<"This app's targets mix browsers and native apps. Give each kind an app of its own.">

/** One handle for each app a test declares, named as the config names the app. */
export type Apps<Names extends AppName> = { readonly [Name in Names]: AppHandle<Name> }

type DefaultPage = IsRegistered extends true
  ? [DefaultAppName] extends [never]
    ? RetestTypeError<'This config has several apps and no defaultApp. List the apps the test uses in apps, or set defaultApp.'>
    : AppHandle<DefaultAppName>
  : Page<false>

/** What a test that declares no apps receives: `page`, the default app's page, in a new browser context. */
export type TestContext = { readonly page: DefaultPage }

/** What a test's function receives: `page` without apps, and one page per app with them. */
export type ContextFor<Names extends AppName> = [Names] extends [never] ? TestContext : Apps<Names>

/** A test's function. Await every action and assertion inside it. */
export type TestBody<Context = TestContext> = (context: Context) => void | Promise<void>
