import { citationRecordToCsl } from './cslRenderer'
import { renderDocxExport, type DocxExportOptions } from './docxExport'
import { measurePortableManuscript } from './manuscriptMetrics'
import { normalizeProjectRelativePath } from './projectPaths'
import { projectComputationsForPublication } from './publicationComputation'
import { parsePublicationMetadata, updatePublicationAuthorDetails, type PublicationAuthor } from './publicationMetadata'
import type { CitationRecord } from './types'
import { createStoredZip } from './zipArchive'

export type SubmissionReviewModel = 'identified' | 'double-anonymous'

export interface SubmissionOptions {
  journal: string
  articleType: string
  correspondingAuthor: string
  correspondingEmail: string
  reviewModel: SubmissionReviewModel
  submissionUrl?: string
  coverLetter?: string
}

export interface SubmissionAsset {
  path: string
  bytes: Uint8Array
}

export interface SubmissionFigure {
  index: number
  alt: string
  source: string
  packagedPath?: string
  kind: 'project' | 'embedded' | 'remote' | 'unsafe'
}

export interface SubmissionCheck {
  id: string
  label: string
  level: 'pass' | 'warning' | 'error'
  message: string
}

export interface SubmissionAnalysis {
  title: string
  abstract: string
  keywords: string[]
  authors: PublicationAuthor[]
  figures: SubmissionFigure[]
  citedKeys: string[]
  missingCitationKeys: string[]
  words: number
  checks: SubmissionCheck[]
  errors: number
  warnings: number
}

export interface SubmissionPackageInput {
  source: string
  baseName: string
  options: SubmissionOptions
  citations: CitationRecord[]
  assets?: SubmissionAsset[]
  docx?: DocxExportOptions
}

export interface SubmissionPackageResult {
  bytes: Uint8Array<ArrayBuffer>
  filename: string
  analysis: SubmissionAnalysis
  files: string[]
}

const FIGURE_PATTERN = /(!\[([^\]\r\n]*)\]\(\s*)(<[^>\r\n]+>|data:image\/[^\s)]+|[^)\s]+)(\s+(?:"[^"\r\n]*"|'[^'\r\n]*'))?(\s*\)(?:\{[^}\r\n]*\})?)/g

function frontmatter(source: string) {
  if (!source.startsWith('---\n') && !source.startsWith('---\r\n')) return ''
  const normalized = source.replaceAll('\r\n', '\n').replaceAll('\r', '\n')
  const end = normalized.indexOf('\n---', 4)
  return end < 0 ? '' : normalized.slice(4, end)
}

function yamlText(source: string, key: string) {
  const yaml = frontmatter(source)
  const lines = yaml.split('\n')
  const index = lines.findIndex((line) => new RegExp(`^${key}[ \\t]*:`, 'i').test(line))
  if (index < 0) return ''
  const inline = lines[index].replace(new RegExp(`^${key}[ \\t]*:[ \\t]*`, 'i'), '').trim()
  if (inline && inline !== '|' && inline !== '>') return inline.replace(/^['"]|['"]$/g, '')
  const values: string[] = []
  for (const line of lines.slice(index + 1)) {
    if (line.trim() && !/^\s/.test(line)) break
    const value = line.replace(/^\s+/, '')
    if (value) values.push(value.replace(/^-[ \\t]*/, ''))
  }
  return values.join(inline === '>' ? ' ' : '\n').trim()
}

function sectionText(source: string, name: string) {
  const normalized = source.replaceAll('\r\n', '\n').replaceAll('\r', '\n')
  const heading = new RegExp(`^(#{1,6})[ \\t]+${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[ \\t]*(?:\\{[^}]*\\})?[ \\t]*$`, 'im').exec(normalized)
  if (!heading || heading.index === undefined) return ''
  const contentStart = normalized.indexOf('\n', heading.index) + 1
  if (!contentStart) return ''
  const level = heading[1].length
  const remainder = normalized.slice(contentStart)
  const next = new RegExp(`^#{1,${level}}[ \\t]+`, 'm').exec(remainder)
  return remainder.slice(0, next?.index ?? remainder.length).trim()
}

function keywordsFromSource(source: string) {
  const value = yamlText(source, 'keywords')
  if (!value) return []
  const unwrapped = value.replace(/^\[/, '').replace(/\]$/, '')
  return unwrapped.split(/,|\n/).map((item) => item.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
}

function safeFilename(value: string, fallback: string) {
  const normalized = value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
  return normalized.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120) || fallback
}

function sourceTarget(raw: string) {
  return raw.startsWith('<') && raw.endsWith('>') ? raw.slice(1, -1) : raw
}

function embeddedExtension(source: string) {
  const mediaType = source.match(/^data:(image\/[a-zA-Z0-9.+-]+)/i)?.[1]?.toLowerCase()
  if (mediaType === 'image/jpeg') return 'jpg'
  if (mediaType === 'image/svg+xml') return 'svg'
  if (mediaType === 'image/tiff') return 'tif'
  return mediaType?.split('/')[1]?.replace(/[^a-z0-9]/g, '') || 'bin'
}

function projectFigureName(source: string, index: number) {
  const basename = source.split('/').at(-1) ?? `figure-${index}`
  return `figures/Figure${index}-${safeFilename(basename, `figure-${index}`)}`
}

export function submissionFigures(source: string): SubmissionFigure[] {
  return [...source.matchAll(FIGURE_PATTERN)].map((match, index) => {
    const target = sourceTarget(match[3])
    if (/^data:image\//i.test(target)) return {
      index: index + 1,
      alt: match[2].trim(),
      source: target,
      packagedPath: `figures/Figure${index + 1}.${embeddedExtension(target)}`,
      kind: 'embedded' as const,
    }
    if (/^https?:\/\//i.test(target)) return { index: index + 1, alt: match[2].trim(), source: target, kind: 'remote' as const }
    const normalized = normalizeProjectRelativePath(target)
    if (!normalized) return { index: index + 1, alt: match[2].trim(), source: target, kind: 'unsafe' as const }
    return {
      index: index + 1,
      alt: match[2].trim(),
      source: normalized,
      packagedPath: projectFigureName(normalized, index + 1),
      kind: 'project' as const,
    }
  })
}

export function submissionProjectAssetPaths(source: string) {
  return [...new Set(submissionFigures(source).filter((figure) => figure.kind === 'project').map((figure) => figure.source))]
}

function citedKeys(source: string) {
  const keys = [...source.matchAll(/@([a-zA-Z0-9_:.+-]+)/g)]
    .map((match) => match[1])
    .filter((key) => !/^(?:fig|tbl|eq|sec)-/.test(key))
  return [...new Set(keys)]
}

function hasSection(source: string, names: string[]) {
  return names.some((name) => new RegExp(`^#{1,6}[ \\t]+${name}[ \\t]*(?:\\{[^}]*\\})?[ \\t]*$`, 'im').test(source))
}

function validSubmissionUrl(value?: string) {
  if (!value?.trim()) return true
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:'
  } catch {
    return false
  }
}

export function analyzeSubmission(sourceInput: string, citations: CitationRecord[], options: SubmissionOptions): SubmissionAnalysis {
  const source = projectComputationsForPublication(sourceInput)
  const metadata = parsePublicationMetadata(source)
  const abstract = yamlText(source, 'abstract') || sectionText(source, 'Abstract')
  const keywords = keywordsFromSource(source)
  const figures = submissionFigures(source)
  const keys = citedKeys(source)
  const availableKeys = new Set(citations.map((citation) => citation.citekey))
  const missingCitationKeys = keys.filter((key) => !availableKeys.has(key))
  const authors = metadata.authorDetails.length
    ? metadata.authorDetails
    : metadata.authors.map((name) => ({ name, affiliations: [] }))
  const declarations = [
    hasSection(source, ['Data availability', 'Availability of data and materials']),
    hasSection(source, ['Competing interests', 'Conflict of interest', 'Conflicts of interest']),
    hasSection(source, ['Funding', 'Funding information']),
    hasSection(source, ['Author contributions', 'Contributions']),
  ].filter(Boolean).length
  const checks: SubmissionCheck[] = [
    {
      id: 'target-journal',
      label: 'Target journal',
      level: options.journal.trim() ? 'pass' : 'error',
      message: options.journal.trim() || 'Choose the journal before preparing the package.',
    },
    {
      id: 'article-type',
      label: 'Article type',
      level: options.articleType.trim() ? 'pass' : 'error',
      message: options.articleType.trim() || 'Enter the article type requested by the journal.',
    },
    {
      id: 'title-abstract',
      label: 'Title and abstract',
      level: metadata.title?.trim() && abstract ? 'pass' : 'warning',
      message: metadata.title?.trim() && abstract
        ? `${metadata.title} · ${measurePortableManuscript(abstract).words} abstract words`
        : `Missing ${[!metadata.title?.trim() && 'title', !abstract && 'abstract'].filter(Boolean).join(' and ')}.`,
    },
    {
      id: 'authors',
      label: 'Authors and affiliations',
      level: authors.length && authors.every((author) => author.affiliations.length) ? 'pass' : 'warning',
      message: authors.length
        ? `${authors.length} author${authors.length === 1 ? '' : 's'}${authors.every((author) => author.affiliations.length) ? ' with affiliations' : ' · some affiliations are missing'}`
        : 'No publication authors were found.',
    },
    {
      id: 'corresponding-author',
      label: 'Corresponding author',
      level: options.correspondingAuthor.trim() && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(options.correspondingEmail.trim()) ? 'pass' : 'error',
      message: options.correspondingAuthor.trim() && options.correspondingEmail.trim()
        ? `${options.correspondingAuthor} · ${options.correspondingEmail}`
        : 'Select the corresponding author and enter an email address.',
    },
    {
      id: 'citations',
      label: 'References',
      level: missingCitationKeys.length ? 'warning' : 'pass',
      message: missingCitationKeys.length
        ? `Metadata is unavailable for ${missingCitationKeys.map((key) => `@${key}`).join(', ')}.`
        : `${keys.length} cited reference${keys.length === 1 ? '' : 's'} with available metadata.`,
    },
    {
      id: 'figures',
      label: 'Figures',
      level: figures.some((figure) => figure.kind === 'remote' || figure.kind === 'unsafe') ? 'error' : figures.some((figure) => !figure.alt) ? 'warning' : 'pass',
      message: figures.some((figure) => figure.kind === 'remote' || figure.kind === 'unsafe')
        ? 'Remote or unsafe figure paths must be replaced by project files before packaging.'
        : `${figures.length} figure${figures.length === 1 ? '' : 's'} will be packaged separately${figures.some((figure) => !figure.alt) ? ' · some descriptions are missing' : ''}.`,
    },
    {
      id: 'keywords',
      label: 'Keywords',
      level: keywords.length ? 'pass' : 'warning',
      message: keywords.length ? keywords.join(', ') : 'No keywords were found in manuscript metadata.',
    },
    {
      id: 'declarations',
      label: 'Submission declarations',
      level: declarations >= 2 ? 'pass' : 'warning',
      message: declarations
        ? `${declarations} common declaration section${declarations === 1 ? '' : 's'} found; confirm the journal-specific requirements.`
        : 'Check data availability, funding, competing interests, ethics, and author contributions.',
    },
    {
      id: 'review-model',
      label: 'Review identity',
      level: 'pass',
      message: options.reviewModel === 'double-anonymous'
        ? 'Author metadata will be removed from the manuscript copy; inspect the text for self-identifying details.'
        : 'The manuscript copy will retain author metadata.',
    },
  ]
  if (!validSubmissionUrl(options.submissionUrl)) checks.push({
    id: 'submission-url',
    label: 'Submission portal',
    level: 'error',
    message: 'The submission portal must be an HTTP or HTTPS URL.',
  })
  if (/\.dm-anchor|\.draftmatter-reviews|\.dm-change|\.dm-thread|\.dm-decision/.test(source)) checks.push({
    id: 'review-data',
    label: 'Clean manuscript',
    level: 'error',
    message: 'Review storage remains in this source. Resolve a clean final projection before packaging.',
  })
  return {
    title: metadata.title?.trim() || 'Untitled manuscript',
    abstract,
    keywords,
    authors,
    figures,
    citedKeys: keys,
    missingCitationKeys,
    words: measurePortableManuscript(source).words,
    checks,
    errors: checks.filter((check) => check.level === 'error').length,
    warnings: checks.filter((check) => check.level === 'warning').length,
  }
}

function decodeDataImage(source: string) {
  const match = source.match(/^data:(image\/[a-zA-Z0-9.+-]+)(;base64)?,(.*)$/s)
  if (!match) throw new Error('An embedded figure uses an unsupported data URL.')
  if (match[2]) {
    const binary = globalThis.atob(match[3])
    return Uint8Array.from(binary, (character) => character.charCodeAt(0))
  }
  return new TextEncoder().encode(decodeURIComponent(match[3]))
}

function rewriteFigureSources(source: string, figures: SubmissionFigure[]) {
  let index = 0
  return source.replace(FIGURE_PATTERN, (_match, prefix: string, _alt: string, _target: string, title: string | undefined, suffix: string) => {
    const figure = figures[index]
    index += 1
    return `${prefix}${figure.packagedPath ?? figure.source}${title ?? ''}${suffix}`
  })
}

function html(value: string) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
}

function submissionSummary(analysis: SubmissionAnalysis, options: SubmissionOptions, bibliography: Array<{ id: string; value: string }>) {
  const authors = analysis.authors.map((author) => `<li>${html(author.name)}${author.orcid ? ` · ORCID ${html(author.orcid)}` : ''}${author.affiliations.length ? `<br><small>${author.affiliations.map(html).join('; ')}</small>` : ''}</li>`).join('')
  const checks = analysis.checks.map((check) => `<li class="${check.level}"><strong>${html(check.label)}</strong><span>${html(check.message)}</span></li>`).join('')
  const figures = analysis.figures.map((figure) => `<li><strong>Figure ${figure.index}</strong> · ${html(figure.alt || 'No description')}<br><code>${html(figure.packagedPath ?? figure.source)}</code></li>`).join('')
  const references = bibliography.map((entry) => `<li id="ref-${html(entry.id)}">${html(entry.value)}</li>`).join('')
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Submission summary · ${html(analysis.title)}</title><style>body{color:#24312b;font:15px/1.5 system-ui,sans-serif;margin:40px auto;max-width:860px;padding:0 28px}h1{line-height:1.15}h2{border-bottom:1px solid #dce4df;padding-bottom:6px}dl{display:grid;grid-template-columns:180px 1fr;gap:7px 18px}dt{font-weight:700}dd{margin:0}.checks{list-style:none;padding:0}.checks li{border-left:4px solid #789487;margin:8px 0;padding:8px 12px}.checks li.warning{border-color:#c18b3f}.checks li.error{border-color:#b55346}.checks span{display:block;color:#647169}code{font-size:.9em}small{color:#647169}</style></head><body><p>Prepared by DraftMatter</p><h1>${html(analysis.title)}</h1><dl><dt>Target journal</dt><dd>${html(options.journal)}</dd><dt>Article type</dt><dd>${html(options.articleType)}</dd><dt>Review model</dt><dd>${options.reviewModel === 'double-anonymous' ? 'Double-anonymous' : 'Identified author metadata'}</dd><dt>Corresponding author</dt><dd>${html(options.correspondingAuthor)} · ${html(options.correspondingEmail)}</dd><dt>Manuscript length</dt><dd>${analysis.words} words</dd>${options.submissionUrl ? `<dt>Submission portal</dt><dd><a href="${html(options.submissionUrl)}">${html(options.submissionUrl)}</a></dd>` : ''}</dl><h2>Abstract</h2><p>${analysis.abstract ? html(analysis.abstract).replaceAll('\n', '<br>') : '<em>Not supplied</em>'}</p><h2>Keywords</h2><p>${analysis.keywords.length ? analysis.keywords.map(html).join(' · ') : '<em>Not supplied</em>'}</p><h2>Authors</h2><ol>${authors || '<li>Not supplied</li>'}</ol><h2>Readiness checks</h2><ul class="checks">${checks}</ul><h2>Figures</h2><ol>${figures || '<li>No figures</li>'}</ol><h2>Formatted references</h2><ol>${references || '<li>No formatted references</li>'}</ol></body></html>`
}

function packageReadme(analysis: SubmissionAnalysis, options: SubmissionOptions) {
  return `DRAFTMATTER JOURNAL SUBMISSION PACKAGE\n\nTarget journal: ${options.journal}\nArticle type: ${options.articleType}\nManuscript: ${analysis.title}\nCorresponding author: ${options.correspondingAuthor} <${options.correspondingEmail}>\nReview model: ${options.reviewModel === 'double-anonymous' ? 'double-anonymous' : 'identified'}\n\nUPLOAD GUIDANCE\n\n1. Open submission-summary.html and confirm every readiness check against the journal's current Instructions for Authors.\n2. Upload manuscript.docx as the editable main manuscript.\n3. Upload files from figures/ separately when the journal requests separate artwork.\n4. Upload cover-letter.txt and supplementary files separately when requested.\n5. Keep source/manuscript.qmd and references/references.json as the portable source record; most journal portals do not accept QMD directly.\n6. The corresponding author must personally confirm authorship, conflicts, ethics, licensing, and other declarations in the journal portal.\n${options.submissionUrl ? `\nSubmission portal recorded by the author: ${options.submissionUrl}\n` : ''}\nThis package contains a clean final projection. DraftMatter review records and executable manuscript code are not included.\n`
}

export function buildSubmissionPackage(input: SubmissionPackageInput): SubmissionPackageResult {
  const publicationSource = projectComputationsForPublication(input.source)
  const analysis = analyzeSubmission(publicationSource, input.citations, input.options)
  if (analysis.errors) {
    throw new Error(`Submission package has ${analysis.errors} blocking readiness ${analysis.errors === 1 ? 'check' : 'checks'}.`)
  }
  const suppliedAssets = new Map((input.assets ?? []).map((asset) => [normalizeProjectRelativePath(asset.path), asset.bytes]))
  const figureFiles = analysis.figures.map((figure) => {
    if (!figure.packagedPath) throw new Error(`Figure ${figure.index} cannot be packaged from ${figure.source}.`)
    if (figure.kind === 'embedded') return { name: figure.packagedPath, bytes: decodeDataImage(figure.source) }
    const bytes = suppliedAssets.get(figure.source)
    if (!bytes) throw new Error(`Figure ${figure.index} is missing from the project: ${figure.source}.`)
    return { name: figure.packagedPath, bytes }
  })
  let packageSource = rewriteFigureSources(publicationSource, analysis.figures)
  if (input.options.reviewModel === 'double-anonymous') packageSource = updatePublicationAuthorDetails(packageSource, [])
  const docx = renderDocxExport(packageSource, input.docx)
  const cited = new Set(analysis.citedKeys)
  const referenceRecords = input.citations.filter((record) => cited.has(record.citekey)).map(citationRecordToCsl)
  const formattedBibliography = input.docx?.bibliography ?? []
  const entries = [
    { name: 'README.txt', bytes: packageReadme(analysis, input.options) },
    { name: 'manifest.json', bytes: JSON.stringify({
      schemaVersion: 1,
      generator: 'DraftMatter',
      journal: input.options.journal,
      articleType: input.options.articleType,
      reviewModel: input.options.reviewModel,
      correspondingAuthor: { name: input.options.correspondingAuthor, email: input.options.correspondingEmail },
      manuscript: { title: analysis.title, words: analysis.words },
      figures: analysis.figures.map((figure) => ({ source: figure.source, packagedPath: figure.packagedPath, description: figure.alt })),
      citedKeys: analysis.citedKeys,
    }, null, 2) },
    { name: 'manuscript.docx', bytes: docx.bytes },
    { name: 'submission-summary.html', bytes: submissionSummary(analysis, input.options, formattedBibliography) },
    { name: 'source/manuscript.qmd', bytes: packageSource },
    { name: 'references/references.json', bytes: JSON.stringify(referenceRecords, null, 2) },
    ...figureFiles,
    ...(input.options.coverLetter?.trim() ? [{ name: 'cover-letter.txt', bytes: input.options.coverLetter.trim() + '\n' }] : []),
  ]
  const stem = safeFilename(input.baseName.replace(/\.(?:qmd|md)$/i, ''), 'manuscript')
  return {
    bytes: createStoredZip(entries),
    filename: `${stem}-submission.zip`,
    analysis,
    files: entries.map((entry) => entry.name),
  }
}
