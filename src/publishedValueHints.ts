import type { ExecutableCell, ExecutionLanguage } from './executionCells'

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
    return `{{${name}}} is unavailable.\nPublish it from a ${languageLabel[language]} values cell, then run the cell:\n${publishedValueSnippet(name, language)}`
  }
  return `{{${name}}} is unavailable.\nPublish it from a values cell, then run the cell:\nPython/R: publish("${name}", value, unit="cm", digits=1)\nJulia: ${publishedValueSnippet(name, 'julia')}`
}

function explicitlyPublishes(cell: ExecutableCell, name: string) {
  const quotedName = new RegExp(`\\bpublish\\s*\\(\\s*(["'])${escapeRegExp(name)}\\1\\s*,`)
  if (quotedName.test(cell.source)) return true
  return cell.language === 'julia'
    && /^[A-Za-z][A-Za-z0-9_]*$/.test(name)
    && new RegExp(`@publish\\s+${escapeRegExp(name)}\\b`).test(cell.source)
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
