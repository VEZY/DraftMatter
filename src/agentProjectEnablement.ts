import type { AgentProjectStore } from './agentProjectStore'
import { AgentProjectStoreError } from './agentProjectStore'

export const AI_INTEGRATION_SCHEMA_VERSION = 2
export const AI_INTEGRATION_MANIFEST_PATH = '.draftmatter/ai-integration.json'
export const DRAFTMATTER_AGENT_SKILL = 'draftmatter-authoring'

export interface DraftMatterAiProjectManifest {
  schemaVersion: 2
  protocolVersion: '1.0'
  draftmatterVersion: string
  enabled: true
  skill: {
    name: typeof DRAFTMATTER_AGENT_SKILL
    version: 1
    discovery: 'global'
    portableFallback: boolean
  }
  localAdapters: string[]
  files: Array<{
    path: string
    owner: 'managed-block' | 'generated-file'
    created: boolean
    generatedRevision: string | null
  }>
}

export async function readDraftMatterAiProjectManifest(store: AgentProjectStore) {
  let content: string
  try {
    content = (await store.readText(AI_INTEGRATION_MANIFEST_PATH)).content
  } catch (error) {
    if (error instanceof AgentProjectStoreError && error.code === 'project-missing') return null
    throw error
  }

  let value: unknown
  try {
    value = JSON.parse(content)
  } catch {
    throw new AgentProjectStoreError(
      'project-invalid',
      `${AI_INTEGRATION_MANIFEST_PATH} is not valid JSON. AI access remains disabled.`,
    )
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AgentProjectStoreError(
      'project-invalid',
      `${AI_INTEGRATION_MANIFEST_PATH} must contain one JSON object. AI access remains disabled.`,
    )
  }
  const manifest = value as Partial<DraftMatterAiProjectManifest>
  if (
    manifest.schemaVersion !== AI_INTEGRATION_SCHEMA_VERSION
    || manifest.protocolVersion !== '1.0'
    || manifest.enabled !== true
    || manifest.skill?.name !== DRAFTMATTER_AGENT_SKILL
    || manifest.skill.version !== 1
    || manifest.skill.discovery !== 'global'
    || typeof manifest.skill.portableFallback !== 'boolean'
    || !Array.isArray(manifest.localAdapters)
    || !Array.isArray(manifest.files)
  ) {
    throw new AgentProjectStoreError(
      'project-invalid',
      `${AI_INTEGRATION_MANIFEST_PATH} is missing a supported, enabled DraftMatter AI manifest. AI access remains disabled.`,
    )
  }
  return manifest as DraftMatterAiProjectManifest
}

export async function assertDraftMatterAiProjectEnabled(store: AgentProjectStore) {
  const manifest = await readDraftMatterAiProjectManifest(store)
  if (!manifest) {
    throw new AgentProjectStoreError(
      'project-invalid',
      'This DraftMatter project has not enabled AI integration. Open it in DraftMatter and choose “Enable AI for this project”.',
    )
  }
  return manifest
}
