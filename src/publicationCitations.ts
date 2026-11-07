import { renderCslDocument, type CitationLocale, type CitationStyleId } from './cslRenderer'
import { structuredCitationClusters } from './structuredManuscript'
import type { CitationRecord } from './types'

/** Build citations from the exact export snapshot, independently of transient editor formatting. */
export async function preparePublicationCitations(source: string, records: CitationRecord[], style: CitationStyleId, locale: CitationLocale) {
  const clusters = structuredCitationClusters(source)
  const result = await renderCslDocument({ records, clusters, style, locale })
  if (result.diagnostics.length) throw new Error(`Publication citations are incomplete: ${result.diagnostics[0].message}`)
  const citationLabels: Record<string, string> = {}
  for (const cluster of clusters) {
    const label = result.clusters[cluster.id]
    if (!label) throw new Error('Citation formatting did not complete. Retry the publication export.')
    citationLabels[cluster.signature] = label
  }
  return { citationLabels, bibliography: result.bibliography }
}
