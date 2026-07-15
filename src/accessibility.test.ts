import { afterEach, describe, expect, it, vi } from 'vitest'
import { motionAwareScrollBehavior, prefersReducedMotion } from './accessibility'

describe('accessibility motion preferences', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('uses immediate navigation when reduced motion is requested', () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })))

    expect(prefersReducedMotion()).toBe(true)
    expect(motionAwareScrollBehavior()).toBe('auto')
  })

  it('keeps spatial navigation when reduced motion is not requested', () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false })))

    expect(prefersReducedMotion()).toBe(false)
    expect(motionAwareScrollBehavior()).toBe('smooth')
  })

  it('defaults safely when media queries are unavailable', () => {
    vi.stubGlobal('matchMedia', undefined)

    expect(prefersReducedMotion()).toBe(false)
    expect(motionAwareScrollBehavior()).toBe('smooth')
  })
})
