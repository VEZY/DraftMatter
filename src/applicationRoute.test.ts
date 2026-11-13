import { describe, expect, it } from 'vitest'
import { applicationRoutePath, parseApplicationRoute } from './applicationRoute'
import { legalDocuments } from './legalConfig'

describe('application routes', () => {
  it('keeps existing legal bookmarks stable when the public labels are English', () => {
    expect(legalDocuments.map(({ id, title }) => ({ path: applicationRoutePath({ destination: 'legal', documentId: id }), title }))).toEqual([
      { path: '/legal/mentions-legales', title: 'Legal notice' },
      { path: '/legal/confidentialite', title: 'Privacy policy' },
      { path: '/legal/conditions-utilisation', title: 'Terms of use' },
    ])
  })
  it.each(['mentions-legales', 'confidentialite', 'conditions-utilisation'] as const)('round-trips the public legal document %s without retaining account parameters', (documentId) => {
    const route = { destination: 'legal', documentId } as const
    const path = applicationRoutePath(route)
    expect(path).toBe(`/legal/${documentId}`)
    expect(parseApplicationRoute(new URL(`${path}?code=private-code&state=private-state`, 'https://draftmatter.example'))).toEqual(route)
  })

  it.each(['/legal', '/legal/unknown', '/legal/confidentialite/extra', '/legal/%2e%2e'])('does not treat an unsupported legal path %s as a document', (path) => {
    expect(parseApplicationRoute({ pathname: path, search: '?example=complete' })).toEqual({ destination: 'home' })
  })

  it('round-trips collaborative and local editor destinations', () => {
    const collaborative = { destination: 'collaborative-editor', workspaceId: 'forest lab', projectId: 'paper/one' } as const
    const collaborativePath = applicationRoutePath(collaborative)
    expect(collaborativePath).toBe('/workspace/forest%20lab/project/paper%2Fone')
    expect(parseApplicationRoute(new URL(collaborativePath, 'https://draftmatter.example'))).toEqual(collaborative)

    const local = { destination: 'local-editor', localProjectId: '/Users/research/paper' } as const
    const localPath = applicationRoutePath(local)
    expect(parseApplicationRoute(new URL(localPath, 'https://draftmatter.example'))).toEqual(local)

    const startCollaboration = { ...local, startCollaboration: true } as const
    expect(parseApplicationRoute(new URL(applicationRoutePath(startCollaboration), 'https://draftmatter.example'))).toEqual(startCollaboration)
  })

  it('recognizes workspace-filtered Home, invitations, learning, and the complete example', () => {
    expect(parseApplicationRoute(new URL('/workspace/forest', 'https://draftmatter.example'))).toEqual({ destination: 'home', workspaceId: 'forest' })
    expect(parseApplicationRoute(new URL('/invite', 'https://draftmatter.example'))).toEqual({ destination: 'invitation' })
    expect(parseApplicationRoute(new URL('/?example=complete', 'https://draftmatter.example'))).toEqual({ destination: 'example' })
    expect(parseApplicationRoute(new URL('/learn', 'https://draftmatter.example'))).toEqual({ destination: 'learn' })
    expect(parseApplicationRoute(new URL('/languages', 'https://draftmatter.example'))).toEqual({ destination: 'languages' })
    expect(parseApplicationRoute(new URL('/tutorial', 'https://draftmatter.example'))).toEqual({ destination: 'tutorial' })
    expect(parseApplicationRoute(new URL('/draft', 'https://draftmatter.example'))).toEqual({ destination: 'browser-editor' })
    expect(applicationRoutePath({ destination: 'learn' })).toBe('/learn')
    expect(applicationRoutePath({ destination: 'languages' })).toBe('/languages')
    expect(applicationRoutePath({ destination: 'tutorial' })).toBe('/tutorial')
    expect(applicationRoutePath({ destination: 'browser-editor' })).toBe('/draft')
    expect(parseApplicationRoute(new URL('/unknown', 'https://draftmatter.example'))).toEqual({ destination: 'home' })
  })
})
