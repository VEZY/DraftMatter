import { expect, type Locator, type Page } from '@playwright/test'

/** Reveal the unpinned toolbar through the same reachable tab a reader uses. */
export async function showWritingTools(page: Page) {
  const reveal = page.getByRole('button', { name: 'Show writing tools', exact: true })
  await reveal.hover()
  await reveal.click()
  await expect(page.getByRole('toolbar', { name: 'Formatting toolbar', exact: true })).toHaveCSS('opacity', '1')
}

export async function setTrackChanges(page: Page, enabled = true) {
  const options = page.getByRole('dialog', { name: 'Review options', exact: true })
  if (!await options.isVisible()) await page.getByRole('button', { name: 'Review options', exact: true }).click()
  const tracking = options.getByRole('switch', { name: 'Track changes', exact: true })
  if (await tracking.getAttribute('aria-checked') !== String(enabled)) await tracking.click()
  await expect(tracking).toHaveAttribute('aria-checked', String(enabled))
  await options.getByRole('button', { name: 'Close review options' }).click()
}

/** Reproduce a shortcut opening before Chromium delivers the caret's selectionchange. */
export async function advanceCaretBeforeDialog(page: Page, paragraph: Locator) {
  await paragraph.evaluate((element) => {
    const editor = element.closest<HTMLElement>('[contenteditable="true"]')!
    editor.focus()
    const text = Array.from(element.childNodes).find((node): node is Text => node instanceof Text && node.data.endsWith('.'))!
    document.getSelection()!.collapse(text, text.length - 1)
    document.dispatchEvent(new Event('selectionchange'))

    const deferSelectionChange = (event: Event) => event.stopImmediatePropagation()
    document.addEventListener('selectionchange', deferSelectionChange, true)
    editor.addEventListener('blur', () => {
      document.removeEventListener('selectionchange', deferSelectionChange, true)
    }, { once: true })
  })
  await page.keyboard.press('ArrowRight')
}
