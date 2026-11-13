export const legalDocuments = [
  { id: 'mentions-legales', title: 'Legal notice' },
  { id: 'confidentialite', title: 'Privacy policy' },
  { id: 'conditions-utilisation', title: 'Terms of use' },
] as const

export type LegalDocumentId = typeof legalDocuments[number]['id']

export interface LegalConfiguration {
  publisherName: string
  contactEmail: string
  hostingDetails: string
  dataLocation: string
  additionalProcessors: string
  deletionDays: number
  backupDays: number
  noticeDays: number
  ready: boolean
}

export const LEGAL_DOCUMENT_VERSION = '2026-11-13'

export function isLegalDocumentId(value: string): value is LegalDocumentId {
  return legalDocuments.some((document) => document.id === value)
}

export const legalEnvironmentKeys = [
  'DM_LEGAL_PUBLISHER_NAME',
  'DM_LEGAL_CONTACT_EMAIL',
  'DM_LEGAL_HOSTING_DETAILS',
  'DM_LEGAL_DATA_LOCATION',
  'DM_LEGAL_ADDITIONAL_PROCESSORS',
] as const

function publicText(value: string | undefined, fallback = '') {
  return (value?.trim() || fallback).slice(0, 4000)
}

/** Only public information belongs here; this module is included in both bundles. */
export function readLegalConfiguration(environment: Record<string, string | undefined> = {}): LegalConfiguration {
  const value = (key: typeof legalEnvironmentKeys[number], fallback = '') => publicText(environment[`VITE_${key}`], fallback)
  const publisherName = value('DM_LEGAL_PUBLISHER_NAME', 'Rémi Vezy')
  const contactEmail = value('DM_LEGAL_CONTACT_EMAIL', 'vezy.remi@gmail.com')
  const hostingDetails = value('DM_LEGAL_HOSTING_DETAILS')
  const dataLocation = value('DM_LEGAL_DATA_LOCATION')
  const additionalProcessors = value('DM_LEGAL_ADDITIONAL_PROCESSORS', 'Google (Gmail), for messages sent to the contact address. Do not send manuscripts or research data by email; include only the project concerned and your request.')
  const fields = [publisherName, contactEmail, hostingDetails, dataLocation, additionalProcessors]
  const ready = fields.every((field) => Boolean(field) && !/REPLACE_|à (?:renseigner|confirmer)|\b(?:to be (?:confirmed|provided|completed)|not yet (?:confirmed|configured)|TBD|TODO)\b|example\.(?:com|org|net|test|invalid)/i.test(field))
    && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(contactEmail)
  return { publisherName, contactEmail, hostingDetails, dataLocation, additionalProcessors, deletionDays: 30, backupDays: 30, noticeDays: 30, ready }
}

export const legalConfiguration = readLegalConfiguration(import.meta.env)
