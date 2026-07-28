import { describe, expect, it } from 'vitest'
import { desktopLaunchTarget, desktopLaunchUrl, desktopProjectLaunchUrl } from './desktopLaunch'

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

  it('opens the application home or one absolute local project', () => {
    expect(desktopLaunchTarget('draftmatter://open')).toBe('/')
    const unix = desktopProjectLaunchUrl('/Users/researcher/Complete example paper')
    expect(desktopLaunchTarget(unix!)).toBe('/local/%2FUsers%2Fresearcher%2FComplete%20example%20paper')
    const windows = desktopProjectLaunchUrl('C:\\Research\\Complete example paper')
    expect(desktopLaunchTarget(windows!)).toBe('/local/C%3A%5CResearch%5CComplete%20example%20paper')
    expect(desktopProjectLaunchUrl('relative/project')).toBeNull()
  })

  it('rejects non-web sources, credentials, unrelated routes, and malformed launch links', () => {
    expect(desktopLaunchUrl('file:///tmp/paper.qmd')).toBeNull()
    expect(desktopLaunchUrl('https://user:secret@example.test/workspace/a/project/b')).toBeNull()
    expect(desktopLaunchUrl('https://example.test/learn')).toBeNull()
    expect(desktopLaunchTarget('draftmatter://settings')).toBeNull()
    expect(desktopLaunchTarget('draftmatter://open?source=javascript%3Aalert%281%29')).toBeNull()
    expect(desktopLaunchTarget('draftmatter://open?source=https%3A%2F%2Fexample.test%2Finvite&project=%2Ftmp%2Fpaper')).toBeNull()
  })
})
