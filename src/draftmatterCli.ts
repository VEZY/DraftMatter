import packageMetadata from '../package.json'
import { agentSchemaDocument, runAgentJsonCli } from './agentCli'
import { runDraftMatterAiCli } from './agentIntegrationCli'
import type { DraftMatterAiOperation, DraftMatterAiTarget } from './agentIntegration'
import { serveDraftMatterMcpStdio } from './agentMcpServer'
import { renderNativeHtmlExport } from './nativeHtmlExport'
import { projectComputationsForPublication } from './publicationComputation'
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

interface AgentCommand {
  command: 'agent'
  requestPath: string
  projectRoot?: string
}

interface McpCommand {
  command: 'mcp'
  projectRoot: string
}

interface AiCommand {
  command: 'ai'
  operation: DraftMatterAiOperation | 'doctor'
  target?: DraftMatterAiTarget
  projectRoot: string
  apply: boolean
}

type ParsedCommand = RenderCommand | ReportCommand | AgentCommand | McpCommand | AiCommand | { command: 'agent-schema' } | { command: 'help' } | { command: 'version' }

const HELP = `DraftMatter ${packageMetadata.version}

Create clean, inert projections from portable Markdown or Quarto manuscripts.

Usage:
  draftmatter render <input> [--view original|final] [--format markdown|html]
                     [--select <change-id>[,<change-id>...]] [--output <path>]
  draftmatter review-report <input> [--output <path>]
  draftmatter agent --request <path|-> [--project-root <path>]
  draftmatter agent schema
  draftmatter mcp --stdio --project-root <path>
  draftmatter ai init [--project-root <path>] [--apply]
  draftmatter ai doctor --json [--project-root <path>]
  draftmatter ai configure <codex|claude|copilot|vibe|all>
                           [--project-root <path>] [--apply]
  draftmatter ai update [codex|claude|copilot|vibe|all]
                        [--project-root <path>] [--apply]
  draftmatter ai remove [codex|claude|copilot|vibe|all]
                        [--project-root <path>] [--apply]
  draftmatter --help

Use - as the input or output path for standard input or standard output. Final
rendering fails closed until exactly one proposal is selected in every unresolved
overlap group. Rendering never executes document code. Agent mode accepts one
JSON request and emits one JSON result.
`

function argumentError(message: string) {
  return { error: `${message}\n\n${HELP}` }
}

function optionValue(arguments_: string[], index: number, option: string): { value: string; nextIndex: number } | { error: string } {
  const inline = arguments_[index].startsWith(`${option}=`) ? arguments_[index].slice(option.length + 1) : undefined
  if (inline !== undefined) return { value: inline, nextIndex: index }
  const value = arguments_[index + 1]
  if (!value || (value.startsWith('-') && value !== '-')) return { error: `Option ${option} requires a value.` }
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

function parseAgent(arguments_: string[]): ParsedCommand | { error: string } {
  if (arguments_.length === 1 && arguments_[0] === 'schema') return { command: 'agent-schema' }
  let requestPath = '-'
  let projectRoot: string | undefined
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]
    if (argument === '--help' || argument === '-h') return { command: 'help' }
    if (argument === '--request' || argument.startsWith('--request=')) {
      const parsed = optionValue(arguments_, index, '--request')
      if ('error' in parsed) return argumentError(parsed.error)
      requestPath = parsed.value
      index = parsed.nextIndex
      continue
    }
    if (argument === '--project-root' || argument.startsWith('--project-root=')) {
      const parsed = optionValue(arguments_, index, '--project-root')
      if ('error' in parsed) return argumentError(parsed.error)
      projectRoot = parsed.value
      index = parsed.nextIndex
      continue
    }
    return argumentError(`Unknown agent option “${argument}”.`)
  }
  return { command: 'agent', requestPath, projectRoot }
}

function parseMcp(arguments_: string[]): ParsedCommand | { error: string } {
  let stdio = false
  let projectRoot: string | undefined
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]
    if (argument === '--help' || argument === '-h') return { command: 'help' }
    if (argument === '--stdio') {
      stdio = true
      continue
    }
    if (argument === '--project-root' || argument.startsWith('--project-root=')) {
      const parsed = optionValue(arguments_, index, '--project-root')
      if ('error' in parsed) return argumentError(parsed.error)
      projectRoot = parsed.value
      index = parsed.nextIndex
      continue
    }
    return argumentError(`Unknown MCP option “${argument}”.`)
  }
  if (!stdio) return argumentError('The local MCP server requires --stdio.')
  if (!projectRoot) return argumentError('The local MCP server requires --project-root <path>.')
  return { command: 'mcp', projectRoot }
}

function parseAi(arguments_: string[]): ParsedCommand | { error: string } {
  const [rawOperation, ...rest] = arguments_
  if (rawOperation === '--help' || rawOperation === '-h') return { command: 'help' }
  if (!rawOperation || !['init', 'doctor', 'configure', 'update', 'remove'].includes(rawOperation)) {
    return argumentError('The ai command requires init, doctor, configure, update, or remove.')
  }
  const operation = rawOperation as DraftMatterAiOperation | 'doctor'
  let projectRoot = '.'
  let apply = false
  let json = false
  let target: DraftMatterAiTarget | undefined
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index]
    if (argument === '--project-root' || argument.startsWith('--project-root=')) {
      const parsed = optionValue(rest, index, '--project-root')
      if ('error' in parsed) return argumentError(parsed.error)
      projectRoot = parsed.value
      index = parsed.nextIndex
      continue
    }
    if (argument === '--apply') {
      apply = true
      continue
    }
    if (argument === '--json') {
      json = true
      continue
    }
    if (!argument.startsWith('-') && ['codex', 'claude', 'copilot', 'vibe', 'all'].includes(argument) && !target) {
      target = argument as DraftMatterAiTarget
      continue
    }
    return argumentError(`Unknown AI integration option “${argument}”.`)
  }
  if (operation === 'doctor' && !json) return argumentError('The ai doctor command requires --json.')
  if (operation === 'doctor' && (apply || target)) return argumentError('The ai doctor command does not accept a target or --apply.')
  if (operation === 'init' && target) return argumentError('The ai init command does not accept a client target.')
  if (operation === 'configure' && !target) return argumentError('The ai configure command requires a client or all.')
  return {
    command: 'ai',
    operation,
    ...(target ? { target } : {}),
    projectRoot,
    apply,
  }
}

function parseCommand(arguments_: string[]): ParsedCommand | { error: string } {
  if (!arguments_.length) return argumentError('Choose a command.')
  const [command, ...rest] = arguments_
  if (command === '--help' || command === '-h' || command === 'help') return { command: 'help' }
  if (command === '--version' || command === '-v') return { command: 'version' }
  if (command === 'render') return parseRender(rest)
  if (command === 'review-report' || command === 'report') return parseReport(rest)
  if (command === 'agent') return parseAgent(rest)
  if (command === 'mcp') return parseMcp(rest)
  if (command === 'ai') return parseAi(rest)
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
  if (parsed.command === 'agent-schema') {
    io.stdout(`${JSON.stringify(agentSchemaDocument())}\n`)
    return 0
  }
  if (parsed.command === 'agent') {
    return await runAgentJsonCli({
      requestPath: parsed.requestPath,
      ...(parsed.projectRoot ? { projectRoot: parsed.projectRoot } : {}),
    }, io)
  }
  if (parsed.command === 'mcp') {
    try {
      await serveDraftMatterMcpStdio(parsed.projectRoot)
      return 0
    } catch (error) {
      io.stderr(`DraftMatter MCP server failed to start: ${errorMessage(error)}\n`)
      return 70
    }
  }
  if (parsed.command === 'ai') {
    return await runDraftMatterAiCli({
      operation: parsed.operation,
      projectRoot: parsed.projectRoot,
      ...(parsed.target ? { target: parsed.target } : {}),
      apply: parsed.apply,
    }, io)
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

  let output: string
  if (parsed.format === 'html') {
    try {
      output = renderNativeHtmlExport(projection.source)
    } catch (error) {
      io.stderr(`Native HTML rendering failed: ${errorMessage(error)}\n`)
      return 2
    }
  } else {
    output = projectComputationsForPublication(projection.source, { stripOutputMarkers: true })
  }
  return await writeOutput(parsed.output, output, io) ? 0 : 1
}
