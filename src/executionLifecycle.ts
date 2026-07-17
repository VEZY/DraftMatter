import { isSetupCell, type ExecutableCell, type ExecutionLanguage } from './executionCells'
import type { ExecutionRequest, NormalizedExecutionResult } from './kernelExecution'
import type { TrustedKernelExecution } from './executionTrust'

export type LifecycleCellStatus = 'never-run' | 'queued' | 'running' | 'succeeded' | 'failed' | 'interrupted'

export interface LifecycleCellState {
  cellId: string
  language: ExecutionLanguage
  status: LifecycleCellStatus
  result?: NormalizedExecutionResult
  message?: string
}

export interface ExecutionRunReport {
  requested: string[]
  completed: string[]
  certified: boolean
}

export type ExecutionRequestFactory = (cell: ExecutableCell, root: string) => Promise<ExecutionRequest> | ExecutionRequest
export type LifecycleListener = (states: LifecycleCellState[]) => void
const languages: ExecutionLanguage[] = ['python', 'r', 'julia']

function defaultRequest(cell: ExecutableCell, root: string): ExecutionRequest {
  return {
    cellId: cell.id,
    language: cell.language,
    code: cell.source,
    workingDirectory: root,
    attributes: { ...cell.attributes },
    inputs: [],
  }
}

function resultStatus(result: NormalizedExecutionResult): LifecycleCellStatus {
  if (result.status === 'succeeded') return 'succeeded'
  if (result.status === 'interrupted') return 'interrupted'
  return 'failed'
}

export class ExecutionLifecycle {
  private readonly cells: ExecutableCell[]
  private readonly states = new Map<string, LifecycleCellState>()
  private readonly listeners = new Set<LifecycleListener>()
  private readonly lanes = new Map<ExecutionLanguage, Promise<void>>()
  private readonly controllers = new Map<ExecutionLanguage, AbortController>()
  private readonly generations: Record<ExecutionLanguage, number> = { python: 0, r: 0, julia: 0 }
  private readonly fresh: Record<ExecutionLanguage, boolean> = { python: true, r: true, julia: true }

  constructor(
    private readonly root: string,
    cells: ExecutableCell[],
    private readonly execution: TrustedKernelExecution,
    private readonly requestFactory: ExecutionRequestFactory = defaultRequest,
  ) {
    this.cells = [...cells]
    for (const cell of this.cells) {
      this.states.set(cell.id, { cellId: cell.id, language: cell.language, status: 'never-run' })
    }
  }

  private setupCells(language: ExecutionLanguage) {
    return this.cells.filter((cell) => cell.language === language && isSetupCell(cell))
  }

  snapshot() {
    return this.cells.map((cell) => ({ ...this.states.get(cell.id)! }))
  }

  subscribe(listener: LifecycleListener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit() {
    const snapshot = this.snapshot()
    for (const listener of this.listeners) listener(snapshot)
  }

  private update(cell: ExecutableCell, patch: Partial<LifecycleCellState>) {
    this.states.set(cell.id, { ...this.states.get(cell.id)!, ...patch })
    this.emit()
  }

  private cell(cellId: string) {
    const cell = this.cells.find((candidate) => candidate.id === cellId)
    if (!cell) throw new Error(`Executable cell ${cellId} was not found.`)
    return cell
  }

  private enqueue(cell: ExecutableCell, generation: number) {
    const language = cell.language
    this.update(cell, { status: 'queued', message: undefined })
    const previous = this.lanes.get(language) ?? Promise.resolve()
    const run = previous.catch(() => undefined).then(async () => {
      if (generation !== this.generations[language]) {
        this.update(cell, { status: 'interrupted', message: 'Cancelled before execution.' })
        return
      }
      const controller = new AbortController()
      this.controllers.set(language, controller)
      this.update(cell, { status: 'running', result: undefined, message: undefined })
      try {
        const request = await this.requestFactory(cell, this.root)
        const result = await this.execution.run(this.root, request, controller.signal)
        this.update(cell, { status: resultStatus(result), result })
        if (result.status === 'failed') throw new Error(`Execution failed in ${cell.id}.`)
      } catch (error) {
        const interrupted = controller.signal.aborted || (error instanceof DOMException && error.name === 'AbortError')
        this.update(cell, {
          status: interrupted ? 'interrupted' : 'failed',
          message: error instanceof Error ? error.message : String(error),
        })
        if (!interrupted) throw error
      } finally {
        if (this.controllers.get(language) === controller) this.controllers.delete(language)
      }
    })
    const settled = run.then(() => undefined, () => undefined)
    this.lanes.set(language, settled)
    void settled.finally(() => {
      if (this.lanes.get(language) === settled) this.lanes.delete(language)
    })
    return run
  }

  private async runSequence(cells: ExecutableCell[]) {
    const requested = cells.map((cell) => cell.id)
    const completed: string[] = []
    const commandGenerations = { ...this.generations }
    for (const cell of cells) {
      await this.enqueue(cell, commandGenerations[cell.language])
      const state = this.states.get(cell.id)
      if (state?.status === 'succeeded') completed.push(cell.id)
      if (state?.status === 'failed' || state?.status === 'interrupted') break
    }
    return { requested, completed, certified: requested.length > 0 && requested.length === completed.length }
  }

  private async withFreshSetup(cells: ExecutableCell[]) {
    const languagesNeeded = [...new Set(cells.map((cell) => cell.language))]
    const setup = languagesNeeded.flatMap((language) => this.fresh[language] ? this.setupCells(language) : [])
    const requested = [...setup, ...cells.filter((cell) => !setup.some((candidate) => candidate.id === cell.id))]
    const report = await this.runSequence(requested)
    for (const language of languagesNeeded) {
      const languageSetup = setup.filter((cell) => cell.language === language)
      if (languageSetup.every((cell) => report.completed.includes(cell.id))) this.fresh[language] = false
    }
    return report
  }

  runCell(cellId: string) {
    return this.withFreshSetup([this.cell(cellId)])
  }

  runAbove(cellId: string) {
    const index = this.cells.findIndex((cell) => cell.id === cellId)
    if (index < 0) throw new Error(`Executable cell ${cellId} was not found.`)
    return this.withFreshSetup(this.cells.slice(0, index).filter((cell) => !isSetupCell(cell)))
  }

  runLanguage(language: ExecutionLanguage) {
    return this.withFreshSetup(this.cells.filter((cell) => cell.language === language && !isSetupCell(cell)))
  }

  async cleanRunAll(): Promise<ExecutionRunReport> {
    const present = languages.filter((language) => this.cells.some((cell) => cell.language === language))
    for (const language of present) await this.restart(language)
    const ordered = [
      ...this.cells.filter(isSetupCell),
      ...this.cells.filter((cell) => !isSetupCell(cell)),
    ]
    return this.runSequence(ordered)
  }

  async interrupt(language: ExecutionLanguage) {
    this.generations[language] += 1
    this.controllers.get(language)?.abort()
    for (const cell of this.cells.filter((candidate) => candidate.language === language)) {
      const state = this.states.get(cell.id)
      if (state?.status === 'queued' || state?.status === 'running') {
        this.update(cell, { status: 'interrupted', message: 'Interrupted by the author.' })
      }
    }
    await this.execution.interrupt(language)
  }

  async restart(language: ExecutionLanguage) {
    this.generations[language] += 1
    this.controllers.get(language)?.abort()
    if (this.controllers.has(language)) {
      await this.execution.interrupt(language)
    }
    await this.lanes.get(language)
    await this.execution.restart(this.root, language)
    this.fresh[language] = true
  }

  async terminate(language: ExecutionLanguage) {
    this.generations[language] += 1
    this.controllers.get(language)?.abort()
    await this.execution.terminate(language)
    this.fresh[language] = true
    await this.lanes.get(language)
  }
}
