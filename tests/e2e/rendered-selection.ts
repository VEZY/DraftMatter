import { expect, type Locator, type Page } from '@playwright/test'

/** Select rendered prose with real mouse events so the editor observes the gesture. */
export async function selectRenderedTextWithMouse(page: Page, target: Locator, quote: string, occurrence = 0) {
  await target.scrollIntoViewIfNeeded()
  const endpoints = await target.evaluate((element, selection) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
    const nodes: Text[] = []
    while (walker.nextNode()) nodes.push(walker.currentNode as Text)
    const text = nodes.map((node) => node.data).join('')
    let start = -1
    for (let index = 0; index <= selection.occurrence; index++) {
      start = text.indexOf(selection.quote, start + 1)
      if (start < 0) throw new Error('The requested rendered selection is missing')
    }
    const locate = (offset: number) => {
      let consumed = 0
      for (const node of nodes) {
        if (offset < consumed + node.length) return { node, offset: offset - consumed }
        consumed += node.length
      }
      throw new Error('The selection endpoint is outside the rendered text')
    }
    const from = locate(start), to = locate(start + selection.quote.length - 1)
    const first = document.createRange(), last = document.createRange()
    first.setStart(from.node, from.offset)
    first.setEnd(from.node, from.offset + 1)
    last.setStart(to.node, to.offset)
    last.setEnd(to.node, to.offset + 1)
    const a = first.getBoundingClientRect(), b = last.getBoundingClientRect()
    return { from: { x: a.left + 1, y: a.top + a.height / 2 }, to: { x: b.right - 1, y: b.top + b.height / 2 } }
  }, { quote, occurrence })
  await page.mouse.move(endpoints.from.x, endpoints.from.y)
  await page.mouse.down()
  await page.mouse.move(endpoints.to.x, endpoints.to.y, { steps: 16 })
  await page.mouse.up()
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe(quote)
}
