import { expect, test } from '@playwright/test'

test('typing after a terminal citation resumes ordinary paragraph formatting', async ({ page }) => {
  const source = '# Citation boundary\n\nEvidence ends with a source [@vezy2024]\n'
  await page.addInitScript((portableSource) => {
    localStorage.setItem('draftmatter.structured-source.v1', portableSource)
    localStorage.setItem('draftmatter.structured-mode.v1', 'true')
  }, source)
  await page.goto('/draft')

  const paragraph = page.locator('.structured-editor-content p').filter({ hasText: 'Evidence ends with a source' })
  const bounds = await paragraph.boundingBox()
  if (!bounds) throw new Error('Citation paragraph was not rendered.')
  await page.mouse.click(bounds.x + bounds.width - 2, bounds.y + bounds.height / 2)
  await page.keyboard.press('End')
  await page.keyboard.type(' and ordinary prose continues.')

  await expect(paragraph).toContainText('and ordinary prose continues.')
  const boundary = await paragraph.evaluate((element) => {
    const citation = element.querySelector<HTMLElement>('.structured-citation')
    const followingText = [...element.childNodes]
      .slice(citation ? [...element.childNodes].indexOf(citation) + 1 : 0)
      .filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => node.textContent ?? '')
      .join('')
    return {
      citationText: citation?.textContent ?? '',
      followingText,
    }
  })
  expect(boundary.followingText).toContain('ordinary prose continues')
  expect(boundary.citationText).not.toContain('ordinary prose continues')
})

test('citation details open beside the clicked citation and remain in view', async ({ page }) => {
  const source = '# Citation details\n\nEvidence is linked to its source [@vezy2024].\n'
  await page.addInitScript((portableSource) => {
    localStorage.setItem('draftmatter.structured-source.v1', portableSource)
    localStorage.setItem('draftmatter.structured-mode.v1', 'true')
  }, source)
  await page.goto('/draft')

  const citation = page.locator('.structured-citation')
  await citation.click()
  const details = page.locator('.structured-citation-detail')
  await expect(details).toBeVisible()

  const geometry = await page.evaluate(() => {
    const anchor = document.querySelector<HTMLElement>('.structured-citation')!.getBoundingClientRect()
    const panel = document.querySelector<HTMLElement>('.structured-citation-detail')!.getBoundingClientRect()
    const boundary = document.querySelector<HTMLElement>('.editor-area')!.getBoundingClientRect()
    const verticalGap = panel.top >= anchor.bottom
      ? panel.top - anchor.bottom
      : anchor.top >= panel.bottom
        ? anchor.top - panel.bottom
        : 0
    return {
      verticalGap,
      panelTop: panel.top,
      panelBottom: panel.bottom,
      boundaryTop: boundary.top,
      boundaryBottom: boundary.bottom,
    }
  })
  expect(geometry.verticalGap).toBeLessThanOrEqual(10)
  expect(geometry.panelTop).toBeGreaterThanOrEqual(geometry.boundaryTop)
  expect(geometry.panelBottom).toBeLessThanOrEqual(geometry.boundaryBottom)
})
