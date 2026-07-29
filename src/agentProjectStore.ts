import { mkdir, open, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { sha256 } from './kernelExecution'
import { normalizeProjectRelativePath } from './projectPaths'
import type { ProjectConfig } from './desktopHost'

export interface AgentProjectSnapshot {
  root: string
  config: ProjectConfig
  configRevision: string
  mainDocument: string
  source: string
  documentRevision: string
}

export interface AgentProjectWrite {
  path: string
  content: string | null
  expectedRevision: string | null
}

export interface AgentProjectCommit {
  transactionId: string
  revisions: Record<string, string | null>
  recoveryPath?: string
}

export interface AgentProjectStore {
  readonly root: string
  snapshot(): Promise<AgentProjectSnapshot>
  readText(path: string): Promise<{ content: string; revision: string }>
  readBytes(path: string): Promise<Uint8Array>
  commit(writes: AgentProjectWrite[]): Promise<AgentProjectCommit>
}

export interface NodeAgentProjectStoreOptions {
  /** Deterministic transaction fault injection used by crash-recovery tests. */
  failAfterReplacements?: number
}

export class AgentProjectStoreError extends Error {
  constructor(
    readonly code: 'project-missing' | 'project-invalid' | 'path-outside-project' | 'path-symlink-escape' | 'stale-revision' | 'transaction-failed',
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'AgentProjectStoreError'
  }
}

function inside(root: string, candidate: string) {
  const path = relative(root, candidate)
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path))
}

function parsedProjectConfig(value: unknown): ProjectConfig {
  if (!value || typeof value !== 'object') throw new AgentProjectStoreError('project-invalid', 'The DraftMatter project configuration must be an object.')
  const config = value as Partial<ProjectConfig>
  if (config.schemaVersion !== 1) throw new AgentProjectStoreError('project-invalid', 'The DraftMatter project configuration schemaVersion must be 1.')
  if (typeof config.name !== 'string' || !config.name.trim()) throw new AgentProjectStoreError('project-invalid', 'The DraftMatter project name is missing.')
  if (typeof config.mainDocument !== 'string' || !normalizeProjectRelativePath(config.mainDocument)) {
    throw new AgentProjectStoreError('project-invalid', 'The DraftMatter main document path is invalid.')
  }
  if (config.citationStyle !== 'draftmatter-author-date' && config.citationStyle !== 'draftmatter-numeric') {
    throw new AgentProjectStoreError('project-invalid', 'The DraftMatter citation style is invalid.')
  }
  if (config.citationLocale !== 'en-US' && config.citationLocale !== 'fr-FR') {
    throw new AgentProjectStoreError('project-invalid', 'The DraftMatter citation locale is invalid.')
  }
  return config as ProjectConfig
}

async function fileRevision(content: string) {
  return await sha256(content)
}

export class NodeAgentProjectStore implements AgentProjectStore {
  readonly root: string

  private constructor(
    root: string,
    private readonly rootIdentity: string,
    private readonly options: NodeAgentProjectStoreOptions,
  ) {
    this.root = root
  }

  static async open(rawRoot: string, options: NodeAgentProjectStoreOptions = {}) {
    if (!rawRoot.trim()) throw new AgentProjectStoreError('project-missing', 'A project root is required.')
    let canonical: string
    try {
      canonical = await realpath(resolve(rawRoot))
      if (!(await stat(canonical)).isDirectory()) throw new Error('not a directory')
    } catch {
      throw new AgentProjectStoreError('project-missing', `DraftMatter project root “${rawRoot}” was not found.`)
    }
    const identity = await stat(canonical, { bigint: true })
    return new NodeAgentProjectStore(canonical, `${identity.dev}:${identity.ino}`, options)
  }

  private async assertRootIdentity() {
    try {
      const canonical = await realpath(this.root)
      const identity = await stat(canonical, { bigint: true })
      if (
        canonical !== this.root
        || !identity.isDirectory()
        || `${identity.dev}:${identity.ino}` !== this.rootIdentity
      ) throw new Error('root identity changed')
    } catch {
      throw new AgentProjectStoreError(
        'project-missing',
        'The selected DraftMatter project was moved or replaced; reopen it before continuing.',
      )
    }
  }

  private portable(path: string) {
    const normalized = normalizeProjectRelativePath(path)
    if (!normalized) throw new AgentProjectStoreError('path-outside-project', `Project path “${path}” is not a safe relative path.`)
    return normalized
  }

  private unresolvedPath(path: string) {
    const normalized = this.portable(path)
    const candidate = resolve(this.root, ...normalized.split('/'))
    if (!inside(this.root, candidate)) throw new AgentProjectStoreError('path-outside-project', `Project path “${path}” leaves the selected project.`)
    return { normalized, candidate }
  }

  private async readablePath(path: string) {
    await this.assertRootIdentity()
    const target = this.unresolvedPath(path)
    let canonical: string
    try {
      canonical = await realpath(target.candidate)
    } catch {
      throw new AgentProjectStoreError('project-missing', `Project file “${target.normalized}” was not found.`)
    }
    if (!inside(this.root, canonical)) {
      throw new AgentProjectStoreError('path-symlink-escape', `Project file “${target.normalized}” resolves outside the selected project.`)
    }
    return { ...target, canonical }
  }

  private async writablePath(path: string) {
    await this.assertRootIdentity()
    const target = this.unresolvedPath(path)
    let ancestor = dirname(target.candidate)
    while (true) {
      try {
        const canonical = await realpath(ancestor)
        if (!inside(this.root, canonical)) {
          throw new AgentProjectStoreError('path-symlink-escape', `Project path “${target.normalized}” has a parent that resolves outside the selected project.`)
        }
        break
      } catch (error) {
        if (error instanceof AgentProjectStoreError) throw error
        const parent = dirname(ancestor)
        if (parent === ancestor) {
          throw new AgentProjectStoreError('path-outside-project', `Project path “${target.normalized}” has no confined writable parent.`)
        }
        ancestor = parent
      }
    }
    return target
  }

  async readText(path: string) {
    const target = await this.readablePath(path)
    const content = await readFile(target.canonical, 'utf8')
    return { content, revision: await fileRevision(content) }
  }

  async readBytes(path: string) {
    const target = await this.readablePath(path)
    return await readFile(target.canonical)
  }

  async snapshot(): Promise<AgentProjectSnapshot> {
    const configFile = await this.readText('.draftmatter/project.json')
    let value: unknown
    try {
      value = JSON.parse(configFile.content)
    } catch (error) {
      throw new AgentProjectStoreError('project-invalid', `The DraftMatter project configuration is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
    }
    const config = parsedProjectConfig(value)
    const mainDocument = this.portable(config.mainDocument)
    const document = await this.readText(mainDocument)
    return {
      root: this.root,
      config,
      configRevision: configFile.revision,
      mainDocument,
      source: document.content,
      documentRevision: document.revision,
    }
  }

  async commit(writes: AgentProjectWrite[]): Promise<AgentProjectCommit> {
    if (!writes.length) throw new AgentProjectStoreError('transaction-failed', 'A transaction requires at least one file write.')
    const transactionId = randomUUID()
    const transactionPath = join(this.root, '.draftmatter', 'transactions', transactionId)
    const stagedPath = join(transactionPath, 'staged')
    const backupPath = join(transactionPath, 'backup')
    const targets = await Promise.all(writes.map(async (write) => {
      const target = await this.writablePath(write.path)
      let current: { content: string; revision: string } | undefined
      try {
        current = await this.readText(target.normalized)
      } catch (error) {
        if (!(error instanceof AgentProjectStoreError) || error.code !== 'project-missing') throw error
      }
      const currentRevision = current?.revision ?? null
      if (write.expectedRevision !== currentRevision) {
        throw new AgentProjectStoreError(
          'stale-revision',
          `Project file “${target.normalized}” changed after it was inspected.`,
          { path: target.normalized, expectedRevision: write.expectedRevision, currentRevision },
        )
      }
      return { ...target, write, current }
    }))

    await mkdir(stagedPath, { recursive: true })
    await mkdir(backupPath, { recursive: true })
    const journal = {
      schemaVersion: 1,
      transactionId,
      state: 'staged',
      files: targets.map((target) => ({
        path: target.normalized,
        action: target.write.content === null ? 'delete' : 'write',
        existed: Boolean(target.current),
      })),
    }
    await Promise.all(targets.map(async (target) => {
      if (target.write.content !== null) {
        const stage = join(stagedPath, ...target.normalized.split('/'))
        await mkdir(dirname(stage), { recursive: true })
        await writeFile(stage, target.write.content, 'utf8')
        const handle = await open(stage, 'r+')
        try {
          await handle.sync()
        } finally {
          await handle.close()
        }
      }
      if (target.current) {
        const backup = join(backupPath, ...target.normalized.split('/'))
        await mkdir(dirname(backup), { recursive: true })
        await writeFile(backup, target.current.content, 'utf8')
      }
    }))
    const journalPath = join(transactionPath, 'journal.json')
    await writeFile(journalPath, `${JSON.stringify(journal, null, 2)}\n`, 'utf8')

    const replaced: typeof targets = []
    try {
      for (const target of targets) {
        if (target.write.content === null) {
          if (target.current) await unlink(target.candidate)
        } else {
          await mkdir(dirname(target.candidate), { recursive: true })
          await rename(join(stagedPath, ...target.normalized.split('/')), target.candidate)
        }
        replaced.push(target)
        if (this.options.failAfterReplacements === replaced.length) {
          throw new Error(`Injected transaction interruption after ${replaced.length} replacement(s).`)
        }
      }
      await writeFile(journalPath, `${JSON.stringify({ ...journal, state: 'committed' }, null, 2)}\n`, 'utf8')
      return {
        transactionId,
        revisions: Object.fromEntries(await Promise.all(targets.map(async (target) =>
          [target.normalized, target.write.content === null ? null : await fileRevision(target.write.content)] as const))),
      }
    } catch (error) {
      const rollbackFailures: string[] = []
      for (const target of [...replaced].reverse()) {
        try {
          if (target.current) {
            try {
              await unlink(target.candidate)
            } catch {
              // A deletion replacement already leaves no target to remove.
            }
            await rename(join(backupPath, ...target.normalized.split('/')), target.candidate)
          } else if (target.write.content !== null) {
            await unlink(target.candidate)
          }
        } catch (rollbackError) {
          rollbackFailures.push(`${target.normalized}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`)
        }
      }
      await writeFile(journalPath, `${JSON.stringify({
        ...journal,
        state: rollbackFailures.length ? 'recovery-required' : 'rolled-back',
        error: error instanceof Error ? error.message : String(error),
        rollbackFailures,
      }, null, 2)}\n`, 'utf8')
      throw new AgentProjectStoreError(
        'transaction-failed',
        rollbackFailures.length
          ? 'The project transaction failed and requires recovery.'
          : 'The project transaction failed and was rolled back.',
        { recoveryPath: relative(this.root, journalPath).split(sep).join('/'), rollbackFailures },
      )
    }
  }
}
