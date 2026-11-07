import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { base64ToBytes, PROJECT_RESOURCES_ROOT, projectResourcesDiagnostic, publishProjectResources, readProjectResources, sharedImage } from './projectResources'
import type { CitationRecord } from '../types'

const reference: CitationRecord = { citekey: 'paper2026', type: 'article-journal', title: 'A shared reference', authors: ['Smith, Ada'], source: 'csl-json', cslData: { DOI: '10.1234/shared', issued: { 'date-parts': [[2026]] } } }

describe('portable project resources for browser collaborators', () => {
  it('transmits local figure bytes and complete bibliography snapshots without a filesystem or runtime', () => {
    const owner = new Y.Doc()
    const browser = new Y.Doc()
    const bytes = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><text>Shared figure</text></svg>')
    publishProjectResources(owner, { images: [sharedImage('figures/plot.svg', bytes)], citations: [reference] })
    Y.applyUpdate(browser, Y.encodeStateAsUpdate(owner))
    const resources = readProjectResources(browser)
    expect(resources.citations).toEqual([reference])
    expect(base64ToBytes(resources.images[0].base64)).toEqual(bytes)
    expect(projectResourcesDiagnostic(browser)).toBeNull()
    owner.destroy(); browser.destroy()
  })

  it('rejects unsafe paths, unsupported media and malformed bibliography records', () => {
    expect(() => sharedImage('../outside.svg', new Uint8Array([1]))).toThrow(/inside the project/)
    expect(() => sharedImage('script.html', new Uint8Array([1]))).toThrow(/supported image/)
    const doc = new Y.Doc()
    doc.getMap(PROJECT_RESOURCES_ROOT).set('citation:other', { kind: 'citation', record: reference })
    expect(projectResourcesDiagnostic(doc)).toBe('invalid-project-resource')
    doc.destroy()
  })

  it('retains peer resources and avoids retransmitting unchanged bytes on ordinary text edits', () => {
    const doc = new Y.Doc()
    publishProjectResources(doc, { images: [], citations: [reference] })
    let count = 0
    doc.on('update', () => { count += 1 })
    publishProjectResources(doc, { images: [], citations: [reference] })
    publishProjectResources(doc, { images: [sharedImage('figure.png', new Uint8Array([1]))], citations: [] })
    expect(count).toBe(1)
    expect(readProjectResources(doc).citations).toEqual([reference])
    doc.destroy()
  })
})
