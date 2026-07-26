import { z } from 'zod/v4'

const externalReference = z.string().regex(/^(?:project|document|node|cell|figure|table|equation|review|citation-candidate|artifact|operation):[A-Za-z0-9._~:-]+$/)
const revision = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const idempotencyKey = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$/)
const safeName = z.string().regex(/^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/)
const shortText = z.string().min(1).max(16_384)
const longText = z.string().min(1).max(1_000_000)

export const actorSchema = z.object({
  id: safeName.describe('Stable agent actor identifier; not a manuscript object ID.'),
  name: z.string().min(1).max(256),
  provider: z.string().min(1).max(256).optional(),
  model: z.string().min(1).max(256).optional(),
}).strict()

const referenceSelector = z.object({ kind: z.literal('reference'), reference: externalReference }).strict()
const sectionSelector = z.object({ kind: z.literal('section-label'), label: safeName }).strict()
const headingSelector = z.object({
  kind: z.literal('heading'),
  text: shortText,
  occurrence: z.number().int().positive().max(10_000).optional(),
}).strict()
const quoteSelector = z.object({
  kind: z.literal('quote'),
  quote: shortText,
  prefix: shortText.optional(),
  suffix: shortText.optional(),
  occurrence: z.number().int().positive().max(100_000).optional(),
}).strict()
const boundarySelector = z.object({
  kind: z.literal('document-boundary'),
  edge: z.enum(['start', 'end']),
}).strict()
const sectionTarget = z.union([referenceSelector, sectionSelector, headingSelector])
const paragraphSelector = z.object({
  kind: z.literal('paragraph'),
  section: sectionTarget.optional(),
  ordinal: z.number().int().positive().max(100_000),
}).strict()

export const selectorSchema = z.discriminatedUnion('kind', [
  referenceSelector,
  sectionSelector,
  headingSelector,
  paragraphSelector,
  quoteSelector,
  boundarySelector,
])

const placement = z.enum(['before', 'after', 'start', 'end', 'replace'])
const blockPlacement = z.enum(['before', 'after', 'start', 'end'])
const guard = {
  mode: z.enum(['preview', 'suggest', 'apply']),
  expectedRevision: revision,
  idempotencyKey,
  actor: actorSchema,
}

const textMutation = z.object({
  kind: z.literal('text'),
  operation: z.enum(['insert', 'replace', 'delete', 'format']),
  selector: selectorSchema,
  placement: placement.optional(),
  text: longText.optional(),
  format: z.enum(['bold', 'italic', 'code', 'clear']).optional(),
  rationale: longText.optional(),
}).strict()
const headingMutation = z.object({
  kind: z.literal('heading'),
  operation: z.enum(['insert', 'update']),
  selector: selectorSchema,
  placement: placement.optional(),
  level: z.number().int().min(1).max(6).optional(),
  text: shortText,
}).strict()
const equationMutation = z.object({
  kind: z.literal('equation'),
  operation: z.enum(['insert', 'update']),
  selector: selectorSchema,
  placement: placement.optional(),
  tex: longText,
  caption: shortText.optional(),
}).strict()
const citationMutation = z.object({
  kind: z.literal('citation'),
  operation: z.literal('insert'),
  selector: selectorSchema,
  placement: placement.optional(),
  citekeys: z.array(safeName).min(1).max(100),
  prefix: shortText.optional(),
  locator: shortText.optional(),
  suffix: shortText.optional(),
  suppressAuthor: z.boolean().optional(),
}).strict()
const crossReferenceMutation = z.object({
  kind: z.literal('cross-reference'),
  operation: z.literal('insert'),
  selector: selectorSchema,
  placement: placement.optional(),
  target: externalReference,
}).strict()
const valueMutation = z.object({
  kind: z.literal('published-value'),
  operation: z.literal('insert'),
  selector: selectorSchema,
  placement: placement.optional(),
  name: safeName,
}).strict()
const linkMutation = z.object({
  kind: z.literal('link'),
  operation: z.literal('insert'),
  selector: selectorSchema,
  placement: placement.optional(),
  text: shortText,
  href: z.url(),
}).strict()
const footnoteMutation = z.object({
  kind: z.literal('footnote'),
  operation: z.literal('insert'),
  selector: selectorSchema,
  placement: placement.optional(),
  text: longText,
}).strict()
const moveMutation = z.object({
  kind: z.literal('move'),
  operation: z.literal('move'),
  selector: selectorSchema,
  destination: selectorSchema,
  placement: blockPlacement,
}).strict()

export const manuscriptMutationSchema = z.discriminatedUnion('kind', [
  textMutation,
  headingMutation,
  equationMutation,
  citationMutation,
  crossReferenceMutation,
  valueMutation,
  linkMutation,
  footnoteMutation,
  moveMutation,
])

const page = {
  pageSize: z.number().int().positive().max(100).optional(),
  cursor: z.string().min(1).max(256).optional(),
}

export const projectToolSchema = z.object({
  action: z.enum(['inspect', 'capabilities', 'trust-status', 'trust', 'untrust']),
  acknowledgement: shortText.optional(),
}).strict()

export const manuscriptToolSchema = z.object({
  action: z.enum(['inspect', 'read', 'mutate']),
  include: z.array(z.enum(['metadata', 'outline', 'objects', 'citations', 'cells', 'values', 'reviews', 'diagnostics', 'publication'])).min(1).max(9).optional(),
  ...page,
  selector: selectorSchema.optional(),
  contextCharacters: z.number().int().min(0).max(8_000).optional(),
  includeSource: z.boolean().optional(),
  mode: guard.mode.optional(),
  expectedRevision: guard.expectedRevision.optional(),
  idempotencyKey: guard.idempotencyKey.optional(),
  actor: guard.actor.optional(),
  mutation: manuscriptMutationSchema.optional(),
}).strict()

const computationReference = {
  reference: externalReference.optional(),
  ...page,
}
const computationChange = {
  ...guard,
  reference: externalReference,
  source: longText.optional(),
  role: z.enum(['setup', 'figure', 'table', 'values', 'ordinary']).optional(),
  destination: selectorSchema.optional(),
  placement: blockPlacement.optional(),
  caption: shortText.optional(),
  alt: shortText.optional(),
}

export const computationToolSchema = z.object({
  action: z.enum(['inspect', 'create', 'update', 'move', 'remove', 'run', 'clean-run', 'status', 'logs', 'artifact', 'interrupt', 'restart', 'terminate']),
  ...computationReference,
  mode: guard.mode.optional(),
  expectedRevision: guard.expectedRevision.optional(),
  idempotencyKey: guard.idempotencyKey.optional(),
  actor: guard.actor.optional(),
  language: z.enum(['python', 'r', 'julia']).optional(),
  role: z.enum(['setup', 'figure', 'table', 'values', 'ordinary']).optional(),
  source: longText.optional(),
  selector: selectorSchema.optional(),
  placement: blockPlacement.optional(),
  caption: shortText.optional(),
  alt: shortText.optional(),
  publishedValues: z.array(safeName).max(100).optional(),
  references: z.array(externalReference).min(1).max(100).optional(),
  destination: selectorSchema.optional(),
  timeoutMs: z.number().int().positive().max(86_400_000).optional(),
}).strict()

const referenceMutation = {
  ...guard,
  candidate: externalReference.optional(),
  citekeys: z.array(safeName).min(1).max(100).optional(),
  selector: selectorSchema.optional(),
  placement: placement.optional(),
  prefix: shortText.optional(),
  locator: shortText.optional(),
  suffix: shortText.optional(),
  suppressAuthor: z.boolean().optional(),
}

export const referencesToolSchema = z.object({
  action: z.enum(['search', 'candidate', 'add', 'cite', 'add-and-cite', 'validate']),
  query: shortText.optional(),
  sources: z.array(z.enum(['project', 'zotero', 'crossref'])).min(1).max(3).optional(),
  allowNetwork: z.boolean().optional(),
  ...page,
  mode: guard.mode.optional(),
  expectedRevision: guard.expectedRevision.optional(),
  idempotencyKey: guard.idempotencyKey.optional(),
  actor: guard.actor.optional(),
  candidate: externalReference.optional(),
  citekeys: z.array(safeName).min(1).max(100).optional(),
  selector: selectorSchema.optional(),
  placement: placement.optional(),
  prefix: shortText.optional(),
  locator: shortText.optional(),
  suffix: shortText.optional(),
  suppressAuthor: z.boolean().optional(),
}).strict()

const reviewMutation = {
  ...guard,
  selector: selectorSchema.optional(),
  proposal: longText.optional(),
  rationale: longText.optional(),
  reference: externalReference.optional(),
  decision: z.enum(['accepted', 'rejected']).optional(),
}

export const reviewToolSchema = z.object({
  action: z.enum(['inspect', 'suggest', 'decide', 'rebase']),
  ...page,
  mode: guard.mode.optional(),
  expectedRevision: guard.expectedRevision.optional(),
  idempotencyKey: guard.idempotencyKey.optional(),
  actor: guard.actor.optional(),
  selector: selectorSchema.optional(),
  proposal: longText.optional(),
  rationale: longText.optional(),
  reference: externalReference.optional(),
  decision: z.enum(['accepted', 'rejected']).optional(),
}).strict()

export const validateToolSchema = z.object({
  action: z.enum(['project', 'references', 'freshness', 'reviews', 'publication']),
}).strict()
