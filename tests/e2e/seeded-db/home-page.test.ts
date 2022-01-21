import { test, expect as pwExpect } from '@playwright/test'
import { expect } from 'chai'

import { createLoginCookie, checkElementExists, showWebPageErrorsInTerminal } from '../../test-utils'

test.describe('Home Page', () => {
  test.beforeEach(async ({ context, page }) => {
    showWebPageErrorsInTerminal(page)
    await createLoginCookie(context)
    await page.goto('/')
  })

  test('validates home page html and text', async ({ page }) => {
    await pwExpect(page).toHaveTitle('Roffline Home Page')

    const [navHTML, headHTML] = await page.evaluate(() => [
      document.querySelector('header>nav')?.outerHTML,
      document.querySelector('head')?.outerHTML,
    ])

    pwExpect(headHTML).toMatchSnapshot('home-page-head-html.txt')
    pwExpect(navHTML).toMatchSnapshot('home-page-nav-menu-html.txt')

    const firstSevenPostsHTML = await page.evaluate(() => {
      const firstSevenPosts = document.querySelectorAll('main>#posts>.post-container:nth-child(-n+7)')
      return Array.from(firstSevenPosts).map(elem => {
        // remove the time elem as that will change so cant snapshot it.
        elem.querySelector('time')?.remove()
        return elem.outerHTML
      })
    })

    firstSevenPostsHTML.forEach((postHTML, index) =>
      pwExpect(postHTML).toMatchSnapshot(`home-page-post-${index + 1}-html.txt`)
    )

    const galleryPostHTML = await page.evaluate(() => {
      const galleryPost = document.querySelector('.gallery-container')?.parentElement?.parentElement
        ?.parentElement as HTMLDivElement

      // remove the time elem as that will change so cant snapshot it.
      galleryPost.querySelector('time')?.remove()
      return galleryPost.outerHTML
    })

    pwExpect(galleryPostHTML).toMatchSnapshot('home-page-gallery-post-html.txt')

    const paginationHTML = await page.evaluate(() => document.querySelector('nav.pagination')?.outerHTML)

    pwExpect(paginationHTML).toMatchSnapshot('home-page-pagination-html.txt')

    await checkElementExists(page.locator('body>script[src^="/js/index-page.js"]'))
  })

  test.only('infinite scroll works and loads more posts', async ({ page }) => {
    await page.goto('/settings')

    const infiniteScrollEnabled = await page.locator('input[data-setting-name="infiniteScroll"]').isChecked()

    if (!infiniteScrollEnabled) {
      await page.click('input[data-setting-name="infiniteScroll"]')
    }

    // eslint-disable-next-line ui-testing/no-hard-wait
    page.waitForTimeout(1000)

    await page.goto('/')

    await pwExpect(page.locator('nav.pagination')).toHaveCount(0)

    const numOfPostInitial = await page.locator(`main>#posts>.post-container`).count()

    // Scroll to bottom
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))

    await page.waitForResponse('/api/infinite-scroll-load-more-posts*')

    const numOfPostAfterScroll1 = await page.locator(`main>#posts>.post-container`).count()

    expect(numOfPostInitial).to.not.equal(numOfPostAfterScroll1)

    // Scroll to bottom
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))

    // I dunno why but Firefox stalls on this one so make it a waitForTimeout
    // eslint-disable-next-line ui-testing/no-hard-wait
    await page.waitForTimeout(500)

    const numOfPostAfterScroll2 = await page.locator(`main>#posts>.post-container`).count()

    expect(numOfPostInitial).to.not.equal(numOfPostAfterScroll2)
    expect(numOfPostAfterScroll1).to.not.equal(numOfPostAfterScroll2)

    // Scroll to bottom
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))

    await page.waitForResponse('/api/infinite-scroll-load-more-posts*')

    const numOfPostAfterScroll3 = await page.locator(`main>#posts>.post-container`).count()

    expect(numOfPostInitial).to.not.equal(numOfPostAfterScroll3)
    expect(numOfPostAfterScroll1).to.not.equal(numOfPostAfterScroll3)
    expect(numOfPostAfterScroll2).to.not.equal(numOfPostAfterScroll3)
  })
})
