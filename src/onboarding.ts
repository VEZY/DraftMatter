import type { WorkspaceRole } from './collaboration/workspaceService'

export const ONBOARDING_TASK_IDS = [
  'create-or-open',
  'author-profile',
  'organize-sections',
  'add-citation',
  'reproducible-output',
  'review-change',
  'invite-collaborator',
  'run-computation',
  'export-checkpoint',
] as const

export type OnboardingTaskId = typeof ONBOARDING_TASK_IDS[number]

export interface OnboardingProgress {
  completedTaskIds: OnboardingTaskId[]
  dismissed: boolean
  updatedAt?: string
}

export interface OnboardingTask {
  id: OnboardingTaskId
  label: string
  detail: string
  roles: WorkspaceRole[]
  desktopOnly?: boolean
}

export const ONBOARDING_TASKS: OnboardingTask[] = [
  { id: 'create-or-open', label: 'Create or open a draft', detail: 'Start with a portable manuscript you control.', roles: ['owner', 'editor', 'commenter', 'viewer'] },
  { id: 'author-profile', label: 'Complete the author profile', detail: 'Add the name and identifiers used for attribution.', roles: ['owner', 'editor'] },
  { id: 'organize-sections', label: 'Edit or reorganize sections', detail: 'Shape the manuscript outline around the research story.', roles: ['owner', 'editor'] },
  { id: 'add-citation', label: 'Add a citation', detail: 'Connect a claim to a durable scholarly source.', roles: ['owner', 'editor'] },
  { id: 'reproducible-output', label: 'Insert a reproducible figure or table', detail: 'Keep code private while publishing its retained output.', roles: ['owner', 'editor'], desktopOnly: true },
  { id: 'review-change', label: 'Add a comment or suggestion', detail: 'Leave a precise, attributed review item.', roles: ['owner', 'editor', 'commenter'] },
  { id: 'invite-collaborator', label: 'Invite a collaborator', detail: 'Share only the access role this person needs.', roles: ['owner'] },
  { id: 'run-computation', label: 'Run a computation', detail: 'Refresh a retained figure, table, or value on desktop.', roles: ['owner', 'editor'], desktopOnly: true },
  { id: 'export-checkpoint', label: 'Export or create an owner checkpoint', detail: 'Materialize a clean, portable result.', roles: ['owner'] },
]

export function onboardingTasksFor(role: WorkspaceRole, desktop: boolean) {
  return ONBOARDING_TASKS.filter((task) => task.roles.includes(role) && (desktop || !task.desktopOnly))
}

const ONBOARDING_KEY_PREFIX = 'draftmatter.onboarding.v1:'

export function readLocalOnboarding(storage: Pick<Storage, 'getItem'>, userId = 'desktop'): OnboardingProgress {
  try {
    const value = JSON.parse(storage.getItem(`${ONBOARDING_KEY_PREFIX}${userId}`) ?? '{}') as Partial<OnboardingProgress>
    return {
      completedTaskIds: Array.isArray(value.completedTaskIds)
        ? value.completedTaskIds.filter((id): id is OnboardingTaskId => ONBOARDING_TASK_IDS.includes(id as OnboardingTaskId))
        : [],
      dismissed: value.dismissed === true,
      ...(typeof value.updatedAt === 'string' ? { updatedAt: value.updatedAt } : {}),
    }
  } catch {
    return { completedTaskIds: [], dismissed: false }
  }
}

export function writeLocalOnboarding(storage: Pick<Storage, 'setItem'>, userId: string, progress: OnboardingProgress) {
  const next = {
    completedTaskIds: [...new Set(progress.completedTaskIds)].filter((id) => ONBOARDING_TASK_IDS.includes(id)),
    dismissed: progress.dismissed,
    updatedAt: new Date().toISOString(),
  }
  storage.setItem(`${ONBOARDING_KEY_PREFIX}${userId}`, JSON.stringify(next))
  return next
}
