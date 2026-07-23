/// <reference types="node" />

import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { parseBibliographyFile } from './bibliography'
import { sourceHash, validateCleanProjection } from './document'
import { renderDocxExport } from './docxExport'
import { extractExecutableCells } from './executionCells'
import { renderNativeHtmlExport } from './nativeHtmlExport'
import { numberedManuscriptObjects } from './numberedObjects'
import { parsePublicationMetadata } from './publicationMetadata'
import { projectComputationsForPublication } from './publicationComputation'
import { parseRetainedPublishedValues } from './publishedValues'
import { referenceIntegrityDiagnostics } from './referenceIntegrity'
import { parseRetainedOutputs } from './retainedOutputs'
import { buildReviewExportBundle } from './reviewExport'
import { parseReviewMarkup } from './reviewMarkup'
import { parseStructuredManuscript, serializeStructuredManuscript, structuredCitationClusters } from './structuredManuscript'

const fixtureRoot = join(process.cwd(), 'src/fixtures/projects/alpha-article')
const source = readFileSync(join(fixtureRoot, 'paper.qmd'), 'utf8')
const referencesSource = readFileSync(join(fixtureRoot, 'references.json'), 'utf8')
const citationLabels = {
  '[@vezy2024; @chen2025]': '(Vezy & Martin, 2024; Chen & Silva, 2025)',
}
const bibliography = [
  { id: 'vezy2024', value: 'Vezy, R., & Martin, A. (2024). Portable evidence chains in multilingual plant phenotyping.' },
  { id: 'chen2025', value: 'Chen, L., & Silva, M. (2025). Review-aware drought analysis in executable manuscripts.' },
]

describe('DM-P7-05 article-sized alpha dogfood', () => {
  const temporaryRoots: string[] = []

  afterEach(() => {
    for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  it('reopens one stored cross-language project without source repair or semantic loss', () => {
    const config = JSON.parse(readFileSync(join(fixtureRoot, '.draftmatter/project.json'), 'utf8')) as Record<string, unknown>
    const metadata = parsePublicationMetadata(source)
    const parsed = parseStructuredManuscript(source)
    const execution = extractExecutableCells(source)
    const cells = execution.cells
    const retained = parseRetainedOutputs(source)
    const values = parseRetainedPublishedValues(source)
    const review = parseReviewMarkup(source)
    const references = parseBibliographyFile('references.json', referencesSource, 'project-file')
    const semanticObjects = numberedManuscriptObjects(parsed.document)

    expect(config).toMatchObject({ schemaVersion: 1, mainDocument: 'paper.qmd', citationBibliography: 'references.json' })
    expect(metadata.authorDetails).toEqual([
      {
        name: 'Ada Researcher',
        orcid: '0000-0002-1825-0097',
        affiliations: ['Open Methods Laboratory', 'Field Phenotyping Institute'],
      },
      { name: 'Lin Chen', affiliations: ['Field Phenotyping Institute'] },
      { name: 'Marta Silva', affiliations: ['Open Methods Laboratory', 'Reproducible Research Unit'] },
    ])
    expect(references.diagnostics.filter((diagnostic) => diagnostic.level === 'error')).toEqual([])
    expect(references.records.map((record) => record.citekey)).toEqual(['vezy2024', 'chen2025'])
    expect(structuredCitationClusters(source)).toEqual([expect.objectContaining({
      items: [{ citekey: 'vezy2024' }, { citekey: 'chen2025' }],
    })])
    expect(execution.diagnostics).toEqual([])
    expect(cells).toHaveLength(9)
    expect(Object.fromEntries(['python', 'r', 'julia'].map((language) => [language, cells.filter((cell) => cell.language === language).map((cell) => cell.role)]))).toEqual({
      python: ['figure', 'table', 'values'],
      r: ['figure', 'table', 'values'],
      julia: ['figure', 'table', 'values'],
    })
    expect(retained.outputs).toHaveLength(9)
    expect(retained.diagnostics).toEqual([])
    expect(Object.fromEntries(Object.entries(values.values).map(([name, value]) => [name, value.rendered]))).toEqual({
      canopy_reduction: '18.4 %',
      allocation_p: '0.032',
      prediction_r2: '0.99',
    })
    expect(values.diagnostics).toEqual([])
    expect(semanticObjects.filter((object) => object.kind === 'figure')).toHaveLength(3)
    expect(semanticObjects.filter((object) => object.kind === 'table')).toHaveLength(3)
    expect(semanticObjects.filter((object) => object.kind === 'equation')).toHaveLength(1)
    expect(referenceIntegrityDiagnostics(parsed.document)).toEqual([])
    expect(review.changes).toEqual([expect.objectContaining({ id: 'dm-alpha-suggestion', status: 'open' })])
    expect(review.threads).toEqual([expect.objectContaining({ id: 'dm-alpha-thread', status: 'open' })])
    expect(review.authors.map((author) => author.name)).toEqual(['Ada Researcher', 'Lin Chen'])
    expect(serializeStructuredManuscript(parsed.document, parsed.metadata)).toBe(source)
  })

  it('creates a deterministic clean publication with output-only computations in every export', () => {
    const resolved = buildReviewExportBundle(source, ['dm-alpha-suggestion'])
    expect(resolved.finalProjection.ok).toBe(true)
    expect(resolved.final).toContain('drought treatment reduced canopy expansion by 18.4%')
    expect(resolved.report).toContain('Please confirm that the ±3.0 cm² diagnostic threshold')

    const publication = projectComputationsForPublication(resolved.final!)
    expect(validateCleanProjection(publication)).toEqual([])
    expect(publication).toContain('Final canopy area was 18.4 % lower under drought')
    expect(publication).toContain('the allocation contrast had *p* = 0.032')
    expect(publication).toContain('prediction performance reached $R^2$ = 0.99')
    expect(publication).not.toMatch(/```(?:python|r|julia)|@publish|\bpublish\(|dm-published-value|\.dm-anchor|\.draftmatter-reviews/)
    for (const target of ['eq-canopy-response', 'fig-python-canopy', 'tbl-python-means', 'fig-r-allocation', 'tbl-r-coefficients', 'fig-julia-model', 'tbl-julia-predictions']) {
      expect(publication).toContain(`#${target}`)
    }

    const html = renderNativeHtmlExport(resolved.final!, { citationLabels, bibliography })
    const docx = renderDocxExport(resolved.final!, { citationLabels, bibliography })
    const readableDocx = new TextDecoder().decode(docx.bytes)
    expect(html).toContain('<span class="author-name">Ada Researcher</span>')
    expect(html).toContain('ORCID 0000-0002-1825-0097')
    expect(html).toContain('(Vezy &amp; Martin, 2024; Chen &amp; Silva, 2025)')
    expect(html).toContain('<span class="author-name">Marta Silva</span>')
    expect(html).toContain('<figure id="fig-python-canopy">')
    expect(html).toContain('<table id="tbl-r-coefficients">')
    expect(html).toContain('Observed and fitted canopy means generated in Julia.')
    expect(html).toContain('@media print')
    expect(html).not.toMatch(/cell-python|cell-r-|cell-julia|write_text|writeLines|println\(|dm-published-value|\.dm-anchor|\.draftmatter-reviews|<script/)
    expect(readableDocx).toContain('word/document.xml')
    expect(readableDocx).toContain('Ada Researcher; Lin Chen; Marta Silva')
    expect(readableDocx).toContain('18.4 %')
    expect(readableDocx).toContain('Observed and fitted canopy means generated in Julia.')
    expect(readableDocx).not.toMatch(/cell-python|cell-r-|cell-julia|write_text|writeLines|println\(|dm-published-value|\.dm-anchor|\.draftmatter-reviews|<w:(?:ins|del)\b/)
    expect(sourceHash(publication)).toBe(sourceHash(projectComputationsForPublication(buildReviewExportBundle(source, ['dm-alpha-suggestion']).final!)))
  })

  it('copies the stored project into a named child folder, checkpoints it, closes it, and reopens identical bytes', () => {
    const parent = mkdtempSync(join(tmpdir(), 'draftmatter-alpha-parent-'))
    temporaryRoots.push(parent)
    const project = join(parent, 'cross-language-canopy-alpha')
    cpSync(fixtureRoot, project, { recursive: true })
    const runGit = (arguments_: string[]) => spawnSync('git', arguments_, {
      cwd: project,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'DraftMatter Alpha',
        GIT_AUTHOR_EMAIL: 'alpha@draftmatter.invalid',
        GIT_COMMITTER_NAME: 'DraftMatter Alpha',
        GIT_COMMITTER_EMAIL: 'alpha@draftmatter.invalid',
      },
    })

    expect(runGit(['init', '--quiet']).status).toBe(0)
    expect(runGit(['add', '--all']).status).toBe(0)
    const checkpoint = runGit(['-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Alpha article checkpoint'])
    expect(checkpoint.status, checkpoint.stderr).toBe(0)
    const checkpointHash = runGit(['rev-parse', 'HEAD']).stdout.trim()
    expect(checkpointHash).toMatch(/^[0-9a-f]{40}$/)
    expect(runGit(['status', '--porcelain']).stdout).toBe('')

    const beforeClose = readFileSync(join(project, 'paper.qmd'), 'utf8')
    const reopenedConfig = JSON.parse(readFileSync(join(project, '.draftmatter/project.json'), 'utf8')) as { mainDocument: string }
    const afterReopen = readFileSync(join(project, reopenedConfig.mainDocument), 'utf8')
    expect(afterReopen).toBe(beforeClose)
    expect(sourceHash(afterReopen)).toBe(sourceHash(source))
    expect(parseStructuredManuscript(afterReopen).diagnostics.filter((diagnostic) => diagnostic.level === 'error')).toEqual([])
    expect(parseReviewMarkup(afterReopen).changes).toHaveLength(1)
    expect(parseRetainedOutputs(afterReopen).outputs).toHaveLength(9)
  })
})
