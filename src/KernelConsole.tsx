import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { ExecutionLanguage } from './executionCells'
import { stripTerminalControlSequences, type NormalizedExecutionResult } from './kernelExecution'
import { publishedValuesFromExecution, renderPublishedValue } from './publishedValues'

export type KernelConsoleStatus = 'not-started' | 'starting' | 'ready' | 'busy' | 'interrupted' | 'failed'
export type KernelConsoleStatuses = Record<ExecutionLanguage, KernelConsoleStatus>
export type KernelConsoleRestartEpochs = Record<ExecutionLanguage, number>

export interface KernelProjectActivity {
  id: string
  title: string
  status: 'running' | 'succeeded' | 'failed'
  output: string
  language?: ExecutionLanguage
}

export interface KernelCellFailure {
  id: number
  cellId: string
  language: ExecutionLanguage
  result?: NormalizedExecutionResult
  message?: string
}

interface ConsoleEntry {
  id: number
  prompt: string
  code: string
  setupCode?: string
  result?: NormalizedExecutionResult
  error?: string
  sourceCellId?: string
}

export type JuliaTerminalMode = 'julia' | 'pkg' | 'shell' | 'help'

const languageLabel: Record<ExecutionLanguage, string> = { python: 'Python', r: 'R', julia: 'Julia' }
const languagePrompt: Record<ExecutionLanguage, string> = { python: '>>>', r: '>', julia: 'julia>' }

const juliaModePrefix: Record<string, JuliaTerminalMode> = { ']': 'pkg', ';': 'shell', '?': 'help' }
export { stripTerminalControlSequences } from './kernelExecution'

function juliaStringLiteral(value: string) {
  return `"${value
    .replaceAll('\\', '\\\\')
    .replaceAll('$', '\\$')
    .replaceAll('"', '\\"')
    .replaceAll('\r', '\\r')
    .replaceAll('\n', '\\n')
    .replaceAll('\t', '\\t')}"`
}

export function juliaTerminalPrompt(mode: JuliaTerminalMode, projectLabel = 'project') {
  if (mode === 'pkg') return `(${projectLabel}) pkg>`
  if (mode === 'shell') return 'shell>'
  if (mode === 'help') return 'help?>'
  return 'julia>'
}

export function juliaTerminalCode(mode: JuliaTerminalMode, code: string) {
  const literal = juliaStringLiteral(code)
  if (mode === 'pkg') return `import Pkg; Pkg.REPLMode.pkgstr(${literal})`
  if (mode === 'shell') return `Base.repl_cmd(Core.eval(Main, :(Base.cmd_gen($(Base.shell_parse(${literal})[1])))), stdout)`
  if (mode === 'help') return `import REPL; REPL.helpmode(stdout, ${literal}, Main)`
  return code
}

function statusLabel(status: KernelConsoleStatus) {
  return status === 'not-started' ? 'not started' : status
}

function textualMime(result: NormalizedExecutionResult) {
  return result.mime.flatMap((bundle) => {
    const markdown = bundle.data['text/markdown']
    if (typeof markdown === 'string') return [stripTerminalControlSequences(markdown)]
    const plain = bundle.data['text/plain']
    return typeof plain === 'string' && plain.trim() ? [stripTerminalControlSequences(plain)] : []
  })
}

export function KernelConsole({
  languages,
  projectLabel,
  preferredLanguage,
  preferredLanguageEpoch,
  statuses,
  restartEpochs,
  projectActivity,
  cellFailure,
  onExecute,
  onInterrupt,
  onRestart,
  onStatusChange,
  onDirtyChange,
  onPromoteSetup,
  onClose,
}: {
  languages: ExecutionLanguage[]
  projectLabel?: string
  preferredLanguage?: ExecutionLanguage
  preferredLanguageEpoch?: number
  statuses: KernelConsoleStatuses
  restartEpochs: KernelConsoleRestartEpochs
  projectActivity?: KernelProjectActivity
  cellFailure?: KernelCellFailure
  onExecute: (language: ExecutionLanguage, code: string) => Promise<NormalizedExecutionResult>
  onInterrupt: (language: ExecutionLanguage) => Promise<void>
  onRestart: (language: ExecutionLanguage) => Promise<void>
  onStatusChange: (language: ExecutionLanguage, status: KernelConsoleStatus) => void
  onDirtyChange: (dirty: boolean) => void
  onPromoteSetup: (language: ExecutionLanguage, code: string) => void
  onClose: () => void
}) {
  const [active, setActive] = useState<ExecutionLanguage>(languages[0] ?? 'python')
  const [activeView, setActiveView] = useState<ExecutionLanguage | 'project'>(languages[0] ?? 'python')
  const [juliaMode, setJuliaMode] = useState<JuliaTerminalMode>('julia')
  const [input, setInput] = useState('')
  const [entries, setEntries] = useState<Record<ExecutionLanguage, ConsoleEntry[]>>({ python: [], r: [], julia: [] })
  const [histories, setHistories] = useState<Record<ExecutionLanguage, string[]>>({ python: [], r: [], julia: [] })
  const [historyIndex, setHistoryIndex] = useState<number>()
  const [height, setHeight] = useState(310)
  const counter = useRef(0)
  const outputRef = useRef<HTMLDivElement>(null)
  const projectOutputRef = useRef<HTMLPreElement>(null)
  const previousRestartEpochs = useRef(restartEpochs)

  useEffect(() => {
    if (!languages.includes(active) && languages[0]) {
      setActive(languages[0])
      if (activeView !== 'project') setActiveView(languages[0])
    }
  }, [active, activeView, languages])

  useEffect(() => {
    if (preferredLanguage && languages.includes(preferredLanguage)) {
      setActive(preferredLanguage)
      setActiveView(preferredLanguage)
    }
  }, [languages, preferredLanguage, preferredLanguageEpoch])

  useEffect(() => {
    if (projectActivity) setActiveView('project')
  }, [projectActivity?.id])

  useEffect(() => {
    if (!cellFailure) return
    const id = ++counter.current
    setEntries((current) => ({
      ...current,
      [cellFailure.language]: [...current[cellFailure.language], {
        id,
        prompt: 'cell',
        code: cellFailure.cellId,
        result: cellFailure.result,
        error: cellFailure.result ? undefined : cellFailure.message,
        sourceCellId: cellFailure.cellId,
      }],
    }))
    setActive(cellFailure.language)
    setActiveView(cellFailure.language)
    setHistoryIndex(undefined)
  }, [cellFailure?.id])

  useEffect(() => {
    if (typeof outputRef.current?.scrollTo === 'function') outputRef.current.scrollTo({ top: outputRef.current.scrollHeight })
  }, [entries, active])

  useEffect(() => {
    const output = projectOutputRef.current
    if (output) output.scrollTop = output.scrollHeight
  }, [projectActivity?.output, activeView])

  useEffect(() => {
    const reset = (['python', 'r', 'julia'] as const).filter((language) => previousRestartEpochs.current[language] !== restartEpochs[language])
    previousRestartEpochs.current = restartEpochs
    if (!reset.length) return
    setHistories((current) => ({ ...current, ...Object.fromEntries(reset.map((language) => [language, []])) }))
    if (reset.includes('julia')) setJuliaMode('julia')
    setHistoryIndex(undefined)
  }, [restartEpochs])

  useEffect(() => {
    onDirtyChange((['python', 'r', 'julia'] as const).some((language) => histories[language].length > 0))
  }, [histories, onDirtyChange])

  const currentEntries = entries[active]
  const dirty = histories[active].length > 0
  const canRun = Boolean(input.trim()) && statuses[active] !== 'busy' && statuses[active] !== 'starting'
  const currentPrompt = active === 'julia' ? juliaTerminalPrompt(juliaMode, projectLabel) : languagePrompt[active]
  const latestCode = useMemo(() => [...currentEntries].reverse().find((entry) => entry.setupCode)?.setupCode, [currentEntries])

  const copyVisibleOutput = async () => {
    const text = currentEntries.map((entry) => {
      const streams = entry.result?.streams.map((stream) => stripTerminalControlSequences(stream.text)).join('') ?? ''
      const mime = entry.result ? textualMime(entry.result).join('\n') : ''
      const errors = entry.result?.errors.map((error) => stripTerminalControlSequences(`${error.name}: ${error.message}`)).join('\n') ?? stripTerminalControlSequences(entry.error ?? '')
      return [entry.sourceCellId ? `[cell ${entry.sourceCellId} failed]` : `${entry.prompt} ${entry.code}`, streams, mime, errors].filter(Boolean).join('\n')
    }).join('\n\n')
    if (text && globalThis.navigator?.clipboard) {
      try {
        await globalThis.navigator.clipboard.writeText(text)
      } catch {
        // The output remains selectable when clipboard permission is unavailable.
      }
    }
  }

  const run = async () => {
    const enteredCode = input.trimEnd()
    if (!enteredCode.trim() || !canRun) return
    let mode = active === 'julia' ? juliaMode : undefined
    let code = enteredCode
    if (active === 'julia' && mode === 'julia') {
      const inlineMode = juliaModePrefix[code[0]]
      if (inlineMode) {
        setJuliaMode(inlineMode)
        mode = inlineMode
        code = code.slice(1).trimStart()
        setInput('')
        if (!code) return
      }
    }
    const prompt = active === 'julia' ? juliaTerminalPrompt(mode ?? 'julia', projectLabel) : languagePrompt[active]
    const executionCode = active === 'julia' ? juliaTerminalCode(mode ?? 'julia', code) : code
    const setupCode = active !== 'julia' || mode === 'julia' ? code : undefined
    const id = ++counter.current
    setEntries((current) => ({ ...current, [active]: [...current[active], { id, prompt, code, setupCode }] }))
    setHistories((current) => ({ ...current, [active]: [...current[active], code] }))
    setHistoryIndex(undefined)
    setInput('')
    onStatusChange(active, statuses[active] === 'not-started' ? 'starting' : 'busy')
    await Promise.resolve()
    onStatusChange(active, 'busy')
    try {
      const result = await onExecute(active, executionCode)
      setEntries((current) => ({ ...current, [active]: current[active].map((entry) => entry.id === id ? { ...entry, result } : entry) }))
      onStatusChange(active, result.status === 'interrupted' ? 'interrupted' : result.status === 'failed' ? 'failed' : 'ready')
    } catch (error) {
      setEntries((current) => ({ ...current, [active]: current[active].map((entry) => entry.id === id ? { ...entry, error: error instanceof Error ? error.message : String(error) } : entry) }))
      onStatusChange(active, 'failed')
    }
  }

  const browseHistory = (direction: -1 | 1) => {
    const history = histories[active]
    if (!history.length) return
    const next = Math.max(0, Math.min(history.length, (historyIndex ?? history.length) + direction))
    setHistoryIndex(next)
    setInput(next === history.length ? '' : history[next])
  }

  const startResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const startY = event.clientY
    const startHeight = height
    const move = (pointer: PointerEvent) => setHeight(Math.max(210, Math.min(globalThis.innerHeight * .72, startHeight + startY - pointer.clientY)))
    const stop = () => {
      globalThis.removeEventListener('pointermove', move)
      globalThis.removeEventListener('pointerup', stop)
    }
    globalThis.addEventListener('pointermove', move)
    globalThis.addEventListener('pointerup', stop, { once: true })
  }

  return <section className="kernel-console kernel-terminal" aria-label="Shared kernel terminal" style={{ height }}>
    <button className="kernel-console-resize" onPointerDown={startResize} aria-label="Resize kernel terminal" title="Drag to resize" />
    <header>
      <div className="kernel-console-tabs" role="tablist" aria-label="Kernel language">
        {languages.map((language) => <button key={language} role="tab" aria-selected={activeView === language} onClick={() => { setActive(language); setActiveView(language); setHistoryIndex(undefined) }}>
          <span>{languageLabel[language]}</span><i className={statuses[language]} /> <small>{statusLabel(statuses[language])}</small>
        </button>)}
        {projectActivity && <button className="kernel-project-tab" role="tab" aria-selected={activeView === 'project'} data-status={projectActivity.status} onClick={() => setActiveView('project')} title={projectActivity.title}>
          <span>Project</span><i className={projectActivity.status === 'running' ? 'busy' : projectActivity.status === 'succeeded' ? 'ready' : 'failed'} /> <small>{projectActivity.status === 'running' ? 'working' : projectActivity.status === 'succeeded' ? 'ready' : 'attention'}</small>
        </button>}
      </div>
      <span className={`kernel-console-dirty ${dirty ? 'dirty' : ''}`}>{dirty ? 'Interactive · clean run will restart this kernel' : 'Reproducible session'}</span>
      <button onClick={onClose} aria-label="Close kernel terminal">Close</button>
    </header>
    {activeView === 'project' && projectActivity ? <div className="kernel-project-activity" data-status={projectActivity.status}>
      <div className="kernel-project-activity-head">
        <span className="setup-activity-indicator" aria-hidden="true" />
        <span><strong>{projectActivity.title}</strong><small>{projectActivity.status === 'running' ? 'Project process · live output · editor remains usable' : projectActivity.status === 'succeeded' ? 'Process completed successfully' : 'Process needs attention'}</small></span>
      </div>
      <pre ref={projectOutputRef} className="kernel-project-activity-output" role="log" aria-live="polite">{projectActivity.output}</pre>
      <div className="kernel-project-activity-footer">
        <span>{projectActivity.status === 'running' ? 'Working…' : projectActivity.status === 'succeeded' ? 'Ready' : 'Setup stopped'}</span>
        {projectActivity.language && <button onClick={() => { setActive(projectActivity.language!); setActiveView(projectActivity.language!); setHistoryIndex(undefined) }}>Open {languageLabel[projectActivity.language]} REPL</button>}
      </div>
    </div> : <>
    <div className="kernel-console-output" ref={outputRef} aria-live="polite">
      {!currentEntries.length && <div className="kernel-console-empty"><strong>{languageLabel[active]} REPL · shared document kernel</strong>{active === 'julia' && <><code>$ julia --project=.</code><span>Type <kbd>]</kbd> for Pkg mode, <kbd>;</kbd> for shell mode, or <kbd>?</kbd> for help. Backspace on an empty prompt returns to Julia mode.</span></>}<span>Commands run in the same live session as document cells, so variables, imports, and working state are shared.</span></div>}
      {currentEntries.map((entry) => {
        const published = entry.result ? publishedValuesFromExecution(entry.result).records : []
        return <div className="kernel-console-entry" key={entry.id}>
          <pre className={`kernel-console-input ${entry.sourceCellId ? 'document-cell-failure' : ''}`}><span>{entry.prompt}</span>{entry.sourceCellId ? `${entry.sourceCellId} failed` : entry.code}</pre>
          {entry.result?.streams.map((stream) => <pre className={`kernel-console-stream ${stream.name}`} key={`${entry.id}-${stream.sequence}`}>{stripTerminalControlSequences(stream.text)}</pre>)}
          {entry.result && textualMime(entry.result).map((value, index) => <pre className="kernel-console-result" key={`${entry.id}-mime-${index}`}>{value}</pre>)}
          {published.map((record) => <div className="kernel-console-published" key={record.name}><span>{`{{${record.name}}}`}</span><strong>{renderPublishedValue(record)}</strong><small>session preview only</small></div>)}
          {entry.result?.errors.map((error, index) => <pre className="kernel-console-error" key={`${entry.id}-error-${index}`}>{stripTerminalControlSequences(`${error.name}: ${error.message}${error.traceback.length ? `\n${error.traceback.join('\n')}` : ''}`)}</pre>)}
          {entry.error && <pre className="kernel-console-error">{stripTerminalControlSequences(entry.error)}</pre>}
        </div>
      })}
    </div>
    <div className="kernel-console-compose">
      <div className={`kernel-terminal-command terminal-mode-${active === 'julia' ? juliaMode : active}`}><span aria-hidden="true">{currentPrompt}</span><textarea value={input} onChange={(event) => {
        const value = event.target.value
        const nextMode = active === 'julia' && juliaMode === 'julia' ? juliaModePrefix[value] : undefined
        if (nextMode) {
          setJuliaMode(nextMode)
          setInput('')
          setHistoryIndex(undefined)
        } else setInput(value)
      }} onKeyDown={(event) => {
        if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void run() }
        else if (active === 'julia' && juliaMode !== 'julia' && !input && (event.key === 'Backspace' || event.key === 'Escape')) { event.preventDefault(); setJuliaMode('julia'); setHistoryIndex(undefined) }
        else if (event.key === 'ArrowUp' && !input.includes('\n')) { event.preventDefault(); browseHistory(-1) }
        else if (event.key === 'ArrowDown' && historyIndex !== undefined && !input.includes('\n')) { event.preventDefault(); browseHistory(1) }
      }} placeholder={active === 'julia' && juliaMode === 'pkg' ? 'Type a Pkg command…' : active === 'julia' && juliaMode === 'shell' ? 'Type a shell command…' : active === 'julia' && juliaMode === 'help' ? 'Search Julia help…' : `Type ${languageLabel[active]} code…`} aria-label={`${languageLabel[active]} terminal input`} spellCheck={false} rows={2} /></div>
      <div className="kernel-terminal-actions">
        <span>{active === 'julia' && juliaMode !== 'julia' ? <><kbd>Backspace</kbd> Julia mode · </> : null}<kbd>Enter</kbd> Run · <kbd>Shift</kbd><kbd>Enter</kbd> adds a line · shared with document cells</span>
        <button onClick={() => { if (latestCode) onPromoteSetup(active, latestCode) }} disabled={!latestCode}>Make setup cell</button>
        <button onClick={() => void copyVisibleOutput()} disabled={!currentEntries.length}>Copy</button>
        <button onClick={() => setEntries((current) => ({ ...current, [active]: [] }))}>Clear</button>
        <button onClick={async () => { await onInterrupt(active); onStatusChange(active, 'interrupted') }} disabled={statuses[active] !== 'busy'}>Interrupt</button>
        <button onClick={async () => {
          onStatusChange(active, 'starting')
          try {
            await onRestart(active)
            setHistories((current) => ({ ...current, [active]: [] }))
            if (active === 'julia') setJuliaMode('julia')
            onStatusChange(active, 'ready')
          } catch {
            onStatusChange(active, 'failed')
          }
        }}>Restart</button>
        <button className="primary" onClick={() => void run()} disabled={!canRun}>Run</button>
      </div>
    </div>
    </>}
  </section>
}
