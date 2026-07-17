import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { ExecutionLanguage } from './executionCells'
import type { NormalizedExecutionResult } from './kernelExecution'
import { publishedValuesFromExecution, renderPublishedValue } from './publishedValues'

export type KernelConsoleStatus = 'not-started' | 'starting' | 'ready' | 'busy' | 'interrupted' | 'failed'

interface ConsoleEntry {
  id: number
  code: string
  result?: NormalizedExecutionResult
  error?: string
}

const languageLabel: Record<ExecutionLanguage, string> = { python: 'Python', r: 'R', julia: 'Julia' }

function statusLabel(status: KernelConsoleStatus) {
  return status === 'not-started' ? 'not started' : status
}

function textualMime(result: NormalizedExecutionResult) {
  return result.mime.flatMap((bundle) => {
    const markdown = bundle.data['text/markdown']
    if (typeof markdown === 'string') return [markdown]
    const plain = bundle.data['text/plain']
    return typeof plain === 'string' && plain.trim() ? [plain] : []
  })
}

export function KernelConsole({
  languages,
  onExecute,
  onInterrupt,
  onRestart,
  onPromoteSetup,
  onClose,
}: {
  languages: ExecutionLanguage[]
  onExecute: (language: ExecutionLanguage, code: string) => Promise<NormalizedExecutionResult>
  onInterrupt: (language: ExecutionLanguage) => Promise<void>
  onRestart: (language: ExecutionLanguage) => Promise<void>
  onPromoteSetup: (language: ExecutionLanguage, code: string) => void
  onClose: () => void
}) {
  const [active, setActive] = useState<ExecutionLanguage>(languages[0] ?? 'python')
  const [input, setInput] = useState('')
  const [statuses, setStatuses] = useState<Record<ExecutionLanguage, KernelConsoleStatus>>({ python: 'not-started', r: 'not-started', julia: 'not-started' })
  const [entries, setEntries] = useState<Record<ExecutionLanguage, ConsoleEntry[]>>({ python: [], r: [], julia: [] })
  const [histories, setHistories] = useState<Record<ExecutionLanguage, string[]>>({ python: [], r: [], julia: [] })
  const [historyIndex, setHistoryIndex] = useState<number>()
  const [height, setHeight] = useState(310)
  const counter = useRef(0)
  const outputRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!languages.includes(active) && languages[0]) setActive(languages[0])
  }, [active, languages])

  useEffect(() => {
    if (typeof outputRef.current?.scrollTo === 'function') outputRef.current.scrollTo({ top: outputRef.current.scrollHeight })
  }, [entries, active])

  const currentEntries = entries[active]
  const dirty = histories[active].length > 0
  const canRun = Boolean(input.trim()) && statuses[active] !== 'busy' && statuses[active] !== 'starting'
  const latestCode = useMemo(() => histories[active].at(-1), [active, histories])

  const copyVisibleOutput = async () => {
    const text = currentEntries.map((entry) => {
      const streams = entry.result?.streams.map((stream) => stream.text).join('') ?? ''
      const mime = entry.result ? textualMime(entry.result).join('\n') : ''
      const errors = entry.result?.errors.map((error) => `${error.name}: ${error.message}`).join('\n') ?? entry.error ?? ''
      return [`> ${entry.code}`, streams, mime, errors].filter(Boolean).join('\n')
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
    const code = input.trimEnd()
    if (!code.trim() || !canRun) return
    const id = ++counter.current
    setEntries((current) => ({ ...current, [active]: [...current[active], { id, code }] }))
    setHistories((current) => ({ ...current, [active]: [...current[active], code] }))
    setHistoryIndex(undefined)
    setInput('')
    setStatuses((current) => ({ ...current, [active]: current[active] === 'not-started' ? 'starting' : 'busy' }))
    await Promise.resolve()
    setStatuses((current) => ({ ...current, [active]: 'busy' }))
    try {
      const result = await onExecute(active, code)
      setEntries((current) => ({ ...current, [active]: current[active].map((entry) => entry.id === id ? { ...entry, result } : entry) }))
      setStatuses((current) => ({ ...current, [active]: result.status === 'interrupted' ? 'interrupted' : result.status === 'failed' ? 'failed' : 'ready' }))
    } catch (error) {
      setEntries((current) => ({ ...current, [active]: current[active].map((entry) => entry.id === id ? { ...entry, error: error instanceof Error ? error.message : String(error) } : entry) }))
      setStatuses((current) => ({ ...current, [active]: 'failed' }))
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

  return <section className="kernel-console" aria-label="Shared kernel console" style={{ height }}>
    <button className="kernel-console-resize" onPointerDown={startResize} aria-label="Resize kernel console" title="Drag to resize" />
    <header>
      <div className="kernel-console-tabs" role="tablist" aria-label="Kernel language">
        {languages.map((language) => <button key={language} role="tab" aria-selected={active === language} onClick={() => { setActive(language); setHistoryIndex(undefined) }}>
          <span>{languageLabel[language]}</span><i className={statuses[language]} /> <small>{statusLabel(statuses[language])}</small>
        </button>)}
      </div>
      <span className={`kernel-console-dirty ${dirty ? 'dirty' : ''}`}>{dirty ? 'Interactive · clean run will restart this kernel' : 'Reproducible session'}</span>
      <button onClick={onClose} aria-label="Close kernel console">Close</button>
    </header>
    <div className="kernel-console-output" ref={outputRef} aria-live="polite">
      {!currentEntries.length && <div className="kernel-console-empty"><strong>{languageLabel[active]} kernel console</strong><span>Commands share state with document cells. This is not an operating-system shell.</span></div>}
      {currentEntries.map((entry) => {
        const published = entry.result ? publishedValuesFromExecution(entry.result).records : []
        return <div className="kernel-console-entry" key={entry.id}>
          <pre className="kernel-console-input"><span>›</span>{entry.code}</pre>
          {entry.result?.streams.map((stream) => <pre className={`kernel-console-stream ${stream.name}`} key={`${entry.id}-${stream.sequence}`}>{stream.text}</pre>)}
          {entry.result && textualMime(entry.result).map((value, index) => <pre className="kernel-console-result" key={`${entry.id}-mime-${index}`}>{value}</pre>)}
          {published.map((record) => <div className="kernel-console-published" key={record.name}><span>{`{{${record.name}}}`}</span><strong>{renderPublishedValue(record)}</strong><small>session preview only</small></div>)}
          {entry.result?.errors.map((error, index) => <pre className="kernel-console-error" key={`${entry.id}-error-${index}`}>{error.name}: {error.message}{error.traceback.length ? `\n${error.traceback.join('\n')}` : ''}</pre>)}
          {entry.error && <pre className="kernel-console-error">{entry.error}</pre>}
        </div>
      })}
    </div>
    <div className="kernel-console-compose">
      <textarea value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => {
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void run() }
        else if (event.key === 'ArrowUp' && !input.includes('\n')) { event.preventDefault(); browseHistory(-1) }
        else if (event.key === 'ArrowDown' && historyIndex !== undefined && !input.includes('\n')) { event.preventDefault(); browseHistory(1) }
      }} placeholder={`Enter ${languageLabel[active]} code…`} aria-label={`${languageLabel[active]} kernel input`} spellCheck={false} rows={3} />
      <div>
        <span><kbd>⌘/Ctrl</kbd><kbd>↵</kbd> Run · Enter adds a line</span>
        <button onClick={() => { if (latestCode) onPromoteSetup(active, latestCode) }} disabled={!latestCode}>Make setup cell</button>
        <button onClick={() => void copyVisibleOutput()} disabled={!currentEntries.length}>Copy</button>
        <button onClick={() => setEntries((current) => ({ ...current, [active]: [] }))}>Clear</button>
        <button onClick={async () => { await onInterrupt(active); setStatuses((current) => ({ ...current, [active]: 'interrupted' })) }} disabled={statuses[active] !== 'busy'}>Interrupt</button>
        <button onClick={async () => {
          setStatuses((current) => ({ ...current, [active]: 'starting' }))
          try {
            await onRestart(active)
            setHistories((current) => ({ ...current, [active]: [] }))
            setStatuses((current) => ({ ...current, [active]: 'ready' }))
          } catch {
            setStatuses((current) => ({ ...current, [active]: 'failed' }))
          }
        }}>Restart</button>
        <button className="primary" onClick={() => void run()} disabled={!canRun}>Run</button>
      </div>
    </div>
  </section>
}
