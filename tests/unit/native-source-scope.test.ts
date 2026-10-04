import assert from 'node:assert/strict'
import { test } from 'node:test'
import { crc32 } from 'node:zlib'
import { cropPng, decodePng, distinctColours, encodePng, pngSize } from '../../src/native/png.ts'
import { scopeSource } from '../../src/native/source-scope.ts'
import { solidPng } from './native-fake-executor.ts'

const macTree = `<?xml version="1.0" encoding="UTF-8"?>
<XCUIElementTypeApplication title="TaskDesk" label="">
  <XCUIElementTypeMenuBar><XCUIElementTypeMenuBarItem title="Apple"><XCUIElementTypeMenu><XCUIElementTypeMenuItem title="Recent Items: Taxes 2026.pdf"/></XCUIElementTypeMenu></XCUIElementTypeMenuBarItem></XCUIElementTypeMenuBar>
  <XCUIElementTypeWindow title="TaskDesk" x="454" y="266" width="820" height="560">
    <XCUIElementTypeButton identifier="sign-in" label="Sign in"/>
    <XCUIElementTypeMenuButton label="Actions"><XCUIElementTypeMenu><XCUIElementTypeMenuItem title="Open Recent: notes.txt"/></XCUIElementTypeMenu></XCUIElementTypeMenuButton>
  </XCUIElementTypeWindow>
  <XCUIElementTypeWindow title="Second"/>
</XCUIElementTypeApplication>`

test('a macOS tree is cut to the app\'s first window: no menu bar, and menu text inside the window hashed', () => {
  const scoped = scopeSource(macTree, { platform: 'macos', bundleId: 'dev.retest.fixtures.taskdesk', appNames: ['TaskDesk'] })
  assert.ok(scoped.ok)
  if (!scoped.ok) return
  assert.match(scoped.source.xml, /^<XCUIElementTypeWindow title="TaskDesk"/)
  assert.doesNotMatch(scoped.source.xml, /Taxes|notes\.txt|Second|MenuBar/)
  assert.match(scoped.source.xml, /title="sha256:[0-9a-f]{12}"/)
  assert.equal(scoped.source.hashedMenuElements, 2)
  assert.equal(scoped.source.elements, 5)
  assert.deepEqual(scoped.source.window, { x: 454, y: 266, width: 820, height: 560 })
})

test('a tree of another app is refused whole, without naming that app', () => {
  const home = '<XCUIElementTypeApplication type="XCUIElementTypeApplication" name=" " label=" " bundleId="com.apple.springboard"><XCUIElementTypeWindow/></XCUIElementTypeApplication>'
  const refused = scopeSource(home, { platform: 'ios-simulator', bundleId: 'dev.retest.fixtures.taskphone', appNames: ['TaskPhone'] })
  assert.equal(refused.ok, false)
  assert.doesNotMatch(!refused.ok ? refused.problem : '', /springboard/)
  const named = scopeSource('<XCUIElementTypeApplication title="Notes"><XCUIElementTypeWindow/></XCUIElementTypeApplication>', { platform: 'macos', bundleId: 'dev.retest.fixtures.taskdesk', appNames: ['TaskDesk'] })
  assert.equal(named.ok, false)
  assert.doesNotMatch(!named.ok ? named.problem : '', /Notes/)
})

test('an iOS tree keeps the app\'s own tree when its bundle id is the owned one', () => {
  const tree = '<XCUIElementTypeApplication name="TaskPhone" bundleId="dev.retest.fixtures.taskphone"><XCUIElementTypeWindow><XCUIElementTypeTextField value="Release checklist"/></XCUIElementTypeWindow><XCUIElementTypeWindow><XCUIElementTypeKeyboard/></XCUIElementTypeWindow></XCUIElementTypeApplication>'
  const scoped = scopeSource(tree, { platform: 'ios-simulator', bundleId: 'dev.retest.fixtures.taskphone', appNames: ['Renamed'] })
  assert.ok(scoped.ok)
  assert.equal(scoped.ok && scoped.source.elements, 5)
  assert.equal(scoped.ok && scoped.source.window, undefined)
})

test('a tree that ends before its element closes is refused', () => {
  const cut = scopeSource('<XCUIElementTypeApplication title="TaskDesk"><XCUIElementTypeWindow title="TaskDesk"><XCUIElementTypeButton/>', { platform: 'macos', bundleId: 'b', appNames: ['TaskDesk'] })
  assert.equal(cut.ok, false)
})

test('a PNG is decoded, cut and encoded again with the same pixels', () => {
  const original = decodePng(solidPng(10, 6))
  assert.deepEqual(pngSize(solidPng(10, 6)), { width: 10, height: 6 })
  assert.equal(distinctColours(original), 2)
  const cut = cropPng(original, { x: 2, y: 0, width: 4, height: 3 })
  const again = decodePng(encodePng(cut))
  assert.deepEqual([again.width, again.height, again.channels], [4, 3, 4])
  assert.deepEqual(again.pixels, cut.pixels)
  assert.deepEqual([...again.pixels.subarray(0, 4)], [255, 0, 0, 255], 'the first row kept its colour')
  assert.throws(() => cropPng(original, { x: 8, y: 0, width: 4, height: 3 }), /does not lie inside/)
  assert.throws(() => decodePng(new Uint8Array([1, 2, 3])), /not a PNG/)
})


// Keep the header's checksum valid while producing an image whose compressed stream exceeds its stated dimensions.
function resizedHeader(png: Uint8Array, width: number, height: number): Uint8Array {
  const changed = png.slice()
  const view = new DataView(changed.buffer, changed.byteOffset, changed.byteLength)
  view.setUint32(16, width)
  view.setUint32(20, height)
  view.setUint32(29, crc32(changed.subarray(12, 29)))
  return changed
}

test('PNG inflation is bounded by the declared image length before allocation', () => {
  const png = encodePng({ width: 32, height: 32, channels: 4, pixels: new Uint8Array(32 * 32 * 4) })
  assert.throws(() => decodePng(resizedHeader(png, 1, 1)), /could not be inflated within 5 bytes/)
})

test('PNG dimensions cannot request an unbounded decoded allocation', () => {
  assert.throws(() => decodePng(resizedHeader(solidPng(1, 1), 65536, 65536)), /exceeds the decoded limit/)
  assert.throws(() => decodePng(resizedHeader(solidPng(1, 1), 0, 1)), /exceeds the decoded limit/)
})
