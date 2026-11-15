import { expect, test } from '@playwright/test'

const source = `# Point comments

Measure canopy area[]{#dm-sampling-point .dm-anchor data-anchor="dm-sampling-point" data-edge="point" data-affinity="after"} weekly.

::::: {.draftmatter-reviews .hidden data-schema="1"}
:::: {#dm-sampling-thread .dm-thread data-anchor="dm-sampling-point" data-author="dm-alice" data-status="open" data-created="2026-07-15T09:00:00.000Z"}
~~~{.dm-message}
Add the sampling date here.
~~~
::::
:::: {#dm-alice .dm-author data-name="Alice Martin"}
::::
:::::
`

test.describe('DM-P4-01 rendered point comments', () => {
  test('retains an imported zero-width comment, its prose and replies across reload', async ({ page }) => {
    await page.addInitScript((portableSource) => {
      if (!localStorage.getItem('draftmatter.structured-mode.v1')) {
        localStorage.setItem('draftmatter.structured-source.v1', portableSource)
        localStorage.setItem('draftmatter.structured-mode.v1', 'true')
      }
    }, source)
    await page.goto('/draft')

    const manuscript = page.getByRole('article', { name: 'Editable manuscript' })
    const marker = manuscript.getByRole('button', { name: 'Open point comment', exact: true })
    await marker.click()
    const comment = page.locator('#review-item-dm-sampling-thread')
    await expect(comment).toContainText('Add the sampling date here.')
    await expect(comment.getByText('Alice Martin', { exact: true })).toBeVisible()
    await expect(comment.locator('.comment-quote')).toHaveCount(0)

    const acceptedProse = () => manuscript.locator('.structured-editor-content p').evaluate((paragraph) =>
      [...paragraph.childNodes].filter((node) => node.nodeType === Node.TEXT_NODE).map((node) => node.textContent).join(''),
    )
    await expect.poll(acceptedProse).toBe('Measure canopy area weekly.')
    await comment.getByRole('button', { name: 'Reply', exact: true }).click()
    await comment.getByRole('textbox', { name: 'Reply to Alice Martin', exact: true }).fill('Sampled on 15 July.')
    await comment.getByRole('button', { name: 'Send reply', exact: true }).click()
    await expect(comment).toContainText('Sampled on 15 July.')
    await expect.poll(() => page.evaluate(() => localStorage.getItem('draftmatter.structured-source.v1') ?? '')).toContain('Sampled on 15 July.')

    const portable = await page.evaluate(() => localStorage.getItem('draftmatter.structured-source.v1') ?? '')
    expect(portable.match(/data-edge="point"/g)).toHaveLength(1)
    expect(portable).not.toContain('data-edge="end"')
    expect(portable).toContain('canopy area[]{#dm-sampling-point')

    await page.reload()
    await expect.poll(acceptedProse).toBe('Measure canopy area weekly.')
    await marker.click()
    await expect(comment).toContainText('Add the sampling date here.')
    await expect(comment).toContainText('Sampled on 15 July.')
    await expect(marker).toHaveAttribute('data-review-anchor', 'dm-sampling-point')
  })
})
