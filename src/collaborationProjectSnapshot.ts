import { bibliographyValues, DEFAULT_ACQUISITION_BIBLIOGRAPHY, ensureBibliographyReference } from './citationAcquisition'
import { normalizeProjectRelativePath } from './projectPaths'
import type { CitationRecord } from './types'

function frontmatter(source: string) {
  const lines = (source.match(/[^\r\n]*(?:\r\n|\n|\r|$)/g) ?? []).filter(Boolean)
  const content = lines.map((line) => line.replace(/(?:\r\n|\n|\r)$/, ''))
  if (content[0] !== '---') return undefined
  const closing = content.findIndex((line, index) => index > 0 && line === '---')
  if (closing < 0) throw new Error('The manuscript YAML front matter has no closing delimiter. Repair it before creating a collaboration checkpoint.')
  const yaml = content.slice(1, closing)
  const entries = yaml.flatMap((line, index) => /^bibliography[ \t]*:/.test(line) ? [index] : [])
  if (entries.length > 1) throw new Error('The manuscript has duplicate bibliography fields. Keep one unambiguous field before creating a collaboration checkpoint.')
  return { lines, closing, yaml, index: entries[0], ending: lines[0].slice(3) || '\n' }
}

/** Bibliography paths named by the manuscript take precedence over incidental project/cache files. */
export function referencedBibliographyPaths(source: string, mainDocumentPath?: string) {
  const metadata = frontmatter(source)
  if (!metadata || metadata.index === undefined) return []
  const { values } = bibliographyValues(metadata.yaml, metadata.index, true)
  const mainPath = mainDocumentPath === undefined ? undefined : normalizeProjectRelativePath(mainDocumentPath)
  if (mainDocumentPath !== undefined && !mainPath) throw new Error('The main manuscript path must stay inside the project.')
  const directory = mainPath?.includes('/') ? mainPath.slice(0, mainPath.lastIndexOf('/')) : ''
  return [...new Set(values.map((value) => {
    if (/^[\\/]|^[a-z][a-z0-9+.-]*:/i.test(value)) throw new Error('Bibliography paths must stay inside the project. Use a relative path before reopening this collaboration checkpoint.')
    const path = normalizeProjectRelativePath(directory ? `${directory}/${value}` : value)
    if (!path) throw new Error('Bibliography paths must stay inside the project. Use a relative path before reopening this collaboration checkpoint.')
    return path
  }))]
}

/** An explicit owner checkpoint materializes its shared citation snapshot as ordinary CSL JSON. */
export function prepareCollaborationCheckpointSource(source: string, citations: CitationRecord[], bibliographyReference = DEFAULT_ACQUISITION_BIBLIOGRAPHY) {
  if (!citations.length) return source
  if (!bibliographyReference || /[\r\n\0]/.test(bibliographyReference) || /^[\\/]|^[a-z][a-z0-9+.-]*:/i.test(bibliographyReference)) throw new Error('The checkpoint bibliography reference must be a relative manuscript path.')
  const yamlPath = /^[A-Za-z0-9_./-]+$/.test(bibliographyReference) ? bibliographyReference : JSON.stringify(bibliographyReference)
  const metadata = frontmatter(source)
  if (!metadata) {
    const ending = source.includes('\r\n') ? '\r\n' : source.includes('\r') ? '\r' : '\n'
    return ensureBibliographyReference('', yamlPath).replaceAll('\n', ending) + source
  }
  if (metadata.index === undefined) {
    const offset = metadata.lines.slice(0, metadata.closing).join('').length
    return `${source.slice(0, offset)}bibliography: ${yamlPath}${metadata.ending}${source.slice(offset)}`
  }
  const bibliography = bibliographyValues(metadata.yaml, metadata.index, true)
  if (bibliography.values.length === 1 && bibliography.values[0] === bibliographyReference) return source
  const start = metadata.lines.slice(0, metadata.index + 1).join('').length
  const end = metadata.lines.slice(0, bibliography.end + 1).join('').length
  return `${source.slice(0, start)}bibliography: ${yamlPath}${metadata.ending}${source.slice(end)}`
}
