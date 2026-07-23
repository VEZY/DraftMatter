import { useEffect, useMemo, useState } from 'react'
import type { CollaborationServiceClient } from './collaboration/serviceClient'
import type { WorkspaceRole } from './collaboration/workspaceService'
import { desktopHost } from './desktopHost'
import { Icon } from './Icon'
import {
  onboardingTasksFor,
  readLocalOnboarding,
  writeLocalOnboarding,
  type OnboardingProgress,
  type OnboardingTaskId,
} from './onboarding'

export function GettingStarted({
  userId,
  role,
  client,
  hasDraft,
  onTutorial,
  onLearn,
}: {
  userId: string
  role: WorkspaceRole
  client?: CollaborationServiceClient | null
  hasDraft: boolean
  onTutorial: () => void
  onLearn: () => void
}) {
  const [progress, setProgress] = useState<OnboardingProgress>(() => readLocalOnboarding(localStorage, userId))
  const [syncNote, setSyncNote] = useState('')
  const tasks = useMemo(() => onboardingTasksFor(role, desktopHost.available), [role])

  useEffect(() => {
    const local = readLocalOnboarding(localStorage, userId)
    const withOpened = hasDraft && !local.completedTaskIds.includes('create-or-open')
      ? writeLocalOnboarding(localStorage, userId, { ...local, completedTaskIds: [...local.completedTaskIds, 'create-or-open'] })
      : local
    setProgress(withOpened)
    if (!client) return
    void client.getOnboardingProgress().then((remote) => {
      const merged = {
        completedTaskIds: [...new Set([...withOpened.completedTaskIds, ...remote.completedTaskIds])],
        dismissed: remote.dismissed,
        updatedAt: remote.updatedAt,
      } satisfies OnboardingProgress
      setProgress(writeLocalOnboarding(localStorage, userId, merged))
      if (merged.completedTaskIds.length !== remote.completedTaskIds.length) {
        void client.updateOnboardingProgress(merged).catch(() => setSyncNote('Checklist changes are saved on this device and will sync when the service is available.'))
      }
    }).catch(() => setSyncNote('Checklist progress is saved on this device while account sync is unavailable.'))
  }, [client, hasDraft, userId])

  const save = (next: OnboardingProgress) => {
    const stored = writeLocalOnboarding(localStorage, userId, next)
    setProgress(stored)
    if (client) void client.updateOnboardingProgress(stored).catch(() => setSyncNote('Checklist progress is saved on this device while account sync is unavailable.'))
  }

  const toggle = (taskId: OnboardingTaskId) => {
    const completed = progress.completedTaskIds.includes(taskId)
    save({
      ...progress,
      completedTaskIds: completed
        ? progress.completedTaskIds.filter((id) => id !== taskId)
        : [...progress.completedTaskIds, taskId],
    })
  }

  if (progress.dismissed) {
    return <div className="getting-started-resume"><Icon name="check" size={15} /><span>Getting started is hidden.</span><button onClick={() => save({ ...progress, dismissed: false })}>Show checklist</button></div>
  }

  const completed = tasks.filter((task) => progress.completedTaskIds.includes(task.id)).length
  return (
    <section className="getting-started" aria-labelledby="getting-started-title">
      <header><div><span className="home-kicker">A quiet guide</span><h2 id="getting-started-title">Getting started</h2><p>{completed} of {tasks.length} relevant steps complete</p></div><button onClick={() => save({ ...progress, dismissed: true })} aria-label="Hide Getting started checklist"><Icon name="close" size={15} /></button></header>
      <div className="getting-started-progress" aria-hidden="true"><span style={{ width: `${tasks.length ? completed / tasks.length * 100 : 0}%` }} /></div>
      <div className="getting-started-tasks">
        {tasks.map((task) => {
          const done = progress.completedTaskIds.includes(task.id)
          return <button key={task.id} className={done ? 'complete' : ''} onClick={() => toggle(task.id)} aria-pressed={done}><span>{done ? <Icon name="check" size={14} /> : null}</span><span><strong>{task.label}</strong><small>{task.detail}</small></span></button>
        })}
      </div>
      {syncNote && <p className="getting-started-sync" role="status">{syncNote}</p>}
      <footer><button onClick={onTutorial}><Icon name="spark" size={15} />Open my tutorial</button><button onClick={onLearn}>Learn DraftMatter <Icon name="arrowRight" size={14} /></button></footer>
    </section>
  )
}
