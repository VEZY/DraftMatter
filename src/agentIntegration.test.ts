import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  diagnoseDraftMatterAi,
  DRAFTMATTER_MCP_TOOLS,
  planDraftMatterAiIntegration,
} from './agentIntegration'

async function projectFixture() {
  const root = await mkdtemp(join(tmpdir(), 'draftmatter-ai-project-'))
  await mkdir(join(root, '.draftmatter'), { recursive: true })
  await writeFile(join(root, '.draftmatter', 'project.json'), `${JSON.stringify({
    schemaVersion: 1,
    name: 'AI adapter fixture',
    mainDocument: 'paper.qmd',
    citationStyle: 'draftmatter-author-date',
    citationLocale: 'en-US',
    citationBibliography: 'references.json',
    execution: { python: {}, r: {}, julia: {} },
  }, null, 2)}\n`)
  await writeFile(join(root, 'paper.qmd'), '# Existing manuscript\n')
  await writeFile(join(root, 'AGENTS.md'), '# Existing agent guidance\n\nKeep this exact line.\n')
  await writeFile(join(root, 'CLAUDE.md'), '# Existing Claude guidance\n\nKeep Claude context.\n')
  await writeFile(join(root, '.mcp.json'), `${JSON.stringify({
    mcpServers: {
      existing: { command: 'existing-tool', args: [] },
    },
    unrelated: true,
  }, null, 2)}\n`)
  await mkdir(join(root, '.github'), { recursive: true })
  await writeFile(join(root, '.github', 'mcp.json'), `${JSON.stringify({
    mcpServers: {
      existing: { type: 'local', command: 'existing-copilot-tool', args: [], tools: ['*'] },
    },
  }, null, 2)}\n`)
  await mkdir(join(root, '.codex'), { recursive: true })
  await writeFile(join(root, '.codex', 'config.toml'), 'sandbox_mode = "workspace-write"\n')
  await mkdir(join(root, '.vibe'), { recursive: true })
  await writeFile(join(root, '.vibe', 'config.toml'), 'active_model = "local"\n')
  return root
}

describe('DraftMatter AI project integration', () => {
  it('previews initialization without changing project files', async () => {
    const root = await projectFixture()
    const before = await readFile(join(root, 'AGENTS.md'), 'utf8')
    const result = await planDraftMatterAiIntegration({
      projectRoot: root,
      operation: 'init',
    })
    expect(result).toMatchObject({ ok: true, applied: false, target: 'common' })
    expect(result.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'AGENTS.md', action: 'update' }),
      expect.objectContaining({ path: '.agents/skills/draftmatter-authoring/SKILL.md', action: 'create' }),
    ]))
    expect(await readFile(join(root, 'AGENTS.md'), 'utf8')).toBe(before)
  })

  it('configures every client atomically while preserving unrelated content', async () => {
    const root = await projectFixture()
    const result = await planDraftMatterAiIntegration({
      projectRoot: root,
      operation: 'configure',
      target: 'all',
      apply: true,
    })
    expect(result).toMatchObject({ ok: true, applied: true, target: 'all' })
    expect(result.transactionId).toBeTruthy()

    const agents = await readFile(join(root, 'AGENTS.md'), 'utf8')
    expect(agents).toContain('Keep this exact line.')
    expect(agents).toContain('draftmatter-ai:start')
    const claude = await readFile(join(root, 'CLAUDE.md'), 'utf8')
    expect(claude).toContain('Keep Claude context.')
    expect(claude).toContain('@AGENTS.md')
    const claudeMcp = JSON.parse(await readFile(join(root, '.mcp.json'), 'utf8'))
    expect(claudeMcp.unrelated).toBe(true)
    expect(claudeMcp.mcpServers.existing.command).toBe('existing-tool')
    expect(claudeMcp.mcpServers.draftmatter).toMatchObject({ command: 'draftmatter' })
    const copilotMcp = JSON.parse(await readFile(join(root, '.github', 'mcp.json'), 'utf8'))
    expect(copilotMcp.mcpServers.existing.command).toBe('existing-copilot-tool')
    expect(copilotMcp.mcpServers.draftmatter).toMatchObject({ type: 'local', command: 'draftmatter' })
    expect(await readFile(join(root, '.codex', 'config.toml'), 'utf8')).toContain('sandbox_mode = "workspace-write"')
    expect(await readFile(join(root, '.vibe', 'config.toml'), 'utf8')).toContain('active_model = "local"')
    expect(await readFile(join(root, '.agents', 'skills', 'draftmatter-authoring', 'SKILL.md'), 'utf8')).toContain('name: draftmatter-authoring')
    expect(await readFile(join(root, '.claude', 'skills', 'draftmatter-authoring', 'SKILL.md'), 'utf8')).toContain('name: draftmatter-authoring')
    expect(await readFile(join(root, '.vibe', 'skills', 'draftmatter-authoring', 'SKILL.md'), 'utf8')).toContain('name: draftmatter-authoring')

    const manifest = JSON.parse(await readFile(join(root, '.draftmatter', 'ai-integration.json'), 'utf8'))
    expect(manifest.configuredClients).toEqual(['claude', 'codex', 'copilot', 'vibe'])
    expect(manifest.protocolVersion).toBe('1.0')
  })

  it('diagnoses generated guidance and discovers the six tools through the SDK', async () => {
    const root = await projectFixture()
    await planDraftMatterAiIntegration({
      projectRoot: root,
      operation: 'configure',
      target: 'all',
      apply: true,
    })
    const previousPath = process.env.PATH
    process.env.PATH = ''
    const result = await diagnoseDraftMatterAi(root).finally(() => {
      process.env.PATH = previousPath
    })
    expect(result.ok).toBe(false)
    expect(result.executable.status).toBe('problem')
    expect(result.mcp).toMatchObject({ status: 'ok', tools: [...DRAFTMATTER_MCP_TOOLS] })
    expect(result.runtime.execution).toBeDefined()
    expect(result.files.agents.status).toBe('ok')
    expect(result.clients.claude.adapter.status).toBe('ok')
    expect(result.project.executionTrust.trusted).toBe(false)
  })

  it('removes only DraftMatter-managed content and retains other settings', async () => {
    const root = await projectFixture()
    await planDraftMatterAiIntegration({
      projectRoot: root,
      operation: 'configure',
      target: 'all',
      apply: true,
    })
    const result = await planDraftMatterAiIntegration({
      projectRoot: root,
      operation: 'remove',
      target: 'all',
      apply: true,
    })
    expect(result).toMatchObject({ ok: true, applied: true })
    expect(await readFile(join(root, 'AGENTS.md'), 'utf8')).toBe('# Existing agent guidance\n\nKeep this exact line.\n')
    expect(await readFile(join(root, 'CLAUDE.md'), 'utf8')).toBe('# Existing Claude guidance\n\nKeep Claude context.\n')
    const claudeMcp = JSON.parse(await readFile(join(root, '.mcp.json'), 'utf8'))
    expect(claudeMcp).toEqual({
      mcpServers: { existing: { command: 'existing-tool', args: [] } },
      unrelated: true,
    })
    const copilotMcp = JSON.parse(await readFile(join(root, '.github', 'mcp.json'), 'utf8'))
    expect(copilotMcp.mcpServers).toEqual({
      existing: { type: 'local', command: 'existing-copilot-tool', args: [], tools: ['*'] },
    })
    expect(await readFile(join(root, '.codex', 'config.toml'), 'utf8')).toBe('sandbox_mode = "workspace-write"\n')
    expect(await readFile(join(root, '.vibe', 'config.toml'), 'utf8')).toBe('active_model = "local"\n')
    await expect(readFile(join(root, '.draftmatter', 'ai-integration.json'), 'utf8')).rejects.toThrow()
    await expect(readFile(join(root, '.agents', 'skills', 'draftmatter-authoring', 'SKILL.md'), 'utf8')).rejects.toThrow()
  })

  it('fails closed without partial writes when a generated skill was edited', async () => {
    const root = await projectFixture()
    await planDraftMatterAiIntegration({
      projectRoot: root,
      operation: 'configure',
      target: 'all',
      apply: true,
    })
    const agentsBefore = await readFile(join(root, 'AGENTS.md'), 'utf8')
    const skillPath = join(root, '.agents', 'skills', 'draftmatter-authoring', 'SKILL.md')
    await writeFile(skillPath, `${await readFile(skillPath, 'utf8')}\nLocal edit.\n`)
    const result = await planDraftMatterAiIntegration({
      projectRoot: root,
      operation: 'remove',
      target: 'all',
      apply: true,
    })
    expect(result).toMatchObject({ ok: false, applied: false })
    expect(result.conflicts).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: '.agents/skills/draftmatter-authoring/SKILL.md', action: 'conflict' }),
    ]))
    expect(await readFile(join(root, 'AGENTS.md'), 'utf8')).toBe(agentsBefore)
    expect(await readFile(skillPath, 'utf8')).toContain('Local edit.')
  })
})
