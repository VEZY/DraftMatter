import { describe, expect, it } from 'vitest'
import { alignReviewBalloons } from './reviewBalloonAlignment'

describe('review balloon alignment', () => {
  it('aligns cards to document lines and preserves a collision gap', () => {
    const layout = alignReviewBalloons([
      { id: 'first', naturalTop: 20, height: 100, targetTop: 240 },
      { id: 'second', naturalTop: 131, height: 80, targetTop: 260 },
      { id: 'third', naturalTop: 222, height: 60, targetTop: 520 },
    ])

    expect(layout.placements).toEqual([
      { id: 'first', aligned: true, top: 240, translateY: 220 },
      { id: 'second', aligned: true, top: 351, translateY: 220 },
      { id: 'third', aligned: true, top: 520, translateY: 298 },
    ])
    expect(layout.bottom).toBe(580)
  })

  it('keeps unplaced reviews in queue order after aligned cards', () => {
    const layout = alignReviewBalloons([
      { id: 'placed', naturalTop: 10, height: 70, targetTop: 180 },
      { id: 'unplaced', naturalTop: 90, height: 50 },
    ], 8)

    expect(layout.placements[1]).toEqual({
      id: 'unplaced',
      aligned: false,
      top: 260,
      translateY: 170,
    })
  })

  it('never pulls a balloon above its ordinary rail position', () => {
    expect(alignReviewBalloons([
      { id: 'early', naturalTop: 80, height: 40, targetTop: 12 },
    ]).placements[0]).toEqual({
      id: 'early',
      aligned: true,
      top: 80,
      translateY: 0,
    })
  })
})
