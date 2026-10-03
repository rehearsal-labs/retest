import type { Route } from './route.ts'
import { asyncRoutes } from './workflow-async-page.ts'
import { listsRoutes } from './workflow-lists-page.ts'
import { navigationRoutes } from './workflow-navigation-page.ts'
import { searchRoutes } from './workflow-search-page.ts'
import { selectionRoutes } from './workflow-selection-page.ts'
import { signInRoutes } from './workflow-sign-in-page.ts'
import { tasksRoutes } from './workflow-tasks-page.ts'
import { validationRoutes } from './workflow-validation-page.ts'

/**
 * The pages the fixed basic workflow cases drive, each family under its own path. A new list each time the app
 * starts, so every app keeps its own state.
 */
export function workflowRoutes(): Route[] {
  return [
    ...navigationRoutes(),
    ...signInRoutes(),
    ...tasksRoutes(),
    ...validationRoutes(),
    ...selectionRoutes(),
    ...listsRoutes(),
    ...searchRoutes(),
    ...asyncRoutes(),
  ]
}
