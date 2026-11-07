import { expect, test } from '@playwright/test'
import * as Y from 'yjs'

test('keeps both offline branches when two tabs save the same collaboration journal, then reopens them after reload', async ({ page, context }) => {
  const first = new Y.Doc()
  const second = new Y.Doc()
  first.getText('paper').insert(0, 'First tab offline edit.')
  second.getText('paper').insert(0, 'Second tab offline edit.')
  const key = `two-tabs-${crypto.randomUUID()}`
  const secondPage = await context.newPage()
  await Promise.all([page.goto('/'), secondPage.goto('/')])
  const write = async (target: typeof page, state: Uint8Array) => target.evaluate(async ({ key, state }) => {
    const modulePath = '/src/sharedEditor/collaborationJournal.ts'
    const { createCollaborationJournal } = await import(modulePath)
    await createCollaborationJournal(key).save(Uint8Array.from(state))
  }, { key, state: Array.from(state) })
  await Promise.all([write(page, Y.encodeStateAsUpdate(first)), write(secondPage, Y.encodeStateAsUpdate(second))])
  await page.reload()
  const bytes = await page.evaluate(async (key) => {
    const modulePath = '/src/sharedEditor/collaborationJournal.ts'
    const { createCollaborationJournal } = await import(modulePath)
    const journal = createCollaborationJournal(key)
    const saved = await journal.load()
    try { await journal.save(new Uint8Array(16 * 1024 * 1024 + 1)); throw new Error('Size limit was not enforced') } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('16 MB')) throw error
    }
    const afterFailedSave = await journal.load()
    if (Array.from(saved).join(',') !== Array.from(afterFailedSave).join(',')) throw new Error('A rejected save changed the valid journal')
    return Array.from(afterFailedSave) as number[]
  }, key)
  const recovered = new Y.Doc()
  Y.applyUpdate(recovered, Uint8Array.from(bytes))
  const content = recovered.getText('paper').toString()
  expect(content).toContain('First tab offline edit.')
  expect(content).toContain('Second tab offline edit.')
  expect(content.match(/offline edit/g)).toHaveLength(2)
  first.destroy(); second.destroy(); recovered.destroy()
  await secondPage.close()
})
