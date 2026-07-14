import { useCallback, useReducer } from 'react'
import type { DraftState } from './types'

const DEFAULT_HISTORY_LIMIT = 100

export interface DraftHistoryState {
  past: DraftState[]
  present: DraftState
  future: DraftState[]
}

export type DraftHistoryAction =
  | { type: 'update'; patch: Partial<DraftState> }
  | { type: 'commit'; draft: DraftState }
  | { type: 'reset'; draft: DraftState }
  | { type: 'undo' }
  | { type: 'redo' }

export function createDraftHistory(draft: DraftState): DraftHistoryState {
  return { past: [], present: draft, future: [] }
}

function appendBounded(history: DraftState[], draft: DraftState, limit: number) {
  const next = [...history, draft]
  return next.length > limit ? next.slice(next.length - limit) : next
}

export function reduceDraftHistory(
  state: DraftHistoryState,
  action: DraftHistoryAction,
  limit = DEFAULT_HISTORY_LIMIT,
): DraftHistoryState {
  if (action.type === 'reset') return createDraftHistory(action.draft)

  if (action.type === 'undo') {
    const previous = state.past.at(-1)
    if (!previous) return state
    return {
      past: state.past.slice(0, -1),
      present: previous,
      future: [state.present, ...state.future],
    }
  }

  if (action.type === 'redo') {
    const next = state.future[0]
    if (!next) return state
    return {
      past: appendBounded(state.past, state.present, limit),
      present: next,
      future: state.future.slice(1),
    }
  }

  const next = action.type === 'commit' ? action.draft : { ...state.present, ...action.patch }
  if (next === state.present || Object.keys(next).every((key) => Object.is(next[key as keyof DraftState], state.present[key as keyof DraftState]))) {
    return state
  }
  return {
    past: appendBounded(state.past, state.present, limit),
    present: next,
    future: [],
  }
}

function defaultDraftHistoryReducer(state: DraftHistoryState, action: DraftHistoryAction) {
  return reduceDraftHistory(state, action)
}

export function useDraftHistory(initialDraft: DraftState) {
  const [history, dispatch] = useReducer(defaultDraftHistoryReducer, initialDraft, createDraftHistory)
  const update = useCallback((patch: Partial<DraftState>) => dispatch({ type: 'update', patch }), [])
  const commit = useCallback((draft: DraftState) => dispatch({ type: 'commit', draft }), [])
  const reset = useCallback((draft: DraftState) => dispatch({ type: 'reset', draft }), [])
  const undo = useCallback(() => dispatch({ type: 'undo' }), [])
  const redo = useCallback(() => dispatch({ type: 'redo' }), [])

  return {
    draft: history.present,
    update,
    commit,
    reset,
    undo,
    redo,
    canUndo: history.past.length > 0,
    canRedo: history.future.length > 0,
  }
}
