import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import {
  diagnoseDraftMatterAi,
  DRAFTMATTER_MCP_TOOLS,
  planDraftMatterAiIntegration,
} from './agentIntegration'
import { createDraftMatterMcpServer } from './agentMcpServer'

async function projectFixture() {
  const root = await mkdtemp(join(tmpdir(), 'draftmatter-ai-project-'))
  await mkdir(join(root, '.draftmatter'), { recursive: true })
  await writeFile(join(root, '.draftmatter', 'project.json'), `${JSON.stringify({
    schemaVersion: 1,
    name: 'AI project fixture',
    mainDocument: 'paper.qmd',
    citationStyle: 'draftmatter-author-date',
    citationLocale: 'en-US',
    citationBibliography: 'references.json',
    execution: { python: {}, r: {}, julia: {} },
  }, null, 2)}\n`)
  await writeFile(join(root, 'paper.qmd'), '# Existing manuscript\n')
  await writeFile(join(root, 'AGENTS.md'), '# Existing agent guidance\n\nKeep this exact line.\n')
  await writeFile(join(root, 'CLAUDE.md'), '# Existing Claude guidance\n\nKeep Claude context.\n')
  return root
}

describe('DraftMatter project AI enablement', () => {
  it('previews enablement without changing project files', async () => {
    const root = await projectFixture()
    const before = await readFile(join(root, 'AGENTS.md'), 'utf8')
    const result = await planDraftMatterAiIntegration({ projectRoot: root, operation: 'enable' })
    expect(result).toMatchObject({ ok: true, applied: false, operation: 'enable', schemaVersion: 2 })
    expect(result.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'AGENTS.md', action: 'update' }),
      expect.objectContaining({ path: '.agents/skills/draftmatter-authoring/SKILL.md', action: 'create' }),
      expect.objectContaining({ path: '.draftmatter/ai-integration.json', action: 'create' }),
    ]))
    expect(await readFile(join(root, 'AGENTS.md'), 'utf8')).toBe(before)
  })

  it('enables only project instructions, manifest, and the optional portable skill', async () => {
    const root = await projectFixture()
    const result = await planDraftMatterAiIntegration({
      projectRoot: root,
      operation: 'enable',
      apply: true,
    })
    expect(result).toMatchObject({ ok: true, applied: true, portableSkillFallback: true })
    expect(result.transactionId).toBeTruthy()
    expect(await readFile(join(root, 'AGENTS.md'), 'utf8')).toContain('globally installed `draftmatter-authoring` skill')
    expect(await readFile(join(root, 'CLAUDE.md'), 'utf8')).toContain('@AGENTS.md')
    expect(await readFile(join(root, '.agents', 'skills', 'draftmatter-authoring', 'SKILL.md'), 'utf8')).toContain('name: draftmatter-authoring')
    const manifest = JSON.parse(await readFile(join(root, '.draftmatter', 'ai-integration.json'), 'utf8'))
    expect(manifest).toMatchObject({
      schemaVersion: 2,
      enabled: true,
      localAdapters: [],
      skill: { discovery: 'global', portableFallback: true },
    })
    await expect(readFile(join(root, '.mcp.json'), 'utf8')).rejects.toThrow()
    await expect(readFile(join(root, '.codex', 'config.toml'), 'utf8')).rejects.toThrow()
  })

  it('rejects MCP startup until the project is enabled and then pins it', async () => {
    const root = await projectFixture()
    await expect(createDraftMatterMcpServer(root)).rejects.toThrow('has not enabled AI integration')
    await planDraftMatterAiIntegration({ projectRoot: root, operation: 'enable', apply: true })
    const connection = await createDraftMatterMcpServer(root)
    expect(connection.root).toBe(await realpath(root))
    await connection.server.close()
  })

  it('resolves a global MCP launch from cwd and rejects later root injection', async () => {
    const root = await projectFixture()
    const otherRoot = await projectFixture()
    await planDraftMatterAiIntegration({ projectRoot: root, operation: 'enable', apply: true })
    await planDraftMatterAiIntegration({ projectRoot: otherRoot, operation: 'enable', apply: true })
    const previousCwd = process.cwd()
    process.chdir(root)
    try {
      const connection = await createDraftMatterMcpServer()
      expect(connection.root).toBe(await realpath(root))
      const client = new Client({ name: 'root-pinning-test', version: '1.0.0' })
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
      await connection.server.connect(serverTransport)
      await client.connect(clientTransport)
      const injected = await client.callTool({
        name: 'draftmatter_project',
        arguments: { action: 'inspect', projectRoot: otherRoot },
      })
      expect(injected).toMatchObject({ isError: true })
      expect(injected.content).toEqual(expect.arrayContaining([
        expect.objectContaining({ text: expect.stringContaining('Unrecognized key') }),
      ]))
      const inspection = await client.callTool({
        name: 'draftmatter_project',
        arguments: { action: 'inspect' },
      })
      expect((inspection.structuredContent as { result?: { project?: { root?: string } } }).result?.project?.root).not.toBe(await realpath(otherRoot))
      await client.close()
      await connection.server.close()
    } finally {
      process.chdir(previousCwd)
    }
  })

  it('diagnoses an enabled project and discovers the six semantic tools', async () => {
    const root = await projectFixture()
    await planDraftMatterAiIntegration({ projectRoot: root, operation: 'enable', apply: true })
    const result = await diagnoseDraftMatterAi(root)
    expect(result.ok).toBe(true)
    expect(result.mcp).toMatchObject({ status: 'ok', tools: [...DRAFTMATTER_MCP_TOOLS] })
    expect(result.project.aiEnabled).toBe(true)
    expect(result.project.executionTrust.trusted).toBe(false)
    expect(result.project.networkAccess.approved).toBe(false)
  })

  it('migrates legacy project adapters while preserving unrelated configuration', async () => {
    const root = await projectFixture()
    await mkdir(join(root, '.codex'), { recursive: true })
    await writeFile(join(root, '.codex', 'config.toml'), `sandbox_mode = "workspace-write"

# draftmatter-ai:start
[mcp_servers.draftmatter]
command = "draftmatter"
args = ["mcp", "--stdio", "--project-root", "."]
# draftmatter-ai:end
`)
    await writeFile(join(root, '.mcp.json'), `${JSON.stringify({
      unrelated: true,
      mcpServers: {
        existing: { command: 'existing-tool', args: [] },
        draftmatter: { command: 'draftmatter', args: ['mcp', '--stdio', '--project-root', '.'] },
      },
    }, null, 2)}\n`)
    await writeFile(join(root, '.draftmatter', 'ai-integration.json'), `${JSON.stringify({
      schemaVersion: 1,
      protocolVersion: '1.0',
      configuredClients: ['codex', 'claude'],
      files: [],
    }, null, 2)}\n`)

    const result = await planDraftMatterAiIntegration({ projectRoot: root, operation: 'update', apply: true })
    expect(result.ok).toBe(true)
    expect(await readFile(join(root, '.codex', 'config.toml'), 'utf8')).toBe('sandbox_mode = "workspace-write"\n')
    expect(JSON.parse(await readFile(join(root, '.mcp.json'), 'utf8'))).toEqual({
      unrelated: true,
      mcpServers: { existing: { command: 'existing-tool', args: [] } },
    })
    const manifest = JSON.parse(await readFile(join(root, '.draftmatter', 'ai-integration.json'), 'utf8'))
    expect(manifest.schemaVersion).toBe(2)
    expect(manifest).not.toHaveProperty('configuredClients')
  })

  it('does not treat unowned project-local client files as migration targets', async () => {
    const root = await projectFixture()
    const manualAdapter = `${JSON.stringify({
      note: 'Maintained by the project team',
      mcpServers: {
        draftmatter: { command: 'draftmatter', args: ['mcp', '--stdio', '--project-root', '.'] },
      },
    }, null, 2)}\n`
    await writeFile(join(root, '.mcp.json'), manualAdapter)

    const result = await planDraftMatterAiIntegration({
      projectRoot: root,
      operation: 'enable',
      apply: true,
    })

    expect(result.ok).toBe(true)
    expect(await readFile(join(root, '.mcp.json'), 'utf8')).toBe(manualAdapter)
  })

  it('disables reversibly without changing manuscript content or unrelated instructions', async () => {
    const root = await projectFixture()
    const manuscriptBefore = await readFile(join(root, 'paper.qmd'), 'utf8')
    await planDraftMatterAiIntegration({ projectRoot: root, operation: 'enable', apply: true })
    const result = await planDraftMatterAiIntegration({ projectRoot: root, operation: 'disable', apply: true })
    expect(result).toMatchObject({ ok: true, applied: true })
    expect(await readFile(join(root, 'paper.qmd'), 'utf8')).toBe(manuscriptBefore)
    expect(await readFile(join(root, 'AGENTS.md'), 'utf8')).toBe('# Existing agent guidance\n\nKeep this exact line.\n')
    expect(await readFile(join(root, 'CLAUDE.md'), 'utf8')).toBe('# Existing Claude guidance\n\nKeep Claude context.\n')
    await expect(readFile(join(root, '.draftmatter', 'ai-integration.json'), 'utf8')).rejects.toThrow()
    await expect(createDraftMatterMcpServer(root)).rejects.toThrow('has not enabled AI integration')
  })

  it('fails closed without partial writes when a portable skill was edited', async () => {
    const root = await projectFixture()
    await planDraftMatterAiIntegration({ projectRoot: root, operation: 'enable', apply: true })
    const agentsBefore = await readFile(join(root, 'AGENTS.md'), 'utf8')
    const skillPath = join(root, '.agents', 'skills', 'draftmatter-authoring', 'SKILL.md')
    await writeFile(skillPath, `${await readFile(skillPath, 'utf8')}\nLocal edit.\n`)
    const result = await planDraftMatterAiIntegration({ projectRoot: root, operation: 'disable', apply: true })
    expect(result).toMatchObject({ ok: false, applied: false })
    expect(result.conflicts).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: '.agents/skills/draftmatter-authoring/SKILL.md', action: 'conflict' }),
    ]))
    expect(await readFile(join(root, 'AGENTS.md'), 'utf8')).toBe(agentsBefore)
  })
})
