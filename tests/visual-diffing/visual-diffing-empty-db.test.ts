import { test, expect as pwExpect } from '@playwright/test'

import { createLoginCookie, createTestUser, deleteTestUser, showWebPageErrorsInTerminal } from '../test-utils'

test.describe('Visual Diffing All Pages (empty db)', () => {
  test.beforeAll(async () => {
    await createTestUser()
  })

  test.beforeEach(async ({ context, page }) => {
    showWebPageErrorsInTerminal(page)
    await createLoginCookie(context)
  })

  test('Login Page', async ({ page, context }) => {
    await context.clearCookies()
    await page.goto('/login')
    pwExpect(await page.screenshot()).toMatchSnapshot('login-page-login.png')

    /*****
      Gotta manually set the signup username as it is unique and would otherwise make
      the page look different on each page load.
    *****/
    await page.evaluate(() => {
      const preElem = document.querySelector('#unique-username') as HTMLPreElement
      preElem.textContent = 'correct-horse-battery-staple'
    })

    await page.click('a:has-text("Sign Up")')

    pwExpect(await page.screenshot()).toMatchSnapshot('login-page-signup.png')
  })

  test('Home Page', async ({ page }) => {
    await page.goto('/')

    pwExpect(await page.screenshot()).toMatchSnapshot('home-page.png')

    await page.goto('/sub-management')
    await page.fill('input[name="subToAdd"]', 'aww')
    await page.click('input[type="submit"]')
    await page.waitForLoadState('networkidle')
    await page.goto('/')

    pwExpect(await page.screenshot()).toMatchSnapshot('home-page-subs-added-but-not-yet-retrieved.png')

    await page.click('.subs-dropdown summary')
    await page.click('.top-filter summary')

    pwExpect(await page.screenshot()).toMatchSnapshot('home-page-dropdowns.png')
  })

  test('Settings Page', async ({ page }) => {
    await page.goto('/settings')

    pwExpect(await page.screenshot()).toMatchSnapshot('settings-page.png')
  })

  test('Search Page', async ({ page }) => {
    await page.goto('/search')

    pwExpect(await page.screenshot()).toMatchSnapshot('search-page.png')

    await page.fill('#search-input', 'asd')

    await Promise.all([page.waitForNavigation(), page.click('button[type="submit"]')])

    pwExpect(await page.screenshot()).toMatchSnapshot('search-page-0-results.png')
  })

  test('Help Page', async ({ page }) => {
    await page.goto('/help')

    pwExpect(await page.screenshot()).toMatchSnapshot('help-page.png')
  })

  test.afterAll(async () => {
    await deleteTestUser()
  })
})
