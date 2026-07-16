import { expect, test } from '@playwright/test'

const structuredSource = `---
title: "Outline field study"
---

# Outline field study

## Background {#sec-background}

Context for the study.

### Field setup {#sec-field-setup}

Setup details.

## Methods {#sec-methods}

The main protocol.

### Analysis {#sec-analysis}

Analysis details.

#### Diagnostics {#sec-diagnostics}

Diagnostic details.
`

test.describe('DM-P1-06 manuscript outline', () => {
  test('searches, filters, resets, and navigates a structured outline', async ({ page }) => {
    await page.addInitScript((portableSource) => {
      localStorage.setItem('draftmatter.structured-source.v1', portableSource)
      localStorage.setItem('draftmatter.structured-mode.v1', 'true')
    }, structuredSource)
    await page.goto('/')

    const outline = page.getByRole('complementary', { name: 'Manuscript outline' })
    const tree = outline.locator('.outline-tree')
    await expect(tree.getByText('Diagnostics', { exact: true })).toBeVisible()

    await outline.getByRole('button', { name: 'Outline options' }).click()
    const options = page.getByRole('dialog', { name: 'Outline display options' })
    await expect(options).toBeVisible()
    await options.getByRole('textbox', { name: 'Search outline' }).fill('methods')
    await expect(tree.getByText('Methods', { exact: true })).toBeVisible()
    await expect(tree.getByText('Background', { exact: true })).toHaveCount(0)
    await expect(options).toContainText('1 of 6 items')

    await options.getByRole('textbox', { name: 'Search outline' }).fill('')
    await options.getByRole('combobox', { name: 'Heading depth' }).selectOption('2')
    await expect(tree.getByText('Background', { exact: true })).toBeVisible()
    await expect(tree.getByText('Methods', { exact: true })).toBeVisible()
    await expect(tree.getByText('Analysis', { exact: true })).toHaveCount(0)
    await expect(options).toContainText('3 of 6 items')

    await options.getByRole('button', { name: 'Reset' }).click()
    await expect(tree.getByText('Diagnostics', { exact: true })).toBeVisible()
    await expect(options).toContainText('6 of 6 items')

    await page.evaluate(() => {
      ;(window as typeof window & { __lastOutlineScroll?: string | null }).__lastOutlineScroll = null
      HTMLElement.prototype.scrollIntoView = function scrollIntoView() {
        ;(window as typeof window & { __lastOutlineScroll?: string | null }).__lastOutlineScroll = this.getAttribute('data-dm-id')
      }
    })
    await outline.getByRole('button', { name: 'Outline options' }).click()
    await expect(options).toBeHidden()
    await tree.getByRole('button', { name: /Methods/ }).click()
    await expect.poll(() => page.evaluate(() => (window as typeof window & { __lastOutlineScroll?: string | null }).__lastOutlineScroll)).not.toBeNull()
  })

  test('creates the first sample-mode section before portable review metadata and reopens it', async ({ page }) => {
    await page.goto('/')
    const outline = page.getByRole('complementary', { name: 'Manuscript outline' })
    const answers = ['Discussion', '2', 'sec-discussion']
    const answerPrompt = (dialog: import('@playwright/test').Dialog) => dialog.accept(answers.shift())
    page.on('dialog', answerPrompt)
    await outline.getByRole('button', { name: /Add section/ }).click()
    page.off('dialog', answerPrompt)

    await expect(outline.getByText('Discussion', { exact: true })).toBeVisible()
    await expect(page.getByRole('article', { name: 'Editable manuscript' }).locator('#sec-discussion')).toHaveText('Discussion')
    await expect.poll(() => page.evaluate(() => localStorage.getItem('draftmatter.structured-mode.v1'))).toBe('true')
    await expect.poll(() => page.evaluate(() => localStorage.getItem('draftmatter.structured-source.v1') ?? '')).toContain('## Discussion {#sec-discussion}')
    const portable = await page.evaluate(() => localStorage.getItem('draftmatter.structured-source.v1') ?? '')
    expect(portable.indexOf('## Discussion {#sec-discussion}')).toBeGreaterThan(-1)
    expect(portable.indexOf('::::: {.draftmatter-reviews')).toBeGreaterThan(portable.indexOf('## Discussion {#sec-discussion}'))

    await page.reload()
    await expect(page.getByRole('article', { name: 'Editable manuscript' }).locator('#sec-discussion')).toHaveText('Discussion')
    await expect(page.getByRole('complementary', { name: 'Manuscript outline' }).getByText('Discussion', { exact: true })).toBeVisible()
  })
})
