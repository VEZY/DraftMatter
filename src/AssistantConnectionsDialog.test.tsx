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
    expect(container.textContent).toContain('Codex is configured.')
    expect(container.textContent).toContain('Open a new chat in the enabled project folder')
    expect(container.textContent).not.toContain('Review changes')
  })

  it.each(['conflict', 'host error'])('shows the cause and recovery for a %s instead of opening the disconnect preview', async (failure) => {
    const stale = { ...connected, connected: false, mcpCurrent: false, recommendedAction: 'update' as const }
    vi.spyOn(desktopHost, 'assistantConnectionsStatus').mockResolvedValue({ ok: true, scope: 'device', clients: [stale] })
    const action = vi.spyOn(desktopHost, 'assistantConnectionAction')
    const message = 'Launch arguments changed. Review them and choose Reconnect.'
    if (failure === 'host error') action.mockRejectedValue({ kind: 'integration', message })
    else action.mockResolvedValue({ ok: false, scope: 'device', applied: false, results: [{
      client: 'codex', operation: 'update', statusBefore: stale, ok: false, applied: false,
      changes: [], conflicts: [{ kind: 'mcp-registration', action: 'conflict', path: 'config.toml', message }],
      guarantees: [], advancedCommand: 'draftmatter assistants update codex',
    }] })
    await act(async () => root.render(<AssistantConnectionsDialog open onClose={() => undefined} />))
    await flush()
    const button = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Connect')!
    await act(async () => button.click())
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(message)
    if (failure === 'conflict') expect(container.querySelector('[role="alert"]')?.textContent).toContain('config.toml')
    expect(container.textContent).not.toMatch(/\[object Object\]|Disconnect Codex\?/)
  })
})
