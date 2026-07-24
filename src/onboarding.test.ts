import { describe, expect, it } from 'vitest'
import {
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

})
