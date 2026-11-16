import { useEffect, useMemo, useState } from 'react'
import { normalizeCitationItems } from './citation'
import { citationRecordToCsl, renderCslDocument, type CslRenderOptions, type CslRenderResult } from './cslRenderer'
import type { CitationItem, DocumentDiagnostic } from './types'

export interface CslDocumentView {
  renderedCitations: Record<string, string>
  renderedBibliography: CslRenderResult['bibliography']
  cslState: 'loading' | 'ready' | 'error'
  cslDiagnostics: DocumentDiagnostic[]
}

interface RenderedRequest {
  request: CslRenderOptions
  result?: CslRenderResult
  error?: DocumentDiagnostic
}

const EMPTY_BIBLIOGRAPHY: CslRenderResult['bibliography'] = []
const EMPTY_DIAGNOSTICS: DocumentDiagnostic[] = []
const clusterId = (index: number) => `csl-cluster-${index}`

function readableError(error: unknown) {
  if (error instanceof Error) return error.message
  if (typeof error === 'object' && error !== null) {
    try { return JSON.stringify(error) }
    catch { return 'The formatter returned an unreadable error.' }
  }
  return String(error)
}

/** Citation positions/IDs may change with prose; only ordered citation semantics require CSL work. */
export function useCslDocument(options: CslRenderOptions): CslDocumentView {
  const clustersKey = JSON.stringify(options.clusters.map((cluster) => normalizeCitationItems(cluster.items)))
  const clusters = useMemo(() => (JSON.parse(clustersKey) as CitationItem[][])
    .map((items, index) => ({ id: clusterId(index), items })), [clustersKey])

  // Records follow React's immutable-state contract. Scan a large bibliography only
  // when its array changes, retaining every field the formatter actually consumes.
  const recordsKey = useMemo(() => JSON.stringify(options.records.map((record) => [record.citekey, citationRecordToCsl(record)])), [options.records])
  // The semantic key deliberately permits equivalent new arrays to reuse this input.
  const records = useMemo(() => options.records, [recordsKey])
  const request = useMemo<CslRenderOptions>(() => ({ records, clusters, style: options.style, locale: options.locale }), [records, clusters, options.style, options.locale])
  const [rendered, setRendered] = useState<RenderedRequest>()

  useEffect(() => {
    let active = true
    void renderCslDocument(request).then((result) => {
      if (active) setRendered({ request, result })
    }).catch((error) => {
      if (active) setRendered({ request, error: {
        code: 'csl-render-failed',
        level: 'error',
        message: `Citation formatting is temporarily unavailable: ${readableError(error)}`,
      } })
    })
    return () => { active = false }
  }, [request])

  const current = rendered?.request === request ? rendered : undefined
  const result = current?.result
  const renderedCitations = useMemo(() => {
    const labels: Record<string, string> = {}
    options.clusters.forEach((cluster, index) => {
      const value = result?.clusters[clusterId(index)]
      if (value !== undefined) labels[cluster.id] = value
    })
    return labels
  }, [options.clusters, result])

  return {
    renderedCitations,
    renderedBibliography: result?.bibliography ?? EMPTY_BIBLIOGRAPHY,
    cslState: current?.error ? 'error' : result ? 'ready' : 'loading',
    cslDiagnostics: current?.error ? [current.error] : result?.diagnostics ?? EMPTY_DIAGNOSTICS,
  }
}
