import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { inspectAssistantConnections, planAssistantConnection } from './assistantIntegration'

async function fixture() {
  const homeDir = await mkdtemp(join(tmpdir(), 'draftmatter-assistants-'))
  const bundledCommand = join(homeDir, 'DraftMatter.app', 'draftmatter-mcp')
  await mkdir(join(homeDir, '.codex'), { recursive: true })
  await writeFile(join(homeDir, '.codex', 'config.toml'), 'sandbox_mode = "workspace-write"\n')
  await writeFile(join(homeDir, '.claude.json'), `${JSON.stringify({
    unrelated: true,
    mcpServers: { existing: { command: 'existing', args: [] } },
  }, null, 2)}\n`)
  await mkdir(join(homeDir, '.copilot'), { recursive: true })
  await writeFile(join(homeDir, '.copilot', 'mcp-config.json'), `${JSON.stringify({
    mcpServers: { existing: { type: 'local', command: 'existing', args: [], tools: ['*'] } },
  }, null, 2)}\n`)
  await mkdir(join(homeDir, '.vibe'), { recursive: true })
  await writeFile(join(homeDir, '.vibe', 'config.toml'), 'active_model = "local"\n')
  return { homeDir, bundledCommand, path: '' }
}

describe('device-wide assistant connections', () => {
  it('reports detection and connection independently', async () => {
    const options = await fixture()
    const statuses = await inspectAssistantConnections(options)
    expect(statuses).toHaveLength(4)
    expect(statuses.every((status) => !status.detected && !status.connected)).toBe(true)
    expect(statuses.every((status) => status.registrationScope === 'user')).toBe(true)
  })

  it('previews without writing and installs the bundled MCP registration plus global skill', async () => {
    const options = await fixture()
    const preview = await planAssistantConnection({ ...options, client: 'claude', operation: 'install' })
    expect(preview).toMatchObject({ ok: true, applied: false })
    expect(JSON.parse(await readFile(join(options.homeDir, '.claude.json'), 'utf8'))).not.toHaveProperty('mcpServers.draftmatter')

    const installed = await planAssistantConnection({ ...options, client: 'claude', operation: 'install', apply: true })
    expect(installed.statusAfter).toMatchObject({ connected: true, mcpCurrent: true, skillCurrent: true })
    const config = JSON.parse(await readFile(join(options.homeDir, '.claude.json'), 'utf8'))
    expect(config.unrelated).toBe(true)
    expect(config.mcpServers.existing.command).toBe('existing')
    expect(config.mcpServers.draftmatter).toEqual({
      command: options.bundledCommand,
      args: ['mcp', '--stdio'],
    })
    expect(await readFile(join(options.homeDir, '.claude', 'skills', 'draftmatter-authoring', 'SKILL.md'), 'utf8')).toContain('name: draftmatter-authoring')
  })

  it('registers all supported clients at user scope without project-local files', async () => {
    const options = await fixture()
    for (const client of ['codex', 'claude', 'copilot', 'vibe'] as const) {
      const result = await planAssistantConnection({ ...options, client, operation: 'install', apply: true })
      expect(result.ok).toBe(true)
      expect(result.statusAfter?.connected).toBe(true)
      expect(result.statusAfter?.projectLocalRequired).toBe(false)
    }
    expect(await readFile(join(options.homeDir, '.codex', 'config.toml'), 'utf8')).toContain('[mcp_servers.draftmatter]')
    expect(await readFile(join(options.homeDir, '.vibe', 'config.toml'), 'utf8')).toContain('name = "draftmatter"')
  })

  it('uses the Codex plugin when plugin management is available', async () => {
    const options = await fixture()
    const marketplace = join(options.homeDir, '.agents', 'plugins', 'marketplace.json')
    await mkdir(join(options.homeDir, '.agents', 'plugins'), { recursive: true })
    await writeFile(marketplace, `${JSON.stringify({
      name: 'personal',
      plugins: [{ name: 'existing', source: { source: 'local', path: './plugins/existing' } }],
    }, null, 2)}\n`)
    const applyCodexPlugin = vi.fn(async () => undefined)
    const pluginOptions = {
      ...options,
      codexPluginAvailable: true,
      codexPluginInstalled: false,
      applyCodexPlugin,
    }

    const preview = await planAssistantConnection({
      ...pluginOptions,
      client: 'codex',
      operation: 'install',
    })
    expect(preview.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'plugin', action: 'create' }),
      expect.objectContaining({ kind: 'mcp-registration', action: 'create' }),
    ]))
    expect(await readFile(join(options.homeDir, '.codex', 'config.toml'), 'utf8')).not.toContain('draftmatter')

    const installed = await planAssistantConnection({
      ...pluginOptions,
      client: 'codex',
      operation: 'install',
      apply: true,
    })
    expect(installed.statusAfter).toMatchObject({
      connected: true,
      registrationMethod: 'codex-plugin',
    })
    expect(applyCodexPlugin).toHaveBeenCalledWith('install')
    const pluginRoot = join(options.homeDir, '.agents', 'plugins', 'plugins', 'draftmatter')
    expect(JSON.parse(await readFile(join(pluginRoot, '.mcp.json'), 'utf8'))).toEqual({
      mcpServers: {
        draftmatter: {
          command: options.bundledCommand,
          args: ['mcp', '--stdio'],
        },
      },
    })
    expect(JSON.parse(await readFile(marketplace, 'utf8')).plugins).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'existing' }),
      expect.objectContaining({ name: 'draftmatter' }),
    ]))

    const removed = await planAssistantConnection({
      ...pluginOptions,
      codexPluginInstalled: true,
      client: 'codex',
      operation: 'remove',
      apply: true,
    })
    expect(removed.statusAfter?.connected).toBe(false)
    expect(applyCodexPlugin).toHaveBeenLastCalledWith('remove')
    expect(JSON.parse(await readFile(marketplace, 'utf8')).plugins).toEqual([
      expect.objectContaining({ name: 'existing' }),
    ])
  })

  it('repairs a stale managed registration only after an explicit Repair preview', async () => {
    const options = await fixture()
    await planAssistantConnection({ ...options, client: 'copilot', operation: 'install', apply: true })
    const path = join(options.homeDir, '.copilot', 'mcp-config.json')
    const config = JSON.parse(await readFile(path, 'utf8'))
    config.mcpServers.draftmatter.command = '/stale/draftmatter'
    await writeFile(path, `${JSON.stringify(config, null, 2)}\n`)

    const update = await planAssistantConnection({ ...options, client: 'copilot', operation: 'update', apply: true })
    expect(update).toMatchObject({ ok: false, applied: false })
    const repair = await planAssistantConnection({ ...options, client: 'copilot', operation: 'repair', apply: true })
    expect(repair).toMatchObject({ ok: true, applied: true })
    expect(repair.statusAfter?.connected).toBe(true)
  })

  it('updates a prior managed registration when the bundled app path changes', async () => {
    const options = await fixture()
    await planAssistantConnection({ ...options, client: 'vibe', operation: 'install', apply: true })
    const movedBundle = join(options.homeDir, 'DraftMatter 2.app', 'draftmatter-mcp')
    const updated = await planAssistantConnection({
      ...options,
      bundledCommand: movedBundle,
      client: 'vibe',
      operation: 'update',
      apply: true,
    })
    expect(updated).toMatchObject({ ok: true, applied: true })
    expect(updated.statusAfter?.connected).toBe(true)
    expect(await readFile(join(options.homeDir, '.vibe', 'config.toml'), 'utf8'))
      .toContain(`command = ${JSON.stringify(movedBundle)}`)
  })

  it('keeps a PATH-resolved development launcher while preserving its script argument', async () => {
    const options = await fixture()
    const script = join(options.homeDir, 'dist-cli', 'draftmatter.js')
    await planAssistantConnection({
      ...options,
      bundledCommand: 'node',
      bundledArgs: [script],
      client: 'claude',
      operation: 'install',
      apply: true,
    })

    const config = JSON.parse(await readFile(join(options.homeDir, '.claude.json'), 'utf8'))
    expect(config.mcpServers.draftmatter).toEqual({
      command: 'node',
      args: [script, 'mcp', '--stdio'],
    })
  })

  it('removes only DraftMatter entries and leaves unrelated configuration intact', async () => {
    const options = await fixture()
    await planAssistantConnection({ ...options, client: 'claude', operation: 'install', apply: true })
    const removed = await planAssistantConnection({ ...options, client: 'claude', operation: 'remove', apply: true })
    expect(removed).toMatchObject({ ok: true, applied: true })
    expect(JSON.parse(await readFile(join(options.homeDir, '.claude.json'), 'utf8'))).toEqual({
      unrelated: true,
      mcpServers: { existing: { command: 'existing', args: [] } },
    })
    expect(removed.guarantees).toEqual(expect.arrayContaining([
      expect.stringContaining('No model was contacted'),
      expect.stringContaining('No manuscript code was executed'),
    ]))
  })
})
