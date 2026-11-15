import { expect, test } from '@playwright/test'

const SOURCE_KEY = 'draftmatter.structured-source.v1'
const source = `---
title: Evidence title
---

## A search study

Measured **evidence** inside prose, and evidence from another observation.

A separate paragraph preserves the typing position.

A reference [@search2026].
`

async function seed(page: import('@playwright/test').Page, manuscript = source) {
  await page.addInitScript(({ source }) => {
    if (sessionStorage.getItem('draftmatter-find-seeded')) return
    localStorage.setItem('draftmatter.structured-source.v1', source)
    localStorage.setItem('draftmatter.structured-mode.v1', 'true')
    localStorage.setItem('draftmatter.project-meta.v1', JSON.stringify({ filename: 'find-study.md', projectName: 'Document find study', citationStyle: 'draftmatter-author-date', citationLocale: 'en-US' }))
    localStorage.setItem('draftmatter.citations.v1', JSON.stringify([{ citekey: 'search2026', type: 'article', title: 'Evidence from a generated reference', authors: ['Alex Reader'], year: '2026', source: 'csl-json' }]))
    sessionStorage.setItem('draftmatter-find-seeded', 'true')
  }, { source: manuscript })
  await page.goto('/draft')
  await expect(page.getByRole('textbox', { name: 'Rendered manuscript editor', exact: true })).toBeVisible()
  await expect(page.locator('.bibliography-entries')).toContainText('Evidence from a generated reference')
  await expect(page.getByRole('textbox', { name: 'Manuscript title', exact: true })).toContainText('Evidence title')
}

for (const modifier of ['Meta', 'Control']) {
  test(`${modifier}+F searches title, formatted prose and bibliography without editing the manuscript`, async ({ page }) => {
    await seed(page)
    const editor = page.getByRole('textbox', { name: 'Rendered manuscript editor', exact: true })
    const target = editor.locator('p').filter({ hasText: 'A separate paragraph' })
    await target.evaluate((paragraph) => {
      const editor = paragraph.closest<HTMLElement>('[contenteditable="true"]')!
      editor.focus()
      const range = document.createRange(); range.selectNodeContents(paragraph); range.collapse(false)
      const selection = getSelection()!; selection.removeAllRanges(); selection.addRange(range)
    })
    await page.keyboard.press('ArrowLeft'); await page.keyboard.press('ArrowRight')
    const original = await page.evaluate((key) => localStorage.getItem(key), SOURCE_KEY)
    await page.keyboard.press(`${modifier}+f`)
    const search = page.getByRole('search', { name: 'Find in document', exact: true })
    const query = search.getByRole('searchbox', { name: 'Find in document', exact: true })
    await expect(query).toBeFocused()
    await query.fill('evidence')
    await expect(search.locator('output')).toHaveText('1 of 4')
    await expect(editor.locator('.manuscript-find-match')).toHaveCount(2)
    await query.press('Enter')
    await expect(search.locator('output')).toHaveText('2 of 4')
    await query.press('Shift+Enter')
    await expect(search.locator('output')).toHaveText('1 of 4')
    await query.press('Shift+Enter')
    await expect(search.locator('output')).toHaveText('4 of 4')
    await query.fill('measured evidence')
    await expect(search.locator('output')).toHaveText('1 of 1')
    await query.fill('missing phrase')
    await expect(search.locator('output')).toHaveText('0 of 0')
    await expect(search.getByRole('button', { name: 'Next match' })).toBeDisabled()
    await query.press('Escape')
    await expect(search).toHaveCount(0)
    await expect(editor).toBeFocused()
    expect(await page.evaluate((key) => localStorage.getItem(key), SOURCE_KEY)).toBe(original)
    await page.keyboard.type(' Kept caret.')
    await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), SOURCE_KEY)).toContain('A separate paragraph preserves the typing position. Kept caret.')
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z')
    await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), SOURCE_KEY)).toBe(original)
    await page.keyboard.press(`${modifier}+f`)
    await expect(query).toBeFocused()
    await query.fill('another observation')
    await expect(search.locator('output')).toHaveText('1 of 1')
    await editor.click()
    await page.keyboard.press(`${modifier}+f`)
    await expect(query).toBeFocused()
    await expect(query).toHaveValue('another observation')
  })
}


test('updates the match count while editing with Find open and restores it with ordinary undo', async ({ page }) => {
  await seed(page)
  await page.keyboard.press('Control+f')
  const search = page.getByRole('search', { name: 'Find in document', exact: true })
  await search.getByRole('searchbox', { name: 'Find in document', exact: true }).fill('evidence')
  await expect(search.locator('output')).toHaveText('1 of 4')
  const editor = page.getByRole('textbox', { name: 'Rendered manuscript editor', exact: true })
  await editor.locator('p').filter({ hasText: 'A separate paragraph' }).evaluate((paragraph) => {
    paragraph.closest<HTMLElement>('[contenteditable="true"]')!.focus()
    const range = document.createRange(); range.selectNodeContents(paragraph); range.collapse(false)
    const selection = getSelection()!; selection.removeAllRanges(); selection.addRange(range)
  })
  await page.keyboard.press('ArrowLeft'); await page.keyboard.press('ArrowRight')
  const original = await page.evaluate((key) => localStorage.getItem(key), SOURCE_KEY)
  await page.keyboard.type(' More evidence.')
  await expect(search.locator('output')).toHaveText('1 of 5')
  await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), SOURCE_KEY)).toContain('typing position. More evidence.')
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z')
  await expect(search.locator('output')).toHaveText('1 of 4')
  await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), SOURCE_KEY)).toBe(original)
})


test('searches generated table text and captions in document order while excluding computation source', async ({ page }) => {
  const output = '```python {#find-table .execute output="table"}\nprint("secret_hidden_code evidence")\n```\n\n<!-- dm-output:start cell="find-table" run="sha256:find" -->\n| Treatment | Mean |\n| --- | --- |\n| evidence | 18 |\n: Generated evidence. {#tbl-find}\n<!-- dm-output:end -->\n\n'
  const manuscript = source.replace('A separate paragraph', output + 'A separate paragraph')
  await seed(page, manuscript)
  await expect(page.locator('.structured-output-caption')).toContainText('Generated evidence')
  const original = await page.evaluate((key) => localStorage.getItem(key), SOURCE_KEY)
  await page.keyboard.press('Control+f')
  const search = page.getByRole('search', { name: 'Find in document', exact: true })
  const query = search.getByRole('searchbox', { name: 'Find in document', exact: true })
  await query.fill('evidence')
  await expect(search.locator('output')).toHaveText('1 of 6')
  await query.press('Enter'); await query.press('Enter'); await query.press('Enter')
  await expect(search.locator('output')).toHaveText('4 of 6')
  const activeText = () => page.evaluate(() => {
    const highlight = CSS.highlights.get('draftmatter-find-current')
    const range = highlight && [...highlight][0] as Range | undefined
    return { text: range?.toString(), caption: Boolean(range?.startContainer.parentElement?.closest('.structured-output-caption')), cell: Boolean(range?.startContainer.parentElement?.closest('td')) }
  })
  expect(await activeText()).toMatchObject({ text: 'evidence', caption: true })
  await query.press('Enter')
  await expect(search.locator('output')).toHaveText('5 of 6')
  expect(await activeText()).toMatchObject({ text: 'evidence', cell: true })
  await query.fill('secret_hidden_code')
  await expect(search.locator('output')).toHaveText('0 of 0')
  await query.fill('TreatmentMean')
  await expect(search.locator('output')).toHaveText('0 of 0')
  await query.fill('Generated evidence')
  await expect(search.locator('output')).toHaveText('1 of 1')
  await query.press('Escape')
  expect(await page.evaluate((key) => localStorage.getItem(key), SOURCE_KEY)).toBe(original)
})
