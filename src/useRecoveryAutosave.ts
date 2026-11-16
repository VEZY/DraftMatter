import { useEffect, useRef } from 'react'

interface RecoveryAutosaveOptions {
  documentKey?: string
  source: string
  paused?: boolean
  onSnapshot: (source: string, documentKey: string) => boolean
  delay?: number
  maxWait?: number
}

/** Capture changed text after a pause, with a deadline that continuous typing cannot reset. */
export function useRecoveryAutosave({ documentKey, source, paused = false, onSnapshot,
  delay = 1800, maxWait = 60_000,
}: RecoveryAutosaveOptions) {
  const capture = useRef(onSnapshot)
  capture.current = onSnapshot
  const pending = useRef<{ key?: string; capturedSource?: string; dirtySince?: number }>({})

  useEffect(() => {
    if (pending.current.key !== documentKey) pending.current = { key: documentKey }
    if (!documentKey) return
    if (source === pending.current.capturedSource) {
      pending.current.dirtySince = undefined
      return
    }
    pending.current.dirtySince ??= Date.now()
    if (paused) return
    let pauseTimer: number | undefined
    let deadlineTimer: number | undefined
    const save = () => {
      window.clearTimeout(pauseTimer)
      window.clearTimeout(deadlineTimer)
      if (pending.current.key !== documentKey) return
      // A failed write does not retry in an idle loop. The next edit or resume can retry.
      if (capture.current(source, documentKey)) pending.current.capturedSource = source
      pending.current.dirtySince = undefined
    }
    pauseTimer = window.setTimeout(save, delay)
    deadlineTimer = window.setTimeout(save, Math.max(0, maxWait - (Date.now() - pending.current.dirtySince)))
    return () => {
      window.clearTimeout(pauseTimer)
      window.clearTimeout(deadlineTimer)
    }
  }, [documentKey, source, paused, delay, maxWait])
}
