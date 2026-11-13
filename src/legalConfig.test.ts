import { describe, expect, it } from 'vitest'
import { isLegalDocumentId, legalEnvironmentKeys, readLegalConfiguration } from './legalConfig'

const deployment = {
  VITE_DM_LEGAL_PUBLISHER_NAME: 'Rémi Vezy',
  VITE_DM_LEGAL_CONTACT_EMAIL: 'vezy.remi@gmail.com',
  VITE_DM_LEGAL_HOSTING_DETAILS: 'OVH SAS, coordonnées confirmées dans le contrat d’hébergement.',
  VITE_DM_LEGAL_DATA_LOCATION: 'France, région du VPS et du stockage vérifiée par l’exploitant.',
}

describe('public alpha legal configuration', () => {
  it('keeps an unprovisioned instance explicitly in preparation', () => {
    const config = readLegalConfiguration()
    expect(config.ready).toBe(false)
    expect(config.contactEmail).toBe('vezy.remi@gmail.com')
    expect(config.hostingDetails).toBe('')
    expect(config.dataLocation).toBe('')
    expect(config).toMatchObject({ deletionDays: 30, backupDays: 30, noticeDays: 30 })
  })

  it('requires real hosting information and a usable contact for publication', () => {
    expect(readLegalConfiguration(deployment).ready).toBe(true)
    expect(readLegalConfiguration({ ...deployment, VITE_DM_LEGAL_HOSTING_DETAILS: 'REPLACE_HOST' }).ready).toBe(false)
    expect(readLegalConfiguration({ ...deployment, VITE_DM_LEGAL_DATA_LOCATION: 'à confirmer' }).ready).toBe(false)
    expect(readLegalConfiguration({ ...deployment, VITE_DM_LEGAL_CONTACT_EMAIL: 'bad\naddress' }).ready).toBe(false)
  })

  it('does not read credentials into public metadata', () => {
    const config = readLegalConfiguration({ ...deployment, DM_OBJECT_SECRET_KEY: 'private-storage-secret' })
    expect(JSON.stringify(config)).not.toContain('private-storage-secret')
    expect(legalEnvironmentKeys.every((key) => key.startsWith('DM_LEGAL_'))).toBe(true)
  })

  it('accepts only the three published document identifiers', () => {
    expect(isLegalDocumentId('confidentialite')).toBe(true)
    expect(isLegalDocumentId('../confidentialite')).toBe(false)
    expect(isLegalDocumentId('confidentialite?token=private')).toBe(false)
  })
})
