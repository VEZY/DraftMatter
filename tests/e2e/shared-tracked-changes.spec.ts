import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { AuthenticatedWorkspaceService } from '../../src/collaboration/workspaceService'
import { CollaborativeDocument } from '../../src/sharedEditor/collaboration'
import { FileCollaborationStore } from '../../services/collaboration/fileStore'
import { createDraftMatterHocuspocusServer } from '../../services/collaboration/hocuspocusServer'
import { selectRenderedTextWithMouse } from './rendered-selection'

test('two collaborators see one amended replacement and stay at the passage under review', async ({ browser, baseURL }, testInfo) => {
  test.setTimeout(60_000)
  const root = await mkdtemp(join(tmpdir(), 'draftmatter-browser-review-'))
  const authorization = new AuthenticatedWorkspaceService({ secret: randomBytes(32) })
  const owner = await authorization.createSessionForVerifiedIdentity({ userId: 'alice', sessionId: 'alice-browser' })
  const editor = await authorization.createSessionForVerifiedIdentity({ userId: 'bea', sessionId: 'bea-browser' })
  const workspace = await authorization.createWorkspace(owner, { id: 'forest', name: 'Field study' })
  await authorization.createProject(owner, 'forest', { id: 'water', name: 'Water in the canopy' })
  const invitation = await authorization.createInvitation(owner, 'forest', { role: 'editor' })
  await authorization.acceptInvitation(editor, invitation.token)
  const viewer = await authorization.createSessionForVerifiedIdentity({ userId: 'sam', sessionId: 'sam-browser' })
  const readOnlyInvite = await authorization.createInvitation(owner, 'forest', { role: 'viewer' })
  await authorization.acceptInvitation(viewer, readOnlyInvite.token)

  const source = [
    '# Water in the canopy', ...Array.from({ length: 24 }, (_, index) =>
      `## Plot ${index + 1}\n\nAt this site, the team recorded water loss from leaves throughout the season.`),
    '## Results', 'The canopy retained more water under shade.', '## Interpretation',
    'The measurements reflect the balance between interception and evaporation.',
  ].join('\n\n') + '\n'
  const persistence = new FileCollaborationStore({ root })
  const document = CollaborativeDocument.fromPortableSource(source)
  await persistence.createSnapshot({ workspaceId: 'forest', projectId: 'water' }, 'seed', document.encodeUpdate())
  document.destroy()
  const server = createDraftMatterHocuspocusServer({ address: '127.0.0.1', port: 0, authorization, persistence })
  const authorContext = await browser.newContext({ baseURL })
  const readerContext = await browser.newContext({ baseURL })
  try {
    await server.listen()
    const serviceUrl = server.webSocketURL.replace(/^ws:/, 'http:')
    const author = await authorContext.newPage()
    const reader = await readerContext.newPage()
    async function open(page: Page, token: string, userId: string, displayName: string) {
      const projects = await authorization.listProjects(token, 'forest')
      const workspaces = [{ ...workspace, role: projects[0].role }]
      const launch = { serviceUrl, token, profile: { userId, displayName }, workspaceId: 'forest', projectId: 'water', projects, workspaces }
      await page.addInitScript((value) => Object.assign(window, { sharedReviewLaunch: value }), launch)
      await page.route('**/api/workspaces/forest/projects', (route) => route.fulfill({ json: { projects } }))
      // The separate collaboration gateway is the only WebSocket under test.
      // Ignore Vite reloads so local source edits cannot remount an active editor.
      await page.routeWebSocket((url) => url.host === new URL(baseURL!).host, () => {})
      await page.goto('/tests/e2e/fixtures/shared-review.html')
      await expect(page.locator('.collaboration-toggle.connected')).toBeVisible()
    }
    await open(author, owner, 'alice', 'Alice Green')
    await open(reader, editor, 'bea', 'Bea Stone')
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

    const observer = await readerContext.newPage()
    await open(observer, viewer, 'sam', 'Sam Lee')
    await expect(observer.locator(`[data-review-balloon="${proposalId}"]`)).toContainText('slightly less')
    await expect(observer.getByRole('button', { name: /^(Accept|Reject) and go to next change$/ })).toHaveCount(0)

    const toolbar = reader.locator('.topbar')
    await toolbar.getByRole('button', { name: 'Accept and go to next change' }).click()
    const insertionId = await interpretation(author).getByRole('textbox', { name: 'Edit suggested wording' }).getAttribute('data-proposal-id')
    await expect(reader.locator(`[data-review-balloon="${proposalId}"]`)).toContainText(/accepted/i)
    await expect(interpretation(reader)).toBeInViewport()
    await toolbar.getByRole('button', { name: 'Reject and go to next change' }).click()
    for (const page of [author, reader]) {
      await expect(page.locator(`[data-review-balloon="${proposalId}"]`)).toContainText(/accepted/i)
      await expect(page.locator(`[data-review-balloon="${insertionId}"]`)).toContainText(/rejected/i)
      await expect(page.getByRole('group', { name: 'Review tracked changes' })).toBeHidden()
      await page.getByRole('button', { name: 'Review options', exact: true }).click()
      await page.getByLabel('Review display and preview').selectOption('final')
      await page.getByRole('button', { name: 'Close review options' }).click()
      await expect(passage(page)).toHaveText('The canopy retained slightly less water under shade.')
      await expect(passage(page).locator('.dm-review-wording, button.dm-review-proposal')).toHaveCount(0)
      await expect(interpretation(page)).toHaveText('The measurements reflect the balance between interception and evaporation.')
    }
  } finally {
    await Promise.all([authorContext.close(), readerContext.close()])
    await server.destroy()
    await rm(root, { recursive: true, force: true })
  }
})
