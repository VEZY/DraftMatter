import { expect, test } from '@playwright/test'

const source = `# Batch review

The []{#dm-alpha-start .dm-anchor data-anchor="dm-alpha" data-edge="start"}alpha phrase[]{#dm-alpha-end .dm-anchor data-anchor="dm-alpha" data-edge="end"} stays here.

The []{#dm-beta-start .dm-anchor data-anchor="dm-beta" data-edge="start"}beta phrase[]{#dm-beta-end .dm-anchor data-anchor="dm-beta" data-edge="end"} stays here.

The []{#dm-gamma-start .dm-anchor data-anchor="dm-gamma" data-edge="start"}gamma phrase[]{#dm-gamma-end .dm-anchor data-anchor="dm-gamma" data-edge="end"} stays here.

::::: {.draftmatter-reviews .hidden data-schema="1"}
:::: {#dm-change-alpha .dm-change data-anchor="dm-alpha" data-kind="replace" data-author="dm-alice" data-status="open"}
~~~{.dm-proposal}
revised alpha phrase
~~~
::::
:::: {#dm-change-beta .dm-change data-anchor="dm-beta" data-kind="replace" data-author="dm-alice" data-status="open"}
~~~{.dm-proposal}
revised beta phrase
~~~
::::
:::: {#dm-change-gamma .dm-change data-anchor="dm-gamma" data-kind="replace" data-author="dm-marcus" data-status="open"}
~~~{.dm-proposal}
revised gamma phrase
~~~
::::
:::: {#dm-alice .dm-author data-name="Alice Martin"}
::::
:::: {#dm-marcus .dm-author data-name="Marcus Chen"}
::::
:::::
`

test.describe('DM-P4-04 selected and author batch decisions', () => {
  test('accepts an author-filtered set atomically, then rejects all remaining suggestions', async ({ page }) => {
    await page.addInitScript((portableSource) => {
      localStorage.setItem('draftmatter.structured-source.v1', portableSource)
      localStorage.setItem('draftmatter.structured-mode.v1', 'true')
    }, source)
    await page.goto('/')

    const review = page.getByRole('complementary', { name: 'Review feedback' })
    await review.getByLabel('Review author').selectOption('dm-alice')
    await expect(review.getByRole('group', { name: 'Batch suggestion decisions' })).toContainText("Alice Martin's visible suggestions")
    await review.getByRole('button', { name: 'Select all 2' }).click()
    await expect(review.getByLabel('Select suggestion by Alice Martin')).toHaveCount(2)
    await expect(review.getByLabel('Select suggestion by Alice Martin').first()).toBeChecked()
    await review.getByRole('button', { name: 'Accept selected' }).click()
    await expect(page.getByText('2 suggestions accepted atomically')).toBeVisible()

    await expect.poll(() => page.evaluate(() => localStorage.getItem('draftmatter.structured-source.v1') ?? ''))
      .toContain('data-status="accepted"')
    let portable = await page.evaluate(() => localStorage.getItem('draftmatter.structured-source.v1') ?? '')
    expect(portable.match(/data-status="accepted"/g)).toHaveLength(2)
    expect(portable.match(/data-action="accepted"/g)).toHaveLength(2)
    expect(portable).toMatch(/#dm-change-gamma[^\n]*data-status="open"/)

    await review.getByLabel('Review author').selectOption('all')
    await review.getByRole('button', { name: 'Select all 1' }).click()
    await review.getByRole('button', { name: 'Reject selected' }).click()
    await expect(page.getByText('1 suggestion rejected atomically')).toBeVisible()
    await expect(review.getByRole('group', { name: 'Batch suggestion decisions' })).toHaveCount(0)
    await expect.poll(() => page.evaluate(() => localStorage.getItem('draftmatter.structured-source.v1') ?? ''))
      .toContain('data-status="rejected"')

    portable = await page.evaluate(() => localStorage.getItem('draftmatter.structured-source.v1') ?? '')
    expect(portable).toMatch(/#dm-change-gamma[^\n]*data-status="rejected"/)
    expect(portable.match(/\.dm-decision/g)).toHaveLength(3)
  })
})
