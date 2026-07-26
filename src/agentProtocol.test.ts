import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import {
  AGENT_CAPABILITY_BOUNDARIES,
  AGENT_EXIT_CODES,
  AGENT_OPERATION_VOCABULARY,
  AGENT_PROTOCOL_VERSION,
  agentExitCode,
  type AgentFailure,
} from './agentProtocol'
import { parseAgentRequest } from './agentRequestValidation'

async function fixture(name: string) {
  return JSON.parse(await readFile(new URL(`./fixtures/agent/${name}.json`, import.meta.url), 'utf8')) as Array<Record<string, unknown>>
}

describe('provider-neutral local agent protocol', () => {
  it('freezes the six domain operation groups without provider concepts', () => {
    expect(Object.keys(AGENT_OPERATION_VOCABULARY)).toEqual([
      'project', 'manuscript', 'computation', 'references', 'review', 'validate',
    ])
    expect(JSON.stringify(AGENT_OPERATION_VOCABULARY)).not.toMatch(/codex|openai|anthropic|claude|copilot|mistral|vibe/i)
    expect(AGENT_PROTOCOL_VERSION).toBe('1.0')
  })

  it('separates mutation, trust, and approval capability boundaries', () => {
    expect(AGENT_CAPABILITY_BOUNDARIES.read).toEqual({
      mutates: false,
      requiresTrust: false,
      explicitApproval: false,
    })
    expect(AGENT_CAPABILITY_BOUNDARIES.execute).toEqual({
      mutates: true,
      requiresTrust: true,
      explicitApproval: true,
    })
    expect(AGENT_CAPABILITY_BOUNDARIES.network.explicitApproval).toBe(true)
  })

  it('enumerates representative workflow fixtures without generated identities', async () => {
    const fixtures = await fixture('representative')
    expect(fixtures.map((entry) => entry.name)).toEqual([
      'tracked prose rewrite',
      'reproducible figure',
      'reproducible table and named values',
      'failed cell inspection',
      'stale-output validation',
      'authoritative duplicate reference search',
      'citation cluster',
      'review conflict inspection',
      'malformed managed markup validation',
    ])
    const creationRequests = fixtures
      .map((entry) => entry.request as Record<string, unknown>)
      .filter((request) => request.action === 'create')
    for (const request of creationRequests) {
      expect(request).not.toHaveProperty('id')
      expect(request).not.toHaveProperty('cellId')
      expect(request).not.toHaveProperty('outputId')
      expect(request).not.toHaveProperty('filename')
      expect(request).not.toHaveProperty('label')
    }
  })

  it('enumerates hostile-client fixtures and their required safe failures', async () => {
    const fixtures = await fixture('adversarial')
    expect(fixtures.map((entry) => entry.expectedCode)).toEqual([
      'unknown-field',
      'idempotency-conflict',
      'stale-revision',
      'ambiguous-selector',
      'path-outside-project',
      'output-truncated',
      'unknown-field',
      'project-not-trusted',
    ])
  })

  it('maps stable result categories to CLI exit codes', () => {
    const failure = (category: AgentFailure['error']['category']): AgentFailure => ({
      ok: false,
      protocolVersion: '1.0',
      requestId: 'request:test',
      operation: 'validate.project',
      diagnostics: [],
      error: { category, code: category, message: category, retryable: false },
    })
    expect(agentExitCode(failure('validation'))).toBe(AGENT_EXIT_CODES.validation)
    expect(agentExitCode(failure('conflict'))).toBe(AGENT_EXIT_CODES.conflict)
    expect(agentExitCode(failure('permission'))).toBe(AGENT_EXIT_CODES.permission)
    expect(agentExitCode(failure('execution'))).toBe(AGENT_EXIT_CODES.execution)
    expect(agentExitCode(failure('cancelled'))).toBe(AGENT_EXIT_CODES.cancelled)
    expect(agentExitCode(failure('invalid-request'))).toBe(AGENT_EXIT_CODES.invalidRequest)
    expect(agentExitCode(failure('internal'))).toBe(AGENT_EXIT_CODES.internal)
  })

  it('fails closed for malformed, oversized, deeply nested, and unknown inputs', () => {
    const deeplyNested: Record<string, unknown> = {}
    let cursor = deeplyNested
    for (let depth = 0; depth < 80; depth += 1) {
      const next: Record<string, unknown> = {}
      cursor.next = next
      cursor = next
    }
    const cases: unknown[] = [
      null,
      [],
      'not an object',
      deeplyNested,
      {
        protocolVersion: '1.0',
        domain: 'manuscript',
        action: 'read',
        selector: { kind: 'quote', quote: 'x'.repeat(1_100_000) },
      },
      {
        protocolVersion: '1.0',
        domain: 'computation',
        action: 'create',
        mode: 'apply',
        expectedRevision: `sha256:${'0'.repeat(64)}`,
        idempotencyKey: 'fuzz-generated-id-001',
        actor: { id: 'agent:fuzzer', name: 'Fuzzer' },
        language: 'python',
        role: 'ordinary',
        source: '1',
        selector: { kind: 'document-boundary', edge: 'end' },
        placement: 'after',
        outputId: 'caller-owned',
      },
    ]
    for (const value of cases) {
      expect(() => parseAgentRequest(value, { allowProjectRoot: true })).not.toThrow()
      expect(parseAgentRequest(value, { allowProjectRoot: true }).ok).toBe(false)
    }
  })
})
