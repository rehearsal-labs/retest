import type { AriaRole } from '../../../src/protocol/aria-role.ts'
import type { LocatorRecipe } from '../../../src/protocol/locator.ts'

export const button: AriaRole = 'button'
export const typo: AriaRole = 'buton' // type-error TS2820 Did you mean '"button"'?
export const abstract: AriaRole = 'widget' // type-error TS2322 Type '"widget"' is not assignable to type 'AriaRole'
export const recipe: LocatorRecipe = { by: 'role', role: 'heading', name: 'Tasks', exact: false }
export const wrongKey: LocatorRecipe = { by: 'label', name: 'Email' } // type-error TS2353 'name' does not exist in type
