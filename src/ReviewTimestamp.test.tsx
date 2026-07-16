// @vitest-environment jsdom

import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { portableReviewTime, ReviewTimestamp } from './ReviewTimestamp'

describe('portable review timestamps', () => {
  it('formats a stable UTC label independently of the host timezone', () => {
    expect(portableReviewTime('2026-07-15T08:04:00-04:00')).toEqual({
      dateTime: '2026-07-15T12:04:00.000Z',
      label: '15 Jul 2026 · 12:04 UTC',
    })
  })

  it('renders semantic source-backed time with optional detail', () => {
    expect(renderToStaticMarkup(<ReviewTimestamp value="2026-07-15T09:00:00Z" fallback="Portable suggestion" detail="Results excerpt" />)).toBe(
      '<time dateTime="2026-07-15T09:00:00.000Z" title="Recorded 15 Jul 2026 · 09:00 UTC">15 Jul 2026 · 09:00 UTC</time> · Results excerpt',
    )
  })

  it('uses neutral text when source data has no valid timestamp', () => {
    expect(renderToStaticMarkup(<ReviewTimestamp value="not-a-date" fallback="Portable comment" />)).toBe('Portable comment')
    expect(portableReviewTime()).toBeNull()
  })
})
