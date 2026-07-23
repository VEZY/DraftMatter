import type { ProjectSnapshot } from './desktopHost'

const LOCAL_PROJECTS_KEY = 'draftmatter.local-project-catalogue.v1'
const MAX_LOCAL_PROJECTS = 24

export interface LocalProjectRecent {
  root: string
  name: string
  mainDocument: string
  lastOpenedAt: string
}

type LocalProjectStorage = Pick<Storage, 'getItem' | 'setItem'>

function validRecent(value: unknown): value is LocalProjectRecent {
  if (!value || typeof value !== 'object') return false
  const recent = value as Partial<LocalProjectRecent>
  return typeof recent.root === 'string'
    && Boolean(recent.root.trim())
    && typeof recent.name === 'string'
    && Boolean(recent.name.trim())
    && typeof recent.mainDocument === 'string'
    && Boolean(recent.mainDocument.trim())
    && typeof recent.lastOpenedAt === 'string'
    && Number.isFinite(new Date(recent.lastOpenedAt).getTime())
}

export function readLocalProjectRecents(storage: Pick<LocalProjectStorage, 'getItem'>): LocalProjectRecent[] {
  try {
    const parsed = JSON.parse(storage.getItem(LOCAL_PROJECTS_KEY) ?? '[]') as unknown
    if (!Array.isArray(parsed)) return []
    const unique = new Map<string, LocalProjectRecent>()
    parsed.filter(validRecent).sort((left, right) => right.lastOpenedAt.localeCompare(left.lastOpenedAt)).forEach((recent) => {
      if (!unique.has(recent.root)) unique.set(recent.root, recent)
    })
    return [...unique.values()].slice(0, MAX_LOCAL_PROJECTS)
  } catch {
    return []
  }
}

export function rememberLocalProject(
  storage: LocalProjectStorage,
  project: ProjectSnapshot,
  openedAt = new Date().toISOString(),
) {
  const recent: LocalProjectRecent = {
    root: project.root,
    name: project.config.name,
    mainDocument: project.config.mainDocument,
    lastOpenedAt: openedAt,
  }
  const next = [recent, ...readLocalProjectRecents(storage).filter((candidate) => candidate.root !== project.root)].slice(0, MAX_LOCAL_PROJECTS)
  storage.setItem(LOCAL_PROJECTS_KEY, JSON.stringify(next))
  return next
}

export function forgetLocalProject(storage: LocalProjectStorage, root: string) {
  const next = readLocalProjectRecents(storage).filter((candidate) => candidate.root !== root)
  storage.setItem(LOCAL_PROJECTS_KEY, JSON.stringify(next))
  return next
}
