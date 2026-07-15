import { describe, expect, it } from 'vitest'
import adversarialFixture from './fixtures/execution/adversarial-cells.qmd?raw'
import { extractExecutableCells } from './executionCells'

describe('AST-based executable-cell extraction', () => {
  it('extracts only explicit Python, R, and Julia cells from adversarial source', () => {
    const result = extractExecutableCells(adversarialFixture)

    expect(result.cells.map((cell) => [cell.id, cell.language])).toEqual([
      ['real-python', 'python'],
      ['real-r', 'r'],
      ['real-julia', 'julia'],
    ])
    expect(result.cells[0]).toMatchObject({ attributes: { output: 'figure' }, classes: ['execute'] })
    expect(result.cells.every((cell) => !/literal|review|raw-region/.test(cell.id))).toBe(true)
    expect(result.diagnostics).toEqual([])
  })

  it('keeps a generated content ID stable across unrelated source movement', () => {
    const cell = '```{python}\nprint("stable")\n```'
    const first = extractExecutableCells(cell).cells[0]
    const moved = extractExecutableCells(`# Heading\n\nParagraph.\n\n${cell}`).cells[0]

    expect(first.id).toBe(moved.id)
    expect(first.sourceHash).toBe(moved.sourceHash)
    expect(first.position.startLine).not.toBe(moved.position.startLine)
  })

  it('supports Quarto and Pandoc attribute forms while respecting explicit opt-out', () => {
    const result = extractExecutableCells([
      '```{python #quarto-python}',
      'print(1)',
      '```',
      '```{.julia #pandoc-julia .execute custom="kept"}',
      'println(2)',
      '```',
      '```{r execute=false}',
      'print(3)',
      '```',
    ].join('\n'))

    expect(result.cells.map((cell) => [cell.id, cell.language])).toEqual([
      ['quarto-python', 'python'],
      ['pandoc-julia', 'julia'],
    ])
    expect(result.cells[1]).toMatchObject({ attributes: { custom: 'kept' }, classes: ['execute'] })
  })

  it('diagnoses unsafe and duplicate explicit IDs without dropping runnable source', () => {
    const source = [
      '```python {#same .execute}',
      'print(1)',
      '```',
      '```julia {#same .execute}',
      'println(2)',
      '```',
      '```r {#../unsafe .execute}',
      'print(3)',
      '```',
    ].join('\n')
    const result = extractExecutableCells(source)

    expect(result.cells.map((cell) => cell.id)).toEqual(['same', 'same-2', expect.stringMatching(/^cell-r-/)])
    expect(result.diagnostics.map((item) => item.code)).toEqual([
      'execution-cell-id-duplicate-same',
      expect.stringMatching(/^execution-cell-id-invalid-/),
    ])
  })
})
