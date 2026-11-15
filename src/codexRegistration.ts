import { getStaticTOMLValue, parseTOML, ParseError, type AST } from 'toml-eslint-parser'

const startMarker = '# draftmatter-assistant:start'
const endMarker = '# draftmatter-assistant:end'
type Launch = { command: string; args: string[] }
type Edit = { range: [number, number]; text: string }

function parse(source: string) {
  try {
    return parseTOML(source)
  } catch (error) {
    if (!(error instanceof ParseError)) throw error
    throw new Error(`Fix the TOML at line ${error.lineNumber}, column ${error.column + 1}, then retry: ${error.message}`)
  }
}

// Codex can insert other tables between our marker comments. Only the two
// launch values belong to DraftMatter; the markers never delimit a text edit.
export function codexRegistration(source: string, expected: Launch, remove: boolean, repair: boolean, previous?: Launch) {
  const ast = parse(source)
  const tables = ast.body[0].body.filter((node): node is AST.TOMLTable => node.type === 'TOMLTable')
  const isServer = (key: (string | number)[]) => key[0] === 'mcp_servers' && key[1] === 'draftmatter'
  const table = tables.find((node) => isServer(node.resolvedKey) && node.resolvedKey.length === 2)
  const markers = (label: string) => ast.comments.filter((c) =>
    source.slice(...c.range).trimEnd() === label && !source.slice(source.lastIndexOf('\n', c.range[0] - 1) + 1, c.range[0]).trim())
  const starts = markers(startMarker)
  const ends = markers(endMarker)
  const newline = source.includes('\r\n') ? '\r\n' : '\n'
  const conflict = (message: string) => ({ content: source, installed: Boolean(table), current: false, changed: false, conflict: message })
  if (!starts.length && !ends.length) {
    if (table || tables.some((node) => isServer(node.resolvedKey))) {
      return conflict('An unmarked DraftMatter server already exists. Back up the configuration and move that registration aside before reconnecting.')
    }
    if (remove) return { content: source, installed: false, current: false, changed: false }
    const block = [startMarker, '[mcp_servers.draftmatter]', `command = ${JSON.stringify(expected.command)}`,
      `args = ${JSON.stringify(expected.args)}`, endMarker, ''].join(newline)
    const content = source + (source && !source.endsWith('\n') ? newline : '') + block
    // Also reject collisions with dotted keys or inline tables.
    parse(content)
    return { content, installed: false, current: false, changed: true }
  }
  if (starts.length !== 1 || ends.length !== 1 || !table || table.kind !== 'standard'
    || starts[0].range[1] > table.range[0] || ends[0].range[0] < table.key.range[1]) {
    return conflict('The DraftMatter registration markers are incomplete or misplaced. Back up the configuration and restore the markers around the DraftMatter launch settings before reconnecting.')
  }
  const field = (name: string) => table.body.find((node) => {
    const key = getStaticTOMLValue(node.key)
    return key.length === 1 && key[0] === name
  })
  const command = field('command')
  const args = field('args')
  if (!command || !args || command.value.type !== 'TOMLValue' || command.value.kind !== 'string'
    || args.value.type !== 'TOMLArray' || !args.value.elements.every((e) => e.type === 'TOMLValue' && e.kind === 'string')
    || Math.max(command.range[1], args.range[1]) > ends[0].range[0] || field('url')) {
    return conflict('Check the DraftMatter table: it must contain a stdio command and args between the markers, with no URL. Then reconnect.')
  }
  const matches = (launch: Launch) => getStaticTOMLValue(command.value) === launch.command
    && JSON.stringify(getStaticTOMLValue(args.value)) === JSON.stringify(launch.args)
  const current = matches(expected)
  const oldNodeLauncher = expected.command === process.execPath && expected.args[0]?.endsWith('.js') && matches({ ...expected, command: 'node' })
  if (!current && !repair && !oldNodeLauncher && !(previous && matches(previous))) {
    return conflict('The DraftMatter launch command or arguments were changed. Review them and choose Connection details → Reconnect to replace those values.')
  }
  const edits: Edit[] = []
  if (remove) {
    if (table.body.length !== 2 || tables.some((node) => node !== table && isServer(node.resolvedKey))) {
      return conflict('The DraftMatter server has additional settings. Back them up and remove them from the DraftMatter table before disconnecting.')
    }
    const headerEnd = source.indexOf(']', table.key.range[1]) + 1
    for (const range of [starts[0].range, [table.range[0], headerEnd] as [number, number], command.range, args.range, ends[0].range]) {
      let [start, end] = range
      if (ast.comments.some((c) => c.range[0] > start && c.range[1] < end)) {
        return conflict('Move comments inside the DraftMatter launch values to their own lines before disconnecting.')
      }
      const line = source.lastIndexOf('\n', start - 1) + 1
      const tail = /^[ \t]*(?:\r?\n|$)/u.exec(source.slice(end))
      if (!source.slice(line, start).trim() && tail) { start = line; end += tail[0].length }
      edits.push({ range: [start, end], text: '' })
    }
  } else if (!current) {
    for (const [node, value] of [[command, expected.command], [args, expected.args]] as const) {
      if (JSON.stringify(getStaticTOMLValue(node.value)) === JSON.stringify(value)) continue
      if (ast.comments.some((c) => c.range[0] > node.value.range[0] && c.range[1] < node.value.range[1])) {
        return conflict('Move comments inside the DraftMatter launch values to their own lines before reconnecting.')
      }
      edits.push({ range: node.value.range, text: JSON.stringify(value) })
    }
  }
  const content = edits.sort((a, b) => b.range[0] - a.range[0]).reduce((s, e) =>
    s.slice(0, e.range[0]) + e.text + s.slice(e.range[1]), source)
  return { content, installed: true, current, changed: content !== source }
}
