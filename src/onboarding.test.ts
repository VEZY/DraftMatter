import { describe, expect, it } from 'vitest'
import {
  buildTutorialSource,
  onboardingTasksFor,
  readLocalOnboarding,
  writeLocalOnboarding,
} from './onboarding'

describe('DraftMatter onboarding', () => {
  it('adapts tasks to role and platform without suggesting browser execution', () => {
    const browserOwner = onboardingTasksFor('owner', false).map((task) => task.id)
    expect(browserOwner).toContain('invite-collaborator')
    expect(browserOwner).toContain('export-checkpoint')
    expect(browserOwner).not.toContain('run-computation')
    expect(browserOwner).not.toContain('reproducible-output')

    const desktopEditor = onboardingTasksFor('editor', true).map((task) => task.id)
    expect(desktopEditor).toContain('run-computation')
    expect(desktopEditor).toContain('review-change')
    expect(desktopEditor).not.toContain('invite-collaborator')

    expect(onboardingTasksFor('viewer', true).map((task) => task.id)).toEqual(['create-or-open'])
  })

  it('persists a dismissible, resumable checklist outside the manuscript', () => {
    const values = new Map<string, string>()
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    }
    writeLocalOnboarding(storage, 'researcher-1', {
      completedTaskIds: ['create-or-open', 'add-citation', 'add-citation'],
      dismissed: true,
    })

    expect(readLocalOnboarding(storage, 'researcher-1')).toMatchObject({
      completedTaskIds: ['create-or-open', 'add-citation'],
      dismissed: true,
    })
    expect([...values.keys()]).toEqual(['draftmatter.onboarding.v1:researcher-1'])
  })

  it('builds an isolated personal tutorial covering the five core workflows', () => {
    const source = buildTutorialSource()
    expect(source).toContain('your personal, editable tutorial copy')
    expect(source).toContain('## Write and organize')
    expect(source).toContain('## Cite a source')
    expect(source).toContain('## Reproducible results')
    expect(source).toContain('## Review')
    expect(source).toContain('## Collaborate and checkpoint')
    expect(source).not.toContain('room')
    expect(source).not.toContain('workspaceId')
  })
})
