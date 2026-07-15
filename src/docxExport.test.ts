import { describe, expect, it } from 'vitest'
import { renderDocxExport } from './docxExport'

const article = `---
title: "Canopy response"
author:
  - Remi Vezy
---

# Canopy response

## Results

Leaf area declined by **18%** [@vezy2020]. The relationship was $y = ax + b$.

![Response](figures/response.svg){#fig-response}

| Treatment | Area |
| --- | ---: |
| Control | 100 |
| Drought | 82 |

\`\`\`python
print("inert")
\`\`\`
`

describe('native DOCX export', () => {
  it('builds deterministic clean OOXML with document styles and real tables', () => {
    const first = renderDocxExport(article)
    const second = renderDocxExport(article)
    const readable = new TextDecoder().decode(first.bytes)

    expect(first.bytes.slice(0, 4)).toEqual(new Uint8Array([0x50, 0x4b, 0x03, 0x04]))
    expect(first.bytes).toEqual(second.bytes)
    expect(readable).toContain('word/document.xml')
    expect(readable).toContain('word/styles.xml')
    expect(readable).toContain('Canopy response')
    expect(readable.match(/Canopy response/g)).toHaveLength(1)
    expect(readable).toContain('Remi Vezy')
    expect(readable).toContain('<w:tbl>')
    expect(readable).toContain('not executed during export')
    expect(readable).toContain('print(&quot;inert&quot;)')
    expect(readable).not.toMatch(/\.dm-anchor|\.draftmatter-reviews|<w:(?:ins|del)\b/)
    expect(first.diagnostics).toEqual([expect.objectContaining({ code: 'figure-reference', level: 'warning' })])
  })

  it('blocks review storage instead of representing it as tracked changes', () => {
    expect(() => renderDocxExport('Text\n\n::::: {.draftmatter-reviews .hidden}\n:::::\n')).toThrow(/clean DraftMatter projection/)
  })
})
