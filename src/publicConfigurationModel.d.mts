export type PublicRuntimeEnvironmentKey =
  | 'VITE_DRAFTMATTER_COLLABORATION_URL'
  | 'VITE_DM_LEGAL_PUBLISHER_NAME'
  | 'VITE_DM_LEGAL_CONTACT_EMAIL'
  | 'VITE_DM_LEGAL_HOSTING_DETAILS'
  | 'VITE_DM_LEGAL_DATA_LOCATION'
  | 'VITE_DM_LEGAL_ADDITIONAL_PROCESSORS'
export interface PublicRuntimeConfiguration {
  schemaVersion: 1
  environment: Readonly<Record<PublicRuntimeEnvironmentKey, string>>
}
export const PUBLIC_RUNTIME_ENVIRONMENT_KEYS: readonly PublicRuntimeEnvironmentKey[]
export function validatePublicRuntimeConfiguration(value: unknown): Readonly<PublicRuntimeConfiguration>
export function publicConfigurationFromEnvironment(environment: Record<string, string | undefined>): Readonly<PublicRuntimeConfiguration>
export function serializePublicRuntimeConfiguration(value: unknown): string
