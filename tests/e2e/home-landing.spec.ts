import { expect, test } from '@playwright/test'

const features = [
  ['Writing', 'writing', 'Write in a calm, structured editor where the manuscript stays central.'],
  ['Results from code', 'results', 'Create figures, tables, and in-text values from R, Python, or Julia. DraftMatter keeps the source linked to the result and keeps code out of the final paper.'],
  ['Citations', 'citations', 'Search, insert, and format citations without leaving the manuscript.'],
  ['Review and collaboration', 'review', 'Comment, suggest changes, and work with co-authors in the context of the paper.'],
  ['Checks and export', 'checks', 'Review citation, computation, output, and export issues before sharing the paper.'],
] as const

test.describe('signed-out Home landing experience', () => {
  test('presents the approved story and scrolls to a usable guided preview', async ({ page }) => {
    await page.goto('/')

    await expect(page.getByText('A calm workspace for rigorous research', { exact: true })).toBeVisible()
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Your paper should not be the least reproducible part of your research.')
    await expect(page.getByText('Research writing, with the missing pieces built in.', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Start writing' })).toBeVisible()

    await page.getByRole('button', { name: 'See how it works' }).click()
    const surface = page.locator('.home-welcome')
    await expect.poll(() => surface.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
    await expect(page.locator('#home-showcase')).toBeInViewport()

    const demo = page.locator('.home-workspace-demo')
    await expect(demo).toHaveAttribute('data-active-feature', 'writing')
    await expect(demo.getByText('Canopy recovery after seasonal drought')).toBeVisible()
    await expect(demo.getByText('Figure 1.')).toBeVisible()
    await expect(demo.getByText('Table 1.')).toBeVisible()
    await expect(demo.getByText('Project checks')).toBeVisible()
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
      await expect(demo.getByText('Canopy recovery after seasonal drought')).toHaveCount(1)
    }
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
    await expect(figureSource).toBeDisabled()
    await expect(demo.locator('.home-demo-source-panel')).toHaveCount(0)

    await page.getByRole('tab', { name: /Results from code/ }).click()
    await expect(page.getByText('Try “View source” on the figure or table.')).toBeVisible()
    await expect(figureSource).toBeEnabled()
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
        manuscript: size('.home-demo-paper section > p'),
        source: size('.home-demo-source-panel li'),
        table: size('.home-demo-table-wrap table'),
        outline: size('.home-demo-outline li'),
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

    const references = page.locator('.home-demo-references')
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
