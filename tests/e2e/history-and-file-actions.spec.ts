import { expect, test } from '@playwright/test'
import { BROWSER_ASSET_SCOPE_KEY } from '../../src/browserProjectAssets'
import { parsePortableDocument, sourceHash } from '../../src/document'
import { initialDraft } from '../../src/sampleDraft'
import { recoveryDocumentStorageKey, type RecoveryDocumentIdentity } from '../../src/storage'

test('opens recovery history from the left rail and closes it with Escape', async ({ page }) => {
  await page.goto('/draft')
  const navigation = page.getByRole('navigation', { name: 'Workspace navigation' })
  const history = navigation.getByRole('button', { name: 'History', exact: true })
  await expect(history).toBeVisible()
  await history.click()
  const dialog = page.getByRole('dialog', { name: 'Recovery history', exact: true })
  await expect(dialog).toBeVisible()
  await expect(history).toHaveAttribute('aria-expanded', 'true')
  await expect(dialog).toContainText('Browsing leaves your manuscript unchanged')
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(history).toHaveAttribute('aria-expanded', 'false')
  await history.focus()
  await page.keyboard.press('Enter')
  await expect(dialog).toBeVisible()
})

test('keeps downloads for a paper that lives only in this browser', async ({ page }) => {
  await page.goto('/draft')
  await page.getByRole('navigation', { name: 'Workspace navigation' }).getByRole('button', { name: 'Files', exact: true }).click()
  const file = page.getByRole('region', { name: 'Selected project file', exact: true })
  await expect(file).toBeVisible()
  await expect(file.getByRole('button', { name: /^Download / })).toBeVisible()
})

test('names an older version without restoring it and keeps the name after reopening the project', async ({ page }) => {
  const source = '---\ntitle: "Retention study"\n---\n\n# Results\n\nCurrent manuscript: 18 measured units.\n'
  const older = source.replace('18 measured units.', '12 measured units.')
  const identity: RecoveryDocumentIdentity = { kind: 'browser', browserAssetScope: 'named-history-e2e', documentPath: 'paper.md' }
  const original = { id: 'older-source', kind: 'autosave', filename: 'paper.md', title: 'Before revisions',
    savedAt: '2026-11-01T10:00:00.000Z', sourceHash: sourceHash(older), source: older,
    draft: parsePortableDocument(older, initialDraft).draft, documentIdentity: identity, browserAssetScope: identity.browserAssetScope }
  await page.addInitScript(({ values }) => {
    if (sessionStorage.getItem('named-history-seeded')) return
    for (const [key, value] of Object.entries(values)) localStorage.setItem(key, value)
    sessionStorage.setItem('named-history-seeded', 'true')
  }, { values: {
    'draftmatter.structured-source.v1': source,
    'draftmatter.structured-mode.v1': 'true',
    'draftmatter.project-meta.v1': JSON.stringify({ filename: 'paper.md', projectName: 'Retention study' }),
    [BROWSER_ASSET_SCOPE_KEY]: identity.browserAssetScope,
    [recoveryDocumentStorageKey(identity)]: JSON.stringify({ schemaVersion: 3, texts: [], snapshots: [original] }),
  } })
  await page.goto('/draft')
  await page.getByRole('button', { name: 'History', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Recovery history', exact: true })
  await dialog.locator('[data-history-select="older-source"]').click()
  await dialog.getByRole('button', { name: 'Name & keep version', exact: true }).click()
  await dialog.getByRole('textbox', { name: 'Version name', exact: true }).fill('Before co-author review')
  await dialog.getByRole('textbox', { name: 'Version name', exact: true }).press('Enter')
  await expect(dialog.getByRole('form', { name: 'Name selected version' })).toHaveCount(0)
  await expect(dialog.locator('.recovery-list')).toContainText('Before co-author review')
  await expect(dialog.locator('.recovery-list')).toContainText('Named · kept')
  expect(await page.evaluate(() => localStorage.getItem('draftmatter.structured-source.v1'))).toBe(source)
  await dialog.getByRole('button', { name: 'Back to current manuscript', exact: true }).click()
  await page.reload()
  await expect(page.getByRole('textbox', { name: 'Rendered manuscript editor', exact: true })).toContainText('18 measured units.')
  await page.getByRole('button', { name: 'History', exact: true }).click()
  const named = dialog.locator('.recovery-list > button').filter({ hasText: 'Before co-author review' })
  await expect(named).toContainText('Named · kept')
  await named.click()
  await dialog.getByRole('tab', { name: 'Source', exact: true }).click()
  await expect(dialog.getByLabel('Version source', { exact: true })).toHaveText(older)
  expect(await page.evaluate(() => localStorage.getItem('draftmatter.structured-source.v1'))).toBe(source)
  await page.screenshot({ path: '/private/tmp/draftmatter-named-version-integrated.png' })
})

test('shows and restores only the active manuscript, preserving other files and unassigned old backups', async ({ page }) => {
  const source = '---\ntitle: "The active article"\n---\n\n# Introduction\n\nCurrent article prose.\n'
  const olderSource = source.replace('Current article prose.', 'Earlier article prose.')
  const identity: RecoveryDocumentIdentity = { kind: 'browser', browserAssetScope: 'history-browser-a', documentPath: 'paper.md' }
  const snapshot = (title: string, content: string, documentIdentity?: RecoveryDocumentIdentity) => ({
    id: title, filename: documentIdentity?.documentPath ?? 'README.md', title,
    savedAt: '2026-11-16T08:00:00.000Z', sourceHash: sourceHash(content), source: content,
    draft: parsePortableDocument(content, initialDraft).draft,
    ...(documentIdentity ? { documentIdentity } : {}),
    ...(documentIdentity?.kind === 'browser' ? { browserAssetScope: documentIdentity.browserAssetScope } : {}),
  })
  const readmeIdentity: RecoveryDocumentIdentity = { ...identity, documentPath: 'README.md' }
  const otherProjectIdentity: RecoveryDocumentIdentity = { ...identity, browserAssetScope: 'history-browser-b' }
  const journal = (entry: ReturnType<typeof snapshot>) => JSON.stringify({ schemaVersion: 3, texts: [], snapshots: [entry] })
  const legacy = JSON.stringify([snapshot('Unassigned README backup', '# README\n\nOld project instructions.\n')])
  const readme = journal(snapshot('README history', '# README\n\nInstructions.\n', readmeIdentity))
  const otherProject = journal(snapshot('A different project’s paper', '# Other project\n\nKeep this separate.\n', otherProjectIdentity))
  const fixtures = {
    'draftmatter.structured-source.v1': source,
    'draftmatter.structured-mode.v1': 'true',
    'draftmatter.project-meta.v1': JSON.stringify({ filename: 'paper.md', projectName: 'History scope study' }),
    [BROWSER_ASSET_SCOPE_KEY]: 'history-browser-a',
    [recoveryDocumentStorageKey(identity)]: journal(snapshot('Earlier article version', olderSource, identity)),
    [recoveryDocumentStorageKey(readmeIdentity)]: readme,
    [recoveryDocumentStorageKey(otherProjectIdentity)]: otherProject,
    'draftmatter.recovery.v1': legacy,
  }
  await page.addInitScript((values) => { for (const [key, value] of Object.entries(values)) localStorage.setItem(key, value) }, fixtures)
  await page.goto('/draft')
  await expect(page.getByRole('textbox', { name: 'Rendered manuscript editor', exact: true })).toContainText('Current article prose.')
  await page.getByRole('button', { name: 'History', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Recovery history', exact: true })
  await expect(dialog).toContainText('paper.md')
  await expect(dialog.locator('.recovery-list')).toContainText('Earlier article version')
  await expect(dialog.locator('.recovery-list')).not.toContainText('README')
  await expect(dialog.locator('.recovery-list')).not.toContainText('different project')
  await dialog.locator('.recovery-list > button').filter({ hasText: 'Earlier article version' }).click()
  await expect(page.getByRole('textbox', { name: 'Rendered manuscript editor', exact: true })).toContainText('Current article prose.')
  expect(await page.evaluate(() => localStorage.getItem('draftmatter.structured-source.v1'))).toBe(source)
  await dialog.getByRole('tab', { name: 'Changes', exact: true }).click()
  const changedLine = dialog.getByRole('group', { name: /^Changed line / })
  await expect(changedLine).toHaveCount(1)
  await expect(changedLine.locator('del')).toHaveText('Earlier')
  await expect(changedLine.locator('ins')).toHaveText('Current')
  expect((await changedLine.textContent())?.match(/article prose\./g)).toHaveLength(1)
  await dialog.getByRole('button', { name: 'Restore this version', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect.poll(() => page.evaluate(() => localStorage.getItem('draftmatter.structured-source.v1'))).toBe(olderSource)
  const remaining = await page.evaluate((keys) => keys.map((key) => localStorage.getItem(key)), [
    recoveryDocumentStorageKey(readmeIdentity), recoveryDocumentStorageKey(otherProjectIdentity), 'draftmatter.recovery.v1',
  ])
  expect(remaining).toEqual([readme, otherProject, legacy])
  await page.getByRole('button', { name: 'History', exact: true }).click()
  await expect(dialog.locator('.recovery-list')).toContainText('Earlier article version')
  await expect(dialog.locator('.recovery-list')).toContainText('Before restoration')
  await expect(dialog.locator('.recovery-list')).toContainText('Restored version')
  await dialog.locator('.recovery-list > button').filter({ hasText: 'Earlier article version' }).click()
  for (let count = 0; count < 10; count++) await dialog.getByRole('button', { name: 'Save version', exact: true }).click()
  await expect(dialog.locator('.recovery-version-origin').filter({ hasText: /^Saved version$/ })).toHaveCount(10)
  await expect(dialog.locator('.recovery-list')).toContainText('Earlier article version')
  await expect(dialog.locator('.recovery-version-button[aria-pressed="true"]')).toContainText('Earlier article version')
  await dialog.getByRole('button', { name: 'Back to current manuscript', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  expect(await page.evaluate(() => localStorage.getItem('draftmatter.structured-source.v1'))).toBe(olderSource)
})
