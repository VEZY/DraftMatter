import { afterEach, describe, expect, it, vi } from 'vitest'
import { unified } from 'unified'
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

  it('keeps executable source and identities stable across document line endings', () => {
    const unix = extractExecutableCells('```{python}\nprint("stable")\n```').cells[0]
    const windows = extractExecutableCells('```{python}\r\nprint("stable")\r\n```').cells[0]

    expect(windows).toMatchObject({
      id: unix.id,
      source: unix.source,
      sourceHash: unix.sourceHash,
    })
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

describe('reusing executable-cell analysis', () => {
  afterEach(() => vi.restoreAllMocks())

  it('parses unchanged source once and invalidates syntax and positions when the source changes', () => {
    const parse = vi.spyOn(Object.getPrototypeOf(unified), 'parse')
    const source = '> ```{python #cache-position .execute output="table"}\n> print(1)\n> ```'
    const first = extractExecutableCells(source)
    const repeated = extractExecutableCells(source)
    expect(parse).toHaveBeenCalledTimes(1)
    expect(repeated).toEqual(first)
    expect(first.cells[0]).toMatchObject({ id: 'cache-position', role: 'table', source: 'print(1)' })

    const prefix = '# Moved cached computation\n\n'
    const moved = extractExecutableCells(prefix + source)
    expect(parse).toHaveBeenCalledTimes(2)
    expect(moved.cells[0].id).toBe(first.cells[0].id)
    expect(moved.cells[0].position.startOffset).toBe(first.cells[0].position.startOffset + prefix.length)
    expect(moved.cells[0].position.startLine).toBe(first.cells[0].position.startLine + 2)

    const changed = extractExecutableCells(source.replace('print(1)', 'print(2)'))
    expect(parse).toHaveBeenCalledTimes(3)
    expect(changed.cells[0].source).toBe('print(2)')
    expect(changed.cells[0].sourceHash).not.toBe(first.cells[0].sourceHash)
    expect(extractExecutableCells(source.replace('.execute', 'execute=false')).cells).toEqual([])
    expect(parse).toHaveBeenCalledTimes(4)
  })

  it('does not let caller mutations corrupt subsequent cells or diagnostics', () => {
    const source = [
      '```python {#cache-mutable .execute custom="kept" output="figure"}',
      'print(1)',
      '```',
      '```python {#cache-mutable .execute}',
      'print(2)',
      '```',
    ].join('\n')
    const first = extractExecutableCells(source)
    const expected = structuredClone(first)
    expect(first.diagnostics).toHaveLength(1)
    first.cells[0].source = 'changed by caller'
    first.cells[0].attributes.custom = 'changed'
    first.cells[0].classes.push('changed')
    first.cells[0].position.startOffset = -1
    first.cells.push(first.cells[0])
    first.diagnostics[0].message = 'changed'
    first.diagnostics.push({ code: 'caller', level: 'error', message: 'changed' })

    const repeated = extractExecutableCells(source)
    expect(repeated).toEqual(expected)
    repeated.cells[0].attributes.custom = 'changed again'
    repeated.cells.splice(0)
    repeated.diagnostics.splice(0)
    expect(extractExecutableCells(source)).toEqual(expected)
  })

  it('retains only four recently used sources rather than accumulating every typed revision', () => {
    const parse = vi.spyOn(Object.getPrototypeOf(unified), 'parse')
    const revisions = Array.from({ length: 5 }, (_, index) => `# Cache revision ${index}\n\n\`\`\`{python}\nprint(${index})\n\`\`\``)
    for (const revision of revisions.slice(0, 4)) extractExecutableCells(revision)
    expect(parse).toHaveBeenCalledTimes(4)
    extractExecutableCells(revisions[0])
    expect(parse).toHaveBeenCalledTimes(4)
    extractExecutableCells(revisions[4])
    expect(parse).toHaveBeenCalledTimes(5)
    extractExecutableCells(revisions[0])
    expect(parse).toHaveBeenCalledTimes(5)
    extractExecutableCells(revisions[1])
    expect(parse).toHaveBeenCalledTimes(6)
  })
})
