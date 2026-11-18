import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { writePublicConfiguration } from '../../deploy/production/public-config.mjs'

const environment = () => ({
  DM_PUBLIC_COLLABORATION_URL: 'https://sync.draftmatter.eu',
  DM_PUBLIC_AUTH_ORIGIN: 'https://auth.draftmatter.eu',
  DM_LEGAL_PUBLISHER_NAME: 'Rémi Vezy',
  DM_LEGAL_CONTACT_EMAIL: 'contact@draftmatter.eu',
  DM_LEGAL_HOSTING_DETAILS: 'SAS PulseHeberg, Toulon, France.',
  DM_LEGAL_DATA_LOCATION: 'Hosted in France by a French company.',
  DM_LEGAL_ADDITIONAL_PROCESSORS: 'OVHcloud, for contact email delivery.',
})

describe('generic web image startup public configuration', () => {
  it('writes only the allowlist atomically and refreshes it when the same image changes deployment settings', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'draftmatter-public-config-'))
    const target = join(directory, 'draftmatter-public-config.json')
    try {
      await writePublicConfiguration({ ...environment(), DM_OBJECT_SECRET_KEY: 'private-object-secret', DM_DATABASE_URL: 'private-database-secret' }, target)
      expect(readFileSync(target, 'utf8')).not.toContain('private-')
      expect(JSON.parse(readFileSync(target, 'utf8')).environment.VITE_DM_LEGAL_CONTACT_EMAIL).toBe('contact@draftmatter.eu')
      if (process.platform !== 'win32') expect(statSync(target).mode & 0o777).toBe(0o600)
      await writePublicConfiguration({ ...environment(), DM_LEGAL_CONTACT_EMAIL: 'another-contact@draftmatter.eu' }, target)
      expect(JSON.parse(readFileSync(target, 'utf8')).environment.VITE_DM_LEGAL_CONTACT_EMAIL).toBe('another-contact@draftmatter.eu')
      await expect(writePublicConfiguration({ ...environment(), DM_LEGAL_CONTACT_EMAIL: '' }, target)).rejects.toThrow('Complete')
      expect(JSON.parse(readFileSync(target, 'utf8')).environment.VITE_DM_LEGAL_CONTACT_EMAIL).toBe('another-contact@draftmatter.eu')
      await expect(writePublicConfiguration({ ...environment(), DM_PUBLIC_AUTH_ORIGIN: 'https://wrong.invalid/path' }, target)).rejects.toThrow('public identity origin')
      expect(JSON.parse(readFileSync(target, 'utf8')).environment.VITE_DM_LEGAL_CONTACT_EMAIL).toBe('another-contact@draftmatter.eu')
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })

  it.each(['', 'http://auth.draftmatter.eu', 'https://auth.draftmatter.eu/path', 'https://auth.draftmatter.eu?private', 'https://user:private@auth.draftmatter.eu', 'https://auth.draftmatter.eu#private'])('refuses an unsafe identity origin without printing its value', async (origin) => {
    await expect(writePublicConfiguration({ ...environment(), DM_PUBLIC_AUTH_ORIGIN: origin })).rejects.toThrow('public identity origin')
  })

  it('fails startup without exposing environment values when public settings are invalid', () => {
    const result = spawnSync(process.execPath, ['deploy/production/public-config.mjs'], { encoding: 'utf8', env: { ...process.env, ...environment(), DM_PUBLIC_COLLABORATION_URL: 'https://user:private-access-token@sync.draftmatter.eu', DM_OBJECT_SECRET_KEY: 'private-object-secret' } })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('without credentials')
    expect(result.stderr + result.stdout).not.toContain('private-access-token')
    expect(result.stderr + result.stdout).not.toContain('private-object-secret')
  })
})
