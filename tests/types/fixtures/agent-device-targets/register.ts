import type { AppKind } from '../../../../src/config/register.ts'
import type { Same } from '../support/same.ts'
import { defineConfig, expect, test, type Apps, type NativePage } from '@rehearsal-labs/retest'

// An iOS simulator target through agent-device keeps the iOS handle; an Android target gets an Android one, which takes
// taps and has no click, swipe or keyboard helpers yet.
export const iphone: Same<AppKind<'iphone'>, 'ios-simulator'> = true
export const pixel: Same<AppKind<'pixel'>, 'android'> = true
export const handles: Same<Apps<'iphone' | 'pixel'>, { readonly iphone: NativePage<'ios-simulator'>; readonly pixel: NativePage<'android'> }> = true

test('creates a task on Android and checks it', { apps: ['pixel', 'tablet'] }, async ({ pixel, tablet }) => {
  await pixel.getByTestId('task-title').fill('Release checklist')
  await pixel.getByRole('button', { name: 'Save' }).tap()
  await pixel.getByTestId('task-title').press('Enter')
  await pixel.scroll({ y: 300 })
  await expect(pixel.getByTestId('task-status')).toHaveText('Open')
  await expect(tablet.getByText('Release checklist').first()).toBeVisible()
})

test('mistakes on Android', { apps: ['pixel'] }, async ({ pixel }) => {
  await pixel.goto('/') // type-error TS2349 A native app has no address. goto() is for web apps.
  await pixel.getByTestId('save-task').click() // type-error TS2349 An Android app takes taps. Use tap().
  await pixel.swipe('up') // type-error TS2349 A swipe on an Android app is not built yet. Use scroll().
  await pixel.getByTestId('task-title').swipe('left') // type-error TS2349 A swipe on an Android app is not built yet. Use scroll().
  await pixel.keyboard.dismiss() // type-error TS2349 An Android app's keyboard helpers are not built yet.
})

export const androidDriver = defineConfig({ apps: { phone: { platform: 'android', driver: 'webdriveragent', appPath: 'app.apk', package: 'com.example.tasks', serial: 'emulator-5554' } } }) // type-error TS2322 Type '"webdriveragent"' is not assignable to type '"agent-device"'
export const iosDriver = defineConfig({ apps: { phone: { platform: 'ios-simulator', driver: 'appium', appPath: 'Tasks.app', device: 'iPhone 17', runtime: '26.5' } } }) // type-error TS2322 Type '"appium"' is not assignable to type
