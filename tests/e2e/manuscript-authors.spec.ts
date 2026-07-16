import { readFile } from 'node:fs/promises'
import { expect, test } from '@playwright/test'

const source = `---
title: "Portable author study"
author:
  - name: "Ada Researcher"
    orcid: 0000-0001-2345-6789
    affiliations:
      - Field Institute
  - "Lin Reviewer"
bibliography:
  - references.bib
format: html
---

# Portable author study

Author metadata remains part of the ordinary manuscript.
`

test.describe('portable manuscript authors', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript((portableSource) => {
      Object.defineProperty(window, 'showSaveFilePicker', { configurable: true, value: undefined })
      if (!localStorage.getItem('draftmatter.structured-source.v1')) {
        localStorage.setItem('draftmatter.structured-source.v1', portableSource)
        localStorage.setItem('draftmatter.structured-mode.v1', 'true')
      }
    }, source)
    await page.goto('/')
  })

  test('edits the portable byline without transferring removed metadata and exports it after reload', async ({ page }) => {
    await page.getByRole('button', { name: 'Manage manuscript authors, 2 listed' }).click()
    const dialog = page.getByRole('dialog', { name: 'Manuscript authors' })
    await expect(dialog.getByLabel('Author 1 name')).toHaveValue('Ada Researcher')
    await expect(dialog.getByLabel('Author 1 ORCID')).toHaveValue('0000-0001-2345-6789')
    await expect(dialog.getByLabel('Author 1 affiliations')).toHaveValue('Field Institute')
    await expect(dialog.getByLabel('Author 2 name')).toHaveValue('Lin Reviewer')

    await dialog.getByLabel('Author 2 name').fill('Lin Chen')
    await dialog.getByLabel('Author 2 ORCID').fill('0000-0002-1825-0097')
    await dialog.getByRole('button', { name: 'Remove author 1' }).click()
    await dialog.getByRole('button', { name: 'Add another author' }).click()
    await dialog.getByLabel('Author 2 name').fill('Jo Newcomer')
    await dialog.getByLabel('Author 2 affiliations').fill('Open Methods Lab')
    await dialog.getByRole('button', { name: 'Save authors' }).click()

    await expect(page.getByText('Manuscript authors updated · 2 portable profiles')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Manage manuscript authors, 2 listed' })).toBeVisible()
    await expect.poll(() => page.evaluate(() => localStorage.getItem('draftmatter.structured-source.v1') ?? '')).toContain('Jo Newcomer')
    const portable = await page.evaluate(() => localStorage.getItem('draftmatter.structured-source.v1') ?? '')
    expect(portable).toContain('  - name: "Lin Chen"')
    expect(portable).toContain('    orcid: "0000-0002-1825-0097"')
    expect(portable).toContain('  - name: "Jo Newcomer"')
    expect(portable).toContain('      - "Open Methods Lab"')
    expect(portable).not.toContain('Ada Researcher')
    expect(portable).not.toContain('0000-0001-2345-6789')
    expect(portable).toContain('bibliography:\n  - references.bib\nformat: html')
    expect(portable).toContain('Author metadata remains part of the ordinary manuscript.')

    await page.reload()
    await page.getByRole('button', { name: 'Manage manuscript authors, 2 listed' }).click()
    await expect(dialog.getByLabel('Author 1 name')).toHaveValue('Lin Chen')
    await expect(dialog.getByLabel('Author 2 name')).toHaveValue('Jo Newcomer')
    await dialog.getByRole('button', { name: 'Close manuscript authors' }).click()

    await page.getByRole('button', { name: 'Export' }).click()
    await page.getByRole('button', { name: /Native HTML/ }).click()
    const exportDialog = page.getByRole('dialog', { name: 'Save clean HTML document' })
    const downloadEvent = page.waitForEvent('download')
    await exportDialog.getByRole('button', { name: 'Choose location…' }).click()
    const download = await downloadEvent
    const path = await download.path()
    expect(path).not.toBeNull()
    const html = await readFile(path!, 'utf8')
    expect(html).toContain('<p class="authors">Lin Chen · Jo Newcomer</p>')
    expect(html).not.toContain('Ada Researcher')
  })
})
