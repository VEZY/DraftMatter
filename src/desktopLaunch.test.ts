import { describe, expect, it } from 'vitest'
import { desktopLaunchTarget, desktopLaunchUrl } from './desktopLaunch'

describe('DraftMatter desktop launch links', () => {
  it('round-trips a shared manuscript route without exposing it as an arbitrary desktop URL', () => {
    const source = 'https://write.example.test/workspace/forest/project/canopy?view=review#invite=one-time'
    const launch = desktopLaunchUrl(source)
    expect(launch).toContain('draftmatter://open?source=')
    expect(desktopLaunchTarget(launch!)).toBe('/workspace/forest/project/canopy?view=review#invite=one-time')
  })

  it('accepts invitation routes and loopback development links', () => {
    const launch = desktopLaunchUrl('http://127.0.0.1:4173/invite#token=local')
    expect(desktopLaunchTarget(launch!)).toBe('/invite#token=local')
  })

  it('rejects non-web sources, credentials, unrelated routes, and malformed launch links', () => {
    expect(desktopLaunchUrl('file:///tmp/paper.qmd')).toBeNull()
    expect(desktopLaunchUrl('https://user:secret@example.test/workspace/a/project/b')).toBeNull()
    expect(desktopLaunchUrl('https://example.test/learn')).toBeNull()
    expect(desktopLaunchTarget('draftmatter://settings')).toBeNull()
    expect(desktopLaunchTarget('draftmatter://open?source=javascript%3Aalert%281%29')).toBeNull()
  })
})
