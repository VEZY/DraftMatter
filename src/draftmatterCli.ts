import packageMetadata from '../package.json'
import { renderNativeHtmlExport } from './nativeHtmlExport'
import { renderReviewReport } from './reviewExport'
import { projectPortableReviewSource } from './reviewProjector'

export interface DraftMatterCliIo {
  readText(path: string): Promise<string>
  writeText(path: string, content: string): Promise<void>
  stdout(content: string): void
  stderr(content: string): void
}

type RenderFormat = 'markdown' | 'html'
type ReviewView = 'original' | 'final'

interface RenderCommand {
  command: 'render'
  input: string
  output: string
  view: ReviewView
  format: RenderFormat
  selectedChangeIds: string[]
}

interface ReportCommand {
  command: 'review-report'
  input: string
  output: string
}

type ParsedCommand = RenderCommand | ReportCommand | { command: 'help' } | { command: 'version' }

const HELP = `DraftMatter ${packageMetadata.version}

Create clean, inert projections from portable Markdown or Quarto manuscripts.

Usage:
  draftmatter render <input> [--view original|final] [--format markdown|html]
                     [--select <change-id>[,<change-id>...]] [--output <path>]
  draftmatter review-report <input> [--output <path>]
  draftmatter --help

Use - as the input or output path for standard input or standard output. Final
rendering fails closed until exactly one proposal is selected in every unresolved
overlap group. Rendering never executes document code.
`

function argumentError(message: string) {
  return { error: `${message}\n\n${HELP}` }
}

function optionValue(arguments_: string[], index: number, option: string): { value: string; nextIndex: number } | { error: string } {
  const inline = arguments_[index].startsWith(`${option}=`) ? arguments_[index].slice(option.length + 1) : undefined
  if (inline !== undefined) return { value: inline, nextIndex: index }
  const value = arguments_[index + 1]
  if (!value || value.startsWith('-')) return { error: `Option ${option} requires a value.` }
  return { value, nextIndex: index + 1 }
}

function parseRender(arguments_: string[]): ParsedCommand | { error: string } {
  let input: string | undefined
  let output = '-'
  let view: ReviewView = 'final'
  let format: RenderFormat = 'markdown'
  const selectedChangeIds: string[] = []

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]
    if (argument === '--help' || argument === '-h') return { command: 'help' }
    if (argument === '--view' || argument.startsWith('--view=')) {
      const parsed = optionValue(arguments_, index, '--view')
      if ('error' in parsed) return argumentError(parsed.error)
      if (parsed.value !== 'original' && parsed.value !== 'final') return argumentError(`Unknown review view “${parsed.value}”.`)
      view = parsed.value
      index = parsed.nextIndex
      continue
    }
    if (argument === '--format' || argument.startsWith('--format=')) {
      const parsed = optionValue(arguments_, index, '--format')
      if ('error' in parsed) return argumentError(parsed.error)
      if (parsed.value !== 'markdown' && parsed.value !== 'html') return argumentError(`Unknown render format “${parsed.value}”.`)
      format = parsed.value
      index = parsed.nextIndex
      continue
    }
    if (argument === '--select' || argument.startsWith('--select=')) {
      const parsed = optionValue(arguments_, index, '--select')
      if ('error' in parsed) return argumentError(parsed.error)
      const ids = parsed.value.split(',').map((value) => value.trim()).filter(Boolean)
      if (!ids.length) return argumentError('Option --select requires at least one change ID.')
      selectedChangeIds.push(...ids)
      index = parsed.nextIndex
      continue
    }
    if (argument === '--output' || argument === '-o' || argument.startsWith('--output=')) {
      const option = argument === '-o' ? '-o' : '--output'
      const parsed = optionValue(arguments_, index, option)
      if ('error' in parsed) return argumentError(parsed.error)
      output = parsed.value
      index = parsed.nextIndex
      continue
    }
    if (argument.startsWith('-') && argument !== '-') return argumentError(`Unknown option “${argument}”.`)
    if (input !== undefined) return argumentError(`Unexpected extra input “${argument}”.`)
    input = argument
  }

  if (!input) return argumentError('The render command requires an input manuscript.')
  if (view === 'original' && selectedChangeIds.length) return argumentError('Option --select is only valid with --view final.')
  return { command: 'render', input, output, view, format, selectedChangeIds: [...new Set(selectedChangeIds)] }
}

function parseReport(arguments_: string[]): ParsedCommand | { error: string } {
  let input: string | undefined
  let output = '-'
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]
    if (argument === '--help' || argument === '-h') return { command: 'help' }
    if (argument === '--output' || argument === '-o' || argument.startsWith('--output=')) {
      const option = argument === '-o' ? '-o' : '--output'
      const parsed = optionValue(arguments_, index, option)
      if ('error' in parsed) return argumentError(parsed.error)
      output = parsed.value
      index = parsed.nextIndex
      continue
    }
    if (argument.startsWith('-') && argument !== '-') return argumentError(`Unknown option “${argument}”.`)
    if (input !== undefined) return argumentError(`Unexpected extra input “${argument}”.`)
    input = argument
  }
  if (!input) return argumentError('The review-report command requires an input manuscript.')
  return { command: 'review-report', input, output }
}

function parseCommand(arguments_: string[]): ParsedCommand | { error: string } {
  if (!arguments_.length) return argumentError('Choose a command.')
  const [command, ...rest] = arguments_
  if (command === '--help' || command === '-h' || command === 'help') return { command: 'help' }
  if (command === '--version' || command === '-v') return { command: 'version' }
  if (command === 'render') return parseRender(rest)
  if (command === 'review-report' || command === 'report') return parseReport(rest)
  return argumentError(`Unknown command “${command}”.`)
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function projectionFailure(result: Extract<ReturnType<typeof projectPortableReviewSource>, { ok: false }>) {
  if (result.conflicts.length) {
    const lines = [`Final projection blocked by ${result.conflicts.length} unresolved review conflict${result.conflicts.length === 1 ? '' : 's'}.`]
    for (const conflict of result.conflicts) {
      lines.push('', `${conflict.id} requires exactly one proposal:`, ...conflict.candidates.map((candidate) =>
        `  - ${candidate.changeId} — ${candidate.authorName} (${candidate.status})`))
    }
    const example = result.conflicts.map((conflict) => conflict.candidates[0]?.changeId).filter(Boolean).join(',')
    if (example) lines.push('', `Re-run with --select ${example}, choosing one ID from each conflict.`)
    return `${lines.join('\n')}\n`
  }
  const errors = result.diagnostics.filter((diagnostic) => diagnostic.level === 'error')
  return `Final projection blocked by review integrity errors.\n${errors.map((diagnostic) => `  - [${diagnostic.code}] ${diagnostic.message}`).join('\n')}\n`
}

async function readInput(input: string, io: DraftMatterCliIo): Promise<{ source: string } | { error: string }> {
  try {
    return { source: await io.readText(input) }
  } catch (error) {
    return { error: `Could not read ${input === '-' ? 'standard input' : `“${input}”`}: ${errorMessage(error)}\n` }
  }
}

async function writeOutput(output: string, content: string, io: DraftMatterCliIo) {
  try {
    await io.writeText(output, content)
    return true
  } catch (error) {
    io.stderr(`Could not write ${output === '-' ? 'standard output' : `“${output}”`}: ${errorMessage(error)}\n`)
    return false
  }
}

export async function runDraftMatterCli(arguments_: string[], io: DraftMatterCliIo) {
  const parsed = parseCommand(arguments_)
  if ('error' in parsed) {
    io.stderr(parsed.error)
    return 1
  }
  if (parsed.command === 'help') {
    io.stdout(HELP)
    return 0
  }
  if (parsed.command === 'version') {
    io.stdout(`${packageMetadata.version}\n`)
    return 0
  }

  const input = await readInput(parsed.input, io)
  if ('error' in input) {
    io.stderr(input.error)
    return 1
  }

  if (parsed.command === 'review-report') {
    return await writeOutput(parsed.output, renderReviewReport(input.source), io) ? 0 : 1
  }

  const projection = projectPortableReviewSource(input.source, {
    view: parsed.view,
    selectedChangeIds: parsed.selectedChangeIds,
  })
  if (!projection.ok) {
    io.stderr(projectionFailure(projection))
    return 2
  }

  let output = projection.source
  if (parsed.format === 'html') {
    try {
      output = renderNativeHtmlExport(output)
    } catch (error) {
      io.stderr(`Native HTML rendering failed: ${errorMessage(error)}\n`)
      return 2
    }
  }
  return await writeOutput(parsed.output, output, io) ? 0 : 1
}
