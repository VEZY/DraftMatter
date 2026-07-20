import { describe, expect, it } from 'vitest'
import { isPipeTableSeparator, parseTableCaptionLine, pipeTableAlignments, pipeTableCells } from './tableSyntax'

describe('portable pipe-table syntax', () => {
  it('parses cells and semantic column alignment', () => {
    expect(pipeTableCells('| Treatment | Mean | Range |')).toEqual(['Treatment', 'Mean', 'Range'])
    expect(pipeTableAlignments('| :--- | ---: | :---: |')).toEqual(['left', 'right', 'center'])
  })

  it('recognizes both one-column and multi-column separators without treating a thematic break as a table', () => {
    expect(isPipeTableSeparator('| --- |')).toBe(true)
    expect(isPipeTableSeparator('| :--- | ---: |')).toBe(true)
    expect(isPipeTableSeparator('---')).toBe(false)
    expect(isPipeTableSeparator('| not-a-separator |')).toBe(false)
  })

  it('separates a caption from exact Pandoc attributes', () => {
    expect(parseTableCaptionLine(': Yield **summary**. {#tbl-yield .striped data-owner="Field team"}')).toEqual({
      captionMarkdown: 'Yield **summary**.',
      label: 'tbl-yield',
      sourceAttributes: '#tbl-yield .striped data-owner="Field team"',
    })
  })

  it('keeps ordinary braces as caption text', () => {
    expect(parseTableCaptionLine(': Response at set {A}')).toEqual({
      captionMarkdown: 'Response at set {A}',
      label: null,
      sourceAttributes: null,
    })
  })

  it('parses a portable label even when a table caption is not written yet', () => {
    expect(parseTableCaptionLine(': {#tbl-results}')).toEqual({
      captionMarkdown: '',
      label: 'tbl-results',
      sourceAttributes: '#tbl-results',
    })
  })
})
