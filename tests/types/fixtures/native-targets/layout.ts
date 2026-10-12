import { expect, test } from '@rehearsal-labs/retest'

// Layout matchers measure a web page; a native app's locators refuse them by name.
test('layout matchers on web and native apps', { apps: ['iphone', 'mac', 'web'] }, async ({ iphone, mac, web }) => {
  await expect(web.getByTestId('save-task')).not.toOverlap(web.getByTestId('task-title'))
  await expect(web).not.toScrollHorizontally()
  await expect(iphone.getByTestId('save-task')).toOverlap(iphone.getByTestId('task-title')) // type-error TS2349 Layout matchers measure a web page. A native app has no page layout to measure.
  await expect(mac.getByTestId('task-title')).not.toHaveClippedText() // type-error TS2349 Layout matchers measure a web page. A native app has no page layout to measure.
  await expect(mac.getByTestId('task-status')).toOverflowViewport() // type-error TS2349 Layout matchers measure a web page. A native app has no page layout to measure.
})
