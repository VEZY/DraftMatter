import { describe, expect, it } from 'vitest'
import {
  createCollaborationInvitationLink,
  readCollaborationInvitationLink,
  storePendingCollaborationInvitation,
  takePendingCollaborationInvitation,
} from './invitationLink'

function memoryStorage() {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
    removeItem: (key: string) => { values.delete(key) },
    values,
  }
}

describe('browser collaboration invitation links', () => {
  it('keeps the invitation secret in a fragment and returns a clean app URL', () => {
    const link = createCollaborationInvitationLink(
      'https://app.example.test/writer?draft=private#old-state',
      'wss://collab.example.test/',
      'one-use-secret',
    )!
    const url = new URL(link)
    expect(url.origin + url.pathname).toBe('https://app.example.test/writer')
    expect(url.search).toBe('')
    expect(url.hash).toContain('dm-invite=one-use-secret')
    expect(url.toString().split('#')[0]).not.toContain('one-use-secret')
    expect(readCollaborationInvitationLink(link)).toEqual({
      token: 'one-use-secret',
      serviceUrl: 'https://collab.example.test',
      cleanUrl: 'https://app.example.test/writer',
    })
  })

  it('rejects desktop origins, insecure remote services, and malformed secrets', () => {
    expect(createCollaborationInvitationLink('tauri://localhost/', 'https://collab.example.test', 'secret')).toBeNull()
    expect(createCollaborationInvitationLink('http://app.example.test/', 'https://collab.example.test', 'secret')).toBeNull()
    expect(createCollaborationInvitationLink('https://app.example.test/', 'http://collab.example.test', 'secret')).toBeNull()
    expect(readCollaborationInvitationLink('https://app.example.test/#dm-invite=&dm-service=https%3A%2F%2Fcollab.example.test')).toBeNull()
    expect(readCollaborationInvitationLink('http://app.example.test/#dm-invite=secret&dm-service=https%3A%2F%2Fcollab.example.test')).toBeNull()
    expect(createCollaborationInvitationLink('http://127.0.0.1:4173/', 'http://localhost:1234', 'local-secret')).toContain('#dm-invite=local-secret')
  })

  it('retains the secret only for one bounded OIDC round trip', () => {
    const storage = memoryStorage()
    storePendingCollaborationInvitation(storage, { token: 'one-use-secret', serviceUrl: 'https://collab.example.test' }, () => 1_000)
    expect(storage.values.size).toBe(1)
    expect(takePendingCollaborationInvitation(storage, () => 2_000)).toEqual({ token: 'one-use-secret', serviceUrl: 'https://collab.example.test' })
    expect(storage.values.size).toBe(0)
    expect(takePendingCollaborationInvitation(storage, () => 2_000)).toBeNull()

    storePendingCollaborationInvitation(storage, { token: 'expired', serviceUrl: 'https://collab.example.test' }, () => 1_000)
    expect(takePendingCollaborationInvitation(storage, () => 16 * 60_000)).toBeNull()
    expect(storage.values.size).toBe(0)
  })
})
