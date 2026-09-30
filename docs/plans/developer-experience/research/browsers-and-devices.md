# How existing tools name browsers, engines, devices and platforms

Research for the Retest developer-experience plan, 30 September 2026. Track: how Playwright, WebdriverIO, Appium, Maestro, Detox, Selenium, Cypress and the newer mobile libraries express what a test runs on, what that costs a developer, and what a single Retest config could look like.

Method. Official documentation sources were read from the projects' own repositories (raw Markdown) or documentation sites, and current versions were read from the npm registry and GitHub releases on 30 September 2026. The `safaridriver` manual page was read from this Mac (macOS 27.0, build 26A428). Nothing was installed or run. Snippets marked "copied" are verbatim from the linked source. Anything marked **unverified** was not confirmed against a primary source in this session.

Versions checked on 30 September 2026 (npm registry `latest` unless noted): `@playwright/test` 1.63.0, `webdriverio` 9.32.0 (v10 in progress, [tracking issue](https://github.com/webdriverio/webdriverio/issues/15646)), `appium` 3.8.0, `appium-xcuitest-driver` 12.13.3, `appium-uiautomator2-driver` 8.7.0, `appium-mac2-driver` 4.3.5, `detox` 20.51.4, `cypress` 16.1.1, `selenium-webdriver` 4.49.0, `@wdio/electron-service` 10.3.0, `@wdio/tauri-service` 1.4.0, `mobilewright` 0.0.62 (published 29 September 2026), `appwright` 0.1.45 (last published December 2024). Maestro CLI 2.11.0 was released 29 September 2026 ([releases](https://github.com/mobile-dev-inc/maestro/releases)). geckodriver 0.37.1 was released 20 July 2026 ([releases](https://github.com/mozilla/geckodriver/releases)).

## 1. Playwright

### Projects and device presets

A project is a named entry in a list. Every test runs once per project. The name is a free string, and `use` spreads a device preset plus options such as `channel`. Copied from [Projects](https://playwright.dev/docs/test-projects):

```ts
import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
    /* Test against mobile viewports. */
    { name: 'Mobile Chrome', use: { ...devices['Pixel 5'] } },
    { name: 'Mobile Safari', use: { ...devices['iPhone 12'] } },
    /* Test against branded browsers. */
    { name: 'Microsoft Edge', use: { ...devices['Desktop Edge'], channel: 'msedge' } },
    { name: 'Google Chrome', use: { ...devices['Desktop Chrome'], channel: 'chrome' } },
  ],
});
```

(Whitespace condensed; content unchanged.) One project runs with `npx playwright test --project=firefox`. Projects can depend on a setup project through `dependencies: ['setup']` ([Projects](https://playwright.dev/docs/test-projects)).

A project is a matrix axis, not a composition. One test cannot declare "I need Chrome and an iPhone at once" in config. Inside one test you can open several contexts of the same browser for multi-user cases: "Playwright can create multiple browser contexts within a single scenario. This is useful when you want to test for multi-user functionality, like a chat" ([Isolation](https://playwright.dev/docs/browser-contexts)). Launching a second browser type inside a test is possible through the library API but is not described there.

### What a device preset actually is

A preset is a fixed record of user agent, screen, viewport, scale factor, `isMobile`, `hasTouch` and a default engine. The registry on `main` holds 207 descriptors: 105 default to WebKit, 100 to Chromium and 2 to Firefox (the two desktop Firefox entries), read from [deviceDescriptorsSource.json](https://raw.githubusercontent.com/microsoft/playwright/main/packages/isomorphic/deviceDescriptorsSource.json). The `iPhone 15` entry on 30 September 2026:

```json
{"userAgent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6 Mobile/15E148 Safari/604.1",
 "screen": {"width": 393, "height": 852}, "viewport": {"width": 393, "height": 659},
 "deviceScaleFactor": 3, "isMobile": true, "hasTouch": true, "defaultBrowserType": "webkit"}
```

The docs describe this as emulation: Playwright "will simulate the browser behavior such as `userAgent`, `screenSize`, `viewport` and if it `hasTouch` enabled" ([Emulation](https://playwright.dev/docs/emulation)). `isMobile` means "Whether the `meta viewport` tag is taken into account and touch events are enabled" ([params source](https://raw.githubusercontent.com/microsoft/playwright/main/docs/src/api/params.md)). The official example names a desktop WebKit build with an iPhone user agent "Mobile Safari". Nothing in the project name or the report says it is emulated. No preset exists for mobile Firefox.

### Engines, channels and installation

- Bundled engines are Chromium, Firefox and WebKit. Branded channels are `chrome`, `msedge`, `chrome-beta`, `msedge-beta`, `chrome-dev`, `msedge-dev`, `chrome-canary`, `msedge-canary` ([Browsers](https://playwright.dev/docs/browsers)).
- Chromium defaults to the headless shell. `channel: 'chromium'` opts into new headless mode. `--only-shell` and `--no-shell` choose which Chromium to download ([Browsers source](https://raw.githubusercontent.com/microsoft/playwright/main/docs/src/browsers.md)).
- Firefox: "Playwright's Firefox version matches the recent Firefox Stable build. Playwright doesn't work with the branded version of Firefox since it relies on patches" ([Browsers source](https://raw.githubusercontent.com/microsoft/playwright/main/docs/src/browsers.md)). An experimental `channel: 'moz-firefox'` drives stock Firefox over WebDriver BiDi; it appears in the issue tracker ([issue 42669](https://github.com/microsoft/playwright/issues/42669)) and a Mozilla dashboard ([Playwright BiDi dashboard](https://firefox-dev.tools/playwright-bidi-dashboard/)), not in the docs I read. **Unverified** as a supported option.
- WebKit: "Playwright doesn't work with the branded version of Safari since it relies on patches... While running WebKit on Linux CI is usually the most affordable option, for the closest-to-Safari experience you should run WebKit on mac" ([Browsers source](https://raw.githubusercontent.com/microsoft/playwright/main/docs/src/browsers.md)).
- Install: `npx playwright install`, `npx playwright install webkit`, `npx playwright install-deps`, and `npx playwright install --with-deps chromium` to fetch browsers and Linux system packages in one step. Branded Chrome and Edge install into the operating system's global location, "overriding your current browser installation" ([Browsers source](https://raw.githubusercontent.com/microsoft/playwright/main/docs/src/browsers.md)).
- Each release pins browser builds. 1.63 ships Chromium 153.0.8010.12, Firefox 155.0 and WebKit 26.6, and drops Ubuntu 20.04; on Linux arm64 it now downloads the Chrome for Testing build of Chromium ([Release notes](https://playwright.dev/docs/release-notes)).

### Chrome on Android (experimental)

`_android` drives Chrome for Android and Android WebView. Requirements, copied from the [docs source](https://raw.githubusercontent.com/microsoft/playwright/main/docs/src/mobile-api/class-android.md):

> - Android device or AVD Emulator.
> - ADB daemon running and authenticated with your device. Typically running `adb devices` is all you need to do.
> - Chrome 105 or newer installed on the device
> - "Enable command line on non-rooted devices" enabled in `chrome://flags`.
>
> Known limitations: Raw USB operation is not yet supported, so you need ADB. Device needs to be awake to produce screenshots. Enabling "Stay awake" developer mode will help. We didn't run all the tests against the device, so not everything works.

The published site still says Chrome 87 ([class-android](https://playwright.dev/docs/api/class-android)); the source on `main` says 105. Copied (abridged):

```js
const { _android: android } = require('playwright');
const [device] = await android.devices();
await device.shell('am force-stop com.android.chrome');
const context = await device.launchBrowser();
const page = await context.newPage();
await page.goto('https://webkit.org/');
```

It is a library API, not a project type. There is no `devices['Real Pixel']` and no iOS equivalent.

### Electron (experimental)

Copied from the [docs source](https://raw.githubusercontent.com/microsoft/playwright/main/docs/src/electron-api/class-electron.md):

```js
const { _electron: electron } = require('playwright');
const electronApp = await electron.launch({ args: ['main.js'] });
const appPath = await electronApp.evaluate(async ({ app }) => app.getAppPath());
const window = await electronApp.firstWindow();
await window.click('text=Click me');
await electronApp.close();
```

Supported Electron versions are "v21+" on `main` (the published page lists v12.2.0+, v13.4.0+, v14+). Launch timeouts come from a disabled `nodeCliInspect` fuse. Native dialogs are not intercepted; stub them through `electronApp.evaluate` ([docs source](https://raw.githubusercontent.com/microsoft/playwright/main/docs/src/electron-api/class-electron.md)). Electron's own fuse docs say of `nodeCliInspect`: "Most apps can safely disable this fuse" ([Electron fuses](https://www.electronjs.org/docs/latest/tutorial/fuses)). A hardened production build may therefore refuse this kind of launch.

### How reports show the project

Terminal output prefixes each test with its project name. Copied from the [Browsers source](https://raw.githubusercontent.com/microsoft/playwright/main/docs/src/browsers.md):

```text
  ✓ [chromium] › example.spec.ts:3:1 › basic test (2s)
  ✓ [Mobile Safari] › example.spec.ts:3:1 › basic test (2s)
  ✓ [Microsoft Edge] › example.spec.ts:3:1 › basic test (2s)
```

The HTML report filters with `p:<project>` in its search box ([issue 33681](https://github.com/microsoft/playwright/issues/33681)). The JUnit reporter can prefix test names with the project (`includeProjectInTestName`) ([Reporters](https://playwright.dev/docs/test-reporters)). The report shows the name the author typed, so "Mobile Safari" reads as Safari.

## 2. WebdriverIO

### Setup and capabilities

`npm init wdio@latest .` starts a wizard ([Getting started](https://webdriver.io/docs/gettingstarted)). Its first question offers "E2E Testing - of Web or Mobile Applications", "Component or Unit Testing - in the browser", "Desktop Testing - of Electron, Tauri, Dioxus, or macOS Applications", "VS Code Extension Testing" and "Roku Testing"; the E2E path then asks "Web" or "Mobile - native, hybrid and mobile web apps, on Android or iOS" ([wizard constants](https://raw.githubusercontent.com/webdriverio/webdriverio/main/packages/create-wdio/src/constants.ts)).

A target is a W3C capabilities object: a few standard keys plus vendor-prefixed extensions `goog:chromeOptions`, `moz:firefoxOptions`, `ms:edgeOptions`, `appium:*`, cloud keys such as `bstack:options`, and WebdriverIO's own `wdio:*` keys ([Capabilities source](https://raw.githubusercontent.com/webdriverio/webdriverio/main/website/docs/Capabilities.md)). Channels are a `browserVersion` value. Copied:

```ts
{
    browserName: 'chrome', // or 'chromium'
    browserVersion: '116' // or '116.0.5845.96', 'stable', 'dev', 'canary', 'beta' or 'latest' (same as 'canary')
}
```

Since v8.14 WebdriverIO downloads Chrome, Chromium and Firefox and their drivers itself; "Automated browser setup does not support Microsoft Edge"; "WebdriverIO won't automatically download Safari driver as it is already installed on macOS" ([Driver binaries source](https://raw.githubusercontent.com/webdriverio/webdriverio/main/website/docs/DriverBinaries.md)). Offline use needs a local browser, a full four-part version and a mirror, or it silently reaches a public endpoint ([Capabilities source](https://raw.githubusercontent.com/webdriverio/webdriverio/main/website/docs/Capabilities.md)).

### BiDi by default

"By default, WebdriverIO will attempt to start a local automation session using the WebDriver Bidi protocol" ([Automation protocols source](https://raw.githubusercontent.com/webdriverio/webdriverio/main/website/docs/AutomationProtocols.md)). `wdio:enforceWebDriverClassic: true` turns that off. Emulation commands need BiDi, which "recent versions of Chrome, Edge and Firefox have", while "Safari __does not__" ([Emulation source](https://raw.githubusercontent.com/webdriverio/webdriverio/main/website/docs/Emulation.md)). The `safaridriver` manual page on macOS 27.0 lists no `webSocketUrl` or BiDi capability (local `man safaridriver`).

WebdriverIO states the emulation limit plainly. Copied from the [Emulation source](https://raw.githubusercontent.com/webdriverio/webdriverio/main/website/docs/Emulation.md):

> This should, by no means, be used for mobile testing as desktop browser engines differ from mobile ones. This should only be used if your application offers a specific behavior for smaller viewport sizes.

```ts
const restore = await browser.emulate('device', 'iPhone 15')
```

### Services

Services wire a platform in. Mobile uses Appium (`npx appium-installer` is recommended, because "Setting up the right environment is not straight forward", [Appium setup source](https://raw.githubusercontent.com/webdriverio/webdriverio/main/website/docs/Appium.md)). Desktop services, copied from the desktop docs:

```ts
// Electron (https://webdriver.io/docs/desktop-testing/electron)
services: [['electron', { appEntryPoint: './path/to/bundled/electron/main.bundle.js', appArgs: [] }]]

// Tauri (https://webdriver.io/docs/desktop-testing/tauri)
services: [['tauri', { appBinaryPath: './src-tauri/target/release/my-tauri-app', driverProvider: 'embedded' }]]
```

The Electron service sets up a matching Chromedriver and finds Forge or Builder output ([Electron source](https://raw.githubusercontent.com/webdriverio/webdriverio/main/website/docs/desktop-testing/Electron.md)). The Tauri service drives WebView2 on Windows, WKWebView on macOS and WebKitGTK on Linux; macOS needs the embedded in-app WebDriver plugin or CrabNebula's driver, because "macOS has no WKWebView driver tool available" and CrabNebula needs "a paid API key" on macOS ([Tauri source](https://raw.githubusercontent.com/webdriverio/webdriverio/main/website/docs/desktop-testing/Tauri.md), [Tauri WebDriver](https://v2.tauri.app/develop/tests/webdriver/)). macOS apps go through Appium Mac2. Windows: "Unfortunately there is at the moment no stable driver for automating Windows applications" ([Windows source](https://raw.githubusercontent.com/webdriverio/webdriverio/main/website/docs/desktop-testing/Windows.md)).

### Multiremote: several sessions in one test

This is the closest existing model to Retest's per-test named apps. Instances are keys of the `capabilities` object. Copied from the [Multiremote source](https://raw.githubusercontent.com/webdriverio/webdriverio/main/website/docs/Multiremote.md):

```js
// wdio.conf.js: an object keyed by instance name, not an array
export const config = {
    capabilities: {
        myChromeBrowser: { capabilities: { browserName: 'chrome' } },
        myFirefoxBrowser: { capabilities: { browserName: 'firefox' } }
    }
}
```

```js
// standalone
import { multiremote } from 'webdriverio'
const browser = await multiremote({
    myChromeBrowser: { capabilities: { browserName: 'chrome' } },
    myFirefoxBrowser: { capabilities: { browserName: 'firefox' } }
})
await browser.url('http://json.org')              // runs on every instance
const title = await browser.getTitle()            // ['JSON', 'JSON']
await elem.getInstance('myFirefoxBrowser').click() // one instance only
```

How instances are reached:

- The runner registers each name as a global: `myChromeBrowser`.
- `browser['myChromeBrowser']`, `browser.getInstance('myChromeBrowser')`, and `browser.instances` for the list.
- `multiRemoteBrowser` is a global alias set only for multiremote sessions ([globals README](https://raw.githubusercontent.com/webdriverio/webdriverio/main/packages/wdio-globals/README.md)).
- Commands on `browser` fan out to every instance and return one result per instance.
- Several multiremote groups run in parallel by putting the objects in an array.
- Instances can mix local browsers, Appium devices and cloud sessions: "you can also boot up two mobile devices using Appium or one mobile device and one browser."

Typing is manual declaration merging. Copied:

```ts
// wdio.conf.ts
export const config: WebdriverIO.MultiremoteConfig = {
    capabilities: { myAppiumDriver: { /* ... */ }, myChromeDriver: { /* ... */ } }
}
// wdio.d.ts
declare namespace WebdriverIO {
    interface MultiRemoteBrowser {
        myAppiumDriver: WebdriverIO.Browser
        myChromeDriver: WebdriverIO.Browser
    }
}
```

Weak points visible in the docs themselves:

- The instance set is fixed per config, not per test. Every spec in that run gets every instance.
- The page contradicts itself. It says results are "an array of results" and shows `result[0]`, then says each result is "an object with the browser names as the key". It says commands run "in parallel with each instance", then "each command is executed one by one". Which is current is **unverified**.
- Names are typed twice, once in config and once in a `.d.ts`, with nothing linking them.
- A phone-plus-browser multiremote config is described in prose only; I found no copied example of that exact mix.

## 3. Real mobile browsers

### Chrome on Android

- **CDP directly.** Enable USB debugging, then `adb forward tcp:9222 localabstract:chrome_devtools_remote`; `http://localhost:9222/json` lists page targets ([Remote debug Android devices](https://developer.chrome.com/docs/devtools/remote-debugging)). Google's `chrome-devtools-mcp` uses exactly this and connects to `ws://127.0.0.1:9222/devtools/browser/`, calling it experimental because "Puppeteer does not officially support Chrome on Android as a target" ([debugging-android](https://raw.githubusercontent.com/ChromeDevTools/chrome-devtools-mcp/main/docs/debugging-android.md)). This is the route that fits Retest's own CDP client.
- **ChromeDriver.** `goog:chromeOptions.androidPackage` is `com.android.chrome` (stable) or `com.chrome.beta`; optional `androidDeviceSerial`, `androidUseRunningApp`; WebView apps add `androidActivity` and `androidProcess`. No root since Chrome 33; WebView needs web debugging enabled in the app ([ChromeDriver on Android](https://developer.chrome.com/docs/chromedriver/get-started/android)).
- **Appium UiAutomator2.** Copied from [capability sets](https://raw.githubusercontent.com/appium/appium-uiautomator2-driver/master/docs/capability-sets.md):

```json
{ "platformName": "Android", "appium:automationName": "uiautomator2",
  "browserName": "Chrome", "appium:avd": "<Emulator_Name>", "appium:platformVersion": "<Android_Version>" }
```

It needs a Chromedriver matching the device's Chrome; automatic download requires starting Appium with `--allow-insecure uiautomator2:chromedriver_autodownload` ([UiAutomator2 README](https://github.com/appium/appium-uiautomator2-driver#automatic-discovery-of-compatible-chromedriver)).

### Firefox on Android

geckodriver 0.26+ drives GeckoView packages. Keys under `moz:firefoxOptions`: `androidPackage` (e.g. `org.mozilla.firefox`, `org.mozilla.firefox_beta`, `org.mozilla.geckoview_example`), `androidActivity`, `androidDeviceSerial` (an error if several devices are attached and it is missing), `androidIntentArguments` ([firefoxOptions on MDN](https://developer.mozilla.org/en-US/docs/Web/WebDriver/Reference/Capabilities/firefoxOptions)). Copied:

```json
{ "capabilities": { "alwaysMatch": { "moz:firefoxOptions": {
  "androidPackage": "org.mozilla.geckoview_example",
  "androidActivity": "org.mozilla.geckoview_example.GeckoView",
  "androidDeviceSerial": "emulator-5554",
  "androidIntentArguments": ["-d", "http://example.org"] } } } }
```

For BiDi, "When running on Android a port forward will be set on the host machine, which is using the exact same port as on the device" ([geckodriver changelog](https://raw.githubusercontent.com/mozilla-firefox/firefox/main/testing/geckodriver/CHANGES.md), 0.30.0). A current pain point, from the 0.37.1 known problems: "Firefox for Android versions 153 and later can hang during startup when under automation", worked around by passing `"androidIntentArguments": ["-a", "android.intent.action.VIEW", "-d", "about:blank", "--ez", "automationtest", "true"]` (same changelog). How much of BiDi works on Android is **unverified**.

### Safari on iOS (simulator and device)

- **safaridriver** (Apple). The manual page on this Mac: `platformName` `iOS` makes it "only create a session on a paired iOS device or simulator"; `safari:useSimulator` true selects simulators only ("An Xcode installation is required"); `safari:deviceType` `iPhone` or `iPad`; also `safari:deviceName`, `safari:deviceUDID`, `safari:platformVersion`, `browserVersion`. It boots an unbooted matching simulator and prefers booted ones. Real devices need Settings → Safari → Advanced → Remote Automation, a trusted cable connection, and an unlocked device when the session starts ([WebKit blog, iOS 13](https://webkit.org/blog/9395/webdriver-is-coming-to-safari-in-ios-13/)). Multi-touch and window-rect commands are not supported on iOS (same post).
- **Appium XCUITest.** Copied from [capability sets](https://raw.githubusercontent.com/appium/appium-xcuitest-driver/master/docs/guides/capability-sets.md):

```json
{ "platformName": "iOS", "appium:automationName": "XCUITest", "browserName": "Safari",
  "appium:deviceName": "<Simulator_Name>", "appium:platformVersion": "<iOS_Version>" }
```

Web contexts go through a Web Inspector connection, "a proprietary Apple's JSON RPC similar to Chrome's Devtools Protocol"; real devices need Web Inspector on; WKWebView apps need `isInspectable` set to `true` ([hybrid guide](https://raw.githubusercontent.com/appium/appium-xcuitest-driver/master/docs/guides/hybrid.md)). Real devices also need Developer Mode, "Enable UI Automation", and Safari's Web Inspector and Remote Automation switches ([device setup](https://raw.githubusercontent.com/appium/appium-xcuitest-driver/master/docs/getting-started/device-setup.md)).

### Samsung Internet

Samsung's developer page says ChromeDriver can drive it from Samsung Internet 8 with `androidPackage` `com.sec.android.app.sbrowser`, then based on Chromium M63 ([Samsung Internet WebDriver](https://samsunginternet.github.io/web-driver-chrome-driver/)). That page dates from September 2018. Welcome and default-browser prompts block unattended runs ([issue](https://github.com/SamsungInternet/chromedriver-examples/issues/1)). Current behaviour is **unverified**.

### Desktop Safari

`safaridriver --enable` once, with an administrator password ("This includes checking 'Enable Remote Automation' in Safari's Develop menu", local man page; also [Apple](https://developer.apple.com/documentation/webkit/testing-with-webdriver-in-safari)). Safari and Safari Technology Preview each ship their own `safaridriver` ([Apple](https://developer.apple.com/documentation/webkit/testing-with-webdriver-in-safari)). Limits from Apple's [About WebDriver for Safari](https://developer.apple.com/documentation/webkit/about-webdriver-for-safari):

> Only one Safari browser instance can be active at any given time, and only one WebDriver session at a time can be attached to the browser instance.

Automation windows are isolated like a private window and covered by a "glass pane" that catches stray input. There is no headless mode ([WebdriverIO Capabilities](https://raw.githubusercontent.com/webdriverio/webdriverio/main/website/docs/Capabilities.md)). The man page adds: "Safari on macOS and iOS can only host one WebDriver session at a time, so it is not recommended to run multiple safaridriver instances at the same time." Whether several simulators can host sessions at once from one Mac is **unverified**.

### WebKit on Linux as a real engine

Besides Playwright's patched WebKit, WebKitGTK ships `WebKitWebDriver`, which drives MiniBrowser by default or Epiphany in automation mode through `webkitgtk:browserOptions` ([Ubuntu manpage](https://manpages.ubuntu.com/manpages/jammy/man1/WebKitWebDriver.1.html), [Igalia](https://blogs.igalia.com/carlosgc/2017/09/09/webdriver-support-in-webkitgtk-2-18/)). It is the WebKit engine, not Safari.

## 4. Native mobile

### Maestro

YAML flows name one app per flow with `appId` (or `url` for web). Copied from the [quickstart](https://raw.githubusercontent.com/mobile-dev-inc/maestro-docs/main/introduction/get-started/quickstart.md):

```yaml
appId: com.google.android.contacts
---
- launchApp:
    clearState: true
- tapOn: Create contact
- inputText: John
```

- Device selection is a CLI flag, not config: `maestro --device <id> test flow.yaml`. `maestro start-device --platform android|ios` creates and boots a known-good emulator or simulator; `maestro list-devices` and `maestro list-cloud-devices` show choices ([devices](https://raw.githubusercontent.com/mobile-dev-inc/maestro-docs/main/flows/flow-control-and-logic/specify-and-start-devices.md)). Cloud runs pick `--device-os "iOS-26-2" --device-model "iPhone-17-Pro"` ([cloud OS](https://raw.githubusercontent.com/mobile-dev-inc/maestro-docs/main/cloud/environment-configuration/configure-the-os.md)).
- Maestro Studio is a desktop app that mirrors the device, lets you click elements and writes YAML ([how it works](https://raw.githubusercontent.com/mobile-dev-inc/maestro-docs/main/introduction/get-started/how-maestro-works.md)).
- Waiting: Maestro "embraces instability" by "automatically waiting for the screen to 'settle' or for content to load", and drives the accessibility tree through a companion driver app on the device (same page).
- Cross-app on one device: `launchApp: com.example.app` switches apps, and iOS flows can follow a link into Safari and back ([launchApp](https://raw.githubusercontent.com/mobile-dev-inc/maestro-docs/main/api-reference/commands-available/launchapp.md), [iOS](https://raw.githubusercontent.com/mobile-dev-inc/maestro-docs/main/introduction/get-started/supported-platform/ios/README.md)).
- Multi-device in one flow: not supported. A maintainer, on the request to test sender and receiver on two phones: "This isn't supported. Given the limited number of folks who require it, it's not something staff have planned" ([issue 2957](https://github.com/mobile-dev-inc/Maestro/issues/2957)). Users write orchestration scripts that split steps into separate YAML files.
- Web is beta, Chromium only, with preset viewport and `en-US` ([web](https://raw.githubusercontent.com/mobile-dev-inc/maestro-docs/main/introduction/get-started/supported-platform/web-browser.md)). iOS is simulators only ("iOS: Full support for simulators", [platforms](https://raw.githubusercontent.com/mobile-dev-inc/maestro-docs/main/introduction/get-started/supported-platform/README.md)). Android API levels 29, 30, 31, 33 and 34 are supported, with 35 and 36 promised for Q2 2026 in the same quickstart; whether they shipped is **unverified**. It needs Java 17 or 21 ([known issues](https://raw.githubusercontent.com/mobile-dev-inc/maestro-docs/main/resources/troubleshooting/known-issues.md)).

### Detox

Detox splits `devices`, `apps` and `configurations`, then selects one configuration per run: `detox test -c 'device1+app1'` ([config overview](https://raw.githubusercontent.com/wix/Detox/master/docs/config/overview.mdx)). The docs explain why: debug and release on two platforms is already four combinations. Device types are `ios.simulator`, `android.emulator`, `android.attached` and `android.genycloud` ([devices](https://raw.githubusercontent.com/wix/Detox/master/docs/config/devices.mdx)). Several named apps can share one device. Copied from [apps](https://raw.githubusercontent.com/wix/Detox/master/docs/config/apps.mdx):

```js
{
  "apps": {
    "driver.ios.release": { "type": "ios.app", "name": "driver", "binaryPath": "path/to/driver.app" },
    "passenger.ios.release": { "type": "ios.app", "name": "passenger", "binaryPath": "path/to/passenger.app" }
  },
  "configurations": {
    "ios.release": { "device": "simulator", "apps": ["driver", "passenger"] }
  }
}
```

```js
await device.selectApp('driver');
await device.launchApp();
await device.selectApp('passenger');
```

Detox is gray-box: a native client inside the app waits for network, main thread, layout, timers, animations and the React Native threads, which it presents as the fix for `sleep()` flakiness ([how Detox works](https://raw.githubusercontent.com/wix/Detox/master/docs/articles/how-detox-works.md)). Real iOS devices are "not yet supported" ([README](https://github.com/wix/Detox#readme)). One device per configuration.

### Appium 3

A driver per platform, installed separately: `appium driver install uiautomator2`, or `appium setup` for UiAutomator2, XCUITest (macOS hosts only) and Espresso. `appium setup browser` adds Safari, Gecko and Chromium drivers; `appium setup desktop` adds Mac2 or Windows ([setup](https://raw.githubusercontent.com/appium/appium/master/packages/appium/docs/en/reference/cli/setup.md)). `appium driver doctor <driver>` checks prerequisites ([UiAutomator2 quickstart](https://raw.githubusercontent.com/appium/appium/master/packages/appium/docs/en/quickstart/uiauto2-driver.md)). Appium 3 moved Node to 20.19 and made the Inspector a server plugin (`appium plugin install inspector`) ([Appium 3 post](https://raw.githubusercontent.com/appium/appium/master/packages/appium/docs/en/blog/posts/appium3.md)). Copied from the [JS quickstart](https://raw.githubusercontent.com/appium/appium/master/packages/appium/sample-code/quickstarts/js/test.js):

```js
const capabilities = {
  platformName: 'Android',
  'appium:automationName': 'UiAutomator2',
  'appium:deviceName': 'Android',
  'appium:appPackage': 'com.android.settings',
  'appium:appActivity': '.Settings',
};
```

Real iOS devices need the WebDriverAgent runner signed with an Apple Account; free accounts work with manual Xcode steps, automatic provisioning needs a paid account ([provisioning](https://raw.githubusercontent.com/appium/appium-xcuitest-driver/master/docs/getting-started/provisioning-profile/index.md)). Finding a working mix of Xcode, iOS, driver, WDA and Appium versions takes a six-step lookup ([system requirements](https://raw.githubusercontent.com/appium/appium-xcuitest-driver/master/docs/getting-started/system-requirements.md)). Windows and Linux hosts support real iOS 18+ devices only, through RemoteXPC tunnels, with explicit `appium:udid` ([non-macOS hosts](https://raw.githubusercontent.com/appium/appium-xcuitest-driver/master/docs/guides/non-macos-hosts.md)). Capabilities "cannot be changed during the lifecycle of the session" ([caps guide](https://raw.githubusercontent.com/appium/appium/master/packages/appium/docs/en/guides/caps.md)).

### Appwright and Mobilewright

Appwright wraps Appium in Playwright Test projects; copied from its [README](https://raw.githubusercontent.com/empirical-run/appwright/main/README.md):

```ts
export default defineConfig({
  projects: [
    { name: "android", use: { platform: Platform.ANDROID,
        device: { provider: "emulator" }, // or 'local-device' or 'browserstack'
        buildPath: "app-release.apk" } },
  ],
});
```

It was last published in December 2024. Mobilewright (Apache-2.0, published the day before this research) offers a Playwright-shaped API over its own `mobilecli`, with `npx mobilewright doctor`, `npx mobilewright devices`, and auto-discovery of booted simulators; config names `platform`, `bundleId`, `deviceName` (a RegExp) and `projects` ([README](https://raw.githubusercontent.com/mobile-next/mobilewright/main/README.md)). Neither composes a phone and a browser in one test.

### Espresso, UI Automator and XCUITest

- UI Automator "lets you test an app from outside of the app's process" and interacts with user and system apps ([UI Automator](https://developer.android.com/training/testing/other-components/ui-automator)). Espresso runs in the app's process and is limited to one app, according to secondary guides ([HeadSpin](https://www.headspin.io/blog/a-comprehensive-guide-to-android-ui-testing-with-espresso)); **unverified** against Android's own Espresso page. A Retest Android helper that must cross apps and system dialogs follows the UI Automator model.
- XCUITest drives other apps through `XCUIApplication(bundleIdentifier:)`, for example `com.apple.mobilesafari` ([Apple](https://developer.apple.com/documentation/xcuiautomation/xcuiapplication/init(bundleidentifier:))). The Apple page could not be fetched in text form; the example comes from a [secondary guide](https://testableapple.com/test-multiple-apps-using-bundle-identifier-in-xctest/).

## 5. Desktop

| Target | Route | Prerequisites and limits | Source |
| --- | --- | --- | --- |
| Electron | Playwright `_electron` (CDP) or WebdriverIO Electron service (Chromedriver) | `nodeCliInspect` fuse left on for Playwright; Electron's docs list WebdriverIO, Selenium, Playwright ("experimental") and a custom IPC driver | [Electron testing](https://www.electronjs.org/docs/latest/tutorial/automated-testing) |
| Tauri | WebdriverIO Tauri service | macOS needs the embedded plugin crate in the app or paid CrabNebula | [Tauri](https://v2.tauri.app/develop/tests/webdriver/) |
| macOS apps | Appium Mac2 (XCTest) | macOS 11.3+, Xcode 13+, Accessibility permission for Xcode Helper, `automationmodetool enable-automationmode-without-authentication`; parallel runs "highly discouraged" because the accessibility layer and HID devices are exclusive | [Mac2 getting started](https://raw.githubusercontent.com/appium/appium-mac2-driver/master/docs/getting-started/index.md), [parallel](https://raw.githubusercontent.com/appium/appium-mac2-driver/master/docs/guides/parallel-tests.md) |
| Windows apps | Appium Windows driver over WinAppDriver, or NovaWindows | WinAppDriver's last release is v1.2.99 on 1 July 2021 ([releases](https://github.com/microsoft/WinAppDriver/releases)); Appium: "has not been maintained since 2022"; NovaWindows is the recommended replacement, PowerShell-backed, Windows 10+ | [Appium drivers](https://raw.githubusercontent.com/appium/appium/master/packages/appium/docs/en/ecosystem/drivers.md), [NovaWindows](https://github.com/AutomateThePlanet/appium-novawindows-driver) |

## 6. Selenium and Cypress, briefly

- Selenium Manager ships with Selenium since 4.6. It "automatically discovers, downloads, and caches the drivers" and the browsers (Chrome for Testing from 4.11, Firefox from 4.12, Edge from 4.14) into `~/.cache/selenium`; Safari is not managed ([Selenium Manager](https://www.selenium.dev/documentation/selenium_manager/)). Selenium enables BiDi with `webSocketUrl: true` and calls its CDP support "temporary until WebDriver BiDi has been implemented" ([Selenium BiDi](https://www.selenium.dev/documentation/webdriver/bidi/)).
- Chrome for Testing exists because auto-update breaks reproducible runs and Chrome publishes no versioned binaries; it is built for every Chrome release on every channel ([Chrome blog](https://developer.chrome.com/blog/chrome-for-testing)). `npx @puppeteer/browsers install chrome@stable` fetches one ([Puppeteer](https://pptr.dev/browsers-api)).
- Cypress selects a browser with `--browser chrome`, `--browser chrome:beta`, `--browser firefox:dev`, `--browser edge:canary`; WebKit is experimental behind `experimentalWebKitSupport` and the `playwright-webkit` package; Electron is deprecated ([Launching browsers](https://docs.cypress.io/app/references/launching-browsers)). A permanent trade-off: "Cypress does not support controlling more than 1 open browser at a time"; cross-origin navigation needs `cy.origin` ([Trade-offs](https://docs.cypress.io/app/references/trade-offs)).

## 7. What hurts, and what tools did about it

| Pain | Evidence | What a tool did |
| --- | --- | --- |
| Driver and browser version mismatch | Chrome for Testing rationale; WebdriverIO warns against setting only one of browser and driver binary | Selenium Manager, WebdriverIO auto-download, Playwright pinning browsers to each release |
| Linux system packages for browsers | Playwright ships `install-deps` | `npx playwright install --with-deps` |
| Emulator setup | Android emulators need KVM, Hypervisor.Framework or WHPX; "You can't run a VM-accelerated emulator inside another VM, such as a VM hosted by VirtualBox, VMWare, or Docker" ([Android](https://developer.android.com/studio/run/emulator-acceleration)) | `maestro start-device`; GitHub enabled hardware acceleration on Linux runners ([changelog](https://github.blog/changelog/2024-04-02-github-actions-hardware-accelerated-android-virtualization-now-available/)); Detox boots AVDs from config |
| iOS needs a Mac | "simulators can only be run on macOS" ([XCUITest non-macOS](https://raw.githubusercontent.com/appium/appium-xcuitest-driver/master/docs/guides/non-macos-hosts.md)); Xcode installed but never opened shows no simulators until `xcodebuild -runFirstLaunch` ([Maestro quickstart](https://raw.githubusercontent.com/mobile-dev-inc/maestro-docs/main/introduction/get-started/quickstart.md)) | Cloud device farms; nothing removes the constraint |
| Real iOS device signing | Apple Account, provisioning, Developer Mode, Enable UI Automation | Appium `open-wda` script, prebuilt and preinstalled WDA options |
| Capability sprawl | `appium:*`, `goog:*`, `moz:*`, `safari:*`, `wdio:*`, cloud prefixes, all untyped strings in one object | `appium:options` grouping; WebdriverIO wizard; Appwright and Mobilewright replace capabilities with a few typed fields |
| Flaky mobile waits | Detox's case against `sleep()`; Maestro "embraces instability" and waits for the screen to settle | Gray-box idle detection (Detox), settle-and-retry (Maestro), auto-wait locators (Mobilewright) |
| Setup diagnosis | "Setting up the right environment is not straight forward" (WebdriverIO on Appium) | `appium driver doctor`, `mobilewright doctor`, `npx appium-installer` |
| New browser versions breaking automation | Firefox for Android 153+ hangs at onboarding under automation (geckodriver 0.37.1) | A documented intent-argument workaround |
| One Safari at a time, one Mac2 session at a time | Apple and Mac2 docs above | None; runners must lease these per machine |
| Multi-device tests | Maestro declines; Cypress permanently single browser; Detox one device | WebdriverIO multiremote only |

## 8. Proposed target naming for Retest

These are recommendations for the plan, not capabilities Retest has. The architecture says Firefox, Safari, Android, iOS and desktop "must not be advertised until exercised and verified" ([AGENTS.md](../../../../AGENTS.md)); the names below are the reserved vocabulary, and each is enabled only when its driver passes conformance.

### Principles taken from the research

1. **A target names what runs, in words a user would say.** The engine, version, host and whether it is emulated are facts Retest records and prints, not parts of a free-text name. Playwright's "Mobile Safari" label on desktop WebKit is the mistake to avoid.
2. **Emulation is an option on a desktop target, never a target of its own.** `chromium({ emulate: 'Pixel 9' })` prints as "Chromium 153, emulating Pixel 9". No constructor produces a phone-looking name without a phone.
3. **Typed constructors, not capability dictionaries.** One function per product, a few named options, and an escape hatch for raw launch arguments. Vendor prefixes stay inside drivers.
4. **Keep "what the test needs" apart from "what fills that need in this run".** A test declares roles (`web`, `phone`, `desktop`). The config maps each role to a target. A run matrix rebinds roles, so the same test runs with `web` as Chrome, then as Safari. This combines Playwright's matrix with WebdriverIO's composition, which no surveyed tool offers per test.
5. **Names are typed once.** The role names in config produce the fixture types; no hand-written `.d.ts` as in multiremote.
6. **Requirements are declared and checked before a run.** Each target knows its host OS, tools and exclusive resources. `retest doctor` explains what is missing for the selected targets, and an unavailable target is reported as unavailable, never skipped into a green run.
7. **Installation is explicit and pinned.** The architecture prefers an explicit binary path first. A later `retest install <target>` should download only when asked, pin a version (Chrome for Testing for Chrome), and print what it placed where.

### Sketch

```ts
import { defineConfig, chromium, chrome, edge, firefox, webkit, safari, android, ios, macos, electron } from '@rehearsal-labs/retest'

export default defineConfig({
  targets: {
    // Desktop browsers
    chromium: chromium(),                                  // Chrome for Testing or an explicit binary
    chrome: chrome({ channel: 'stable' }),                 // 'stable' | 'beta' | 'dev' | 'canary', installed Google Chrome
    edge: edge({ channel: 'stable' }),
    firefox: firefox({ channel: 'stable' }),               // stock Firefox over WebDriver BiDi
    webkit: webkit(),                                      // WebKit engine (WebKitGTK/WPE on Linux); never called Safari
    safari: safari(),                                      // macOS Safari through safaridriver
    narrow: chromium({ emulate: 'Pixel 9' }),              // emulation, labelled as such in every report

    // Real mobile browsers
    androidChrome: android.chrome({ device: { emulator: 'Pixel_9_API_36' } }), // or { serial: 'R5CW...' }
    androidFirefox: android.firefox({ device: { serial: 'emulator-5554' } }),
    iosSafari: ios.safari({ device: { simulator: 'iPhone 17', os: '26.2' } }), // or { udid: '...' }

    // Native apps
    shopApp: android.app({ package: 'com.example.shop', install: './app-release.apk', device: { emulator: 'Pixel_9_API_36' } }),
    shopIos: ios.app({ bundleId: 'com.example.shop', install: './Shop.app', device: { simulator: 'iPhone 17' } }),
    adminMac: macos.app({ bundleId: 'com.example.admin' }),
    desktop: electron({ executable: './dist/mac-arm64/Example.app', args: [] }),
  },

  // Roles a test may ask for, bound to targets. A run can rebind them.
  roles: { web: 'chrome', phone: 'iosSafari', desktop: 'desktop' },

  // Matrix: each entry is one full run of the selected tests.
  runs: [
    { name: 'chrome', roles: { web: 'chrome' } },
    { name: 'safari', roles: { web: 'safari' } },
    { name: 'firefox', roles: { web: 'firefox' } },
  ],
})
```

```ts
test('an order placed on the phone shows up for the admin', { uses: ['phone', 'web'] }, async ({ phone, web }) => {
  // phone and web are typed from the config's role names
})
```

Report line proposal: `✓ [safari run] web=Safari 26.6 (macOS 27.0) phone=Mobile Safari (iOS 26.2 simulator) › orders.test.ts:3 › an order placed...`. Emulated targets carry the word "emulated" in that line and in JSONL.

Open design questions this leaves for the plan: whether `runs` is the right word next to Retest's own run IDs; how per-test `uses` interacts with `--target` on the CLI; and whether one config file or one file per host is clearer when some targets need a Mac.

### Each target: engine, reality and what it needs

| Target | Engine | Real or emulated | Host and hardware | Tools and one-time setup | Concurrency limits | Protocol Retest would use |
| --- | --- | --- | --- | --- | --- | --- |
| Chromium | Blink | Real engine, unbranded | Linux, macOS, Windows | A Chromium or Chrome for Testing binary | Many per host | CDP |
| Chrome stable, beta, dev, canary | Blink | Real branded browser | macOS, Windows, Linux x64; Linux arm64 branded Chrome **unverified** | Installed Chrome; auto-update means version drift unless pinned | Many per host | CDP |
| Edge | Blink | Real branded browser | Windows, macOS, Linux | Installed Edge | Many per host | CDP |
| Firefox | Gecko | Real, stock build | Linux, macOS, Windows | Installed Firefox; snap or flatpak packaging can hang startup (geckodriver known problems) | Many per host | WebDriver BiDi |
| WebKit (Linux) | WebKit | Real engine, not Safari | Linux | WebKitGTK or WPE with `WebKitWebDriver`, or a patched build | **Unverified** | WebDriver Classic (BiDi status **unverified**) |
| Safari (macOS) | WebKit | Real branded browser | macOS only | `safaridriver --enable` once with admin password; a logged-in GUI session; no headless | One Safari session per Mac | WebDriver Classic |
| Mobile emulation | Host desktop engine | Emulated: viewport, user agent, touch, scale factor | As the desktop target | None | As the desktop target | CDP (Chromium); BiDi emulation for Firefox |
| Chrome on Android, emulator | Blink (Android build) | Real browser on a virtual device | Hardware virtualization (KVM, Hypervisor.Framework, WHPX); not inside Docker or another VM | Android SDK platform-tools and emulator, a system image with Chrome; `adb` | One Chrome DevTools socket per Chrome instance; emulators limited by RAM and CPU | CDP over `adb forward ... localabstract:chrome_devtools_remote` |
| Chrome on Android, device | Blink | Real device | Any host with `adb` and USB | Developer options, USB debugging, trusted host; screen awake; Playwright also requires "Enable command line on non-rooted devices" in `chrome://flags` | One device per test lease | CDP over `adb` |
| Firefox on Android | Gecko | Real browser | As Android above | geckodriver-style profile push and intent launch; Firefox 153+ onboarding workaround | **Unverified** | WebDriver BiDi through a forwarded port |
| Safari on iOS simulator | WebKit (iOS simulator build) | Real Mobile Safari on a simulated device | Mac with Xcode and the iOS runtime | Xcode first launch; simulator runtime installed | Safari hosts one session at a time; several simulators at once **unverified** | safaridriver with `platformName: iOS`, `safari:useSimulator: true` |
| Safari on iOS device | WebKit | Real device | Mac, cable or paired device | Settings → Safari → Advanced → Remote Automation; trust; unlocked at start | One session per device | safaridriver |
| Samsung Internet | Blink fork | Real browser | Android device with the app | ChromeDriver-style `androidPackage` `com.sec.android.app.sbrowser`; welcome prompts | **Unverified** | CDP (**unverified**) |
| Native Android app | Android UI toolkit | Real app on emulator or device | As Android above | APK install; Retest's instrumentation helper; UI Automator-style access for cross-app and system dialogs | One device per lease | adb plus Retest helper |
| Native iOS app | UIKit or SwiftUI | Real app on simulator or device | Mac with Xcode; devices also need signing | Simulator `.app`, or signed `.ipa` plus a signed Retest XCUITest runner; Developer Mode and Enable UI Automation on devices | One device per lease | Retest XCUITest runner |
| macOS app | AppKit or SwiftUI | Real app | Mac with Xcode | Accessibility permission for the test runner; automation-mode prompt disabled | One UI session per Mac (Mac2 experience) | Retest XCUITest runner (macOS) |
| Electron app | Blink plus Node | Real app | Any OS the app ships for | App launchable with a DevTools port; fuses that block inspection must stay enabled in the tested build | Many per host | CDP |
| Windows native app | Win32, WPF, UWP | Real app | Windows 10+ | No maintained Microsoft driver; out of the current Retest plan | **Unverified** | Not planned |

## 9. Lessons, ranked for Retest

1. **Make the environment check a product feature.** Every tool that improved adoption shipped an installer or doctor: `npx playwright install --with-deps`, Selenium Manager, WebdriverIO auto-download, `appium setup` and `appium driver doctor`, `maestro start-device`, `mobilewright doctor`. Retest should check every selected target before any test starts and say exactly which step is missing.
2. **Label emulation honestly.** Playwright's defaults present desktop WebKit as "Mobile Safari". WebdriverIO warns against using emulation for mobile testing at all. Retest can win trust by printing engine, host and "emulated" on every result.
3. **Offer composition per test.** Only WebdriverIO multiremote puts several sessions in one test, and only for the whole config. Maestro declined multi-device outright; Cypress lists one browser as permanent; Detox allows several apps but one device. Per-test named apps are a real gap.
4. **Type the names once.** Multiremote needs a hand-written declaration file that can drift from config. Retest's config should generate the fixture types.
5. **Separate the matrix from the composition.** Roles in the test, targets in config, runs that rebind roles. This keeps the Playwright "run it on every browser" habit without losing multi-app tests.
6. **Hide capability dictionaries.** Typed constructors with few options, plus a raw-arguments escape hatch.
7. **Treat exclusive resources as leases.** One Safari per Mac, one Mac UI session, one device per test, no emulator inside Docker. The scheduler should know these limits instead of discovering them as flaky failures.
8. **Pin versions and record them.** Chrome for Testing, Playwright's per-release browser builds and the Firefox for Android 153 regression all show that silent browser updates break suites.
9. **Waiting is where mobile suites fail.** Detox's in-app idle tracking and Maestro's settle-wait are the two answers. Retest's own Android helper and XCUITest runner are the place to decide this.

## 10. Not verified in this session, most important first

1. Whether Retest can launch Chrome on a non-rooted Android device with its own command-line flags without the "Enable command line on non-rooted devices" switch, or whether attaching to an already running Chrome over `adb forward` is enough for isolation.
2. Whether one Mac can run Safari sessions on several iOS simulators at the same time through `safaridriver`.
3. Safari's WebDriver BiDi status, including Safari Technology Preview. The macOS 27.0 manual page lists no BiDi capability.
4. How much of WebDriver BiDi works in Firefox for Android.
5. Whether Electron's `--remote-debugging-port` works in packaged apps with hardened fuses; only `nodeCliInspect` behaviour was confirmed.
6. Samsung Internet automation today; the only primary source is from 2018.
7. WebdriverIO multiremote result shape and ordering, given the contradictory docs, and a copied example that mixes Appium with a desktop browser.
8. Branded Google Chrome availability on Linux arm64.
9. Which Android emulator system images carry an updatable Chrome.
10. Playwright published docs versus `main`: Android minimum Chrome 87 versus 105, Electron v12.2+ versus v21+.
11. Playwright's `channel: 'moz-firefox'`, seen only in the issue tracker.
12. Espresso's in-process limit, taken from secondary guides.
13. Maestro support for Android API 35 and 36, promised for Q2 2026.
