import { expect, test } from '@playwright/test'

const features = [
  ['Writing', 'writing', 'Write in a calm, structured editor where the manuscript stays central.'],
  ['Results from code', 'results', 'Use Julia, R, or Python with a local terminal and project packages. DraftMatter parses outputs into manuscript figures, tables, and in-text values while keeping every result linked to its source.'],
  ['Citations', 'citations', 'Search, insert, and format citations without leaving the manuscript.'],
  ['Review and collaboration', 'review', 'Comment, suggest changes, and work with co-authors in the context of the paper.'],
  ['Checks and export', 'checks', 'Review citation, computation, output, and export issues before sharing the paper.'],
] as const

test.describe('signed-out Home landing experience', () => {
  test('presents the approved story and scrolls to a usable guided preview', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto('/')

    await expect(page.getByText('A calm workspace for rigorous research', { exact: true })).toBeVisible()
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Your paper should be as reproducible as your research.')
    await expect(page.getByText('Research writing, with the missing pieces built in.', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Start writing' })).toBeVisible()

    const hero = page.locator('.home-hero-layout')
    const heroPreview = hero.locator('.home-hero-product-preview')
    await expect(heroPreview).toBeVisible()
    await expect(heroPreview.getByRole('heading', { name: 'Canopy recovery after seasonal drought' })).toBeVisible()
    await expect(heroPreview.getByText('Rémi Vezy', { exact: false })).toBeVisible()
    await expect(heroPreview.getByRole('heading', { name: 'Abstract' })).toBeVisible()
    await expect(heroPreview.getByText('Focus mode', { exact: true })).toBeVisible()
    await expect(heroPreview.getByText('2 comments', { exact: true })).toBeVisible()
    await expect(heroPreview.locator('.home-demo-outline, .home-demo-comment, .home-demo-presence')).toHaveCount(0)
    await expect(heroPreview.locator('button, [id], [aria-controls]')).toHaveCount(0)
    await expect(heroPreview.getByRole('region', { name: 'Scrollable example manuscript' })).toHaveAttribute('tabindex', '0')
    const heroLayout = await hero.evaluate((layout) => {
      const preview = layout.querySelector<HTMLElement>('.home-hero-preview')!.getBoundingClientRect()
      const copy = layout.querySelector<HTMLElement>('.home-hero-copy')!.getBoundingClientRect()
      const bounds = layout.getBoundingClientRect()
      return {
        previewShare: preview.width / bounds.width,
        previewBottom: preview.bottom,
        previewBeforeCopy: preview.right < copy.left,
        viewportHeight: window.innerHeight,
      }
    })
    expect(heroLayout.previewShare).toBeGreaterThanOrEqual(.42)
    expect(heroLayout.previewShare).toBeLessThanOrEqual(.46)
    expect(heroLayout.previewBottom).toBeLessThanOrEqual(heroLayout.viewportHeight)
    expect(heroLayout.previewBeforeCopy).toBe(true)
    const paperVisual = await heroPreview.locator('.home-demo-paper').evaluate((paper) => {
      const title = paper.querySelector<HTMLElement>('header h3')!
      const paragraph = paper.querySelector<HTMLElement>('.home-demo-introduction p')!
      const abstract = paper.querySelector<HTMLElement>('.home-demo-abstract')!
      return {
        horizontalInset: Number.parseFloat(getComputedStyle(paper).paddingLeft),
        titleSize: Number.parseFloat(getComputedStyle(title).fontSize),
        paragraphSize: Number.parseFloat(getComputedStyle(paragraph).fontSize),
        paragraphLineHeight: Number.parseFloat(getComputedStyle(paragraph).lineHeight),
        paperBorder: getComputedStyle(paper).borderTopStyle,
        abstractBorder: getComputedStyle(abstract).borderTopStyle,
      }
    })
    expect(paperVisual.horizontalInset).toBeGreaterThanOrEqual(40)
    expect(paperVisual.titleSize / paperVisual.paragraphSize).toBeGreaterThan(2)
    expect(paperVisual.paragraphLineHeight / paperVisual.paragraphSize).toBeGreaterThan(1.65)
    expect(paperVisual.paperBorder).toBe('solid')
    expect(paperVisual.abstractBorder).toBe('solid')

    await page.getByRole('button', { name: 'See how it works' }).click()
    const surface = page.locator('.home-welcome')
    await expect.poll(() => surface.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
    await expect(page.locator('#home-showcase')).toBeInViewport()

    const demo = page.locator('.home-workspace-demo')
    await expect(demo).toHaveAttribute('data-active-feature', 'writing')
    await expect(demo.getByText('Canopy recovery after seasonal drought')).toBeVisible()
    await expect(demo.getByText('Rémi Vezy', { exact: false })).toBeVisible()
    await expect(demo.getByLabel('ORCID 0000-0002-0808-1461')).toBeVisible()
    await expect(demo.getByRole('list', { name: 'Author affiliations' })).toContainText('CIRAD, UMR AMAP')
    await expect(demo.getByRole('heading', { name: 'Abstract' })).toBeVisible()
    await expect(demo.getByRole('heading', { name: 'Introduction' })).toBeVisible()
    await expect(demo.getByText('Figure 1.')).toHaveCount(0)
    await expect(demo.getByRole('heading', { name: 'References' })).toHaveCount(0)
    await expect(demo.getByText('Project checks')).toBeVisible()

    const learning = page.locator('.home-learning-guide')
    await expect(learning.getByRole('heading', { name: 'Explore a complete research paper.' })).toBeVisible()
    await expect(learning.getByText('Produce reproducible results', { exact: true })).toBeVisible()
    await expect(learning.getByRole('button', { name: 'Start guided tour' })).toBeVisible()
    await expect(learning).not.toContainText('steps complete')
  })

  test('keeps a balanced two-column hero at an intermediate width', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 768 })
    await page.goto('/')

    const layout = page.locator('.home-hero-layout')
    const measurements = await layout.evaluate((element) => {
      const preview = element.querySelector<HTMLElement>('.home-hero-preview')!.getBoundingClientRect()
      const copy = element.querySelector<HTMLElement>('.home-hero-copy')!.getBoundingClientRect()
      const bounds = element.getBoundingClientRect()
      return {
        previewShare: preview.width / bounds.width,
        previewBeforeCopy: preview.right < copy.left,
        previewBottom: preview.bottom,
        viewportHeight: window.innerHeight,
      }
    })

    expect(measurements.previewShare).toBeGreaterThanOrEqual(.4)
    expect(measurements.previewShare).toBeLessThanOrEqual(.47)
    expect(measurements.previewBeforeCopy).toBe(true)
    expect(measurements.previewBottom).toBeLessThanOrEqual(measurements.viewportHeight)
    await expect(layout.locator('.home-hero-product-preview')).toBeVisible()
  })

  test('scrolls the complete hero paper from its title through review to generated references', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto('/')

    const paper = page.getByRole('region', { name: 'Scrollable example manuscript' })
    const title = paper.getByRole('heading', { name: 'Canopy recovery after seasonal drought' })
    await expect(title).toBeInViewport()
    const scrollRange = await paper.evaluate((element) => ({
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      scrollTop: element.scrollTop,
    }))
    expect(scrollRange.scrollHeight).toBeGreaterThan(scrollRange.clientHeight)
    expect(scrollRange.scrollTop).toBe(0)

    await paper.focus()
    await paper.press('PageDown')
    await expect.poll(() => paper.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)

    await paper.evaluate((element) => {
      const discussion = element.querySelector<HTMLElement>('.home-demo-discussion')!
      element.scrollTop = discussion.offsetTop - 16
    })
    const discussion = paper.locator('.home-demo-discussion')
    await expect(discussion).toBeInViewport()
    await expect(discussion.locator('del')).toHaveCount(4)
    await expect(discussion.locator('ins')).toHaveCount(5)

    await paper.evaluate((element) => { element.scrollTop = element.scrollHeight })
    const references = paper.locator('.home-demo-references')
    await expect(references).toBeInViewport()
    await expect(references).toContainText('Automatically generated')
    await expect(references).toContainText('Meyer, L., & Okafor, C. (2025).')
  })

  test('keeps one workspace while every feature reveals its concrete description and emphasis', async ({ page }) => {
    await page.goto('/')
    const demo = page.locator('.home-workspace-demo')
    const panel = page.getByRole('tabpanel')

    for (const [label, id, description] of features) {
      const tab = page.getByRole('tab', { name: new RegExp(label) })
      await tab.click()
      await expect(tab).toHaveAttribute('aria-selected', 'true')
      await expect(panel).toContainText(description)
      await expect(demo).toHaveAttribute('data-active-feature', id)
      await expect(demo.locator(`[data-preview-feature="${id}"].is-preview-active`).first()).toBeVisible()
      await expect(demo.locator('.home-demo-paper-view')).toHaveAttribute('data-document-view', id)
      await expect(demo.locator('.home-demo-document-location')).toHaveCount(0)
    }
  })

  test('uses focused document excerpts instead of combining distant sections on one page', async ({ page }) => {
    await page.goto('/')
    const paper = page.locator('.home-workspace-demo .home-demo-paper')

    await expect(paper.getByText('Canopy recovery after seasonal drought')).toBeVisible()
    await expect(paper.getByText('Figure 1.')).toHaveCount(0)
    await expect(paper.getByRole('heading', { name: 'References' })).toHaveCount(0)

    await page.getByRole('tab', { name: /Results from code/ }).click()
    await expect(paper.getByText('Canopy recovery after seasonal drought')).toHaveCount(0)
    await expect(paper.getByText('Figure 1.')).toBeVisible()
    await expect(paper.getByRole('heading', { name: 'References' })).toHaveCount(0)

    await page.getByRole('tab', { name: /Citations/ }).click()
    await expect(paper.getByText('Canopy recovery after seasonal drought')).toHaveCount(0)
    await expect(paper.getByText('Figure 1.')).toHaveCount(0)
    await expect(paper.locator('.home-demo-document-jump')).toHaveText('•••')
    await expect(paper.getByRole('heading', { name: 'References' })).toBeVisible()

    await page.getByRole('tab', { name: /Review and collaboration/ }).click()
    await expect(paper.locator('.home-demo-review-context')).toHaveCount(0)
    await expect(paper.locator('del')).toHaveCount(4)
    await expect(paper.locator('ins')).toHaveCount(5)
    await expect(paper.getByText(/longer monitoring is needed/)).toBeVisible()
  })

  test('supports arrow-key feature navigation and visible focus', async ({ page }) => {
    await page.goto('/')
    const writing = page.getByRole('tab', { name: /Writing/ })
    const results = page.getByRole('tab', { name: /Results from code/ })
    await writing.focus()
    await page.keyboard.press('ArrowRight')
    await expect(results).toBeFocused()
    await expect(results).toHaveAttribute('aria-selected', 'true')
    await expect(results).toHaveCSS('outline-style', 'solid')
  })

  test('keeps result source hidden until the guided View source control is used', async ({ page }) => {
    await page.goto('/')
    const demo = page.locator('.home-workspace-demo')
    const figureSource = demo.getByRole('button', { name: 'View source for Figure 1' })
    await expect(figureSource).toHaveCount(0)
    await expect(demo.locator('.home-demo-source-panel')).toHaveCount(0)

    await page.getByRole('tab', { name: /Results from code/ }).click()
    await expect(page.getByText('Try it in the preview')).toBeVisible()
    await expect(page.getByText('Click “View source” on the figure or table.')).toBeVisible()
    await expect(demo.getByLabel('Programming languages and manuscript output workflow')).toContainText('Python')
    await expect(demo.getByLabel('Programming languages and manuscript output workflow')).toContainText('Julia')
    await expect(demo.getByLabel('Programming languages and manuscript output workflow')).toContainText('Shared with document cells')
    await expect(demo.getByLabel('Programming languages and manuscript output workflow')).toContainText('Project.toml & Manifest.toml')
    await expect(demo.getByLabel('Programming languages and manuscript output workflow')).toContainText('Add package')
    await expect(demo.getByLabel('Programming languages and manuscript output workflow')).toContainText('parsed automatically into manuscript figures, tables, and in-text values')
    await expect(demo.getByLabel('Automatic reference to Figure 1')).toBeVisible()
    await expect(demo.getByLabel('Automatic reference to Table 1')).toBeVisible()
    await expect(demo.getByText(/Canopy cover increased steadily after rainfall returned/)).toBeVisible()
    await expect(demo.getByText(/Treatment estimates and confidence intervals are summarized/)).toBeVisible()
    await expect(figureSource).toHaveCount(1)
    await figureSource.click()

    await expect(demo.getByRole('list', { name: 'Python source for Figure 1' })).toContainText('ax.plot')
    await expect(demo.getByRole('button', { name: 'Close source for Figure 1' })).toHaveAttribute('aria-expanded', 'true')

    await demo.getByRole('button', { name: 'View source for Table 1' }).click()
    await expect(demo.getByRole('list', { name: 'Python source for Figure 1' })).toHaveCount(0)
    await expect(demo.getByRole('list', { name: 'Python source for Table 1' })).toContainText('recovery_table')

    const readability = await page.evaluate(() => {
      const size = (selector: string) => Number.parseFloat(getComputedStyle(document.querySelector<HTMLElement>(selector)!).fontSize)
      const showcase = document.querySelector<HTMLElement>('.home-showcase')!
      return {
        outerGutter: window.innerWidth - showcase.getBoundingClientRect().width,
        manuscript: size('.home-workspace-demo .home-demo-paper section > p'),
        source: size('.home-workspace-demo .home-demo-source-panel li'),
        table: size('.home-workspace-demo .home-demo-table-wrap table'),
        outline: size('.home-workspace-demo .home-demo-outline li'),
      }
    })
    expect(readability.outerGutter).toBeLessThanOrEqual(26)
    expect(readability.manuscript).toBeGreaterThanOrEqual(14)
    expect(readability.source).toBeGreaterThanOrEqual(11)
    expect(readability.table).toBeGreaterThanOrEqual(11)
    expect(readability.outline).toBeGreaterThanOrEqual(11)
  })

  test('shows full reference details from the citation step on hover and focus', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('tab', { name: /Citations/ }).click()
    await expect(page.getByText(/The References section updates automatically/)).toBeVisible()

    const references = page.locator('.home-workspace-demo .home-demo-references')
    await expect(references).toHaveClass(/is-preview-active/)
    await expect(references.getByRole('heading', { name: 'References' })).toBeVisible()
    await expect(references).toContainText('Automatically generated')
    await expect(references).toContainText('Meyer, L., & Okafor, C. (2025).')
    await expect(references).toContainText('Journal of Canopy Ecology, 18')

    const citation = page.getByRole('button', { name: 'Reference details for Meyer and Okafor, 2025' })
    await citation.hover()
    const details = page.getByRole('tooltip')
    await expect(details).toBeVisible()
    await expect(details).toContainText('Canopy resilience following seasonal drought')
    await expect(details).toContainText('Lena Meyer · Chidi Okafor')
    await expect(details).toContainText('2025 · Journal of Canopy Ecology')
    await expect(details).toContainText('@meyer2025')
    const headerLayout = await details.locator('.home-demo-citation-card-head').evaluate((header) => {
      const badge = header.firstElementChild!.getBoundingClientRect()
      const bibliography = header.lastElementChild!.getBoundingClientRect()
      return {
        gap: bibliography.left - badge.right,
        bibliographyWidth: bibliography.width,
      }
    })
    expect(headerLayout.gap).toBeGreaterThanOrEqual(8)
    expect(headerLayout.bibliographyWidth).toBeGreaterThan(150)

    await page.mouse.move(0, 0)
    await expect(details).toHaveCount(0)
    await citation.focus()
    await expect(page.getByRole('tooltip')).toBeVisible()
    await citation.press('Escape')
    await expect(page.getByRole('tooltip')).toHaveCount(0)
  })

  test('stacks at a mobile viewport without horizontal page overflow', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/')
    const mobileHeroLayout = await page.locator('.home-hero-layout').evaluate((layout) => {
      const copy = layout.querySelector<HTMLElement>('.home-hero-copy')!.getBoundingClientRect()
      const actions = layout.querySelector<HTMLElement>('.home-hero-actions')!.getBoundingClientRect()
      const preview = layout.querySelector<HTMLElement>('.home-hero-preview')!.getBoundingClientRect()
      return {
        copyBeforePreview: copy.bottom < preview.top,
        previewAfterActions: actions.bottom < preview.top,
        previewWidth: preview.width,
        viewportWidth: window.innerWidth,
      }
    })
    expect(mobileHeroLayout.copyBeforePreview).toBe(true)
    expect(mobileHeroLayout.previewAfterActions).toBe(true)
    expect(mobileHeroLayout.previewWidth).toBeLessThanOrEqual(mobileHeroLayout.viewportWidth - 30)
    await expect(page.locator('.home-hero-product-preview').getByRole('heading', { name: 'Canopy recovery after seasonal drought' })).toBeVisible()

    await page.getByRole('tab', { name: /Results from code/ }).click()
    await page.getByRole('button', { name: 'View source for Figure 1' }).click()
    await expect(page.getByRole('list', { name: 'Python source for Figure 1' })).toBeVisible()

    const measurements = await page.evaluate(() => {
      const surface = document.querySelector<HTMLElement>('.home-welcome')!
      const showcase = document.querySelector<HTMLElement>('.home-showcase-layout')!
      const style = getComputedStyle(showcase)
      return {
        documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        surfaceOverflow: surface.scrollWidth - surface.clientWidth,
        columns: style.gridTemplateColumns.split(' ').filter(Boolean).length,
      }
    })

    expect(measurements.documentOverflow).toBeLessThanOrEqual(1)
    expect(measurements.surfaceOverflow).toBeLessThanOrEqual(1)
    expect(measurements.columns).toBe(1)
    await expect(page.getByRole('tab', { name: /Results from code/ })).toBeVisible()
    await expect(page.locator('.home-workspace-demo')).toBeVisible()

    await page.getByRole('tab', { name: /Citations/ }).click()
    await page.getByRole('button', { name: 'Reference details for Meyer and Okafor, 2025' }).click()
    await expect(page.getByRole('tooltip')).toBeVisible()
    const citationOverflow = await page.evaluate(() => {
      const surface = document.querySelector<HTMLElement>('.home-welcome')!
      return {
        document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        surface: surface.scrollWidth - surface.clientWidth,
      }
    })
    expect(citationOverflow.document).toBeLessThanOrEqual(1)
    expect(citationOverflow.surface).toBeLessThanOrEqual(1)
  })
})
