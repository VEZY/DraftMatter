import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'
import { desktopHost, type ProjectSnapshot } from './desktopHost'
import { Icon } from './Icon'
import {
  NEW_DRAFT_TEMPLATES,
  buildNewDraftSource,
  portableDraftId,
  type NewDraftTemplateId,
} from './newDraftTemplates'
import { readUserSettings } from './userSettings'
import { useCollaborationSession, type CollaborationProjectLaunch } from './collaboration/sessionContext'
import type { WorkspaceProject } from './collaboration/workspaceService'
import './newDraft.css'

type DraftLocation = 'collaborative' | 'local'

interface NewDraftWizardProps {
  open: boolean
  initialLocation?: DraftLocation
  onClose: () => void
  onCollaborativeCreated: (launch: CollaborationProjectLaunch) => void
  onLocalCreated: (project: ProjectSnapshot) => void
}

function readableError(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function splitAuthors(value: string) {
  return value.split(/\n|;/).map((author) => author.trim()).filter(Boolean)
}

export function NewDraftWizard({
  open,
  initialLocation = 'collaborative',
  onClose,
  onCollaborativeCreated,
  onLocalCreated,
}: NewDraftWizardProps) {
  const session = useCollaborationSession()
  const dialogRef = useRef<HTMLDivElement>(null)
  const returnFocusRef = useRef<HTMLElement | null>(null)
  const [step, setStep] = useState<1 | 2 | 3>(1)
  const [location, setLocation] = useState<DraftLocation>('collaborative')
  const [templateId, setTemplateId] = useState<NewDraftTemplateId>('imrad')
  const [importedSource, setImportedSource] = useState('')
  const [importedName, setImportedName] = useState('')
  const [title, setTitle] = useState('')
  const [projectId, setProjectId] = useState('')
  const [leadAuthor, setLeadAuthor] = useState(() => session.profile?.displayName ?? readUserSettings(localStorage).author.name)
  const [additionalAuthors, setAdditionalAuthors] = useState('')
  const [language, setLanguage] = useState<'en' | 'fr'>('en')
  const [citationStyle, setCitationStyle] = useState<'draftmatter-author-date' | 'draftmatter-numeric'>('draftmatter-author-date')
  const [workspaceId, setWorkspaceId] = useState(() => session.workspaces[0]?.id ?? '')
  const [createWorkspace, setCreateWorkspace] = useState(session.workspaces.length === 0)
  const [workspaceName, setWorkspaceName] = useState('')
  const [workspacePortableId, setWorkspacePortableId] = useState('')
  const [localParent, setLocalParent] = useState('')
  const [enableAi, setEnableAi] = useState(false)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState('')
  const createdRemoteRef = useRef<{ workspaceId: string; project: WorkspaceProject } | null>(null)

  const selectedTemplate = useMemo(() => NEW_DRAFT_TEMPLATES.find((template) => template.id === templateId)!, [templateId])

  useEffect(() => {
    if (!open) return
    returnFocusRef.current = document.activeElement as HTMLElement | null
    setStep(1)
    setLocation(initialLocation)
    setProblem('')
    createdRemoteRef.current = null
    requestAnimationFrame(() => dialogRef.current?.focus())
  }, [initialLocation, open])

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || busy) return
      event.preventDefault()
      onClose()
      requestAnimationFrame(() => returnFocusRef.current?.focus())
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [busy, onClose, open])

  if (!open) return null

  const close = () => {
    if (busy) return
    onClose()
    requestAnimationFrame(() => returnFocusRef.current?.focus())
  }

  const readImport = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    if (!/\.(qmd|md)$/i.test(file.name)) {
      setProblem('Choose a Markdown or Quarto manuscript (.md or .qmd).')
      return
    }
    if (file.size > 5 * 1024 * 1024) {
      setProblem('Manuscripts larger than 5 MB are not imported.')
      return
    }
    setProblem('')
    setImportedSource(await file.text())
    setImportedName(file.name)
    if (!title.trim()) {
      const importedTitle = file.name.replace(/\.(qmd|md)$/i, '').replaceAll(/[-_]+/g, ' ')
      setTitle(importedTitle)
      setProjectId(portableDraftId(importedTitle))
    }
  }

  const source = () => {
    if (templateId === 'import') {
      if (!importedSource) throw new Error('Choose a manuscript to import.')
      return importedSource
    }
    return buildNewDraftSource(templateId, {
      title,
      leadAuthor,
      additionalAuthors: splitAuthors(additionalAuthors),
      language,
      citationStyle,
    })
  }

  const chooseLocalParent = async () => {
    const selected = await desktopHost.pickProjectFolder('Choose where DraftMatter should create the project folder')
    if (selected) setLocalParent(selected)
  }

  const ensureRemoteProject = async (nextWorkspaceId: string) => {
    if (!session.client) throw new Error('Sign in before creating a collaborative draft.')
    const requestedId = projectId.trim()
    const existing = await session.client.listProjects(nextWorkspaceId)
    const prior = existing.find((project) => project.id === requestedId)
    if (prior && createdRemoteRef.current?.project.id !== prior.id) {
      throw new Error('That portable project ID is already used in this workspace. Choose another ID.')
    }
    if (createdRemoteRef.current) return createdRemoteRef.current.project
    try {
      const project = await session.client.createProject(nextWorkspaceId, { id: requestedId, name: title.trim() })
      createdRemoteRef.current = { workspaceId: nextWorkspaceId, project }
      return project
    } catch (error) {
      const after = await session.client.listProjects(nextWorkspaceId).catch(() => [])
      const recovered = after.find((project) => project.id === requestedId && project.name === title.trim())
      if (!recovered) throw error
      createdRemoteRef.current = { workspaceId: nextWorkspaceId, project: recovered }
      return recovered
    }
  }

  const createDraft = async () => {
    setProblem('')
    if (!title.trim()) {
      setProblem('Enter a working title.')
      return
    }
    if (!projectId.trim() || !/^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/.test(projectId.trim())) {
      setProblem('The portable project ID must start with a letter and use only letters, numbers, dots, colons, underscores, or hyphens.')
      return
    }
    if (!leadAuthor.trim()) {
      setProblem('Enter the lead author name.')
      return
    }
    setBusy(true)
    try {
      const portableSource = source()
      if (location === 'local') {
        if (!localParent) throw new Error('Choose the folder where DraftMatter should create this project.')
        const created = await desktopHost.createProject(localParent, title.trim(), { name: leadAuthor.trim(), affiliations: [] }, enableAi)
        const manuscript = created.documents.find((document) => document.path === created.config.mainDocument)
        if (!manuscript) throw new Error('The new local project did not contain its main manuscript.')
        await desktopHost.saveDocument({
          root: created.root,
          path: created.config.mainDocument,
          content: portableSource,
          expectedHash: manuscript.hash,
        })
        await desktopHost.setCitationPreferences(created.root, citationStyle, language === 'fr' ? 'fr-FR' : 'en-US')
        onLocalCreated(await desktopHost.openProject(created.root))
        return
      }

      if (!session.client || !session.profile || !session.token) throw new Error('Sign in before creating a collaborative draft.')
      let nextWorkspaceId = workspaceId
      if (createWorkspace) {
        if (!workspaceName.trim()) throw new Error('Enter a workspace name.')
        if (!/^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/.test(workspacePortableId.trim())) throw new Error('Enter a valid portable workspace ID.')
        const existingWorkspace = session.workspaces.find((workspace) => workspace.id === workspacePortableId.trim())
        const workspace = existingWorkspace ?? await session.client.createWorkspace({ id: workspacePortableId.trim(), name: workspaceName.trim() })
        nextWorkspaceId = workspace.id
      }
      if (!nextWorkspaceId) throw new Error('Choose a workspace.')
      const project = await ensureRemoteProject(nextWorkspaceId)
      const [workspaces, projects] = await Promise.all([
        session.client.listWorkspaces(),
        session.client.listProjects(nextWorkspaceId),
      ])
      void session.refresh()
      onCollaborativeCreated({
        serviceUrl: session.serviceUrl,
        token: session.token,
        client: session.client,
        profile: session.profile,
        workspaces,
        projects,
        workspaceId: nextWorkspaceId,
        projectId: project.id,
        bootstrapSource: portableSource,
        canBootstrap: true,
        requireEmptyForBootstrap: true,
      })
    } catch (error) {
      setProblem(readableError(error))
    } finally {
      setBusy(false)
    }
  }

  const next = () => {
    setProblem('')
    if (step === 1) {
      if (location === 'collaborative' && !session.profile) {
        setProblem('Sign in from Home before creating a collaborative draft.')
        return
      }
      setStep(2)
      return
    }
    if (templateId === 'import' && !importedSource) {
      setProblem('Choose a manuscript to import.')
      return
    }
    setStep(3)
  }

  return (
    <div className="new-draft-backdrop" onMouseDown={close}>
      <div ref={dialogRef} className="new-draft-dialog" role="dialog" aria-modal="true" aria-labelledby="new-draft-title" tabIndex={-1} onMouseDown={(event) => event.stopPropagation()}>
        <header>
          <div><span className="home-kicker">New draft · Step {step} of 3</span><h1 id="new-draft-title">{step === 1 ? 'Where will this draft live?' : step === 2 ? 'Choose a starting point' : 'Name the work'}</h1></div>
          <button className="new-draft-close" onClick={close} aria-label="Close new draft"><Icon name="close" size={17} /></button>
        </header>

        <div className="new-draft-progress" aria-label={`Step ${step} of 3`}>{[1, 2, 3].map((value) => <span key={value} className={value <= step ? 'current' : ''} />)}</div>

        {step === 1 && (
          <div className="new-draft-options">
            <button className={location === 'collaborative' ? 'selected' : ''} onClick={() => setLocation('collaborative')}>
              <span><Icon name="users" size={20} /></span><strong>Collaborative draft</strong><small>Write and review together online. Code cannot run online.</small>
            </button>
            {desktopHost.available && <button className={location === 'local' ? 'selected' : ''} onClick={() => setLocation('local')}><span><Icon name="folder" size={20} /></span><strong>On this computer</strong><small>Work in a portable project folder and run code on your computer.</small></button>}
            <p className="new-draft-location-note">Drafts can move either way: open an online draft on your computer to run code, or put a local draft online to collaborate.</p>
          </div>
        )}

        {step === 2 && (
          <div className="new-draft-templates">
            {NEW_DRAFT_TEMPLATES.map((template) => (
              <label key={template.id} className={templateId === template.id ? 'selected' : ''}>
                <input type="radio" name="template" value={template.id} checked={templateId === template.id} onChange={() => setTemplateId(template.id)} />
                <span><strong>{template.name}</strong><small>{template.description}</small></span>
                {templateId === template.id && <Icon name="check" size={16} />}
              </label>
            ))}
            {templateId === 'import' && <label className="new-draft-import"><span>Portable manuscript</span><input type="file" accept=".md,.qmd,text/markdown" onChange={(event) => void readImport(event)} /><small>{importedName || 'Markdown or Quarto · up to 5 MB'}</small></label>}
          </div>
        )}

        {step === 3 && (
          <div className="new-draft-details">
            <label><span>Working title</span><input autoFocus value={title} maxLength={240} onChange={(event) => { setTitle(event.target.value); if (!projectId || projectId === portableDraftId(title)) setProjectId(portableDraftId(event.target.value)) }} required /></label>
            <div className="new-draft-field-row">
              <label><span>Lead author</span><input value={leadAuthor} onChange={(event) => setLeadAuthor(event.target.value)} required /></label>
              <label><span>Additional authors <small>optional</small></span><textarea value={additionalAuthors} onChange={(event) => setAdditionalAuthors(event.target.value)} placeholder="One per line" /></label>
            </div>
            <div className="new-draft-field-row compact">
              <label><span>Language</span><select value={language} onChange={(event) => setLanguage(event.target.value as 'en' | 'fr')}><option value="en">English</option><option value="fr">French</option></select></label>
              <label><span>Citation style</span><select value={citationStyle} onChange={(event) => setCitationStyle(event.target.value as typeof citationStyle)}><option value="draftmatter-author-date">Author–date</option><option value="draftmatter-numeric">Numeric</option></select></label>
            </div>
            <details>
              <summary>Portable identifiers</summary>
              <label><span>Project ID</span><input value={projectId} onChange={(event) => setProjectId(event.target.value)} autoCapitalize="none" spellCheck={false} /></label>
            </details>

            {location === 'collaborative' ? (
              <section className="new-draft-location-details">
                <label className="new-draft-check"><input type="checkbox" checked={createWorkspace} onChange={(event) => setCreateWorkspace(event.target.checked)} /><span>Create a new workspace</span></label>
                {createWorkspace ? <div className="new-draft-field-row"><label><span>Workspace name</span><input value={workspaceName} onChange={(event) => { setWorkspaceName(event.target.value); setWorkspacePortableId(portableDraftId(event.target.value)) }} /></label><label><span>Workspace ID</span><input value={workspacePortableId} onChange={(event) => setWorkspacePortableId(event.target.value)} /></label></div> : <label><span>Workspace</span><select value={workspaceId} onChange={(event) => setWorkspaceId(event.target.value)}>{session.workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name} · {workspace.role}</option>)}</select></label>}
              </section>
            ) : (
              <section className="new-draft-local-options">
                <div className="new-draft-location-details"><span>Folder location</span><div className="new-draft-folder"><code title={localParent}>{localParent || 'No folder chosen'}</code><button type="button" onClick={() => void chooseLocalParent()}>Choose…</button></div><small>DraftMatter creates a new folder named from the working title inside this location.</small></div>
                <label className="new-draft-ai-enable">
                  <input type="checkbox" checked={enableAi} onChange={(event) => setEnableAi(event.target.checked)} />
                  <span><strong>Enable AI for this project</strong><small>Add managed instruction pointers, an enablement manifest, and a portable skill fallback. Connecting assistants is a separate device-wide step.</small></span>
                </label>
              </section>
            )}
            <p className="new-draft-summary"><Icon name={location === 'collaborative' ? 'users' : 'folder'} size={16} /><span><strong>{selectedTemplate.name}</strong><small>{location === 'collaborative' ? 'The remote record and its portable manuscript are initialized together.' : 'The selected manuscript is written into a new local project folder.'}</small></span></p>
          </div>
        )}

        {problem && <p className="new-draft-problem" role="alert">{problem}</p>}

        <footer>
          <button onClick={step === 1 ? close : () => setStep((step - 1) as 1 | 2)} disabled={busy}>{step === 1 ? 'Cancel' : 'Back'}</button>
          {step < 3
            ? <button className="home-primary" onClick={next}>Continue</button>
            : <button className="home-primary" onClick={() => void createDraft()} disabled={busy}>{busy ? 'Creating draft…' : 'Create draft'}</button>}
        </footer>
      </div>
    </div>
  )
}
