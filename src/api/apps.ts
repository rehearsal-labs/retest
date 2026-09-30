import type { AppHasTouch, AppName, DefaultAppName, IsRegistered, RetestTypeError } from '../config/register.ts'
import type { Page } from './page.ts'

/** One page for each app a test declares, named as the config names the app. */
export type Apps<Names extends AppName> = { readonly [Name in Names]: Page<AppHasTouch<Name>> }

type DefaultPage = IsRegistered extends true
  ? [DefaultAppName] extends [never]
    ? RetestTypeError<'This config has several apps and no defaultApp. List the apps the test uses in apps, or set defaultApp.'>
    : Page<AppHasTouch<DefaultAppName>>
  : Page<false>

/** What a test that declares no apps receives: `page`, the default app's page, in a new browser context. */
export type TestContext = { readonly page: DefaultPage }

/** What a test's function receives: `page` without apps, and one page per app with them. */
export type ContextFor<Names extends AppName> = [Names] extends [never] ? TestContext : Apps<Names>

/** A test's function. Await every action and assertion inside it. */
export type TestBody<Context = TestContext> = (context: Context) => void | Promise<void>
