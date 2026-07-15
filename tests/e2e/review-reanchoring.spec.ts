import { expect, test } from '@playwright/test'

const ambiguousReviewSource = `# External review recovery

target phrase · target phrase

::::: {.draftmatter-reviews .hidden data-schema="1"}
:::: {#dm-author .dm-author data-name="Alice Martin"}
::::
:::: {#dm-thread-ambiguous .dm-thread data-anchor="dm-anchor-ambiguous" data-author="dm-author" data-status="open"}
~~~{.dm-anchor-quote}
target phrase
~~~
~~~{.dm-anchor-prefix}

~~~
~~~{.dm-anchor-suffix}

~~~
~~~{.dm-message data-author="dm-author" data-index="0"}
Keep this review attached after the external edit.
~~~
::::
:::::
`

test.describe('DM-P4-06 external review recovery', () => {
  test('surfaces ambiguous matches and lets the author place the review explicitly', async ({ page }) => {
    await page.addInitScript((source) => {
      localStorage.setItem('draftmatter.structured-source.v1', source)
      localStorage.setItem('draftmatter.structured-mode.v1', 'true')
    }, ambiguousReviewSource)
    await page.goto('/')

    const reviewPanel = page.getByRole('complementary', { name: 'Review feedback' })
    await expect(reviewPanel.getByText('Unplaced suggestion')).toHaveCount(0)
    await expect(reviewPanel.getByText('Location needs attention')).toBeVisible()
    await expect(reviewPanel.getByText('More than one plausible text match remains.')).toBeVisible()
    await expect(reviewPanel.getByRole('button', { name: 'Place here 1' })).toBeVisible()
    await expect(reviewPanel.getByRole('button', { name: 'Place here 2' })).toBeVisible()

    await reviewPanel.getByRole('button', { name: 'Place here 2' }).click()

    await expect(reviewPanel.getByText('Location needs attention')).toHaveCount(0)
    await expect(reviewPanel.getByText('Keep this review attached after the external edit.')).toBeVisible()
    await expect.poll(async () => page.evaluate(() => localStorage.getItem('draftmatter.structured-source.v1'))).toContain('data-anchor="dm-anchor-ambiguous" data-edge="start"')
  })
})
