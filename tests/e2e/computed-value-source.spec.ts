import { createHash } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { startSharedManuscript } from './shared-manuscript'

test('the example opens the producing code beside each value and navigates to its source', async ({ page }, testInfo) => {
  await page.goto('/demo')
  const editor = page.getByRole('textbox', { name: 'Rendered manuscript editor', exact: true })
  const values = editor.getByRole('button', { name: /^Inspect computed value canopy_reduction:/ })
  await expect(values).toHaveCount(3)
  const occurrence = values.nth(1)
  await occurrence.evaluate((element) => element.scrollIntoView({ block: 'center' }))
  await occurrence.hover()
  const dialog = page.getByRole('dialog', { name: 'Computed value canopy_reduction', exact: true })
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('3 occurrences')
  await expect(dialog.locator('.cm-content')).toContainText('publish("canopy_reduction", reduction')
  await expect(dialog.getByRole('button', { name: 'Save & run' })).toHaveCount(0)
  await expect(dialog.locator('.cm-content')).toHaveAttribute('contenteditable', 'false')
  // The panel can flip when the occurrence is near the bottom of the window.
  await expect.poll(async () => {
    const anchor = await occurrence.boundingBox()
    const panel = await dialog.boundingBox()
    return anchor && panel && Math.min(Math.abs(panel.y - anchor.y - anchor.height), Math.abs(anchor.y - panel.y - panel.height))
  }).toBeLessThan(15)
  await page.mouse.move(10, 10)
  await page.screenshot({ path: testInfo.outputPath('computed-value-source.png') })
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(occurrence).toBeFocused()
  await occurrence.press('Enter')
  await expect(dialog).toBeVisible()
  await page.keyboard.press('Escape')

  const row = page.locator('.code-workspace-drawer [data-cell-id="cell-python-values"]')
  const closeDrawer = page.getByRole('button', { name: 'Close Code and computation' })
  for (const shortcut of ['contextmenu', 'Control+Enter', 'Meta+Enter', 'Control+Click', 'Meta+Click'] as const) {
    if (shortcut === 'contextmenu') {
      await occurrence.click({ button: 'right' })
      await page.getByRole('menuitem', { name: 'Go to source' }).click()
    } else if (shortcut === 'Control+Click' || shortcut === 'Meta+Click') {
      await occurrence.click({ modifiers: [shortcut === 'Control+Click' ? 'Control' : 'Meta'] })
    } else {
      await occurrence.press(shortcut)
    }
    await expect(row.locator('details')).toHaveAttribute('open', '')
    await expect(row.locator('.cm-content')).toBeFocused()
    await closeDrawer.click()
    await expect(row).toHaveCount(0)
  }
})

test('a shared source edit reaches a connected reader and keeps the last result at both occurrences', async ({ browser, baseURL }, testInfo) => {
  const original = 'publish("height", 24)', updated = 'publish("height", 43)'
  const retained = {
    version: 1, name: 'height', value: 24, formatting: {},
    provenance: { cellId: 'cell-height', language: 'python', runHash: 'sha256:result',
      codeHash: 'sha256:' + createHash('sha256').update(original).digest('hex'), environmentFingerprint: 'env',
      sessionGeneration: 1, executionSequence: 1, retainedOutputHashes: ['sha256:result'] },
  }
  const manuscript = ['# Measurements', 'Height: {{height}}. Another plot: {{height}}.',
    '~~~python {#cell-height .execute output="values"}\n' + original + '\n~~~',
    '<!-- dm-output:start cell="cell-height" run="sha256:result" -->\n<!-- dm-published-value data="' +
      encodeURIComponent(JSON.stringify(retained)) + '" -->\n<!-- dm-output:end -->\n',
  ].join('\n\n')
  const shared = await startSharedManuscript(browser, baseURL!, manuscript)
  try {
    const editor = await shared.open('editor')
    const reader = await shared.open('viewer')
    const valueButton = { name: /^Inspect computed value height:/ }
    const bubbleName = { name: 'Computed value height', exact: true }
    for (const page of [editor, reader]) await page.getByRole('button', valueButton).nth(1).click()
    const editing = editor.getByRole('dialog', bubbleName)
    const reading = reader.getByRole('dialog', bubbleName)
    const field = editing.locator('.cm-content')
    const remoteField = reading.locator('.cm-content')
    for (const bubble of [editing, reading]) {
      await expect(bubble).toContainText('Open in the desktop app to update the result.')
      await expect(bubble).not.toContainText(/Saved result|Unsaved source changes/i)
      await expect(bubble.getByRole('button', { name: /^(Save|Revert|Run)(?: |$)/i })).toHaveCount(0)
    }
    await expect(remoteField).toHaveAttribute('contenteditable', 'false')
    await editor.bringToFront()
    await field.focus()
    await field.press('End')
    await field.press('ArrowLeft')
    await editor.keyboard.type('0')
    await expect(remoteField).toHaveText('publish("height", 240)')
    await expect(field).toBeFocused()
    await field.press('ControlOrMeta+z')
    await expect(remoteField).toHaveText(original)
    await expect(field).toBeFocused()

    await field.press('End')
    await field.press('ArrowLeft')
    await field.press('Shift+ArrowLeft')
    await field.press('Shift+ArrowLeft')
    await editor.keyboard.type('4')
    await expect(remoteField).toHaveText('publish("height", 4)')
    await expect(field).toBeFocused()
    await editor.keyboard.type('3')
    await editor.keyboard.press('Escape')
    await expect(editing).toHaveCount(0)
    await expect(editor.getByRole('button', valueButton).nth(1)).toBeFocused()
    await expect(remoteField).toHaveText(updated)
    for (const page of [reader, editor]) {
      const occurrences = page.getByRole('button', valueButton)
      await expect(occurrences).toHaveText(['24', '24'])
      for (const occurrence of await occurrences.all()) await expect(occurrence).toHaveAttribute('data-status', 'stale')
    }

    await editor.getByRole('button', valueButton).first().click()
    await expect(field).toHaveText(updated)
    await expect(editing).not.toContainText(/Saved result|Unsaved source changes/i)
    await editor.mouse.move(8, 8)
    await editing.screenshot({ path: testInfo.outputPath('computed-value-edit-shared.png') })
    await reader.reload()
    await expect(reader.locator('.collaboration-toggle.connected')).toBeVisible()
    await reader.getByRole('button', valueButton).first().click()
    await expect(reading.locator('.cm-content')).toHaveText(updated)
    await expect(reading.getByRole('button', { name: 'Save source' })).toHaveCount(0)
  } finally {
    await shared.close()
  }
})
