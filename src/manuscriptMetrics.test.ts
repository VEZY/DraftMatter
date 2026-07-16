import { describe, expect, it } from 'vitest'
import { countWords, measurePortableManuscript, readingMinutesForWords } from './manuscriptMetrics'

describe('reader-facing manuscript metrics', () => {
  it('counts Unicode prose without treating punctuation as words', () => {
    expect(countWords("Drought-resistant canopies aren't static; elles évoluent en 2026.")).toBe(8)
    expect(readingMinutesForWords(0)).toBe(0)
    expect(readingMinutesForWords(1)).toBe(1)
    expect(readingMinutesForWords(441)).toBe(3)
  })

  it('counts semantic prose and headings while excluding code, raw syntax, outputs, and review records', () => {
    const source = `---
title: "Metadata is not prose"
---

# Field study

## Methods

Three careful observations.

~~~python
these code tokens do not count
~~~

::: {.future-extension}
opaque raw tokens do not count
:::

::::: {.draftmatter-reviews .hidden data-schema="1"}
:::: {#dm-author .dm-author data-name="Hidden Reviewer"}
::::
:::::
`

    expect(measurePortableManuscript(source)).toEqual({ words: 6, headings: 2, readingMinutes: 1 })
  })
})
