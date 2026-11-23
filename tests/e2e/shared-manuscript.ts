import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, type Browser, type BrowserContext } from '@playwright/test'
import { AuthenticatedWorkspaceService } from '../../src/collaboration/workspaceService'
import { CollaborativeDocument } from '../../src/sharedEditor/collaboration'
import { FileCollaborationStore } from '../../services/collaboration/fileStore'
import { createDraftMatterHocuspocusServer } from '../../services/collaboration/hocuspocusServer'

export async function startSharedManuscript(browser: Browser, baseURL: string, source: string) {
  const root = await mkdtemp(join(tmpdir(), 'draftmatter-browser-project-'))
  const authorization = new AuthenticatedWorkspaceService({ secret: randomBytes(32) })
  const workspaceId = 'forest', projectId = 'water'
  const accounts = {
    owner: { userId: 'alice', displayName: 'Alice Green' },
    editor: { userId: 'bea', displayName: 'Bea Stone' },
    viewer: { userId: 'sam', displayName: 'Sam Lee' },
  }
  const persistence = new FileCollaborationStore({ root })
  const server = createDraftMatterHocuspocusServer({ address: '127.0.0.1', port: 0, authorization, persistence })
  const contexts: BrowserContext[] = []
  async function close() {
    await Promise.all(contexts.map((context) => context.close()))
    await server.destroy()
    await rm(root, { recursive: true, force: true })
  }
  const session = (userId: string) => authorization.createSessionForVerifiedIdentity({ userId, sessionId: userId + '-browser' })
  try {
    const tokens = { owner: await session('alice'), editor: await session('bea'), viewer: await session('sam') }
    const workspace = await authorization.createWorkspace(tokens.owner, { id: workspaceId, name: 'Field study' })
    await authorization.createProject(tokens.owner, workspaceId, { id: projectId, name: 'Water in the canopy' })
    for (const role of ['editor', 'viewer'] as const) {
      const invitation = await authorization.createInvitation(tokens.owner, workspaceId, { role })
      await authorization.acceptInvitation(tokens[role], invitation.token)
    }
    const document = CollaborativeDocument.fromPortableSource(source)
    try {
      await persistence.createSnapshot({ workspaceId, projectId }, 'seed', document.encodeUpdate())
    } finally {
      document.destroy()
    }
    await server.listen()
    const serviceUrl = server.webSocketURL.replace(/^ws:/, 'http:')
    async function open(role: keyof typeof accounts) {
      const token = tokens[role]
      const projects = await authorization.listProjects(token, workspaceId)
      const workspaces = [{ ...workspace, role: projects[0].role }]
      const launch = { serviceUrl, token, profile: accounts[role], workspaceId, projectId, projects, workspaces }
      const context = await browser.newContext({ baseURL })
      contexts.push(context)
      const page = await context.newPage()
      await page.addInitScript((value) => Object.assign(window, { sharedReviewLaunch: value }), launch)
      await page.route('**/api/workspaces/forest/projects', (route) => route.fulfill({ json: { projects } }))
      // Only the authenticated collaboration socket should affect this editing session.
      await page.routeWebSocket((url) => url.host === new URL(baseURL).host, () => {})
      await page.goto('/tests/e2e/fixtures/shared-review.html')
      await expect(page.locator('.collaboration-toggle.connected')).toBeVisible()
      return page
    }
    return { open, close }
  } catch (error) {
    await close()
    throw error
  }
}
