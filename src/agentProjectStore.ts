import { readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { applyProjectTransaction, confinedProjectPath, ProjectTransactionError, recoverProjectTransactions, withProjectWriteLock } from './projectTransactions'
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
  /** Test seam for real child-process interruption after a durable replacement. */
  afterReplacement?: (count: number) => Promise<void>
}

export class AgentProjectStoreError extends Error {
  constructor(
    readonly code: 'project-missing' | 'project-invalid' | 'path-outside-project' | 'path-symlink-escape' | 'stale-revision' | 'transaction-failed' | 'project-busy',
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
    const store = new NodeAgentProjectStore(canonical, `${identity.dev}:${identity.ino}`, options)
    await store.locked(async () => undefined)
    return store
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

  private async locked<T>(action: () => Promise<T>): Promise<T> {
    await this.assertRootIdentity()
    try {
      return await withProjectWriteLock(this.root, async () => {
        await this.assertRootIdentity()
        await recoverProjectTransactions(this.root)
        return action()
      })
    } catch (error) {
      if (error instanceof ProjectTransactionError) throw new AgentProjectStoreError(error.code, error.message)
      throw error
    }
  }

  private async readTextUnlocked(path: string) {
    const target = await this.readablePath(path)
    const content = await readFile(target.canonical, 'utf8')
    return { content, revision: await fileRevision(content) }
  }

  async readText(path: string) {
    return this.locked(() => this.readTextUnlocked(path))
  }

  async readBytes(path: string) {
    return this.locked(async () => {
      const target = await this.readablePath(path)
      return readFile(target.canonical)
    })
  }

  async snapshot(): Promise<AgentProjectSnapshot> {
    return this.locked(async () => {
      const configFile = await this.readTextUnlocked('.draftmatter/project.json')
      let value: unknown
      try {
        value = JSON.parse(configFile.content)
      } catch (error) {
        throw new AgentProjectStoreError('project-invalid', `The DraftMatter project configuration is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
      }
      const config = parsedProjectConfig(value)
      const mainDocument = this.portable(config.mainDocument)
      const document = await this.readTextUnlocked(mainDocument)
      return {
        root: this.root,
        config,
        configRevision: configFile.revision,
        mainDocument,
        source: document.content,
        documentRevision: document.revision,
      }
    })
  }

  async commit(writes: AgentProjectWrite[]): Promise<AgentProjectCommit> {
    return this.locked(async () => {
      if (!writes.length) throw new AgentProjectStoreError('transaction-failed', 'A transaction requires at least one file write.')
      // Revalidate every expected revision after acquiring the cross-process lock.
      const targets = await Promise.all(writes.map(async (write) => {
        const normalized = this.portable(write.path)
        await confinedProjectPath(this.root, normalized)
        let currentRevision: string | null = null
        try { currentRevision = (await this.readTextUnlocked(normalized)).revision }
        catch (error) {
          if (!(error instanceof AgentProjectStoreError) || error.code !== 'project-missing') throw error
        }
        if (write.expectedRevision !== currentRevision) throw new AgentProjectStoreError(
          'stale-revision', `Project file “${normalized}” changed after it was inspected.`,
          { path: normalized, expectedRevision: write.expectedRevision, currentRevision },
        )
        return { ...write, path: normalized }
      }))
      let transactionId: string
      try {
        transactionId = await applyProjectTransaction(this.root, targets.map((write) => ({
          path: write.path, content: write.content === null ? null : new TextEncoder().encode(write.content),
        })), async (count) => {
          await this.options.afterReplacement?.(count)
          if (this.options.failAfterReplacements === count) throw new Error(`Injected transaction interruption after ${count} replacement(s).`)
        })
      } catch (error) {
        if (error instanceof ProjectTransactionError) throw error
        throw new AgentProjectStoreError('transaction-failed', `The project transaction failed and was rolled back: ${error instanceof Error ? error.message : String(error)}`)
      }
      return {
        transactionId,
        revisions: Object.fromEntries(await Promise.all(targets.map(async (target) =>
          [target.path, target.content === null ? null : await fileRevision(target.content)] as const))),
      }
    })
  }
}
