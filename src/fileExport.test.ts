// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'
import { exportFilenameProblem, saveGeneratedFileInBrowser, type GeneratedFileExport } from './fileExport'

const file: GeneratedFileExport = {
  suggestedName: 'paper.final.qmd',
  bytes: new TextEncoder().encode('# Paper'),
  mimeType: 'text/markdown;charset=utf-8',
  formatLabel: 'Portable manuscript',
  successMessage: 'Portable source exported',
}

describe('generated file export', () => {
  it('requires a simple filename with the generated format extension', () => {
    expect(exportFilenameProblem('paper.final.qmd', file.suggestedName)).toBe('')
    expect(exportFilenameProblem('../paper.final.qmd', file.suggestedName)).toContain('without folders')
    expect(exportFilenameProblem('paper.pdf', file.suggestedName)).toContain('.qmd')
  })

  it('writes through the browser save picker with a suggested filename and filter', async () => {
    const write = vi.fn().mockResolvedValue(undefined)
    const close = vi.fn().mockResolvedValue(undefined)
    const picker = vi.fn().mockResolvedValue({ createWritable: vi.fn().mockResolvedValue({ write, close }) })

    await expect(saveGeneratedFileInBrowser(file, picker)).resolves.toBe('picker')
    expect(picker).toHaveBeenCalledWith(expect.objectContaining({
      suggestedName: file.suggestedName,
      types: [{ description: file.formatLabel, accept: { 'text/markdown': ['.qmd'] } }],
    }))
    expect(write).toHaveBeenCalledWith(expect.any(Blob))
    expect(close).toHaveBeenCalledOnce()
  })
})
