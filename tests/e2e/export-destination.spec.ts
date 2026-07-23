import { expect, test } from '@playwright/test'

test('chooses an export filename before opening the platform save picker', async ({ page }) => {
  await page.addInitScript(() => {
    const state = window as typeof window & {
      __draftmatterSave?: { options?: unknown; bytes?: number; closed?: boolean }
      showSaveFilePicker?: (options: unknown) => Promise<unknown>
    }
    state.__draftmatterSave = {}
    state.showSaveFilePicker = async (options) => {
      state.__draftmatterSave!.options = options
      return {
        createWritable: async () => ({
          write: async (blob: Blob) => { state.__draftmatterSave!.bytes = blob.size },
          close: async () => { state.__draftmatterSave!.closed = true },
        }),
      }
    }
  })
  await page.goto('/draft')

  await page.getByRole('button', { name: 'Export' }).click()
  await page.getByText('Advanced options', { exact: true }).click()
  await page.getByRole('button', { name: /Project source/ }).click()
  const dialog = page.getByRole('dialog', { name: 'Save portable manuscript' })
  await expect(dialog.getByLabel('File name')).toHaveValue('canopy-drought.qmd')
  await dialog.getByLabel('File name').fill('focused-canopy-study.qmd')
  await dialog.getByRole('button', { name: 'Choose location…' }).click()

  await expect(dialog).toBeHidden()
  const save = await page.evaluate(() => (window as typeof window & { __draftmatterSave?: { options?: { suggestedName?: string }; bytes?: number; closed?: boolean } }).__draftmatterSave)
  expect(save?.options?.suggestedName).toBe('focused-canopy-study.qmd')
  expect(save?.bytes).toBeGreaterThan(100)
  expect(save?.closed).toBe(true)
})
