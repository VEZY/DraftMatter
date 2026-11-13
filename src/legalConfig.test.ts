import { describe, expect, it } from 'vitest'
import { LEGAL_DOCUMENT_VERSION, isLegalDocumentId, legalDocuments, legalEnvironmentKeys, readLegalConfiguration } from './legalConfig'

const deployment = {
  VITE_DM_LEGAL_PUBLISHER_NAME: 'Rémi Vezy',
  VITE_DM_LEGAL_CONTACT_EMAIL: 'vezy.remi@gmail.com',
  VITE_DM_LEGAL_HOSTING_DETAILS: 'OVH SAS, contact details confirmed in the hosting agreement.',
  VITE_DM_LEGAL_DATA_LOCATION: 'Hosted in France by a French company.',
}

describe('public alpha legal configuration', () => {
  it('keeps an unprovisioned instance explicitly in preparation', () => {
    const config = readLegalConfiguration()
    expect(config.ready).toBe(false)
    expect(config.contactEmail).toBe('vezy.remi@gmail.com')
    expect(config.hostingDetails).toBe('')
    expect(config.dataLocation).toBe('')
    expect(config.additionalProcessors).toContain('Google (Gmail), for messages sent to the contact address.')
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

  it.each(['To be confirmed', 'Provider to be provided', 'Not yet configured', 'TBD'])('keeps English placeholders in preparation (%s)', (placeholder) => {
    expect(readLegalConfiguration({ ...deployment, VITE_DM_LEGAL_DATA_LOCATION: placeholder }).ready).toBe(false)
  })

  it('accepts only the three published document identifiers', () => {
    expect(legalDocuments).toEqual([
      { id: 'mentions-legales', title: 'Legal notice' },
      { id: 'confidentialite', title: 'Privacy policy' },
      { id: 'conditions-utilisation', title: 'Terms of use' },
    ])
    expect(isLegalDocumentId('confidentialite')).toBe(true)
    expect(isLegalDocumentId('../confidentialite')).toBe(false)
    expect(isLegalDocumentId('confidentialite?token=private')).toBe(false)
    expect(isLegalDocumentId('privacy-policy')).toBe(false)
    expect(LEGAL_DOCUMENT_VERSION).toBe('2026-11-13')
  })
})
