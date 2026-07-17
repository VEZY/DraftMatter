import { expect, test } from '@playwright/test'

const source = `## Results

The []{#dm-i1s .dm-anchor data-anchor="dm-r-identical" data-edge="start"}leaf area declined[]{#dm-i1e .dm-anchor data-anchor="dm-r-identical" data-edge="end"}.

::::: {.draftmatter-reviews .hidden data-schema="1"}
:::: {#dm-i01 .dm-change data-anchor="dm-r-identical" data-kind="replace" data-author="dm-a01" data-status="open"}
~~~{.dm-proposal}
leaf area declined by 18%
~~~
::::
:::: {#dm-i02 .dm-change data-anchor="dm-r-identical" data-kind="replace" data-author="dm-a02" data-status="open"}
~~~{.dm-proposal}
leaf expansion slowed
~~~
::::
:::: {#dm-a01 .dm-author data-name="Alice Martin"}
::::
:::: {#dm-a02 .dm-author data-name="Marcus Chen"}
::::
:::::
`

test.describe('DM-P4-04 atomic local rebase', () => {
  test('folds accepted text into the base and creates one revised portable proposal', async ({ page }) => {
    await page.addInitScript((portableSource) => {
      localStorage.setItem('draftmatter.structured-source.v1', portableSource)
      localStorage.setItem('draftmatter.structured-mode.v1', 'true')
    }, source)
    await page.goto('/')
    await page.locator('.topbar').getByRole('button', { name: /^Review,/ }).click()

    const review = page.getByRole('complementary', { name: 'Review feedback' })
    await review.getByRole('button', { name: /Marcus Chen/ }).click()
    await review.getByRole('button', { name: 'Accept', exact: true }).click()
    await expect(review.locator('#review-item-dm-i01')).toContainText('Needs rebase')

    await review.locator('#review-item-dm-i01 .proposal-option').evaluate((button: HTMLButtonElement) => button.click())
    await expect(review.locator('#review-item-dm-i01')).toHaveClass(/active/)
    await review.getByRole('button', { name: 'Rebase suggestion' }).click()
    const form = review.getByRole('group', { name: 'Rebase suggestion' })
    await form.getByLabel('Text in accepted manuscript').fill('leaf expansion slowed')
    await form.getByLabel('Revised proposal').fill('leaf area declined by 16%')
    await expect(page.getByText('Saved locally')).toBeVisible()
    await expect(page).toHaveScreenshot('review-rebase-form.png')
    await form.getByRole('button', { name: 'Create rebased proposal' }).click()

    await expect(review.getByText('leaf area declined by 16%')).toBeVisible()
    await expect.poll(() => page.evaluate(() => localStorage.getItem('draftmatter.structured-source.v1') ?? '')).toContain('data-status="applied"')
    const portable = await page.evaluate(() => localStorage.getItem('draftmatter.structured-source.v1') ?? '')
    expect(portable).toContain('data-status="applied"')
    expect(portable).toContain('data-status="rebased"')
    expect(portable).toContain('data-action="rebased"')
    expect(portable).toContain('data-rebased-from="dm-i01"')
    expect(portable).toContain('The []{')
    expect(portable).toContain('leaf expansion slowed')

    await review.getByText('Review options', { exact: true }).click()
    await review.getByLabel('Markup view').selectOption('final')
    await expect(page.getByRole('article', { name: 'Editable manuscript' })).toContainText('The leaf area declined by 16%.')
  })
})
