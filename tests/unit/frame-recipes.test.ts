import type { PageCommand } from '../../src/protocol/commands.ts'
import type { FrameRecipe, LocatorRecipe } from '../../src/protocol/locator.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { scopedRecipe } from '../../src/api/locator-recipes.ts'
import { elementsByRole } from '../../src/browser/accessibility.ts'
import { FrameMissing, FrameRefused, framesApart, framesUnreached, inFrame, noFramesInApp, notInFrames } from '../../src/browser/frames.ts'
import { locatorArguments, rolesStopAtShadowRoots } from '../../src/browser/locate.ts'
import { commandLocators } from '../../src/protocol/commands.ts'
import { Deadline } from '../../src/protocol/deadline.ts'
import {
  describeEmptyStep,
  describeLocator,
  framePathOf,
  locatorProblem,
  locatorRecipeSchema,
  locatorSteps,
  sameFramePath,
} from '../../src/protocol/locator.ts'
import { parse } from '../../src/protocol/schema.ts'
import { scriptedSession } from './browser-fixtures.ts'

const payment: FrameRecipe = { by: 'css', selector: 'iframe[title="Secure payment"]' }
const card: LocatorRecipe = { by: 'label', text: 'Card number', frame: [payment] }

test('a locator in a frame is written with each frame on its path, and one without a frame as before', () => {
  assert.equal(describeLocator(card), `frame(locator('iframe[title="Secure payment"]')).getByLabel('Card number')`)
  const nested: LocatorRecipe = { by: 'role', role: 'button', name: 'Add', pick: 'last', within: [{ by: 'testId', value: 'notes' }], frame: [{ by: 'testId', value: 'order', within: [{ by: 'css', selector: 'main' }] }, { by: 'css', selector: 'iframe', pick: 1 }] }
  assert.equal(describeLocator(nested), "frame(locator('main').getByTestId('order')).frame(locator('iframe').nth(1)).getByTestId('notes').getByRole('button', { name: 'Add' }).last()")
  assert.equal(describeLocator({ by: 'label', text: 'Card number' }), "getByLabel('Card number')")
  assert.equal(describeLocator({ ...card, dialect: 'playwright', exact: true }), `frame(locator('iframe[title="Secure payment"]')).getByLabel('Card number', { exact: true })`)
})

test('a frame whose element is not there is named, with the step of its own locator that kept nothing', () => {
  assert.equal(describeEmptyStep(card, { frame: 0, step: 0, matched: 0 }), `frame(locator('iframe[title="Secure payment"]')) found no frame.`)
  const scoped: LocatorRecipe = { by: 'text', text: 'Paid', frame: [{ by: 'css', selector: 'iframe', within: [{ by: 'testId', value: 'checkout' }] }] }
  assert.equal(describeEmptyStep(scoped, { frame: 0, step: 0, matched: 0 }), "frame(getByTestId('checkout').locator('iframe')) found no frame. getByTestId('checkout') matched no element.")
  const picked: LocatorRecipe = { by: 'text', text: 'Paid', frame: [payment, { by: 'css', selector: 'iframe', pick: 3 }] }
  assert.equal(describeEmptyStep(picked, { frame: 1, step: 0, matched: 2 }), `frame(locator('iframe[title="Secure payment"]')).frame(locator('iframe').nth(3)) found no frame. locator('iframe') matched 2 elements, and nth(3) keeps none of them.`)
  assert.equal(describeEmptyStep(card, { step: 0, matched: 0 }), undefined, 'the element of a frame that is there is said by the locator itself')
})

test('a frame path is the frames before an element, then the element itself, without rules of its own', () => {
  const element: LocatorRecipe = { by: 'css', selector: 'iframe', dialect: 'playwright', frame: [payment] }
  assert.deepEqual(framePathOf(element), [payment, { by: 'css', selector: 'iframe' }])
  assert.deepEqual(locatorSteps(card), [{ by: 'label', text: 'Card number' }], 'a frame path is no step of the locator')
  assert.equal(sameFramePath(undefined, []), true)
  assert.equal(sameFramePath([payment], [{ ...payment }]), true)
  assert.equal(sameFramePath([payment], undefined), false)
})

test('a recipe with a frame path is read and written whole, and a frame takes no frame or rules of its own', () => {
  assert.equal(parse(locatorRecipeSchema, card).ok, true)
  assert.equal(parse(locatorRecipeSchema, { ...card, frame: [{ ...payment, frame: [payment] }] }).ok, false)
  assert.equal(parse(locatorRecipeSchema, { ...card, frame: [{ ...payment, dialect: 'playwright' }] }).ok, false)
})

test('what the page cannot be asked is refused in a frame’s own locator too', () => {
  assert.equal(locatorProblem({ ...card, frame: [{ by: 'css', selector: '//iframe' }] })?.class, 'usage')
  assert.equal(locatorProblem({ ...card, frame: [{ by: 'text', text: { pattern: '(', flags: '' } }] })?.class, 'usage')
  assert.equal(locatorProblem(card), undefined)
})

test('a finder on a locator in a frame stays in that frame', () => {
  assert.deepEqual(scopedRecipe(card, { by: 'role', role: 'button' }), { by: 'role', role: 'button', within: [{ by: 'label', text: 'Card number' }], frame: [payment] })
  assert.deepEqual(scopedRecipe({ by: 'testId', value: 'form' }, { by: 'role', role: 'button' }), { by: 'role', role: 'button', within: [{ by: 'testId', value: 'form' }] })
})

test("a command's locators include the element of each frame they are in, which the parent checks as it checks the rest", () => {
  const command: PageCommand = { kind: 'observeLayout', locator: card, other: { by: 'testId', value: 'total' } }
  assert.deepEqual(commandLocators(command), [payment, card, { by: 'testId', value: 'total' }])
})

test('drivers that do not look inside frames, a native app, and a read of several frames each refuse by name', () => {
  assert.equal(inFrame(card), true)
  assert.equal(inFrame({ ...card, frame: [] }), false)
  assert.equal(framesUnreached([{ by: 'testId', value: 'pay' }], 'Firefox'), undefined)
  assert.deepEqual(framesUnreached([card], 'Firefox'), {
    class: 'unsupported',
    message: `Retest looks inside frames on Chrome and Chromium only, and not on Firefox yet, so it sent nothing for frame(locator('iframe[title="Secure payment"]')).getByLabel('Card number').`,
    details: { inputSent: false },
  })
  assert.equal(noFramesInApp([card])?.message, `A native app has no frames, so Retest sent nothing for frame(locator('iframe[title="Secure payment"]')).getByLabel('Card number'). frame() is for a web page.`)
  assert.equal(framesApart([card, { by: 'testId', value: 'total' }], 'measure them')?.class, 'usage')
  assert.equal(framesApart([card, { ...card, by: 'label', text: 'Expiry' }], 'measure them'), undefined)
  assert.equal(notInFrames('take a picture of x').class, 'unsupported')
})

test('a frame not there fails not_found before input, and after input leaves the outcome unknown', () => {
  const missing = new FrameMissing(card, { frame: 0, step: 0, matched: 0 })
  assert.deepEqual(missing.failure("click frame(locator('iframe[title=\"Secure payment\"]')).getByLabel('Card number')", false), {
    class: 'not_found',
    message: `Could not click frame(locator('iframe[title="Secure payment"]')).getByLabel('Card number'): frame(locator('iframe[title="Secure payment"]')) found no frame.`,
    details: { frame: 0 },
  })
  assert.equal(missing.failure('click it', true).class, 'outcome_unknown')
  const several = new FrameRefused(card, 0, { status: 'ambiguous', count: 2 })
  assert.equal(several.failure('click it', false).class, 'ambiguous')
  assert.equal(several.failure('click it', false).message, `Could not click it: frame(locator('iframe[title="Secure payment"]')) matches 2 elements, and a frame's locator must match exactly one. Retest sent nothing.`)
  assert.equal(new FrameRefused(card, 0, { status: 'element', element: '<div>' }).failure('click it', false).class, 'usage')
  assert.match(new FrameRefused(card, 0, { status: 'invalid', step: 0, message: 'bad' }).failure('click it', false).message, /^Could not click it: the page cannot read the CSS selector in locator\('iframe\[title="Secure payment"\]'\), in frame\(.*\)\. bad$/)
})

test('on an engine whose roles stop at shadow roots, a role or label step carries what an open root must hold to be refused, and other steps do not', async () => {
  const { session } = scriptedSession((method) => {
    if (method === 'Runtime.evaluate') return Promise.resolve({ result: { objectId: 'document' } })
    return Promise.resolve({ nodes: [] })
  })
  const scope = { session, context: 7, objectGroup: 'g' }
  const query = async (locator: LocatorRecipe): Promise<unknown> => {
    const args = locatorArguments(locator, [])
    return typeof args === 'function' ? (await args(scope, new Deadline(1000)))[0] : args[0]
  }
  const buttons = { candidates: 'button, input, summary, [role~="button" i]', named: null, unnamed: 'input[type="submit" i], input[type="reset" i], input[type="image" i], input[type="file" i]' }
  assert.deepEqual(await rolesStopAtShadowRoots('Firefox', () => query({ by: 'role', role: 'button' })), { value: { steps: [{ by: 'elements', from: 0, count: 0, pick: null, shadow: buttons }] } })
  assert.deepEqual(await rolesStopAtShadowRoots('Firefox', () => query({ by: 'role', role: 'listitem', name: '  Tree   One ' })), {
    value: { steps: [{ by: 'elements', from: 0, count: 0, pick: null, shadow: { candidates: 'li, [role~="listitem" i]', named: 'tree one', unnamed: null } }] },
  })
  assert.deepEqual(await rolesStopAtShadowRoots('Firefox', () => query({ by: 'testId', value: 'pay' })), { steps: [{ by: 'testId', value: 'pay', pick: null }] })
  assert.deepEqual(await query({ by: 'role', role: 'button' }), { value: { steps: [{ by: 'elements', from: 0, count: 0, pick: null }] } }, 'Chrome refuses nothing')
})

test("a role lookup in a frame's document reads the frame's whole tree once, by the same roles and names", async () => {
  const { session, sent } = scriptedSession((method) => {
    if (method === 'DOM.resolveNode') return Promise.resolve({ object: { objectId: 'element' } })
    return Promise.resolve({
      nodes: [
        { ignored: false, role: { value: 'button' }, name: { value: 'Pay' }, backendDOMNodeId: 1 },
        { ignored: true, role: { value: 'button' }, name: { value: 'Pay' }, backendDOMNodeId: 2 },
        { ignored: false, role: { value: 'textbox' }, name: { value: 'Pay' }, backendDOMNodeId: 3 },
        { ignored: false, role: { value: 'button' }, name: { value: 'Cancel' }, backendDOMNodeId: 4 },
      ],
    })
  })
  const found = await elementsByRole({ session, context: 7, objectGroup: 'g', frame: 'F1' }, { roles: ['button'], name: 'Pay', exact: true }, new Deadline(1000))
  assert.deepEqual(found, [{ objectId: 'element' }])
  assert.deepEqual(sent.map((command) => command.method), ['Accessibility.getFullAXTree', 'DOM.resolveNode'])
  assert.deepEqual(sent[0]?.params, { frameId: 'F1' })
})
