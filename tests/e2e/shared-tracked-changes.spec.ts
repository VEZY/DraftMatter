import { expect, test, type Locator, type Page } from '@playwright/test'
import { createDecoder, readVarString, readVarUint } from 'lib0/decoding'
import { startSharedManuscript } from './shared-manuscript'
import { selectRenderedTextWithMouse } from './rendered-selection'

function manuscriptText(paragraph: Locator) {
  return paragraph.evaluate((element) => {
    const copy = element.cloneNode(true) as HTMLElement
    copy.querySelectorAll('.ProseMirror-yjs-cursor').forEach((cursor) => cursor.remove())
    return copy.textContent
  })
}

test('two collaborators see one amended replacement and stay at the passage under review', async ({ browser, baseURL }, testInfo) => {
  test.setTimeout(60_000)
  const source = [
    '# Water in the canopy', ...Array.from({ length: 24 }, (_, index) =>
      `## Plot ${index + 1}\n\nAt this site, the team recorded water loss from leaves throughout the season.`),
    '## Results', 'The canopy retained more water under shade.', '## Interpretation',
    'The measurements reflect the balance between interception and evaporation.',
  ].join('\n\n') + '\n'
  const shared = await startSharedManuscript(browser, baseURL!, source)
  try {
    const author = await shared.open('owner')
    const reader = await shared.open('editor')
    const readerActions = reader.getByRole('group', { name: 'Review tracked changes' })
    await expect(readerActions).toBeHidden()
    await author.getByRole('button', { name: 'Turn on track changes' }).click()
    await reader.getByRole('button', { name: 'Review options', exact: true }).click()
    await reader.getByRole('button', { name: 'In text', exact: true }).click()
    await reader.getByRole('button', { name: 'Close review options' }).click()

    const passage = (page: Page) => page.locator('.ProseMirror p').filter({ hasText: 'The canopy retained' })
    const readerPassage = passage(reader)
    const authorPassage = passage(author)
    await readerPassage.scrollIntoViewIfNeeded()
    await selectRenderedTextWithMouse(author, authorPassage, 'more')
    await author.keyboard.type('less')
    const wording = author.getByRole('textbox', { name: 'Edit suggested wording' })
    await expect(wording).toHaveValue('less')
    const proposalId = await wording.getAttribute('data-proposal-id')
    expect(proposalId).toBeTruthy()
    const remote = readerPassage.locator('button.dm-review-proposal')
    await expect(remote).toHaveText('less')
    await expect(readerActions).toBeVisible()
    await expect(authorPassage).toBeInViewport()
    await expect(readerPassage).toBeInViewport()
    await wording.press('Escape')
    await wording.click()
    await wording.press('ControlOrMeta+a')
    await author.keyboard.type('slightly less')
    await expect(wording).toHaveValue('slightly less')
    await expect(wording).toHaveAttribute('data-proposal-id', proposalId!)
    await expect(remote).toHaveText('slightly less')
    await expect(readerPassage).toContainText('more')
    await expect(readerPassage).toBeInViewport()
    await expect(authorPassage).toBeInViewport()
    await reader.screenshot({ path: testInfo.outputPath('shared-track-changes.png') })

    const heading = await reader.locator('.ProseMirror').getByRole('heading', { name: 'Results' }).boundingBox()
    const card = await reader.locator('.review-margin [data-review-balloon]').first().boundingBox()
    if (!heading || !card) throw new Error('The review passage and its margin card must be visible.')
    const x = Math.max(0, Math.floor(heading.x) - 14)
    const y = Math.max(0, Math.floor(heading.y) - 14)
    await reader.screenshot({ path: testInfo.outputPath('shared-track-changes-detail.png'), clip: {
      x, y, width: Math.ceil(card.x + card.width) - x + 10, height: Math.ceil(card.y + card.height) - y + 12,
    } })

    // Also type at a caret just before existing prose, with no text selected.
    const interpretation = (page: Page) => page.locator('.ProseMirror p').filter({ hasText: 'The measurements reflect' })
    // Return to the author's window after capturing the reader's view.
    await author.bringToFront()
    await selectRenderedTextWithMouse(author, interpretation(author), 'evaporation')
    await expect(author.locator('.ProseMirror')).toBeFocused()
    await author.keyboard.press('ArrowLeft')
    await expect.poll(() => author.evaluate(() => window.getSelection()?.isCollapsed)).toBe(true)
    await author.keyboard.type('transpiration and ')
    await expect(interpretation(author).getByRole('textbox', { name: 'Edit suggested wording' })).toHaveValue('transpiration and ')
    await expect(interpretation(reader).locator('button.dm-review-proposal')).toHaveText('transpiration and')
    await expect(interpretation(reader)).toContainText('evaporation')

    const observer = await shared.open('viewer')
    await expect(observer.locator(`[data-review-balloon="${proposalId}"]`)).toContainText('slightly less')
    await expect(observer.getByRole('button', { name: /^(Accept|Reject) and go to next change$/ })).toHaveCount(0)

    // The inserted words also serve as the anchor for a reader in margin view.
    await expect(interpretation(observer).locator('.dm-review-insertion')).toHaveText('transpiration and')
    await expect(interpretation(observer).locator('.dm-review-point')).toHaveCount(0)
    expect(await interpretation(observer).locator('.dm-review-insertion').textContent()).toBe('transpiration and ')

    const toolbar = reader.locator('.topbar')
    const insertionId = await interpretation(author).getByRole('textbox', { name: 'Edit suggested wording' }).getAttribute('data-proposal-id')
    expect(insertionId).toBeTruthy()
    await toolbar.getByRole('button', { name: 'Accept and go to next change' }).click()
    await expect(reader.locator(`[data-review-balloon="${proposalId}"]`)).toHaveCount(0)
    await expect(readerPassage).toHaveText('The canopy retained slightly less water under shade.')
    await expect(interpretation(reader)).toBeInViewport()
    await reader.getByRole('button', { name: 'Review options', exact: true }).click()
    const viewOptions = reader.getByRole('dialog', { name: 'Review options' })
    await viewOptions.getByRole('button', { name: 'Final preview' }).click()
    await expect(interpretation(reader)).toContainText('transpiration and evaporation')
    await expect(interpretation(author).getByRole('textbox', { name: 'Edit suggested wording' })).toHaveValue('transpiration and ')
    await viewOptions.getByRole('button', { name: 'In text', exact: true }).click()
    await viewOptions.getByRole('button', { name: 'Close review options' }).click()
    await toolbar.getByRole('button', { name: 'Reject and go to next change' }).click()
    for (const page of [author, reader, observer]) {
      await expect(page.locator(`[data-review-balloon="${proposalId}"]`)).toHaveCount(0)
      await expect(page.locator(`[data-review-balloon="${insertionId}"]`)).toHaveCount(0)
      await expect(page.getByRole('group', { name: 'Review tracked changes' })).toBeHidden()
      await expect(passage(page)).toHaveText('The canopy retained slightly less water under shade.')
      await expect(passage(page).locator('.dm-review-wording, button.dm-review-proposal')).toHaveCount(0)
      await expect(interpretation(page)).toHaveText('The measurements reflect the balance between interception and evaporation.')
    }
    await author.getByRole('button', { name: 'Turn off track changes' }).click()
    const firstIntro = author.locator('.ProseMirror p').first()
    await selectRenderedTextWithMouse(author, firstIntro, 'leaves')
    await author.keyboard.type('stems')
    await expect(reader.locator('.ProseMirror p').first()).toContainText('water loss from stems')
    await reader.bringToFront()
    await reader.keyboard.press('ControlOrMeta+z')
    await expect(observer.locator(`[data-review-balloon="${insertionId}"]`)).toContainText('transpiration')
    await reader.keyboard.press('ControlOrMeta+z')
    await expect(observer.locator(`[data-review-balloon="${proposalId}"]`)).toContainText('slightly less')
    await expect(readerPassage).toContainText('more')
    await reader.keyboard.press('ControlOrMeta+Shift+z')
    await reader.keyboard.press('ControlOrMeta+Shift+z')
    await expect(authorPassage).toHaveText('The canopy retained slightly less water under shade.')
    await author.bringToFront()
    await selectRenderedTextWithMouse(author, authorPassage, 'slightly less')
    await author.keyboard.type('much less')
    await expect.poll(() => manuscriptText(readerPassage)).toBe('The canopy retained much less water under shade.')
    const lateReader = await shared.open('viewer')
    await expect.poll(() => manuscriptText(passage(lateReader))).toBe('The canopy retained much less water under shade.')
    await expect(interpretation(lateReader)).toHaveText('The measurements reflect the balance between interception and evaporation.')
    await expect(lateReader.locator('.ProseMirror p').first()).toContainText('water loss from stems')
    await expect(lateReader.locator('[data-review-balloon]')).toHaveCount(0)
  } finally {
    await shared.close()
  }
})

test('accepting immediately after typing includes the latest shared wording', async ({ browser, baseURL }) => {
  const shared = await startSharedManuscript(browser, baseURL!, '# Measurements\n\nWe recorded one mark.\n')
  try {
    const owner = await shared.open('owner')
    let watchingDecision = false
    let viewerUpdates = 0
    const peer = await shared.open('viewer', (page) => page.on('websocket', (socket) => {
      socket.on('framesent', ({ payload }) => {
        if (!watchingDecision || !Buffer.isBuffer(payload)) return
        const decoder = createDecoder(payload)
        readVarString(decoder) // Hocuspocus document routing key
        if (readVarUint(decoder) === 0 && readVarUint(decoder) === 2) viewerUpdates++ // incremental Yjs sync update
      })
    }))
    await owner.bringToFront()
    await owner.getByRole('button', { name: 'Turn on track changes' }).click()
    const passage = (page: Page) => page.locator('.ProseMirror p').filter({ hasText: 'We recorded one mark' })
    await selectRenderedTextWithMouse(owner, passage(owner), 'mark')
    await owner.keyboard.press('ArrowRight')
    await owner.keyboard.type('e')
    const field = passage(owner).getByRole('textbox', { name: 'Edit suggested wording' })
    await expect(field).toHaveValue('e')
    const accept = owner.getByRole('button', { name: 'Accept and go to next change' })
    await expect(accept).toBeVisible()
    await expect(passage(peer).locator('.dm-review-insertion')).toHaveText('e')
    watchingDecision = true
    // Take the normal toolbar action before the amendment's idle timer can publish.
    await accept.evaluate((button) => {
      document.addEventListener('input', () => queueMicrotask(() => (button as HTMLButtonElement).click()), { once: true })
    })
    await field.press('r')
    await expect.poll(() => manuscriptText(passage(owner))).toBe('We recorded one marker.')
    await expect.poll(() => manuscriptText(passage(peer))).toBe('We recorded one marker.')
    await expect(owner.locator('[data-review-balloon]')).toHaveCount(0)
    await expect(peer.locator('[data-review-balloon]')).toHaveCount(0)
    const latePeer = await shared.open('viewer')
    await expect(passage(latePeer)).toHaveText('We recorded one marker.')
    await expect(latePeer.locator('[data-review-balloon]')).toHaveCount(0)
    expect(viewerUpdates).toBe(0)
  } finally {
    await shared.close()
  }
})
