import type { ExecutableCell, ExecutableCellResult, ExecutionLanguage } from './executionCells'
import type { ParsedPublishedValues } from './publishedValues'

const languageLabel: Record<ExecutionLanguage, string> = {
  python: 'Python',
  r: 'R',
  julia: 'Julia',
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function valueVariable(name: string) {
  return /^[A-Za-z][A-Za-z0-9_]*$/.test(name) ? name : 'value'
}

export function publishedValueSnippet(name: string, language: ExecutionLanguage) {
  const variable = valueVariable(name)
  if (language === 'python') return `publish("${name}", ${variable}, unit="cm", digits=1)`
  if (language === 'r') return `publish("${name}", ${variable}, unit = "cm", digits = 1)`
  if (variable === name) return `@publish ${name} unit="cm" digits=1`
  return `publish("${name}", value; unit="cm", digits=1)`
}

export function publishedValueUnavailableHint(name: string, language?: ExecutionLanguage) {
  if (language) {
    return `{{${name}}} is unavailable.\nProduce it in a ${languageLabel[language]} computed value calculation, then run the calculation:\n${publishedValueSnippet(name, language)}`
  }
  return `{{${name}}} is unavailable.\nProduce it in a computed value calculation, then run the calculation:\nPython/R: publish("${name}", value, unit="cm", digits=1)\nJulia: ${publishedValueSnippet(name, 'julia')}`
}

function explicitlyPublishes(cell: ExecutableCell, name: string) {
  // Only match literal calls outside comments and string literals. Dynamic
  // names can be resolved from the provenance of a successful run.
  const call = `\\bpublish\\s*\\(\\s*["']${escapeRegExp(name)}["']\\s*,`
  const macro = cell.language === 'julia' && /^[A-Za-z][A-Za-z0-9_]*$/.test(name)
    ? `|@publish[ \\t]+${escapeRegExp(name)}\\b` : ''
  const skipped = /#=[\s\S]*?=#|#[^\n]*|"""[\s\S]*?(?:"""|$)|'''[\s\S]*?(?:'''|$)|"(?:\\[\s\S]|[^"\\])*(?:"|$)|'(?:\\[\s\S]|[^'\\])*(?:'|$)/.source
  for (const match of cell.source.matchAll(new RegExp(`${skipped}|(${call}${macro})`, 'g'))) {
    if (match[1] !== undefined) return true
  }
  return false
}

export function computedValueSource(name: string, extracted: ExecutableCellResult, retained: ParsedPublishedValues, openedCellId?: string) {
  const { cells } = extracted
  const record = Object.hasOwn(retained.values, name) ? retained.values[name] : undefined
  const candidates = cells.filter((cell) => cell.id === record?.provenance.cellId || explicitlyPublishes(cell, name))
  if (candidates.length > 1 || retained.diagnostics.some((item) => item.code === `published-value-duplicate-${name}`)) {
    return { message: `More than one calculation publishes “${name}”. Give each value a unique name to identify its source.` }
  }
  if (record && !cells.some((cell) => cell.id === record.provenance.cellId)) {
    return { message: `The calculation that produced this saved result is missing from the manuscript.` }
  }
  // A keystroke can temporarily break the publish call. Keep the open editor
  // attached to its original cell, even before a first result exists.
  const cell = openedCellId ? cells.find((candidate) => candidate.id === openedCellId) : candidates[0]
  if (openedCellId && (!cell || (candidates[0] && candidates[0].id !== openedCellId))) {
    return { message: 'The source for this value has changed. Reopen the value to see its current source.' }
  }
  if (!cell) return { message: `No source was found for “${name}”. Run the calculation that publishes it in DraftMatter Desktop.` }
  if (cell.duplicateId || cells.filter((candidate) => candidate.id === cell.id).length > 1) {
    return { message: 'The source cell has a duplicate identifier. Give each cell a unique identifier before editing this calculation.' }
  }
  return { cell }
}

function onlyLanguage(cells: ExecutableCell[]) {
  const languages = [...new Set(cells.map((cell) => cell.language))]
  return languages.length === 1 ? languages[0] : undefined
}

export function inferPublishedValueLanguage(name: string, cells: ExecutableCell[]) {
  const explicit = cells.find((cell) => explicitlyPublishes(cell, name))
  if (explicit) return explicit.language
  return onlyLanguage(cells.filter((cell) => cell.role === 'values')) ?? onlyLanguage(cells)
}
