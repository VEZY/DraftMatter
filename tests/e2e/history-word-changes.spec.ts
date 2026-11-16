import { expect, test } from '@playwright/test'
import { BROWSER_ASSET_SCOPE_KEY } from '../../src/browserProjectAssets'
import { parsePortableDocument, sourceHash } from '../../src/document'
import { initialDraft } from '../../src/sampleDraft'
import { recoveryDocumentStorageKey, type RecoveryDocumentIdentity } from '../../src/storage'

test('highlights only edited words in a long historical paragraph without changing either version', async ({ page }) => {
  const context = Array.from({ length: 12 }, (_, index) => `Observation ${index + 1} connects the recorded conditions with the measured response. Researchers retain the sampling date, units, instrument settings and interpretation so that each comparison can be checked independently. `).join('')
  const olderParagraph = `The study describes stable responses under controlled conditions. ${context}The final estimate is 12 units and the methods remain available for inspection.`
  const currentParagraph = olderParagraph.replace('stable responses', 'variable responses').replace('12 units', '18 units')
  expect(olderParagraph.length).toBeGreaterThan(2000)
  const older = `---\ntitle: "Word comparison study"\n---\n\n# Results\n\n${olderParagraph}\n`
  const source = older.replace(olderParagraph, currentParagraph)
  const identity: RecoveryDocumentIdentity = { kind: 'browser', browserAssetScope: 'word-history-e2e', documentPath: 'paper.md' }
  const original = { id: 'earlier-words', kind: 'autosave', filename: 'paper.md', title: 'Before wording changes',
    savedAt: '2026-11-01T10:00:00.000Z', sourceHash: sourceHash(older), source: older,
    draft: parsePortableDocument(older, initialDraft).draft, documentIdentity: identity, browserAssetScope: identity.browserAssetScope }
  const journalKey = recoveryDocumentStorageKey(identity)
  await page.addInitScript(({ values }) => {
    for (const [key, value] of Object.entries(values)) localStorage.setItem(key, value)
  }, { values: {
    'draftmatter.structured-source.v1': source,
    'draftmatter.structured-mode.v1': 'true',
    'draftmatter.project-meta.v1': JSON.stringify({ filename: 'paper.md', projectName: 'Word comparison study' }),
    [BROWSER_ASSET_SCOPE_KEY]: identity.browserAssetScope,
    [journalKey]: JSON.stringify({ schemaVersion: 3, texts: [], snapshots: [original] }),
  } })
  await page.goto('/draft')
  await page.getByRole('button', { name: 'History', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Recovery history', exact: true })
  const journalBefore = await page.evaluate((key) => localStorage.getItem(key), journalKey)
  await dialog.locator('[data-history-select="earlier-words"]').click()
  await dialog.getByRole('tab', { name: 'Changes', exact: true }).click()
  const changed = dialog.getByRole('group', { name: /^Changed line / })
  await expect(changed).toHaveCount(1)
  expect((await changed.locator('del').allTextContents()).map((value) => value.trim())).toEqual(['stable', '12'])
  expect((await changed.locator('ins').allTextContents()).map((value) => value.trim())).toEqual(['variable', '18'])
  expect((await changed.textContent())?.match(/Observation 1 connects/g)).toHaveLength(1)
  await expect(dialog.locator('.recovery-changes-row.added, .recovery-changes-row.removed')).toHaveCount(0)
  const fill = await changed.evaluate((element) => getComputedStyle(element).backgroundColor)
  expect(['rgba(0, 0, 0, 0)', 'rgb(255, 255, 255)']).toContain(fill)
  expect(await page.evaluate(() => localStorage.getItem('draftmatter.structured-source.v1'))).toBe(source)
  expect(await page.evaluate((key) => localStorage.getItem(key), journalKey)).toBe(journalBefore)
  await page.screenshot({ path: '/private/tmp/draftmatter-word-level-history.png' })
  await dialog.getByRole('tab', { name: 'Source', exact: true }).click()
  await expect(dialog.getByLabel('Version source', { exact: true })).toHaveText(older)
})
