import skillBody from '../integrations/skills/draftmatter-authoring/SKILL.md?raw'
import skillMetadata from '../integrations/skills/draftmatter-authoring/agents/openai.yaml?raw'
import skillExamples from '../integrations/skills/draftmatter-authoring/references/examples.md?raw'
import skillProtocol from '../integrations/skills/draftmatter-authoring/references/protocol.md?raw'
import pluginIcon from '../integrations/plugins/draftmatter/assets/icon.svg?raw'
import pluginReadme from '../integrations/plugins/draftmatter/README.md?raw'
import licenseText from '../LICENSE?raw'
import packageMetadata from '../package.json'
import { access, mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { delimiter, dirname, extname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { sha256 } from './kernelExecution'
import { DRAFTMATTER_AGENT_SKILL } from './agentProjectEnablement'

export type DraftMatterAssistantClient = 'codex' | 'claude' | 'copilot' | 'vibe'
export type AssistantConnectionOperation = 'install' | 'update' | 'repair' | 'remove'

export interface AssistantConnectionChange {
  path: string
  action: 'create' | 'update' | 'delete' | 'unchanged' | 'conflict'
  kind: 'mcp-registration' | 'skill' | 'plugin' | 'receipt'
  message: string
}

export interface AssistantConnectionStatus {
  client: DraftMatterAssistantClient
  name: string
  detected: boolean
  executable?: string
  connected: boolean
  mcpInstalled: boolean
  mcpCurrent: boolean
  skillInstalled: boolean
  skillCurrent: boolean
  registrationScope: 'user'
  registrationMethod: 'codex-plugin' | 'global-config'
  projectLocalRequired: boolean
  recommendedAction: 'install' | 'update' | 'repair' | 'remove' | 'none'
  configPath: string
  skillPath: string
  notes: string[]
}

export interface AssistantConnectionPlan {
  ok: boolean
  operation: AssistantConnectionOperation
  client: DraftMatterAssistantClient
  applied: boolean
  statusBefore: AssistantConnectionStatus
  statusAfter?: AssistantConnectionStatus
  changes: AssistantConnectionChange[]
  conflicts: AssistantConnectionChange[]
  guarantees: string[]
  advancedCommand: string
}

interface AssistantDefinition {
  name: string
  executable: string
  configPath(home: string): string
  skillPath(home: string): string
  configKind: 'toml-codex' | 'json-claude' | 'json-copilot' | 'toml-vibe'
  registrationMethod: AssistantConnectionStatus['registrationMethod']
}

interface AssistantIntegrationOptions {
  homeDir?: string
  bundledCommand: string
  bundledArgs?: string[]
  path?: string
  codexPluginAvailable?: boolean
  codexPluginInstalled?: boolean
  applyCodexPlugin?: (operation: AssistantConnectionOperation) => Promise<void>
}

interface FileChange {
  path: string
  content: string | null
  current: string | undefined
  plan: AssistantConnectionChange
}

interface AssistantConnectionReceipt {
  schemaVersion: 1
  client: DraftMatterAssistantClient
  draftmatterVersion: string
  bundledCommand: string
  bundledArgs: string[]
  registrationMethod?: AssistantConnectionStatus['registrationMethod']
  configPath: string
  configRevision: string | null
  skillPath: string
  files: Array<{ path: string; revision: string | null }>
}

const CLIENTS: DraftMatterAssistantClient[] = ['codex', 'claude', 'copilot', 'vibe']
const TOML_START = '# draftmatter-assistant:start'
const TOML_END = '# draftmatter-assistant:end'
const RECEIPT_SCHEMA = 1

const DEFINITIONS: Record<DraftMatterAssistantClient, AssistantDefinition> = {
  codex: {
    name: 'Codex',
    executable: 'codex',
    configPath: (home) => join(home, '.codex', 'config.toml'),
    skillPath: (home) => join(home, '.codex', 'skills', DRAFTMATTER_AGENT_SKILL),
    configKind: 'toml-codex',
    registrationMethod: 'codex-plugin',
  },
  claude: {
    name: 'Claude Code',
    executable: 'claude',
    configPath: (home) => join(home, '.claude.json'),
    skillPath: (home) => join(home, '.claude', 'skills', DRAFTMATTER_AGENT_SKILL),
    configKind: 'json-claude',
    registrationMethod: 'global-config',
  },
  copilot: {
    name: 'GitHub Copilot',
    executable: 'copilot',
    configPath: (home) => join(home, '.copilot', 'mcp-config.json'),
    skillPath: (home) => join(home, '.copilot', 'skills', DRAFTMATTER_AGENT_SKILL),
    configKind: 'json-copilot',
    registrationMethod: 'global-config',
  },
  vibe: {
    name: 'Mistral Vibe',
    executable: 'vibe',
    configPath: (home) => join(home, '.vibe', 'config.toml'),
    skillPath: (home) => join(home, '.vibe', 'skills', DRAFTMATTER_AGENT_SKILL),
    configKind: 'toml-vibe',
    registrationMethod: 'global-config',
  },
}

const SKILL_FILES: Record<string, string> = {
  'SKILL.md': skillBody,
  'agents/openai.yaml': skillMetadata,
  'references/examples.md': skillExamples,
  'references/protocol.md': skillProtocol,
}

function normalizedText(content: string) {
  return content.endsWith('\n') ? content : `${content}\n`
}

function stableJson(value: unknown) {
  return `${JSON.stringify(value, null, 2)}\n`
}

function tomlString(value: string) {
  return JSON.stringify(value)
}

function expectedMcp(options: AssistantIntegrationOptions) {
  const command = options.bundledCommand.includes('/') || options.bundledCommand.includes('\\')
    ? resolve(options.bundledCommand)
    : options.bundledCommand
  const args = [...(options.bundledArgs ?? []), 'mcp', '--stdio']
  return { command, args }
}

function tomlBlock(client: 'codex' | 'vibe', options: AssistantIntegrationOptions) {
  const mcp = expectedMcp(options)
  const args = mcp.args.map(tomlString).join(', ')
  if (client === 'codex') {
    return `${TOML_START}
[mcp_servers.draftmatter]
command = ${tomlString(mcp.command)}
args = [${args}]
${TOML_END}`
  }
  return `${TOML_START}
[[mcp_servers]]
name = "draftmatter"
transport = "stdio"
command = ${tomlString(mcp.command)}
args = [${args}]
startup_timeout_sec = 15
tool_timeout_sec = 120
${TOML_END}`
}

async function optionalRead(path: string) {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

function transformManagedBlock(existing: string | undefined, block: string, remove: boolean, repair: boolean) {
  const source = existing ?? ''
  const start = source.indexOf(TOML_START)
  const end = source.indexOf(TOML_END)
  if ((start === -1) !== (end === -1) || (start !== -1 && (end < start || source.indexOf(TOML_START, start + 1) !== -1))) {
    return { content: source, conflict: 'The DraftMatter-managed configuration block is malformed.' }
  }
  if (start === -1) {
    if (remove) return { content: source, changed: false, installed: false, current: false }
    return { content: normalizedText(`${source}${source ? '\n' : ''}${block}`), changed: true, installed: false, current: false }
  }
  const after = end + TOML_END.length
  const currentBlock = source.slice(start, after)
  if (remove) {
    const before = source.slice(0, start).replace(/\n$/u, '')
    const suffix = source.slice(after).replace(/^\n{1,2}/u, '')
    const content = `${before}${suffix}`
    return { content: content.trim() ? normalizedText(content) : '', changed: true, installed: true, current: currentBlock === block }
  }
  if (currentBlock === block) return { content: source, changed: false, installed: true, current: true }
  if (!repair) return { content: source, conflict: 'The existing DraftMatter MCP registration differs from this bundled version.', installed: true, current: false }
  return { content: normalizedText(`${source.slice(0, start)}${block}${source.slice(after)}`), changed: true, installed: true, current: false }
}

function parseJsonObject(content: string | undefined, path: string) {
  if (!content) return {}
  const value = JSON.parse(content) as unknown
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path} must contain one JSON object.`)
  return value as Record<string, unknown>
}

function jsonRegistration(
  existing: string | undefined,
  path: string,
  client: 'claude' | 'copilot',
  options: AssistantIntegrationOptions,
  remove: boolean,
  repair: boolean,
) {
  const root = parseJsonObject(existing, path)
  const serversValue = root.mcpServers
  if (serversValue !== undefined && (!serversValue || typeof serversValue !== 'object' || Array.isArray(serversValue))) {
    throw new Error(`${path}.mcpServers must be one JSON object.`)
  }
  const servers = { ...((serversValue ?? {}) as Record<string, unknown>) }
  const mcp = expectedMcp(options)
  const expected = client === 'copilot'
    ? { type: 'local', ...mcp, env: {}, tools: ['*'] }
    : mcp
  const installed = servers.draftmatter !== undefined
  const current = JSON.stringify(servers.draftmatter) === JSON.stringify(expected)
  if (remove) {
    if (!installed) return { content: existing ?? '', changed: false, installed, current }
    if (!current && !repair) throw new Error('The existing DraftMatter MCP registration differs from the managed version.')
    delete servers.draftmatter
  } else {
    if (installed && !current && !repair) throw new Error('The existing DraftMatter MCP registration differs from this bundled version.')
    if (current) return { content: existing ?? '', changed: false, installed, current }
    servers.draftmatter = expected
  }
  const next = { ...root }
  if (Object.keys(servers).length) next.mcpServers = servers
  else delete next.mcpServers
  return { content: Object.keys(next).length ? stableJson(next) : '', changed: true, installed, current }
}

async function executablePath(command: string, path = process.env.PATH ?? '') {
  const extensions = process.platform === 'win32' ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';') : ['']
  for (const directory of path.split(delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = join(directory, process.platform === 'win32' && !extname(command) ? `${command}${extension}` : command)
      try {
        await access(candidate, process.platform === 'win32' ? constants.F_OK : constants.X_OK)
        return candidate
      } catch {
        // Continue.
      }
    }
  }
  return undefined
}

function receiptPath(home: string, client: DraftMatterAssistantClient) {
  return join(home, '.draftmatter', 'assistant-connections', `${client}.json`)
}

function codexPluginRoot(home: string) {
  return join(home, '.agents', 'plugins', 'plugins', 'draftmatter')
}

function codexPluginMcp(options: AssistantIntegrationOptions) {
  const mcp = expectedMcp(options)
  return stableJson({ mcpServers: { draftmatter: mcp } })
}

function codexPluginManifest() {
  return stableJson({
    name: 'draftmatter',
    version: packageMetadata.version,
    description: 'Safe local AI authoring for DraftMatter research projects.',
    author: {
      name: 'DraftMatter contributors',
      url: 'https://github.com/VEZY/DraftMatter',
    },
    homepage: 'https://github.com/VEZY/DraftMatter',
    repository: 'https://github.com/VEZY/DraftMatter',
    license: 'MIT',
    keywords: ['scientific-writing', 'reproducibility', 'mcp'],
    skills: './skills/',
    interface: {
      displayName: 'DraftMatter',
      shortDescription: 'Author research manuscripts through local tools.',
      longDescription: 'Inspect, review, cite, validate, and create reproducible results in local DraftMatter projects without editing managed manuscript syntax.',
      developerName: 'DraftMatter contributors',
      category: 'Productivity',
      capabilities: ['Read', 'Write', 'Local execution'],
      brandColor: '#3F715E',
      composerIcon: './assets/icon.svg',
      websiteURL: 'https://github.com/VEZY/DraftMatter',
      defaultPrompt: [
        'Review this DraftMatter manuscript with tracked suggestions.',
        'Add and inspect a reproducible figure.',
        'Validate citations, results, and publication readiness.',
      ],
    },
    mcpServers: './.mcp.json',
  })
}

async function configState(client: DraftMatterAssistantClient, options: AssistantIntegrationOptions) {
  const home = resolve(options.homeDir ?? homedir())
  const definition = DEFINITIONS[client]
  if (client === 'codex' && options.codexPluginAvailable) {
    const path = join(codexPluginRoot(home), '.mcp.json')
    const existing = await optionalRead(path)
    return {
      path,
      installed: Boolean(options.codexPluginInstalled),
      current: Boolean(options.codexPluginInstalled) && existing === codexPluginMcp(options),
    }
  }
  const path = definition.configPath(home)
  const existing = await optionalRead(path)
  try {
    if (definition.configKind === 'toml-codex') {
      const transformed = transformManagedBlock(existing, tomlBlock('codex', options), false, false)
      return { path, installed: Boolean(transformed.installed), current: Boolean(transformed.current) }
    }
    if (definition.configKind === 'toml-vibe') {
      const transformed = transformManagedBlock(existing, tomlBlock('vibe', options), false, false)
      return { path, installed: Boolean(transformed.installed), current: Boolean(transformed.current) }
    }
    const transformed = jsonRegistration(existing, path, definition.configKind === 'json-copilot' ? 'copilot' : 'claude', options, false, false)
    return { path, installed: transformed.installed, current: transformed.current }
  } catch {
    const installed = existing?.includes('draftmatter') ?? false
    return { path, installed, current: false }
  }
}

async function skillState(client: DraftMatterAssistantClient, home: string, codexPluginAvailable = false) {
  const base = client === 'codex' && codexPluginAvailable
    ? join(codexPluginRoot(home), 'skills', DRAFTMATTER_AGENT_SKILL)
    : DEFINITIONS[client].skillPath(home)
  const contents = await Promise.all(Object.entries(SKILL_FILES).map(async ([path, expected]) => {
    const current = await optionalRead(join(base, ...path.split('/')))
    return { installed: current !== undefined, current: current === normalizedText(expected) }
  }))
  return {
    path: base,
    installed: contents.some((entry) => entry.installed),
    current: contents.every((entry) => entry.current),
  }
}

export async function inspectAssistantConnection(
  client: DraftMatterAssistantClient,
  options: AssistantIntegrationOptions,
): Promise<AssistantConnectionStatus> {
  const home = resolve(options.homeDir ?? homedir())
  const definition = DEFINITIONS[client]
  const [executable, config, skill] = await Promise.all([
    executablePath(definition.executable, options.path),
    configState(client, options),
    skillState(client, home, Boolean(options.codexPluginAvailable)),
  ])
  const connected = config.current && skill.current
  const notes: string[] = []
  const registrationMethod = client === 'codex' && options.codexPluginAvailable
    ? 'codex-plugin'
    : 'global-config'
  if (!executable) notes.push(`${definition.name} was not detected on PATH; registration can still be prepared for a later install.`)
  if (client === 'codex' && !options.codexPluginAvailable) {
    notes.push('This Codex installation does not expose plugin management, so DraftMatter uses equivalent user-wide MCP and skill registration.')
  }
  notes.push('Project enablement, code-execution trust, network approval, and client tool approval remain separate.')
  return {
    client,
    name: definition.name,
    detected: Boolean(executable),
    ...(executable ? { executable } : {}),
    connected,
    mcpInstalled: config.installed,
    mcpCurrent: config.current,
    skillInstalled: skill.installed,
    skillCurrent: skill.current,
    registrationScope: 'user',
    registrationMethod,
    projectLocalRequired: false,
    recommendedAction: connected
      ? 'none'
      : !config.installed && !skill.installed
        ? 'install'
        : config.installed && skill.installed
          ? 'update'
          : 'repair',
    configPath: config.path,
    skillPath: skill.path,
    notes,
  }
}

export async function inspectAssistantConnections(options: AssistantIntegrationOptions) {
  return await Promise.all(CLIENTS.map(async (client) => await inspectAssistantConnection(client, options)))
}

async function prepareManagedFile(options: {
  path: string
  expected: string
  operation: AssistantConnectionOperation
  managedRevision?: string | null
  kind: AssistantConnectionChange['kind']
  installMessage: string
  removeMessage: string
}): Promise<FileChange> {
  const current = await optionalRead(options.path)
  const expected = normalizedText(options.expected)
  const currentRevision = current === undefined ? null : await sha256(current)
  const managed = options.managedRevision !== undefined && options.managedRevision === currentRevision
  if (options.operation === 'remove') {
    if (current === undefined) {
      return { path: options.path, content: null, current, plan: { path: options.path, action: 'unchanged', kind: options.kind, message: 'Managed file is already absent.' } }
    }
    if (current !== expected && !managed) {
      return { path: options.path, content: current, current, plan: { path: options.path, action: 'conflict', kind: options.kind, message: 'This DraftMatter-managed file was modified and was preserved.' } }
    }
    return { path: options.path, content: null, current, plan: { path: options.path, action: 'delete', kind: options.kind, message: options.removeMessage } }
  }
  if (current === expected) {
    return { path: options.path, content: expected, current, plan: { path: options.path, action: 'unchanged', kind: options.kind, message: 'Managed file is current.' } }
  }
  if (current !== undefined && !managed && options.operation !== 'repair') {
    return { path: options.path, content: current, current, plan: { path: options.path, action: 'conflict', kind: options.kind, message: 'A modified or unmanaged file already exists; use Repair to replace only this DraftMatter path.' } }
  }
  return {
    path: options.path,
    content: expected,
    current,
    plan: {
      path: options.path,
      action: current === undefined ? 'create' : 'update',
      kind: options.kind,
      message: options.installMessage,
    },
  }
}

async function prepareConfigChange(
  client: DraftMatterAssistantClient,
  operation: AssistantConnectionOperation,
  options: AssistantIntegrationOptions,
  managedRevision?: string | null,
): Promise<FileChange> {
  const definition = DEFINITIONS[client]
  const home = resolve(options.homeDir ?? homedir())
  const path = definition.configPath(home)
  const current = await optionalRead(path)
  const remove = operation === 'remove'
  const currentRevision = current === undefined ? null : await sha256(current)
  const replaceManaged = managedRevision !== undefined && managedRevision === currentRevision
  const repair = operation === 'repair' || replaceManaged
  try {
    const transformed = definition.configKind === 'toml-codex'
      ? transformManagedBlock(current, tomlBlock('codex', options), remove, repair)
      : definition.configKind === 'toml-vibe'
        ? transformManagedBlock(current, tomlBlock('vibe', options), remove, repair)
        : jsonRegistration(current, path, definition.configKind === 'json-copilot' ? 'copilot' : 'claude', options, remove, repair)
    if ('conflict' in transformed && transformed.conflict) {
      return { path, content: current ?? null, current, plan: { path, action: 'conflict', kind: 'mcp-registration', message: transformed.conflict } }
    }
    const next = transformed.content || null
    return {
      path,
      content: next,
      current,
      plan: {
        path,
        action: !transformed.changed ? 'unchanged' : next === null ? 'delete' : current === undefined ? 'create' : 'update',
        kind: 'mcp-registration',
        message: remove ? 'Remove only DraftMatter’s user-wide MCP registration.' : 'Register the MCP server bundled with DraftMatter at user scope.',
      },
    }
  } catch (error) {
    return {
      path,
      content: current ?? null,
      current,
      plan: { path, action: 'conflict', kind: 'mcp-registration', message: error instanceof Error ? error.message : String(error) },
    }
  }
}

async function prepareSkillChanges(
  client: DraftMatterAssistantClient,
  operation: AssistantConnectionOperation,
  options: AssistantIntegrationOptions,
  managedRevisions: Map<string, string | null>,
) {
  const home = resolve(options.homeDir ?? homedir())
  const base = DEFINITIONS[client].skillPath(home)
  return await Promise.all(Object.entries(SKILL_FILES).map(async ([relativePath, expectedSource]): Promise<FileChange> => {
    const path = join(base, ...relativePath.split('/'))
    const current = await optionalRead(path)
    const expected = normalizedText(expectedSource)
    const remove = operation === 'remove'
    const currentRevision = current === undefined ? null : await sha256(current)
    const repair = operation === 'repair' || managedRevisions.get(path) === currentRevision
    if (remove) {
      if (current === undefined) return { path, content: null, current, plan: { path, action: 'unchanged', kind: 'skill', message: 'Skill file is already absent.' } }
      if (current !== expected && !repair) return { path, content: current, current, plan: { path, action: 'conflict', kind: 'skill', message: 'The DraftMatter skill file was modified and was preserved.' } }
      return { path, content: null, current, plan: { path, action: 'delete', kind: 'skill', message: 'Remove the managed DraftMatter skill file.' } }
    }
    if (current === expected) return { path, content: expected, current, plan: { path, action: 'unchanged', kind: 'skill', message: 'Canonical skill file is current.' } }
    if (current !== undefined && !repair) return { path, content: current, current, plan: { path, action: 'conflict', kind: 'skill', message: 'A modified DraftMatter skill file already exists; use Repair to replace it after review.' } }
    return {
      path,
      content: expected,
      current,
      plan: { path, action: current === undefined ? 'create' : 'update', kind: 'skill', message: 'Install the canonical DraftMatter authoring skill at user scope.' },
    }
  }))
}

async function prepareCodexMarketplaceChange(
  home: string,
  operation: AssistantConnectionOperation,
  managedRevision?: string | null,
): Promise<FileChange> {
  const path = join(home, '.agents', 'plugins', 'marketplace.json')
  const current = await optionalRead(path)
  const currentRevision = current === undefined ? null : await sha256(current)
  const managed = managedRevision !== undefined && managedRevision === currentRevision
  let root: Record<string, unknown>
  try {
    root = parseJsonObject(current, path)
  } catch (error) {
    return { path, content: current ?? null, current, plan: { path, action: 'conflict', kind: 'plugin', message: error instanceof Error ? error.message : String(error) } }
  }
  const existingPlugins = root.plugins
  if (existingPlugins !== undefined && !Array.isArray(existingPlugins)) {
    return { path, content: current ?? null, current, plan: { path, action: 'conflict', kind: 'plugin', message: `${path}.plugins must be an array.` } }
  }
  const plugins = [...((existingPlugins ?? []) as Array<Record<string, unknown>>)]
  const index = plugins.findIndex((entry) => entry?.name === 'draftmatter')
  const expected = {
    name: 'draftmatter',
    source: { source: 'local', path: './plugins/draftmatter' },
    policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
    category: 'Productivity',
  }
  if (operation === 'remove') {
    if (index === -1) return { path, content: current ?? null, current, plan: { path, action: 'unchanged', kind: 'plugin', message: 'DraftMatter personal-marketplace entry is already absent.' } }
    if (JSON.stringify(plugins[index]) !== JSON.stringify(expected) && !managed) {
      return { path, content: current ?? null, current, plan: { path, action: 'conflict', kind: 'plugin', message: 'The DraftMatter personal-marketplace entry was modified and was preserved.' } }
    }
    plugins.splice(index, 1)
  } else if (index === -1) {
    plugins.push(expected)
  } else if (JSON.stringify(plugins[index]) !== JSON.stringify(expected)) {
    if (operation !== 'repair' && !managed) {
      return { path, content: current ?? null, current, plan: { path, action: 'conflict', kind: 'plugin', message: 'A different DraftMatter personal-marketplace entry already exists.' } }
    }
    plugins[index] = expected
  } else {
    return { path, content: current ?? null, current, plan: { path, action: 'unchanged', kind: 'plugin', message: 'DraftMatter personal-marketplace entry is current.' } }
  }
  const next = { ...root }
  if (operation === 'remove' && plugins.length === 0 && Object.keys(root).every((key) => ['name', 'interface', 'plugins'].includes(key))) {
    const remaining = { ...root, plugins }
    return {
      path,
      content: stableJson(remaining),
      current,
      plan: { path, action: current === undefined ? 'create' : 'update', kind: 'plugin', message: 'Remove only DraftMatter from the personal marketplace.' },
    }
  }
  next.name ??= 'personal'
  next.interface ??= { displayName: 'Personal' }
  next.plugins = plugins
  return {
    path,
    content: stableJson(next),
    current,
    plan: {
      path,
      action: current === undefined ? 'create' : 'update',
      kind: 'plugin',
      message: operation === 'remove'
        ? 'Remove only DraftMatter from the personal marketplace.'
        : 'Add DraftMatter to Codex’s personal local marketplace while preserving other plugins.',
    },
  }
}

async function applyFileChanges(changes: FileChange[]) {
  const applied: FileChange[] = []
  try {
    for (const change of changes) {
      if (change.plan.action === 'unchanged') continue
      await mkdir(dirname(change.path), { recursive: true })
      if (change.content === null) {
        try {
          await unlink(change.path)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
      } else {
        await writeFile(change.path, change.content, 'utf8')
      }
      applied.push(change)
    }
  } catch (error) {
    for (const change of applied.reverse()) {
      if (change.current === undefined) {
        await unlink(change.path).catch(() => undefined)
      } else {
        await writeFile(change.path, change.current, 'utf8').catch(() => undefined)
      }
    }
    throw error
  }
}

async function rollbackFileChanges(changes: FileChange[]) {
  for (const change of [...changes].reverse()) {
    if (change.plan.action === 'unchanged') continue
    if (change.current === undefined) {
      await unlink(change.path).catch(() => undefined)
    } else {
      await mkdir(dirname(change.path), { recursive: true })
      await writeFile(change.path, change.current, 'utf8').catch(() => undefined)
    }
  }
}

export async function planAssistantConnection(options: AssistantIntegrationOptions & {
  client: DraftMatterAssistantClient
  operation: AssistantConnectionOperation
  apply?: boolean
}): Promise<AssistantConnectionPlan> {
  const statusBefore = await inspectAssistantConnection(options.client, options)
  const home = resolve(options.homeDir ?? homedir())
  const receipt = receiptPath(home, options.client)
  const receiptCurrent = await optionalRead(receipt)
  let priorReceipt: AssistantConnectionReceipt | undefined
  try {
    const parsed = receiptCurrent ? JSON.parse(receiptCurrent) as AssistantConnectionReceipt : undefined
    if (parsed?.schemaVersion === RECEIPT_SCHEMA && parsed.client === options.client && Array.isArray(parsed.files)) priorReceipt = parsed
  } catch {
    // A malformed receipt never grants ownership; Repair remains explicit.
  }
  const priorRevisions = new Map((priorReceipt?.files ?? []).map((entry) => [entry.path, entry.revision]))
  const useCodexPlugin = options.client === 'codex' && Boolean(options.codexPluginAvailable)
  let config: FileChange
  let skill: FileChange[]
  let pluginChanges: FileChange[] = []
  let configPath: string
  let skillPath: string
  if (useCodexPlugin) {
    const pluginRoot = codexPluginRoot(home)
    configPath = join(pluginRoot, '.mcp.json')
    skillPath = join(pluginRoot, 'skills', DRAFTMATTER_AGENT_SKILL)
    config = await prepareManagedFile({
      path: configPath,
      expected: codexPluginMcp(options),
      operation: options.operation,
      managedRevision: priorReceipt?.configRevision,
      kind: 'mcp-registration',
      installMessage: 'Configure the Codex plugin to start DraftMatter’s bundled MCP sidecar.',
      removeMessage: 'Remove the managed Codex plugin MCP declaration.',
    })
    skill = await Promise.all(Object.entries(SKILL_FILES).map(async ([relativePath, source]) => {
      const path = join(skillPath, ...relativePath.split('/'))
      return await prepareManagedFile({
        path,
        expected: source,
        operation: options.operation,
        managedRevision: priorRevisions.get(path),
        kind: 'skill',
        installMessage: 'Install the canonical DraftMatter skill inside the Codex plugin.',
        removeMessage: 'Remove the managed Codex plugin skill file.',
      })
    }))
    const pluginSources: Array<[string, string]> = [
      ['.codex-plugin/plugin.json', codexPluginManifest()],
      ['assets/icon.svg', pluginIcon],
      ['LICENSE', licenseText],
      ['README.md', pluginReadme],
    ]
    pluginChanges = await Promise.all(pluginSources.map(async ([relativePath, source]) => {
      const path = join(pluginRoot, ...relativePath.split('/'))
      return await prepareManagedFile({
        path,
        expected: source,
        operation: options.operation,
        managedRevision: priorRevisions.get(path),
        kind: 'plugin',
        installMessage: 'Prepare DraftMatter’s local Codex plugin source.',
        removeMessage: 'Remove the managed DraftMatter Codex plugin file.',
      })
    }))
    const marketplacePath = join(home, '.agents', 'plugins', 'marketplace.json')
    pluginChanges.push(await prepareCodexMarketplaceChange(
      home,
      options.operation,
      priorRevisions.get(marketplacePath),
    ))
  } else {
    configPath = DEFINITIONS[options.client].configPath(home)
    skillPath = DEFINITIONS[options.client].skillPath(home)
    config = await prepareConfigChange(options.client, options.operation, options, priorReceipt?.configRevision)
    skill = await prepareSkillChanges(options.client, options.operation, options, priorRevisions)
  }
  const managedChanges = [config, ...skill, ...pluginChanges]
  const conflicts = managedChanges.filter((entry) => entry.plan.action === 'conflict').map((entry) => entry.plan)
  const receiptContent = options.operation === 'remove'
    ? null
    : stableJson({
        schemaVersion: RECEIPT_SCHEMA,
        client: options.client,
        draftmatterVersion: packageMetadata.version,
        bundledCommand: resolve(options.bundledCommand),
        bundledArgs: options.bundledArgs ?? [],
        registrationMethod: useCodexPlugin ? 'codex-plugin' : 'global-config',
        configPath,
        configRevision: config.content === null ? null : await sha256(config.content),
        skillPath,
        files: await Promise.all([...skill, ...pluginChanges].map(async (entry) => ({
          path: entry.path,
          revision: entry.content === null ? null : await sha256(entry.content),
        }))),
      })
  const receiptChange: FileChange = {
    path: receipt,
    content: receiptContent,
    current: receiptCurrent,
    plan: {
      path: receipt,
      action: receiptContent === receiptCurrent
        ? 'unchanged'
        : receiptContent === null
          ? receiptCurrent === undefined ? 'unchanged' : 'delete'
          : receiptCurrent === undefined ? 'create' : 'update',
      kind: 'receipt',
      message: options.operation === 'remove' ? 'Remove DraftMatter’s connection receipt.' : 'Record the installed versions without storing credentials or approvals.',
    },
  }
  const allChanges = [...managedChanges, receiptChange]
  let applied = false
  if (options.apply && !conflicts.length) {
    if (useCodexPlugin && options.operation === 'remove') {
      await options.applyCodexPlugin?.(options.operation)
      try {
        await applyFileChanges(allChanges)
      } catch (error) {
        await options.applyCodexPlugin?.('install').catch(() => undefined)
        throw error
      }
    } else {
      await applyFileChanges(allChanges)
      try {
        if (useCodexPlugin) await options.applyCodexPlugin?.(options.operation)
      } catch (error) {
        await rollbackFileChanges(allChanges)
        throw error
      }
    }
    applied = true
  }
  const statusOptions = useCodexPlugin && applied
    ? { ...options, codexPluginInstalled: options.operation !== 'remove' }
    : options
  return {
    ok: conflicts.length === 0,
    operation: options.operation,
    client: options.client,
    applied,
    statusBefore,
    ...(applied ? { statusAfter: await inspectAssistantConnection(options.client, statusOptions) } : {}),
    changes: allChanges.map((entry) => entry.plan),
    conflicts,
    guarantees: [
      'No model was contacted.',
      'No manuscript code was executed and no project trust was granted.',
      'No Zotero/Crossref network access or future tool approval was enabled.',
      'Unrelated assistant configuration was preserved.',
    ],
    advancedCommand: `draftmatter assistants ${options.operation} ${options.client}${options.apply ? ' --apply' : ''}`,
  }
}
