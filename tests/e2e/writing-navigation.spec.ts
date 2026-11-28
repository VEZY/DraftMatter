import { expect, test, type Page } from '@playwright/test'
import axe from 'axe-core'
import { advanceCaretBeforeDialog } from './writing-tools'

const SOURCE_KEY = 'draftmatter.structured-source.v1'
const FIRST_PARAGRAPH = 'This first paragraph must keep its own text.'
const CITATION_TARGET = 'The citation belongs at the end of this paragraph.'
const REFERENCE_TITLE = 'An independent study of measured canopy responses'
const source = `# Writing navigation study

## 1. Introduction

${FIRST_PARAGRAPH}

### 1.1 Evidence

${CITATION_TARGET}

### 1.2 Interpretation

The observations support a carefully bounded interpretation.

## 2. Methods

### 2.1 Sampling

Repeated measurements preserve the experimental units.
`

async function openStudy(page: Page) {
  await page.addInitScript(({ source, title }) => {
    if (sessionStorage.getItem('draftmatter.writing-navigation.seeded')) return
    localStorage.setItem('draftmatter.structured-source.v1', source)
    localStorage.setItem('draftmatter.structured-mode.v1', 'true')
    localStorage.setItem('draftmatter.project-meta.v1', JSON.stringify({ filename: 'writing-study.md', projectName: 'Writing navigation study', citationStyle: 'draftmatter-author-date', citationLocale: 'en-US' }))
    localStorage.setItem('draftmatter.citations.v1', JSON.stringify([
      { citekey: 'canopy2026', type: 'article', title, authors: ['Alex Writer', 'Morgan Researcher'], year: '2026', container: 'Journal of Reproducible Observations', source: 'csl-json' },
    ]))
    sessionStorage.setItem('draftmatter.writing-navigation.seeded', 'true')
  }, { source, title: REFERENCE_TITLE })
  await page.goto('/draft')
  await expect(page.getByRole('textbox', { name: 'Rendered manuscript editor', exact: true })).toBeVisible()
}

async function placeCitationCaret(page: Page) {
  const paragraph = page.getByRole('textbox', { name: 'Rendered manuscript editor', exact: true }).getByText(CITATION_TARGET, { exact: true })
  await paragraph.scrollIntoViewIfNeeded()
  await paragraph.evaluate((element) => {
    const editor = element.closest<HTMLElement>('[contenteditable="true"]')!
    editor.focus()
    const range = document.createRange()
    range.selectNodeContents(element)
    range.collapse(false)
    const selection = getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
  })
  // A real navigation event lets ProseMirror read the selection before toolbar focus changes.
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('ArrowRight')
}

async function insertSelectedReference(page: Page) {
  const picker = page.getByRole('dialog', { name: 'Insert citation', exact: true })
  await expect(picker).toBeVisible()
  await expect(picker.getByRole('button', { name: 'Insert selected · 0', exact: true })).toBeDisabled()
  await picker.getByRole('textbox', { name: 'Search citation sources', exact: true }).fill('independent canopy')
  await picker.getByRole('button', { name: new RegExp(REFERENCE_TITLE) }).click()
  await picker.getByRole('button', { name: 'Insert selected · 1', exact: true }).click()
  await expect(picker).toBeHidden()
  const savedSource = () => page.evaluate((key) => localStorage.getItem(key) ?? '', SOURCE_KEY)
  await expect.poll(savedSource).toContain(`${CITATION_TARGET}[@canopy2026]`)
  expect(await savedSource()).toContain(`${FIRST_PARAGRAPH}\n`)
  expect(await savedSource()).not.toContain(`${FIRST_PARAGRAPH}[@canopy2026]`)
  await expect(page.getByRole('button', { name: 'Edit citation @canopy2026', exact: true })).toContainText('Writer and Researcher, 2026')
}

test('groups writing actions in the toolbar and moves change tracking into the header', async ({ page }) => {
  await openStudy(page)
  const header = page.locator('.topbar')
  const toolbar = page.getByLabel('Formatting toolbar', { exact: true })
  const navigation = page.getByRole('navigation', { name: 'Workspace navigation', exact: true })
  await expect(toolbar).toHaveCSS('opacity', '0')
  await page.getByRole('button', { name: 'Show writing tools', exact: true }).hover()
  await expect(toolbar.getByRole('button', { name: 'Insert citation', exact: true })).toBeVisible()
  await expect(toolbar.getByRole('button', { name: 'Insert citation', exact: true })).toHaveAttribute('title', /Zotero/)
  await expect(page.locator('.quick-cite')).toHaveCount(0)
  await expect(header.getByRole('button', { name: /^Review,/ })).toHaveCount(0)
  await expect(header.getByRole('button', { name: 'Browse project files', exact: true })).toHaveCount(0)
  await expect(toolbar.getByRole('button', { name: /track changes/i })).toHaveCount(0)
  await expect(toolbar.getByRole('button', { name: 'Review options', exact: true })).toHaveCount(0)
  await expect(navigation.getByRole('button', { name: 'Files', exact: true })).toBeVisible()
  await expect(navigation.getByRole('button', { name: 'Outline', exact: true })).toBeVisible()
  await expect(navigation.getByRole('button', { name: 'Manuscript', exact: true })).toHaveCount(0)
  await expect(navigation.getByRole('button', { name: 'History', exact: true })).toBeVisible()

  const review = header.getByRole('button', { name: 'Review options', exact: true })
  const options = page.getByRole('dialog', { name: 'Review options', exact: true })
  const tracking = options.getByRole('switch', { name: 'Track changes', exact: true })
  await review.hover()
  await expect(options).toBeHidden()
  await review.press('Enter')
  await expect(options).toContainText('Manuscript view')
  await expect(tracking).toBeFocused()
  await tracking.press('Space')
  await expect(tracking).toHaveAttribute('aria-checked', 'true')
  await expect(review).toHaveAccessibleDescription('Track changes on')
  await tracking.click()
  await expect(tracking).toHaveAttribute('aria-checked', 'false')
  await expect(review).toHaveAccessibleDescription('Track changes off')
  await page.keyboard.press('Escape')
  await expect(options).toBeHidden()
  await expect(review).toBeFocused()

  // Hidden writing tools become fully legible on keyboard focus as well as hover.
  await toolbar.getByRole('button', { name: 'Insert citation', exact: true }).focus()
  await expect(toolbar).toHaveCSS('opacity', '1')
})

test('inserts a project citation at the remembered caret from the writing toolbar', async ({ page }) => {
  await openStudy(page)
  await placeCitationCaret(page)
  await page.getByRole('button', { name: 'Show writing tools', exact: true }).hover()
  await page.getByLabel('Formatting toolbar', { exact: true }).getByRole('button', { name: 'Insert citation', exact: true }).click()
  await insertSelectedReference(page)
  await page.reload()
  await expect(page.getByRole('button', { name: 'Edit citation @canopy2026', exact: true })).toContainText('Writer and Researcher, 2026')
})

test('uses the same empty citation picker and insertion target through its keyboard shortcut', async ({ page }) => {
  await openStudy(page)
  const editor = page.getByRole('textbox', { name: 'Rendered manuscript editor', exact: true })
  await advanceCaretBeforeDialog(page, editor.getByText(CITATION_TARGET, { exact: true }))
  await page.keyboard.press('ControlOrMeta+Shift+C')
  await insertSelectedReference(page)
})

test('keeps major sections visible while subsections expand and outline search reveals their parent', async ({ page }) => {
  await openStudy(page)
  const outline = page.getByRole('complementary', { name: 'Manuscript outline', exact: true })
  await expect(outline.getByRole('button', { name: '1. Introduction', exact: true })).toBeVisible()
  await expect(outline.getByRole('button', { name: '2. Methods', exact: true })).toBeVisible()
  await expect(outline.getByRole('button', { name: '1.1 Evidence', exact: true })).toHaveCount(0)
  await expect(outline.getByRole('button', { name: '2.1 Sampling', exact: true })).toHaveCount(0)

  await outline.getByRole('button', { name: 'Expand 1. Introduction', exact: true }).click()
  await expect(outline.getByRole('button', { name: '1.1 Evidence', exact: true })).toBeVisible()
  await expect(outline.getByRole('button', { name: '1.2 Interpretation', exact: true })).toBeVisible()
  await outline.getByRole('button', { name: 'Collapse 1. Introduction', exact: true }).click()
  await expect(outline.getByRole('button', { name: '1.1 Evidence', exact: true })).toHaveCount(0)

  await outline.getByRole('button', { name: 'Outline options', exact: true }).click()
  const search = outline.getByRole('textbox', { name: 'Search outline', exact: true })
  await search.fill('2.1 Sampling')
  await expect(outline.getByRole('button', { name: '2. Methods', exact: true })).toBeVisible()
  await expect(outline.getByRole('button', { name: '2.1 Sampling', exact: true })).toBeVisible()
  await expect(outline.getByRole('button', { name: '1. Introduction', exact: true })).toHaveCount(0)
  await search.fill('')
  await expect(outline.getByRole('button', { name: '1. Introduction', exact: true })).toBeVisible()
  await expect(outline.getByRole('button', { name: '2.1 Sampling', exact: true })).toHaveCount(0)
})

test('browses folders and file actions in the left sidebar while the manuscript remains available', async ({ page }) => {
  await openStudy(page)
  await page.locator('.project-switcher').click()
  await page.getByRole('button', { name: /Open complete example/ }).click()
  await expect(page.locator('.project-switcher-name')).toHaveText('Complete example paper')
  const navigation = page.getByRole('navigation', { name: 'Workspace navigation', exact: true })
  await navigation.getByRole('button', { name: 'Files', exact: true }).click()
  const files = page.getByRole('complementary', { name: 'Project files', exact: true })
  await expect(files).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Rendered manuscript editor', exact: true })).toBeVisible()
  await expect(page.getByRole('dialog', { name: /Project files/i })).toHaveCount(0)
  await expect(files.getByRole('button', { name: 'Open complete-example.qmd', exact: true })).toHaveAttribute('aria-current', 'page')
  await expect(files.getByRole('button', { name: 'Open figures/python-canopy.svg', exact: true })).toHaveCount(0)
  await files.getByRole('button', { name: 'Expand figures', exact: true }).click()
  await files.getByRole('button', { name: 'Open figures/python-canopy.svg', exact: true }).click()
  const selected = files.getByRole('region', { name: 'Selected project file', exact: true })
  await expect(selected).toContainText('python-canopy.svg')
  await expect(selected.getByRole('button', { name: 'Download figures/python-canopy.svg', exact: true })).toBeVisible()
  await expect(selected.getByRole('button', { name: 'Insert figures/python-canopy.svg as a figure', exact: true })).toBeVisible()

  await files.getByRole('searchbox', { name: 'Find a project file', exact: true }).fill('allocation.csv')
  await expect(files.getByRole('button', { name: 'Open data/allocation.csv', exact: true })).toBeVisible()
  await expect(files.getByRole('button', { name: 'Open figures/python-canopy.svg', exact: true })).toHaveCount(0)
  await navigation.getByRole('button', { name: 'Outline', exact: true }).click()
  await expect(page.getByRole('complementary', { name: 'Manuscript outline', exact: true })).toBeVisible()
  await expect(files).toHaveCount(0)
})


test('keeps citations and project navigation accessible on a small screen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await openStudy(page)
  const navigation = page.getByRole('navigation', { name: 'Workspace navigation' })
  await expect(page.getByRole('complementary', { name: 'Manuscript outline', exact: true })).toHaveCount(0)
  await expect(navigation.getByRole('button', { name: 'Files', exact: true })).toHaveAttribute('aria-pressed', 'false')
  const cite = page.getByRole('toolbar', { name: 'Formatting toolbar' }).getByRole('button', { name: 'Insert citation', exact: true })
  const bounds = await cite.boundingBox()
  expect(bounds!.x).toBeGreaterThanOrEqual(0)
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390)
  await page.addScriptTag({ content: axe.source })
  const audit = async () => page.evaluate(async () => (await (window as typeof window & { axe: typeof axe }).axe.run(document.body, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] } })).violations.map(({ id, nodes }) => ({ id, targets: nodes.map(({ target }) => target) })))
  expect(await audit()).toEqual([])
  await navigation.getByRole('button', { name: 'Files', exact: true }).focus()
  await page.keyboard.press('Enter')
  const files = page.getByRole('complementary', { name: 'Project files', exact: true })
  await expect(files).toBeVisible()
  expect(await audit()).toEqual([])
  await files.getByRole('button', { name: 'Close project files' }).click()
  await page.getByRole('button', { name: 'Show writing tools', exact: true }).hover()
  await cite.click()
  await expect(page.getByRole('dialog', { name: 'Insert citation', exact: true })).toBeVisible()
  expect(await audit()).toEqual([])
})
