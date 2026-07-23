import { expect, test } from '@playwright/test'

const source = `# Review navigation

The []{#dm-alpha-start .dm-anchor data-anchor="dm-alpha" data-edge="start"}alpha phrase[]{#dm-alpha-end .dm-anchor data-anchor="dm-alpha" data-edge="end"} stays here.

The []{#dm-beta-start .dm-anchor data-anchor="dm-beta" data-edge="start"}beta phrase[]{#dm-beta-end .dm-anchor data-anchor="dm-beta" data-edge="end"} stays here.

::::: {.draftmatter-reviews .hidden data-schema="1"}
:::: {#dm-change-alpha .dm-change data-anchor="dm-alpha" data-kind="replace" data-author="dm-alice" data-status="open"}
~~~{.dm-proposal}
revised alpha phrase
~~~
::::
:::: {#dm-change-beta .dm-change data-anchor="dm-beta" data-kind="replace" data-author="dm-marcus" data-status="open"}
~~~{.dm-proposal}
revised beta phrase
~~~
::::
:::: {#dm-alice .dm-author data-name="Alice Martin"}
::::
:::: {#dm-marcus .dm-author data-name="Marcus Chen"}
::::
:::::
`

test.describe('DM-P4-05 markup filtering and navigation', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript((portableSource) => {
      localStorage.setItem('draftmatter.structured-source.v1', portableSource)
      localStorage.setItem('draftmatter.structured-mode.v1', 'true')
    }, source)
    await page.goto('/draft')
    await page.locator('.topbar').getByRole('button', { name: /^Review,/ }).click()
    const review = page.getByRole('complementary', { name: 'Review feedback' })
    await expect(review.getByRole('button', { name: /In panel/ })).toHaveAttribute('aria-pressed', 'true')
    await review.getByRole('button', { name: /In text/ }).click()
    await review.getByText('More options', { exact: true }).click()
  })

  test('keeps the manuscript marks, author filter, rail selection, and navigation aligned', async ({ page }) => {
    const manuscript = page.getByRole('article', { name: 'Editable manuscript' })
    const review = page.getByRole('complementary', { name: 'Review feedback' })
    const marks = manuscript.locator('.dm-review-change[data-review-anchor]')

    await expect(marks).toHaveCount(2)
    await expect(manuscript.locator('.dm-review-proposal')).toHaveCount(2)
    await review.getByLabel('Review author').selectOption('dm-alice')
    await expect(marks).toHaveCount(1)
    await expect(manuscript.locator('.dm-review-proposal')).toHaveText('revised alpha phrase')
    await expect(marks.first()).toHaveAttribute('data-review-anchor', 'dm-alpha')

    await review.getByRole('button', { name: /In panel/ }).click()
    await expect(review.getByRole('button', { name: /In panel/ })).toHaveAttribute('aria-pressed', 'true')
    await expect(manuscript.locator('.dm-review-proposal')).toHaveCount(0)
    await expect(marks).toHaveCount(1)
    await review.getByRole('button', { name: /In text/ }).click()
    await expect(review.getByRole('button', { name: /In text/ })).toHaveAttribute('aria-pressed', 'true')

    await review.getByLabel('Review author').selectOption('dm-marcus')
    await expect(marks).toHaveCount(1)
    await expect(marks.first()).toHaveAttribute('data-review-anchor', 'dm-beta')
    await marks.first().click()
    await expect(review.locator('#review-item-dm-change-beta .proposal-option')).toHaveClass(/selected/)
    await expect(marks.first()).toHaveClass(/dm-review-active/)

    await review.getByLabel('Review author').selectOption('all')
    await expect(marks).toHaveCount(2)
    await review.getByRole('button', { name: 'Next review item' }).click()
    await expect(review.locator('#review-item-dm-change-alpha .proposal-option')).toHaveClass(/selected/)
    await expect(manuscript.locator('.dm-review-change[data-review-anchor="dm-alpha"]')).toHaveClass(/dm-review-active/)
  })
})

test.describe('DM-P4-05 modeled review alternatives', () => {
  test('renders the alternative selected by next and previous navigation', async ({ page }) => {
    await page.goto('/draft')
    await page.locator('.topbar').getByRole('button', { name: /^Review,/ }).click()
    const review = page.getByRole('complementary', { name: 'Review feedback' })
    await review.getByRole('button', { name: /In text/ }).click()
    const reviewedSentence = page.getByRole('article', { name: 'Editable manuscript' })

    await expect(reviewedSentence.locator('.dm-review-proposal')).toHaveText('reduced leaf area by 18%')
    await review.getByRole('button', { name: 'Next review item' }).click()
    await expect(reviewedSentence.locator('.dm-review-proposal')).toHaveText('lowered leaf expansion during the treatment period')
    await review.getByRole('button', { name: 'Previous review item' }).click()
    await expect(reviewedSentence.locator('.dm-review-proposal')).toHaveText('reduced leaf area by 18%')
  })
})
