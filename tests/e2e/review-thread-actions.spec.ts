import { expect, test } from '@playwright/test'

test.describe('DM-P4-01 review thread actions', () => {
  test('copies an ordinary portable figure reference', async ({ context, page }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await page.goto('/draft')

    const output = page.locator('.structured-output-image')
    const copyReference = page.getByRole('button', { name: 'Copy figure reference fig-canopy-result' })
    await output.hover()
    await expect(copyReference).toBeVisible()
    await copyReference.click()
    await expect(page.getByText('Copied @fig-canopy-result')).toBeVisible()
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('@fig-canopy-result')
  })

  test('persists reply and resolve activity timestamps across reload', async ({ page }) => {
    await page.goto('/draft')
    await page.locator('.topbar').getByRole('button', { name: /^Review,/ }).click()
    const review = page.getByRole('complementary', { name: 'Manuscript comments' })
    const comment = review.locator('#review-item-dm-comment-01')
    const createdAt = await comment.locator('.comment-author time').getAttribute('datetime')

    await comment.getByRole('button', { name: 'Reply', exact: true }).click()
    await comment.getByRole('textbox', { name: /^Reply to / }).fill('The interval is now included.')
    await comment.getByRole('textbox', { name: /^Reply to / }).press('Enter')
    await expect(comment).toContainText('The interval is now included.')
    await expect(comment.locator('.comment-author time')).toHaveAttribute('datetime', createdAt!)
    await expect(comment.locator('.portable-comment-reply time')).toHaveAttribute('datetime', /^\d{4}-\d{2}-\d{2}T/)

    await expect.poll(() => page.evaluate(() => localStorage.getItem('draftmatter.structured-source.v1') ?? '')).toContain('data-index="1"')
    const replied = await page.evaluate(() => localStorage.getItem('draftmatter.structured-source.v1') ?? '')
    expect(replied).toMatch(/#dm-comment-01 \.dm-thread[^}]*data-updated="\d{4}-\d{2}-\d{2}T[^}]+Z"/)
    expect(replied).toMatch(/\.dm-message data-author="dm-local-author" data-at="\d{4}-\d{2}-\d{2}T[^"]+Z" data-index="1"/)
    expect(replied.match(/data-name="Remi Vezy"/g)).toHaveLength(1)

    await comment.getByRole('button', { name: 'Resolve comment' }).click()
    await expect(comment.getByRole('button', { name: 'Reopen comment' })).toBeVisible()
    await expect.poll(() => page.evaluate(() => localStorage.getItem('draftmatter.structured-source.v1') ?? '')).toMatch(/#dm-comment-01 \.dm-thread[^}]*data-status="resolved"[^}]*data-updated=/)

    await page.reload()
    await page.locator('.topbar').getByRole('button', { name: /^Review,/ }).click()
    const reopenedReview = page.getByRole('complementary', { name: 'Manuscript comments' })
    const reopenedComment = reopenedReview.locator('#review-item-dm-comment-01')
    await expect(reopenedComment).toContainText('The interval is now included.')
    await expect(reopenedComment.locator('.portable-comment-reply').getByText('Remi Vezy', { exact: true })).toBeVisible()
    await expect(reopenedComment.getByRole('button', { name: 'Reopen comment' })).toBeVisible()
    await reopenedComment.getByRole('button', { name: 'Reopen comment' }).click()
    await expect.poll(() => page.evaluate(() => localStorage.getItem('draftmatter.structured-source.v1') ?? '')).toMatch(/#dm-comment-01 \.dm-thread[^}]*data-status="open"[^}]*data-updated=/)
  })

  test('removes a sample comment from the active queue and reopens its deleted audit record', async ({ page }) => {
    await page.goto('/draft')
    await page.locator('.topbar').getByRole('button', { name: /^Review,/ }).click()
    const review = page.getByRole('complementary', { name: 'Manuscript comments' })
    const topbar = page.locator('.topbar')
    const rail = page.getByRole('navigation', { name: 'Workspace navigation' })
    await expect(topbar.getByRole('button', { name: 'Review, 3 open items' })).toBeVisible()
    await expect(rail.getByRole('button', { name: 'Review, 3 open items' })).toBeVisible()
    await expect(review).not.toContainText('REVIEW 1 OF 3')
    await expect(review.getByText('Can we quantify this increase in the main text?')).toBeVisible()

    await review.locator('#review-item-dm-comment-01').getByRole('button', { name: 'Delete comment' }).click()
    await expect(review.getByText('Can we quantify this increase in the main text?')).toHaveCount(0)
    await expect(topbar.getByRole('button', { name: 'Review, 2 open items' })).toBeVisible()
    await expect(rail.getByRole('button', { name: 'Review, 2 open items' })).toBeVisible()
    await expect(review).not.toContainText('REVIEW 1 OF 2')
    await expect.poll(() => page.evaluate(() => localStorage.getItem('draftmatter.structured-source.v1') ?? '')).toContain('data-status="deleted"')

    await page.reload()
    await page.locator('.topbar').getByRole('button', { name: /^Review,/ }).click()
    await expect(page.getByRole('complementary', { name: 'Manuscript comments' }).getByText('Can we quantify this increase in the main text?')).toHaveCount(0)
    await expect(page.locator('.topbar').getByRole('button', { name: 'Review, 2 open items' })).toBeVisible()
    const portable = await page.evaluate(() => localStorage.getItem('draftmatter.structured-source.v1') ?? '')
    expect(portable).toContain('{#dm-comment-01 .dm-thread')
    expect(portable).toContain('data-status="deleted"')
    expect(portable).toMatch(/data-status="deleted"[^}]*data-updated="\d{4}-\d{2}-\d{2}T[^}]+Z"/)
  })
})
