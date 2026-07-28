// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AssistantConnectionsDialog } from './AssistantConnectionsDialog'
import { desktopHost, type AssistantConnectionStatus } from './desktopHost'

const disconnected: AssistantConnectionStatus = {
  client: 'codex',
  name: 'Codex',
  detected: true,
  executable: '/Applications/Codex.app',
  connected: false,
  mcpInstalled: false,
  mcpCurrent: false,
  skillInstalled: false,
  skillCurrent: false,
  registrationScope: 'user',
  registrationMethod: 'codex-plugin',
  projectLocalRequired: false,
  recommendedAction: 'install',
  configPath: '/Users/researcher/.agents/plugins/draftmatter/.mcp.json',
  skillPath: '/Users/researcher/.agents/plugins/draftmatter/skills/draftmatter-authoring',
  notes: [],
}

const connected: AssistantConnectionStatus = {
  ...disconnected,
  connected: true,
  mcpInstalled: true,
  mcpCurrent: true,
  skillInstalled: true,
  skillCurrent: true,
  recommendedAction: 'none',
}

async function flush() {
  await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 0)) })
}

describe('assistant connection setup', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>

  beforeEach(() => {
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.restoreAllMocks()
  })

  it('connects in one action and explains the one-time assistant refresh', async () => {
    vi.spyOn(desktopHost, 'assistantConnectionsStatus')
      .mockResolvedValueOnce({ ok: true, scope: 'device', clients: [disconnected] })
      .mockResolvedValueOnce({ ok: true, scope: 'device', clients: [connected] })
    const action = vi.spyOn(desktopHost, 'assistantConnectionAction').mockResolvedValue({
      ok: true,
      scope: 'device',
      applied: true,
      results: [{
        client: 'codex',
        operation: 'install',
        applied: true,
        ok: true,
        statusBefore: disconnected,
        statusAfter: connected,
        changes: [],
        conflicts: [],
        guarantees: [],
        advancedCommand: 'draftmatter assistants install codex',
      }],
    })

    await act(async () => root.render(
      <AssistantConnectionsDialog open onClose={() => undefined} />,
    ))
    await flush()

    expect(container.textContent).toContain('DraftMatter sets up the connection automatically.')
    const connect = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === 'Connect')!
    await act(async () => connect.click())
    await flush()

    expect(action).toHaveBeenCalledWith('codex', 'install', true)
    expect(container.textContent).toContain('Codex is connected.')
    expect(container.textContent).toContain('reopen it once')
    expect(container.textContent).not.toContain('Review changes')
  })
})
