import { expect, test } from '@playwright/test'

const source = `---
title: "Portable field notes"
---

# Portable field notes

## Background {#sec-background}

This is an arbitrary manuscript with a citation [@vezy2024] and **editable prose**.[^methods]

See @sec-background for context.

The observed trajectories are summarized in @fig-canopy.

![Canopy response](/fixtures/canopy-response.svg "Observed canopy"){#fig-canopy .wide data-owner="field-team"}
: Canopy response over time.

The measurements are summarized in @tbl-canopy.

| Month | Index |
| :--- | ---: |
| August | 0.54 |
| September | 0.68 |
: Monthly canopy index. {#tbl-canopy .striped data-owner="field-team"}

The fitted response was $y = \\frac{x}{2}$; see @eq-fit.

$$
R^2 = \\frac{a}{b}
$$ {#eq-fit .unnumbered}

A dedicated citation insertion target.

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
    const codeCell = manuscript.locator('.structured-code-cell[data-dm-id="cell-growth"]')

    await expect(manuscript.getByRole('heading', { level: 1 })).toHaveText('Portable field notes')
    await expect(manuscript.getByRole('heading', { level: 2, name: 'Background' })).toBeVisible()
    await expect(manuscript.getByRole('button', { name: 'Edit citation @vezy2024' })).toHaveText('(Vezy et al., 2024)')
    await expect(manuscript.getByRole('link', { name: 'Section background' })).toHaveAttribute('href', '#sec-background')
    await expect(manuscript.getByRole('link', { name: 'Figure canopy' })).toHaveAttribute('href', '#fig-canopy')
    await expect(manuscript.locator('#fig-canopy')).toBeVisible()
    await expect(manuscript.getByRole('img', { name: 'Canopy response' })).toBeVisible()
    await expect(manuscript.getByRole('link', { name: 'Table canopy' })).toHaveAttribute('href', '#tbl-canopy')
    await expect(manuscript.locator('#tbl-canopy')).toBeVisible()
    await expect(manuscript.locator('#tbl-canopy figcaption')).toHaveText('Monthly canopy index.')
    await expect(manuscript.locator('#tbl-canopy th').nth(1)).toHaveCSS('text-align', 'right')
    await expect(manuscript.getByRole('link', { name: 'Equation fit' })).toHaveAttribute('href', '#eq-fit')
    await expect(manuscript.locator('.structured-equation-inline .katex')).toBeVisible()
    await expect(manuscript.locator('#eq-fit .katex')).toBeVisible()
    await expect(manuscript.locator('.structured-equation math')).toHaveCount(2)
    await expect(manuscript.getByRole('button', { name: 'Go to footnote 1' })).toHaveText('1')
    await expect(codeCell.getByRole('button', { name: 'Show julia code for cell-growth' })).toHaveAttribute('aria-expanded', 'false')
    await expect(codeCell.getByRole('textbox', { name: 'julia code cell cell-growth' })).toHaveCount(0)
    await expect(manuscript.getByText('Footnote 1', { exact: true })).toBeVisible()
    await expect(manuscript.getByText('Calibration details stay portable.', { exact: true })).toBeVisible()
    await expect(renderedEditor).not.toContainText(':::')
    await expect(renderedEditor).not.toContainText('@sec-background')
    await expect(renderedEditor).not.toContainText('[^methods]')
    await expect(renderedEditor).not.toContainText('Keep this opaque block exactly.')
    await expect(manuscript.getByText('Preserved source')).toBeVisible()

    await manuscript.getByRole('button', { name: 'Edit section sec-background details' }).click()
    const sectionDialog = page.getByRole('dialog', { name: 'Section details' })
    const sectionLabel = sectionDialog.getByRole('textbox', { name: 'Section label' })
    await sectionLabel.fill('sec-context')
    await sectionLabel.press('Tab')
    await expect(sectionDialog.getByRole('button', { name: 'Cancel' })).toBeFocused()
    await sectionDialog.getByRole('button', { name: 'Cancel' }).press('Shift+Tab')
    await expect(sectionLabel).toBeFocused()
    await expect(sectionDialog).toHaveScreenshot('semantic-section-editor.png')
    await sectionDialog.getByRole('button', { name: 'Save section' }).click()
    await expect(manuscript.getByRole('link', { name: 'Section context' })).toHaveAttribute('href', '#sec-context')
    await expect(manuscript.locator('#sec-context')).toHaveText('Background')
    await expect(manuscript.getByRole('button', { name: 'Edit section sec-context details' })).toBeFocused()
    await expect.poll(async () => page.evaluate(() => localStorage.getItem('draftmatter.structured-source.v1'))).toContain('## Background {#sec-context}')

    const sectionReference = manuscript.locator('.structured-cross-reference[data-target="sec-context"]')
    const sectionReferenceId = await sectionReference.getAttribute('data-dm-id')
    await sectionReference.getByRole('button', { name: 'Edit cross-reference to sec-context' }).click()
    await sectionReference.getByRole('textbox', { name: 'Cross-reference target' }).fill('eq-fit')
    await expect(sectionReference).toHaveScreenshot('semantic-cross-reference-editor.png')
    await sectionReference.getByRole('button', { name: 'Save reference' }).click()
    const updatedSectionReference = manuscript.locator(`.structured-cross-reference[data-dm-id="${sectionReferenceId}"]`)
    await expect(updatedSectionReference.getByRole('link', { name: 'Equation fit' })).toHaveAttribute('href', '#eq-fit')
    await expect.poll(async () => page.evaluate(() => localStorage.getItem('draftmatter.structured-source.v1'))).toContain('See @eq-fit for context.')

    await manuscript.getByRole('button', { name: 'Edit display equation eq-fit' }).click()
    await manuscript.getByRole('textbox', { name: 'Display equation eq-fit TeX' }).fill(String.raw`R^2 = \frac{c}{d}`)
    await manuscript.getByRole('textbox', { name: 'Display equation label' }).fill('eq-response')
    await expect(manuscript.locator('#eq-fit')).toHaveScreenshot('semantic-equation-editor.png')
    await manuscript.getByRole('button', { name: 'Save equation' }).click()
    await expect.poll(async () => page.evaluate(() => localStorage.getItem('draftmatter.structured-source.v1'))).toContain(String.raw`R^2 = \frac{c}{d}`)
    await expect(manuscript.getByRole('link', { name: 'Equation response' })).toHaveCount(2)
    await expect(manuscript.getByRole('link', { name: 'Equation response' }).first()).toHaveAttribute('href', '#eq-response')
    await expect(manuscript.locator('#eq-response .katex-html')).toContainText('R')
    await expect.poll(async () => page.evaluate(() => localStorage.getItem('draftmatter.structured-source.v1'))).toContain('$$ {#eq-response .unnumbered}')

    await manuscript.getByRole('button', { name: 'Edit figure fig-canopy' }).click()
    await manuscript.getByRole('textbox', { name: 'Figure alternative text' }).fill('Revised canopy response')
    await manuscript.getByRole('textbox', { name: 'Figure title' }).fill('Observed canopy trajectory')
    await manuscript.getByRole('textbox', { name: 'Figure label' }).fill('fig-trajectory')
    await expect(manuscript.locator('#fig-canopy')).toHaveScreenshot('semantic-figure-editor.png')
    await manuscript.getByRole('button', { name: 'Save figure' }).click()
    await expect(manuscript.getByRole('link', { name: 'Figure trajectory' })).toHaveAttribute('href', '#fig-trajectory')
    await expect(manuscript.locator('#fig-trajectory')).toBeVisible()
    await expect.poll(async () => page.evaluate(() => localStorage.getItem('draftmatter.structured-source.v1')))
      .toContain('![Revised canopy response](/fixtures/canopy-response.svg "Observed canopy trajectory"){#fig-trajectory .wide data-owner="field-team"}')
    await expect.poll(async () => manuscript.getByRole('img', { name: 'Revised canopy response' }).evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0)
    await expect(manuscript.locator('#fig-trajectory')).toHaveScreenshot('semantic-figure.png')

    await manuscript.getByRole('button', { name: 'Edit table tbl-canopy details' }).click()
    await manuscript.getByRole('textbox', { name: 'Table caption' }).fill('Revised **monthly canopy index**.')
    await manuscript.getByRole('textbox', { name: 'Table label' }).fill('tbl-response')
    await manuscript.locator('#tbl-canopy').evaluate((element) => element.scrollIntoView({ block: 'center' }))
    await expect(manuscript.locator('#tbl-canopy')).toHaveScreenshot('semantic-table-editor.png')
    await manuscript.getByRole('button', { name: 'Save table details' }).click()
    await expect(manuscript.getByRole('link', { name: 'Table response' })).toHaveAttribute('href', '#tbl-response')
    await expect(manuscript.locator('#tbl-response figcaption')).toHaveText('Revised monthly canopy index.')
    await expect.poll(async () => page.evaluate(() => localStorage.getItem('draftmatter.structured-source.v1')))
      .toContain(': Revised **monthly canopy index**. {#tbl-response .striped data-owner="field-team"}')
    const septemberIndex = manuscript.locator('#tbl-response tbody tr').nth(2).locator('td').nth(1).locator('p')
    await septemberIndex.selectText()
    await page.keyboard.type('0.72')
    await expect.poll(async () => page.evaluate(() => localStorage.getItem('draftmatter.structured-source.v1'))).toContain('| September | 0.72 |')
    await expect(manuscript.locator('#tbl-response')).toHaveScreenshot('semantic-table.png')

    await manuscript.getByRole('button', { name: 'Edit footnote 1' }).click()
    await manuscript.getByRole('textbox', { name: 'Footnote label' }).fill('calibration')
    await manuscript.getByRole('textbox', { name: 'Footnote 1 content' }).fill('Calibration details were **independently checked**.')
    const footnoteEditor = manuscript.locator('.structured-footnote-definition[data-footnote-label="methods"]')
    await footnoteEditor.evaluate((element) => element.scrollIntoView({ block: 'center' }))
    const editorStatus = page.locator('.editor-statusbar')
    await editorStatus.evaluate((element) => { element.style.visibility = 'hidden' })
    await expect(footnoteEditor).toHaveScreenshot('semantic-footnote-editor.png')
    await editorStatus.evaluate((element) => { element.style.visibility = '' })
    await manuscript.getByRole('button', { name: 'Save note' }).click()
    await expect(manuscript.getByText('Calibration details were independently checked.', { exact: true })).toBeVisible()
    await expect(manuscript.locator('.structured-footnote-definition[data-footnote-label="calibration"]')).toBeVisible()
    await expect.poll(async () => page.evaluate(() => localStorage.getItem('draftmatter.structured-source.v1'))).toContain('[^calibration]: Calibration details were **independently checked**.')
    await expect.poll(async () => page.evaluate(() => localStorage.getItem('draftmatter.structured-source.v1'))).not.toContain('[^methods]')

    await expect(codeCell).toHaveScreenshot('semantic-code-cell.png')
    await codeCell.getByRole('button', { name: 'Show julia code for cell-growth' }).click()
    await expect(codeCell).toHaveScreenshot('semantic-code-editor.png')
    const code = codeCell.getByRole('textbox', { name: 'julia code cell cell-growth' })
    await code.fill('println("after")')
    await expect.poll(async () => page.evaluate(() => localStorage.getItem('draftmatter.structured-source.v1'))).toContain('println("after")')
    await code.press('Escape')
    await expect(codeCell.getByRole('textbox', { name: 'julia code cell cell-growth' })).toHaveCount(0)

    await page.reload()
    await codeCell.getByRole('button', { name: 'Show julia code for cell-growth' }).click()
    await expect(codeCell.getByRole('textbox', { name: 'julia code cell cell-growth' })).toHaveValue('println("after")')
    await codeCell.getByRole('textbox', { name: 'julia code cell cell-growth' }).press('Escape')
    await expect(page.getByRole('img', { name: 'Revised canopy response' })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Figure trajectory' })).toHaveAttribute('href', '#fig-trajectory')
    await expect(page.getByRole('link', { name: 'Table response' })).toHaveAttribute('href', '#tbl-response')
    await expect(page.locator('#tbl-response')).toContainText('0.72')
    await expect(page.locator('#eq-response .katex')).toBeVisible()
    await expect(page.getByRole('link', { name: 'Equation response' })).toHaveCount(2)
    await expect(page.locator('.structured-footnote-definition[data-footnote-label="calibration"]')).toBeVisible()
    await expect(page.getByText('Calibration details were independently checked.', { exact: true })).toBeVisible()
    let saved = await page.evaluate(() => localStorage.getItem('draftmatter.structured-source.v1'))
    expect(saved).toContain('::: {.future-extension data-owner="research-team"}\nKeep this opaque block exactly.\n:::')
    expect(saved).toContain('See @eq-response for context.')

    await manuscript.getByText('A dedicated citation insertion target.', { exact: true }).evaluate((element) => {
      const editor = element.closest<HTMLElement>('[contenteditable="true"]')
      const selection = window.getSelection()
      if (!editor || !selection) throw new Error('Rendered editor selection is unavailable')
      editor.focus()
      const range = document.createRange()
      range.selectNodeContents(element)
      range.collapse(false)
      selection.removeAllRanges()
      selection.addRange(range)
      document.dispatchEvent(new Event('selectionchange'))
    })
    await page.keyboard.press('Enter')
    await page.keyboard.type('notes/field')
    await expect.poll(async () => page.evaluate(() => localStorage.getItem('draftmatter.structured-source.v1'))).toContain('notes/field')
    await page.keyboard.press('Enter')
    await page.keyboard.type('/')
    const commandMenu = page.getByRole('dialog', { name: 'Command menu' })
    await expect(commandMenu).toBeVisible()
    await expect.poll(async () => page.evaluate(() => localStorage.getItem('draftmatter.structured-source.v1'))).not.toContain('\n/\n')
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
    expect(saved).toContain('# Portable field notes\n\n## Background')
    expect(saved).toContain('@eq-response')
    expect(saved).toContain('@fig-trajectory')
    expect(saved).toContain('@tbl-response')
    expect(saved).not.toMatch(/^#\s+\[@martin2023/m)

    await page.getByRole('button', { name: 'Edit citation @martin2023' }).click()
    const citationDetails = page.locator('.structured-citation-detail')
    const citationMetadata = citationDetails.getByLabel('Citation metadata for Growth coordination under fluctuating water availability')
    await expect(citationMetadata).toContainText('Alice Martin, Marcus Chen')
    await expect(citationMetadata).toContainText('2023 · New Phytologist')
    await expect(citationMetadata).toContainText('10.1111/nph.19208')
    await expect(citationMetadata.getByRole('button', { name: 'Open DOI' })).toBeVisible()
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

    await page.getByRole('complementary', { name: 'Manuscript outline' }).getByRole('button', { name: /Add section/ }).click()
    const insertion = page.getByRole('dialog', { name: 'Add section' })
    await insertion.getByLabel('Section title').fill('Discussion')
    await insertion.getByLabel('Heading level').selectOption('2')
    await insertion.getByLabel('Cross-reference label').fill('sec-discussion')
    await insertion.getByRole('button', { name: 'Insert', exact: true }).click()
    await expect(page.getByRole('complementary', { name: 'Manuscript outline' }).getByText('Discussion')).toBeVisible()
    await expect(manuscript.locator('#sec-discussion')).toHaveText('Discussion')
    await expect.poll(async () => page.evaluate(() => localStorage.getItem('draftmatter.structured-source.v1'))).toContain('## Discussion {#sec-discussion}')

    await manuscript.locator('#fig-trajectory').evaluate((element) => element.scrollIntoView({ block: 'center' }))
    await expect(page).toHaveScreenshot('generic-manuscript-editor.png')
  })

  test('edits ordinary link metadata while preserving direct text editing', async ({ page }) => {
    const linkSource = '# Field links\n\nRead the [field protocol](https://example.test/protocol "Original protocol") before sampling.\n'
    await page.evaluate((portableSource) => localStorage.setItem('draftmatter.structured-source.v1', portableSource), linkSource)
    await page.reload()

    const manuscript = page.getByRole('article', { name: 'Editable manuscript' })
    const link = manuscript.getByRole('link', { name: 'field protocol' })
    const linkMark = link.locator('..')
    await expect(link).toHaveAttribute('href', 'https://example.test/protocol')
    await linkMark.getByRole('button', { name: 'Edit link details' }).click()
    const dialog = page.getByRole('dialog', { name: 'Link details' })
    const destination = dialog.getByRole('textbox', { name: 'Link destination' })
    await destination.fill('data:text/html,unsafe')
    await expect(dialog.getByRole('button', { name: 'Save link' })).toBeDisabled()
    await destination.fill('notes/field-protocol.md')
    await dialog.getByRole('textbox', { name: 'Link title' }).fill('Field evidence protocol')
    await expect(dialog).toHaveScreenshot('semantic-link-editor.png')
    await dialog.getByRole('button', { name: 'Save link' }).click()

    await expect(link).toHaveText('field protocol')
    await expect(link).toHaveAttribute('href', 'notes/field-protocol.md')
    await expect(link).toHaveAttribute('title', 'Field evidence protocol')
    await expect(manuscript).not.toContainText('notes/field-protocol.md')
    await expect.poll(async () => page.evaluate(() => localStorage.getItem('draftmatter.structured-source.v1')))
      .toContain('[field protocol](notes/field-protocol.md "Field evidence protocol")')

    await page.reload()
    const reopenedLink = page.getByRole('link', { name: 'field protocol' })
    await expect(reopenedLink).toHaveAttribute('href', 'notes/field-protocol.md')
    await expect(reopenedLink).toHaveAttribute('title', 'Field evidence protocol')
    await reopenedLink.evaluate((element) => {
      const editor = element.closest<HTMLElement>('[contenteditable="true"]')
      const selection = window.getSelection()
      if (!editor || !selection) throw new Error('Rendered link selection is unavailable')
      editor.focus()
      const range = document.createRange()
      const text = element.firstChild
      if (!text) throw new Error('Rendered link text is unavailable')
      range.setStart(text, 0)
      range.setEnd(text, 'field'.length)
      selection.removeAllRanges()
      selection.addRange(range)
    })
    await page.keyboard.type('sampling')
    await expect(page.getByRole('link', { name: 'sampling protocol' })).toHaveAttribute('href', 'notes/field-protocol.md')
    await expect.poll(async () => page.evaluate(() => localStorage.getItem('draftmatter.structured-source.v1')))
      .toContain('[sampling protocol](notes/field-protocol.md "Field evidence protocol")')
  })

  test('edits one preserved raw block through an explicit focused inspector', async ({ page }) => {
    const rawSource = '# Raw syntax\n\n::: {.future-widget data-owner="lab"}\nOriginal opaque payload.\n:::\n'
    await page.evaluate((portableSource) => localStorage.setItem('draftmatter.structured-source.v1', portableSource), rawSource)
    await page.reload()

    const manuscript = page.getByRole('article', { name: 'Editable manuscript' })
    const raw = manuscript.locator('.structured-raw-node[data-format="pandoc-div"]')
    await expect(raw).not.toContainText('Original opaque payload.')
    await raw.getByRole('button', { name: 'Inspect source' }).click()
    const editor = raw.getByRole('textbox', { name: 'Preserved pandoc-div source' })
    await expect(editor).toHaveValue('::: {.future-widget data-owner="lab"}\nOriginal opaque payload.\n:::\n')
    await editor.fill('::: {.future-widget data-owner="field-team"}\nRevised opaque payload.\n:::')
    await expect(raw).toHaveScreenshot('semantic-raw-editor.png')
    await raw.getByRole('button', { name: 'Save raw block' }).click()
    await expect(raw.getByRole('button', { name: 'Inspect source' })).toHaveAttribute('aria-expanded', 'false')
    await expect.poll(async () => page.evaluate(() => localStorage.getItem('draftmatter.structured-source.v1')))
      .toContain('::: {.future-widget data-owner="field-team"}\nRevised opaque payload.\n:::')

    await page.reload()
    const reopenedRaw = page.getByRole('article', { name: 'Editable manuscript' }).locator('.structured-raw-node[data-format="pandoc-div"]')
    await reopenedRaw.getByRole('button', { name: 'Inspect source' }).click()
    await expect(reopenedRaw.getByRole('textbox', { name: 'Preserved pandoc-div source' }))
      .toHaveValue('::: {.future-widget data-owner="field-team"}\nRevised opaque payload.\n:::\n')
    await reopenedRaw.getByRole('button', { name: 'Open full source inspector' }).click()
    const sourceInspector = page.getByRole('dialog', { name: 'Portable source inspector' })
    await expect(sourceInspector).toContainText('Revised opaque payload.')
    await sourceInspector.getByRole('button', { name: 'Close source inspector' }).click()
  })
})
