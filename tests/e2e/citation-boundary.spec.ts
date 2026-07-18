import { expect, test } from '@playwright/test'

test('typing after a terminal citation resumes ordinary paragraph formatting', async ({ page }) => {
  const source = '# Citation boundary\n\nEvidence ends with a source [@vezy2024]\n'
  await page.addInitScript((portableSource) => {
    localStorage.setItem('draftmatter.structured-source.v1', portableSource)
    localStorage.setItem('draftmatter.structured-mode.v1', 'true')
  }, source)
  await page.goto('/')

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
