import { describe, expect, it } from 'vitest'
import { applicationRoutePath, parseApplicationRoute } from './applicationRoute'

describe('application routes', () => {
  it('round-trips collaborative and local editor destinations', () => {
    const collaborative = { destination: 'collaborative-editor', workspaceId: 'forest lab', projectId: 'paper/one' } as const
    const collaborativePath = applicationRoutePath(collaborative)
    expect(collaborativePath).toBe('/workspace/forest%20lab/project/paper%2Fone')
    expect(parseApplicationRoute(new URL(collaborativePath, 'https://draftmatter.example'))).toEqual(collaborative)

    const local = { destination: 'local-editor', localProjectId: '/Users/research/paper' } as const
    const localPath = applicationRoutePath(local)
    expect(parseApplicationRoute(new URL(localPath, 'https://draftmatter.example'))).toEqual(local)
  })

  it('recognizes workspace-filtered Home, invitations, and the complete example', () => {
    expect(parseApplicationRoute(new URL('/workspace/forest', 'https://draftmatter.example'))).toEqual({ destination: 'home', workspaceId: 'forest' })
    expect(parseApplicationRoute(new URL('/invite', 'https://draftmatter.example'))).toEqual({ destination: 'invitation' })
    expect(parseApplicationRoute(new URL('/?example=complete', 'https://draftmatter.example'))).toEqual({ destination: 'example' })
    expect(parseApplicationRoute(new URL('/unknown', 'https://draftmatter.example'))).toEqual({ destination: 'home' })
  })
})
