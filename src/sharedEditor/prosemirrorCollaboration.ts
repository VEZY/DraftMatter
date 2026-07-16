import { Fragment, type Node as ProseMirrorNode, type Schema } from 'prosemirror-model'
import { keymap } from 'prosemirror-keymap'
import { EditorState, type Plugin } from 'prosemirror-state'
import {
  prosemirrorToYXmlFragment,
  redoCommand,
  undoCommand,
  yCursorPlugin,
  ySyncPlugin,
  yUndoPlugin,
} from 'y-prosemirror'
import type { Awareness } from 'y-protocols/awareness'
import * as Y from 'yjs'
import type { CollaborativeReviewBinding } from './collaborativeReview'

export const COLLABORATIVE_PROSEMIRROR_ROOT = 'draftmatter:prosemirror'

export interface CollaborativeEditorUser {
  id: string
  name: string
  color: string
}

export interface CollaborativeEditorBinding {
  document: Y.Doc
  awareness: Awareness
  user?: CollaborativeEditorUser
  publishPortableSource?: (source: string) => string | void
  review?: CollaborativeReviewBinding
}

export interface CollaborativeProseMirrorState {
  state: EditorState
  fragment: Y.XmlFragment
}

const SAFE_USER_ID = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/
const SAFE_COLOR = /^#[a-f0-9]{6}$/i

export function setCollaborativeEditorPresence(awareness: Awareness, user: CollaborativeEditorUser | null) {
  if (user === null) {
    awareness.setLocalStateField('user', null)
    return
  }
  if (!SAFE_USER_ID.test(user.id)) throw new Error('Collaborator ID must use a safe portable identifier.')
  if (!user.name.trim() || user.name.length > 200) throw new Error('Collaborator name must be between 1 and 200 characters.')
  if (!SAFE_COLOR.test(user.color)) throw new Error('Collaborator color must be a six-digit hexadecimal color.')
  awareness.setLocalStateField('user', { id: user.id, name: user.name.trim(), color: user.color.toLowerCase() })
}

export function collaborativeProseMirrorPlugins(fragment: Y.XmlFragment, awareness?: Awareness | null): Plugin[] {
  return [
    ySyncPlugin(fragment),
    ...(awareness ? [yCursorPlugin(awareness)] : []),
    yUndoPlugin(),
    keymap({ 'Mod-z': undoCommand, 'Mod-y': redoCommand, 'Shift-Mod-z': redoCommand }),
  ]
}

export function withoutCollaborativeReviewAnchors(document: ProseMirrorNode): ProseMirrorNode {
  if (document.isLeaf) return document
  const children: ProseMirrorNode[] = []
  document.forEach((child) => {
    if (child.type.name !== 'review_anchor') children.push(withoutCollaborativeReviewAnchors(child))
  })
  return document.copy(Fragment.fromArray(children))
}

export function createCollaborativeProseMirrorState(options: {
  document: Y.Doc
  schema: Schema
  initialDocument?: ProseMirrorNode
  awareness?: Awareness | null
}): CollaborativeProseMirrorState {
  const fragment = options.document.getXmlFragment(COLLABORATIVE_PROSEMIRROR_ROOT)
  if (fragment.length === 0 && options.initialDocument) {
    options.document.transact(() => {
      prosemirrorToYXmlFragment(withoutCollaborativeReviewAnchors(options.initialDocument!), fragment)
    }, 'prosemirror-initial-document')
  }
  return {
    fragment,
    state: EditorState.create({
      schema: options.schema,
      plugins: collaborativeProseMirrorPlugins(fragment, options.awareness),
    }),
  }
}

export function reconcileCollaborativeProseMirrorDocument(
  binding: CollaborativeEditorBinding,
  document: ProseMirrorNode,
) {
  const fragment = binding.document.getXmlFragment(COLLABORATIVE_PROSEMIRROR_ROOT)
  binding.document.transact(() => {
    prosemirrorToYXmlFragment(withoutCollaborativeReviewAnchors(document), fragment)
  }, 'draftmatter-portable-source-to-prosemirror')
  return fragment
}
