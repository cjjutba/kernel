import { test as base, expect } from '@playwright/test'

/** Fails the test on any console error or uncaught exception. */
export const test = base.extend<{ consoleErrors: string[] }>({
  consoleErrors: [
    async ({ page }, use) => {
      const errors: string[] = []
      page.on('console', (msg) => msg.type() === 'error' && errors.push(msg.text()))
      page.on('pageerror', (err) => errors.push(err.message))
      await use(errors)
      expect(errors).toEqual([])
    },
    { auto: true }
  ]
})

export { expect }

export const isMobile = (testInfo: { project: { name: string } }) => testInfo.project.name === 'mobile'
