import { expect, test } from '@playwright/test'

const source = `# Aligned review balloons

The opening paragraph establishes enough manuscript space for a quiet review rail.

The methods paragraph keeps review controls away from the document header.

The []{#dm-line-start .dm-anchor data-anchor="dm-line" data-edge="start"}measured response[]{#dm-line-end .dm-anchor data-anchor="dm-line" data-edge="end"} remained stable[]{#dm-note .dm-anchor data-anchor="dm-note" data-edge="point" data-affinity="after"} during the final observation.

The closing paragraph leaves room below the reviewed line.

::::: {.draftmatter-reviews .hidden data-schema="1"}
:::: {#dm-change-line .dm-change data-anchor="dm-line" data-kind="replace" data-author="dm-alice" data-status="open"}
~~~{.dm-proposal}
response increased by 12%
~~~
::::
:::: {#dm-thread-note .dm-thread data-anchor="dm-note" data-author="dm-marcus" data-status="open"}
~~~{.dm-message}
Please include the confidence interval.
~~~
::::
:::: {#dm-alice .dm-author data-name="Alice Martin"}
::::
:::: {#dm-marcus .dm-author data-name="Marcus Chen"}
::::
:::::
`

test.describe('DM-P4-01 aligned review balloons', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript((portableSource) => {
      localStorage.setItem('draftmatter.structured-source.v1', portableSource)
      localStorage.setItem('draftmatter.structured-mode.v1', 'true')
    }, source)
    await page.goto('/draft')
    await page.locator('.topbar').getByRole('button', { name: /^Review,/ }).click()
  })

  test('aligns placed balloons, prevents collisions, and follows document scrolling', async ({ page }) => {
    const change = page.locator('[data-review-balloon="dm-change-line"]')
    const thread = page.locator('[data-review-balloon="dm-thread-note"]')
    await expect(change).toHaveAttribute('data-review-balloon-aligned', 'true')
    await expect(thread).toHaveAttribute('data-review-balloon-aligned', 'true')

    const initial = await page.evaluate(() => {
      const changeBalloon = document.querySelector<HTMLElement>('[data-review-balloon="dm-change-line"]')!
      const threadBalloon = document.querySelector<HTMLElement>('[data-review-balloon="dm-thread-note"]')!
      const anchor = document.querySelector<HTMLElement>('.editor-area [data-review-anchor="dm-line"]')!
      return {
        anchorTop: anchor.getBoundingClientRect().top,
        changeTop: changeBalloon.getBoundingClientRect().top,
        changeBottom: changeBalloon.getBoundingClientRect().bottom,
        threadTop: threadBalloon.getBoundingClientRect().top,
      }
    })
    expect(Math.abs(initial.changeTop - initial.anchorTop)).toBeLessThanOrEqual(1)
    expect(initial.threadTop - initial.changeBottom).toBeGreaterThanOrEqual(10)

    const editor = page.locator('.editor-area')
    await editor.evaluate((element) => { element.scrollTop = 180 })
    await expect.poll(async () => page.locator('.review-scroll').evaluate((element) => element.scrollTop)).toBe(180)

    const scrolled = await page.evaluate(() => {
      const balloon = document.querySelector<HTMLElement>('[data-review-balloon="dm-change-line"]')!
      const anchor = document.querySelector<HTMLElement>('.editor-area [data-review-anchor="dm-line"]')!
      return balloon.getBoundingClientRect().top - anchor.getBoundingClientRect().top
    })
    expect(Math.abs(scrolled)).toBeLessThanOrEqual(1)
  })
})
