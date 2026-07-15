import { expect, test } from '@playwright/test'

const source = `---
title: "Portable field notes"
---

# Portable field notes

## Background

This is an arbitrary manuscript with a citation [@vezy2024] and **editable prose**.

~~~julia {#cell-growth .execute output="table"}
println("before")
~~~

::: {.future-extension data-owner="research-team"}
Keep this opaque block exactly.
:::
`

test.describe('DM-P1-03 generic portable manuscript', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript((portableSource) => {
      if (!localStorage.getItem('draftmatter.structured-mode.v1')) {
        localStorage.setItem('draftmatter.structured-source.v1', portableSource)
        localStorage.setItem('draftmatter.structured-mode.v1', 'true')
      }
    }, source)
    await page.goto('/')
  })

  test('renders, edits, and reopens an arbitrary QMD without exposing opaque source', async ({ page }) => {
    const manuscript = page.getByRole('article', { name: 'Editable manuscript' })
    const renderedEditor = page.getByRole('textbox', { name: 'Rendered manuscript editor' })

    await expect(manuscript.getByRole('heading', { level: 1 })).toHaveText('Portable field notes')
    await expect(manuscript.getByRole('heading', { level: 2, name: 'Background' })).toBeVisible()
    await expect(manuscript.locator('.structured-citation')).toHaveText('(vezy2024)')
    await expect(renderedEditor).not.toContainText(':::')
    await expect(renderedEditor).not.toContainText('Keep this opaque block exactly.')
    await expect(manuscript.getByText('Preserved source')).toBeVisible()

    const code = manuscript.getByRole('textbox', { name: 'julia code cell cell-growth' })
    await code.fill('println("after")')
    await expect.poll(async () => page.evaluate(() => localStorage.getItem('draftmatter.structured-source.v1'))).toContain('println("after")')

    await page.reload()
    await expect(page.getByRole('textbox', { name: 'julia code cell cell-growth' })).toHaveValue('println("after")')
    const saved = await page.evaluate(() => localStorage.getItem('draftmatter.structured-source.v1'))
    expect(saved).toContain('::: {.future-extension data-owner="research-team"}\nKeep this opaque block exactly.\n:::')

    await expect(page).toHaveScreenshot('generic-manuscript-editor.png')
  })
})
