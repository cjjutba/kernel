import { expect, test } from './fixtures'

const panel = (page: import('@playwright/test').Page) => page.locator('#features [role="tabpanel"]:visible')

test('tabs switch on click', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('tab', { name: 'Team' }).click()
  await expect(page.getByRole('tab', { name: 'Team' })).toHaveAttribute('aria-selected', 'true')
  await expect(panel(page)).toContainText('See who is working, who needs you and which workspace each agent is in.')
  await expect(panel(page).locator('img')).toHaveAttribute('alt', /The Kernel Team/)
})

test('arrow keys, Home and End move between tabs and keep focus in the tab list', async ({ page }) => {
  await page.goto('/')
  const tab = (name: string) => page.getByRole('tab', { name })
  await tab('Workspaces').focus()
  await page.keyboard.press('ArrowRight')
  await expect(tab('Inbox')).toBeFocused()
  await expect(tab('Inbox')).toHaveAttribute('aria-selected', 'true')
  await expect(panel(page)).toContainText('Plans, risky commands and questions wait here for you.')
  await expect(panel(page).locator('img')).toHaveAttribute('alt', /The Kernel Inbox/)
  await page.keyboard.press('End')
  await expect(tab('Checkpoints')).toBeFocused()
  await expect(panel(page)).toContainText('Every turn is saved. Step back without losing the chat.')
  await page.keyboard.press('Home')
  await expect(tab('Workspaces')).toBeFocused()
  await expect(panel(page)).toContainText('Every task runs in its own git worktree, branch and port.')
})

test('switching tabs does not change the page height', async ({ page }) => {
  await page.goto('/')
  const height = () => page.evaluate(() => document.documentElement.scrollHeight)
  const before = await height()
  for (const name of ['Inbox', 'Team', 'Checkpoints']) {
    await page.getByRole('tab', { name }).click()
    expect(await height()).toBe(before)
  }
})
