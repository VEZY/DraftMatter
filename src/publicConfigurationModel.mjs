export const PUBLIC_RUNTIME_ENVIRONMENT_KEYS = Object.freeze([
  'VITE_DRAFTMATTER_COLLABORATION_URL',
  'VITE_DM_LEGAL_PUBLISHER_NAME',
  'VITE_DM_LEGAL_CONTACT_EMAIL',
  'VITE_DM_LEGAL_HOSTING_DETAILS',
  'VITE_DM_LEGAL_DATA_LOCATION',
  'VITE_DM_LEGAL_ADDITIONAL_PROCESSORS',
])

const placeholder = /REPLACE_|à (?:renseigner|confirmer)|\b(?:to be (?:confirmed|provided|completed)|not yet (?:confirmed|configured)|TBD|TODO)\b|example\.(?:com|org|net|test|invalid)/i
const ownKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))

/** Shared by the container entrypoint and browser; never copy arbitrary environment entries. */
export function validatePublicRuntimeConfiguration(value) {
  if (!ownKeys(value, ['schemaVersion', 'environment']) || value.schemaVersion !== 1
      || !ownKeys(value.environment, PUBLIC_RUNTIME_ENVIRONMENT_KEYS)) {
    throw new Error('The public web configuration has an unsupported schema.')
  }
  const environment = {}
  for (const key of PUBLIC_RUNTIME_ENVIRONMENT_KEYS) {
    const text = value.environment[key]
    if (typeof text !== 'string' || !text.trim() || text.length > 4000
        || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) {
      throw new Error(`Complete the public configuration field ${key}.`)
    }
    environment[key] = text.trim()
  }
  let url
  try { url = new URL(environment.VITE_DRAFTMATTER_COLLABORATION_URL) }
  catch { throw new Error('The public collaboration URL must be an HTTPS URL.') }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.search || url.hash) {
    throw new Error('The public collaboration URL must use HTTPS without credentials or query parameters.')
  }
  for (const key of PUBLIC_RUNTIME_ENVIRONMENT_KEYS.slice(1)) {
    if (placeholder.test(environment[key])) throw new Error(`Replace the placeholder in ${key} before starting the web application.`)
  }
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(environment.VITE_DM_LEGAL_CONTACT_EMAIL)) {
    throw new Error('Set a usable public legal contact email before starting the web application.')
  }
  return Object.freeze({ schemaVersion: 1, environment: Object.freeze(environment) })
}

export function publicConfigurationFromEnvironment(environment) {
  return validatePublicRuntimeConfiguration({ schemaVersion: 1, environment: {
    VITE_DRAFTMATTER_COLLABORATION_URL: environment.DM_PUBLIC_COLLABORATION_URL,
    VITE_DM_LEGAL_PUBLISHER_NAME: environment.DM_LEGAL_PUBLISHER_NAME,
    VITE_DM_LEGAL_CONTACT_EMAIL: environment.DM_LEGAL_CONTACT_EMAIL,
    VITE_DM_LEGAL_HOSTING_DETAILS: environment.DM_LEGAL_HOSTING_DETAILS,
    VITE_DM_LEGAL_DATA_LOCATION: environment.DM_LEGAL_DATA_LOCATION,
    VITE_DM_LEGAL_ADDITIONAL_PROCESSORS: environment.DM_LEGAL_ADDITIONAL_PROCESSORS,
  } })
}

export function serializePublicRuntimeConfiguration(value) {
  const clean = validatePublicRuntimeConfiguration(value)
  // JSON is served as application/json, never executable JS; escaping also keeps
  // it safe if an operator previews it inside an HTML document.
  return JSON.stringify(clean).replace(/[<>&\u2028\u2029]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`) + '\n'
}
