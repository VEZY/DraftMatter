import { useEffect, useRef, useState } from 'react'
import { desktopHost } from './desktopHost'
import { normalizeProjectRelativePath } from './projectPaths'
import { previewImageMediaType, sanitizePreviewSvg } from './projectFilePreview'

const IMAGE_LIMIT = 8 * 1024 * 1024
const CACHE_LIMIT = 96 * 1024 * 1024
const FILE_LIMIT = 128
const READ_CONCURRENCY = 4
const EMPTY: Readonly<Record<string, string>> = Object.freeze({})

interface ImageUrl { url: string; size: number }
interface Snapshot {
  root?: string
  revision?: unknown
  urls: Readonly<Record<string, string>>
  problems: Readonly<Record<string, string>>
}

/** Read images through the confined project API, without granting filesystem URL access. */
export function useProjectImageUrls(root: string | undefined, paths: readonly string[], revision?: unknown) {
  const signature = JSON.stringify([...new Set(paths.flatMap((input) => {
    const path = normalizeProjectRelativePath(input)
    return path && /\.(?:png|jpe?g|gif|webp|svg)$/i.test(path) ? [path] : []
  }))].sort())
  const cache = useRef(new Map<string, ImageUrl>())
  const problems = useRef(new Map<string, string>())
  const scope = useRef<{ root?: string; revision?: unknown }>({})
  const [snapshot, setSnapshot] = useState<Snapshot>({ urls: EMPTY, problems: EMPTY })

  useEffect(() => {
    let cancelled = false
    const wanted = JSON.parse(signature) as string[]
    const retained = new Set(wanted.slice(0, FILE_LIMIT))
    if (scope.current.root !== root || !Object.is(scope.current.revision, revision)) {
      for (const image of cache.current.values()) URL.revokeObjectURL(image.url)
      cache.current.clear(); problems.current.clear()
      scope.current = { root, revision }
    }
    for (const [path, image] of cache.current) if (!retained.has(path)) {
      URL.revokeObjectURL(image.url); cache.current.delete(path)
    }
    for (const path of problems.current.keys()) if (!retained.has(path)) problems.current.delete(path)
    for (const path of wanted.slice(FILE_LIMIT)) problems.current.set(path, 'The manuscript image preview supports up to 128 files.')
    const publish = () => {
      if (!cancelled) setSnapshot({ root, revision,
        urls: Object.fromEntries([...cache.current].map(([path, image]) => [path, image.url])),
        problems: Object.fromEntries(problems.current),
      })
    }
    publish()
    if (!root || !desktopHost.available) return () => { cancelled = true }
    const pending = [...retained].filter((path) => !cache.current.has(path) && !problems.current.has(path))
    let next = 0
    const read = async () => {
      while (!cancelled && next < pending.length) {
        const path = pending[next++]
        try {
          const preview = await desktopHost.readProjectFilePreview(root, path, IMAGE_LIMIT)
          if (cancelled) return
          if (preview.truncated || preview.size > IMAGE_LIMIT || preview.bytes.length > IMAGE_LIMIT) throw new Error('This image exceeds the 8 MiB manuscript preview limit.')
          const bytes = Uint8Array.from(preview.bytes)
          const type = previewImageMediaType(path, bytes)
          const content = type === 'image/svg+xml' ? sanitizePreviewSvg(new TextDecoder().decode(bytes)) : bytes.buffer
          const blob = new Blob([content], { type })
          const total = [...cache.current.values()].reduce((sum, image) => sum + image.size, 0)
          if (total + blob.size > CACHE_LIMIT) throw new Error('The manuscript image previews exceed the 96 MiB limit.')
          cache.current.set(path, { url: URL.createObjectURL(blob), size: blob.size })
        } catch (error) {
          if (cancelled) return
          problems.current.set(path, error instanceof Error ? error.message : String(error))
        }
        publish()
      }
    }
    for (let worker = 0; worker < Math.min(READ_CONCURRENCY, pending.length); worker++) void read()
    return () => { cancelled = true }
  }, [root, signature, revision])

  useEffect(() => () => {
    for (const image of cache.current.values()) URL.revokeObjectURL(image.url)
    cache.current.clear(); problems.current.clear()
  }, [])

  return snapshot.root === root && Object.is(snapshot.revision, revision)
    ? { urls: snapshot.urls, problems: snapshot.problems }
    : { urls: EMPTY, problems: EMPTY }
}
