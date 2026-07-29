import { expect, test } from '@playwright/test'
import { reloadWithPortableSource } from './portable-source'

const continuation = 'Reproducible writing environments can shorten the path between an observation, its supporting analysis, and the claim that enters the literature. This manuscript keeps those elements close without exposing the mechanics during ordinary reading.'

test('migrates the second sample introduction paragraph into an editable block', async ({ page }) => {
  await page.goto('/draft')
  await expect.poll(() => page.evaluate(() => localStorage.getItem('draftmatter.structured-source.v1') ?? '')).not.toBe('')
  const legacySource = await page.evaluate((text) => {
    const key = 'draftmatter.structured-source.v1'
    const source = localStorage.getItem(key) ?? ''
    const legacy = source.replace(`\n\n${text}`, '')
    localStorage.setItem(key, legacy)
    return legacy
  }, continuation)
  expect(legacySource).toContain('title: "Drought acclimation reshapes canopy development"')
  expect(legacySource).toContain('Plant architecture mediates the exchange of light, water, and carbon')
  await reloadWithPortableSource(page, legacySource)

  const paragraphState = await page.evaluate((text) => {
    const element = [...document.querySelectorAll('.structured-editor-content p')].find((candidate) => candidate.textContent === text)
    return { found: Boolean(element), editable: element?.closest('[contenteditable="true"]')?.getAttribute('contenteditable') }
  }, continuation)
  expect(paragraphState).toEqual({ found: true, editable: 'true' })

  await page.evaluate((text) => {
    const element = [...document.querySelectorAll('.structured-editor-content p')].find((candidate) => candidate.textContent === text)
    const selection = window.getSelection()
    const textNode = element?.lastChild
    if (!selection || !textNode) throw new Error('Editable paragraph text is unavailable')
    const range = document.createRange()
    range.setStart(textNode, textNode.textContent?.length ?? 0)
    range.collapse(true)
    selection.removeAllRanges()
    selection.addRange(range)
  }, continuation)
  await page.keyboard.type(' Additional editable note.')
  await expect.poll(() => page.evaluate(() => localStorage.getItem('draftmatter.structured-source.v1') ?? '')).toContain('Additional editable note.')
})
