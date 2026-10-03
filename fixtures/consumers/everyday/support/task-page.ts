import type { Page } from '@rehearsal-labs/retest'
import { expect } from '@rehearsal-labs/retest'

// The task app's controls by test id, in a string enum.
export enum Control {
  Title = 'task-title',
  Save = 'save-task',
  Saved = 'saved-task',
}

// A page object whose constructor keeps its arguments as parameter properties.
export class TaskPage {
  constructor(
    private readonly page: Page,
    readonly name: string,
  ) {}

  async open(): Promise<void> {
    await this.page.goto('/')
  }

  async add(title: string): Promise<void> {
    await this.page.getByTestId(Control.Title).fill(title)
    await this.page.getByTestId(Control.Save).click()
  }

  async expectSaved(title: string): Promise<void> {
    await expect(this.page.getByTestId(Control.Saved)).toHaveText(title)
  }
}
