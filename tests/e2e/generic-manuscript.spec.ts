import { expect, test } from '@playwright/test'

const source = `---
title: "Portable field notes"
---

# Portable field notes

## Background {#sec-background}

This is an arbitrary manuscript with a citation [@vezy2024] and **editable prose**.[^methods]

See @sec-background for context.

A uniquely selected review sentence.

A uniquely selected suggestion sentence.

[^methods]: Calibration details stay portable.

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
    await expect(manuscript.getByRole('button', { name: 'Edit citation @vezy2024' })).toHaveText('(Vezy et al., 2024)')
    await expect(manuscript.getByRole('link', { name: 'Section background' })).toHaveAttribute('href', '#sec-background')
    await expect(manuscript.getByRole('button', { name: 'Go to footnote 1' })).toHaveText('1')
    await expect(manuscript.getByText('Footnote 1', { exact: true })).toBeVisible()
    await expect(manuscript.getByText('Calibration details stay portable.', { exact: true })).toBeVisible()
    await expect(renderedEditor).not.toContainText(':::')
    await expect(renderedEditor).not.toContainText('@sec-background')
    await expect(renderedEditor).not.toContainText('[^methods]')
    await expect(renderedEditor).not.toContainText('Keep this opaque block exactly.')
    await expect(manuscript.getByText('Preserved source')).toBeVisible()

    await manuscript.getByRole('button', { name: 'Edit footnote 1' }).click()
    await manuscript.getByRole('textbox', { name: 'Footnote 1 content' }).fill('Calibration details were **independently checked**.')
    await manuscript.getByRole('button', { name: 'Save note' }).click()
    await expect(manuscript.getByText('Calibration details were independently checked.', { exact: true })).toBeVisible()
    await expect.poll(async () => page.evaluate(() => localStorage.getItem('draftmatter.structured-source.v1'))).toContain('[^methods]: Calibration details were **independently checked**.')

    const code = manuscript.getByRole('textbox', { name: 'julia code cell cell-growth' })
    await code.fill('println("after")')
    await expect.poll(async () => page.evaluate(() => localStorage.getItem('draftmatter.structured-source.v1'))).toContain('println("after")')

    await page.reload()
    await expect(page.getByRole('textbox', { name: 'julia code cell cell-growth' })).toHaveValue('println("after")')
    await expect(page.getByText('Calibration details were independently checked.', { exact: true })).toBeVisible()
    let saved = await page.evaluate(() => localStorage.getItem('draftmatter.structured-source.v1'))
    expect(saved).toContain('::: {.future-extension data-owner="research-team"}\nKeep this opaque block exactly.\n:::')
    expect(saved).toContain('See @sec-background for context.')

    await manuscript.locator('.structured-editor-content p').first().click()
    await page.keyboard.press('End')
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k')
    const commandMenu = page.getByRole('dialog', { name: 'Command menu' })
    await expect(commandMenu.getByRole('button', { name: /Add section/ })).toBeVisible()
    await expect(commandMenu.getByRole('button', { name: /Insert inline equation/ })).toBeVisible()
    await expect(commandMenu.getByRole('button', { name: /Insert cross-reference/ })).toBeVisible()
    await expect(commandMenu.getByRole('button', { name: /Insert footnote/ })).toBeVisible()
    await expect(commandMenu.getByRole('button', { name: /Insert table/ })).toBeVisible()
    await expect(commandMenu.getByRole('button', { name: /Insert figure/ })).toBeVisible()
    await expect(commandMenu.getByRole('button', { name: /Insert code cell/ })).toBeVisible()
    await commandMenu.getByRole('button', { name: /Insert citation/ }).click()
    await page.getByRole('button', { name: /Growth coordination under fluctuating water availability/ }).click()
    await page.getByRole('button', { name: 'Insert selected · 1' }).click()
    await expect.poll(async () => page.evaluate(() => localStorage.getItem('draftmatter.structured-source.v1'))).toContain('[@martin2023]')
    saved = await page.evaluate(() => localStorage.getItem('draftmatter.structured-source.v1'))
    expect(saved).toContain('[@martin2023]')

    await page.getByRole('button', { name: 'Edit citation @martin2023' }).click()
    const citationDetails = page.locator('.structured-citation-detail')
    await citationDetails.getByLabel('Locator').fill('p. 18')
    await expect.poll(async () => page.evaluate(() => localStorage.getItem('draftmatter.structured-source.v1'))).toContain('[@martin2023, p. 18]')
    await citationDetails.getByRole('button', { name: 'Done' }).click()

    await manuscript.getByText('A uniquely selected review sentence.', { exact: true }).selectText()
    const reviewPanel = page.getByRole('complementary', { name: 'Review feedback' })
    await reviewPanel.getByRole('button', { name: 'New comment' }).click()
    const commentComposer = reviewPanel.getByRole('group', { name: 'New comment' })
    await expect(commentComposer.getByLabel('Exact manuscript text')).toHaveValue('A uniquely selected review sentence.')
    await commentComposer.getByLabel('Comment').fill('Clarify how this sentence supports the result.')
    await commentComposer.getByRole('button', { name: 'Add' }).click()
    await expect(reviewPanel.getByText('Clarify how this sentence supports the result.')).toBeVisible()
    await expect.poll(async () => page.evaluate(() => localStorage.getItem('draftmatter.structured-source.v1'))).toContain('.draftmatter-reviews')
    await expect(manuscript.locator('.dm-review-thread')).toContainText('A uniquely selected review sentence.')

    await reviewPanel.getByLabel('Markup view').selectOption('original')
    await expect(manuscript.getByText('Original preview')).toBeVisible()
    await expect(page.getByRole('textbox', { name: 'Rendered manuscript editor' })).toHaveAttribute('contenteditable', 'false')
    await expect(manuscript.locator('.dm-review-thread')).toHaveCount(0)
    await reviewPanel.getByLabel('Markup view').selectOption('all')
    await expect(page.getByRole('textbox', { name: 'Rendered manuscript editor' })).toHaveAttribute('contenteditable', 'true')
    await expect(manuscript.locator('.dm-review-thread')).toContainText('A uniquely selected review sentence.')

    await manuscript.getByText('A uniquely selected suggestion sentence.', { exact: true }).selectText()
    await reviewPanel.getByRole('button', { name: 'Suggest edit' }).click()
    const suggestionComposer = reviewPanel.getByRole('group', { name: 'New suggestion' })
    await expect(suggestionComposer.getByLabel('Exact manuscript text')).toHaveValue('A uniquely selected suggestion sentence.')
    await suggestionComposer.getByLabel('Replacement').fill('A carefully revised suggestion sentence.')
    await suggestionComposer.getByRole('button', { name: 'Add' }).click()
    await reviewPanel.getByRole('button', { name: /A carefully revised suggestion sentence/ }).click()
    await reviewPanel.getByRole('button', { name: 'Accept' }).click()
    await expect(reviewPanel.getByText('Accepted')).toBeVisible()
    await expect.poll(async () => page.evaluate(() => localStorage.getItem('draftmatter.structured-source.v1'))).toContain('A carefully revised suggestion sentence.')

    await reviewPanel.getByLabel('Markup view').selectOption('final')
    await expect(manuscript.getByText('Final preview')).toBeVisible()
    await expect(manuscript.getByText('A carefully revised suggestion sentence.', { exact: true })).toBeVisible()
    await reviewPanel.getByLabel('Markup view').selectOption('all')

    const sectionPrompts = ['Discussion', '2']
    const acceptSectionPrompt = (dialog: import('@playwright/test').Dialog) => dialog.accept(sectionPrompts.shift())
    page.on('dialog', acceptSectionPrompt)
    await page.getByRole('complementary', { name: 'Manuscript outline' }).getByRole('button', { name: /Add section/ }).click()
    page.off('dialog', acceptSectionPrompt)
    await expect(page.getByRole('complementary', { name: 'Manuscript outline' }).getByText('Discussion')).toBeVisible()
    await expect.poll(async () => page.evaluate(() => localStorage.getItem('draftmatter.structured-source.v1'))).toContain('## Discussion')

    await expect(page).toHaveScreenshot('generic-manuscript-editor.png')
  })
})
