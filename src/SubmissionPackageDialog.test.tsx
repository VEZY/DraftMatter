// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GeneratedFileExport } from './fileExport'
import { SubmissionPackageDialog } from './SubmissionPackageDialog'

const source = `---
title: "Portable canopy study"
author:
  - name: Ada Researcher
    affiliations:
      - Field Institute
keywords: [canopy, reproducibility]
---

## Abstract

We tested a portable workflow.

## Results

![Canopy response](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aU1QAAAAASUVORK5CYII=)
`

function field(container: HTMLElement, name: string) {
  const label = [...container.querySelectorAll('label')].find((candidate) => candidate.textContent?.includes(name))
  const input = label?.querySelector('input')
  if (!(input instanceof HTMLInputElement)) throw new Error(`Missing ${name} input`)
  return input
}

async function enter(input: HTMLInputElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('journal submission preparation dialog', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>

  beforeEach(async () => {
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it('turns completed submission details into a downloadable ZIP export', async () => {
    const exported: GeneratedFileExport[] = []
    await act(async () => root.render(
      <SubmissionPackageDialog
        source={source}
        baseName="canopy-paper.qmd"
        citations={[]}
        citationLabels={{}}
        bibliography={[]}
        onClose={vi.fn()}
        onExport={(file) => exported.push(file)}
      />,
    ))

    expect(container.textContent).toContain('Prepare journal submission')
    expect(container.textContent).toContain('2 blocked')
    await enter(field(container, 'Target journal'), 'Plant Methods')
    await enter(field(container, 'Corresponding email'), 'ada@example.org')
    expect(container.textContent).not.toContain('blocked')

    const prepare = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Prepare ZIP package')!
    await act(async () => prepare.click())

    expect(exported).toHaveLength(1)
    expect(exported[0]).toMatchObject({
      suggestedName: 'canopy-paper-submission.zip',
      mimeType: 'application/zip',
      formatLabel: 'journal submission package',
    })
    const readable = new TextDecoder().decode(exported[0].bytes)
    expect(readable).toContain('manuscript.docx')
    expect(readable).toContain('figures/Figure1.png')
    expect(readable).toContain('Plant Methods')
  })
})
