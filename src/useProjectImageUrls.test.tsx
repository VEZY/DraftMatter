// @vitest-environment jsdom
import { act, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { desktopHost } from './desktopHost'
import { useProjectImageUrls } from './useProjectImageUrls'

const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])
type Preview = Awaited<ReturnType<typeof desktopHost.readProjectFilePreview>>
const preview = (path: string, bytes = png): Preview => ({ path, bytes: [...bytes], size: bytes.length, truncated: false, hash: null, modifiedMs: 1 })

describe('confined manuscript image URLs', () => {
  let host: HTMLDivElement
  let app: Root
  let available: boolean
  let result: ReturnType<typeof useProjectImageUrls>
  let create: ReturnType<typeof vi.fn<(blob: Blob) => string>>
  let revoke: ReturnType<typeof vi.fn<(url: string) => void>>
  let blobs: Blob[]

  function Fixture({ root, paths, revision }: { root?: string; paths: string[]; revision?: unknown }) {
    result = useProjectImageUrls(root, paths, revision)
    return <output>{JSON.stringify(result)}</output>
  }
  async function render(root: string | undefined, paths: string[], revision?: unknown, strict = false) {
    await act(async () => app.render(strict
      ? <StrictMode><Fixture root={root} paths={paths} revision={revision} /></StrictMode>
      : <Fixture root={root} paths={paths} revision={revision} />))
  }
  beforeEach(() => {
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    available = desktopHost.available; desktopHost.available = true
    blobs = []
    create = vi.fn((blob: Blob) => { blobs.push(blob); return `blob:project-image-${blobs.length}` })
    revoke = vi.fn()
    vi.stubGlobal('URL', class extends URL { static createObjectURL = create; static revokeObjectURL = revoke })
    vi.spyOn(desktopHost, 'readProjectFilePreview').mockImplementation(async (_root, path) => preview(path))
    host = document.createElement('div'); document.body.append(host); app = createRoot(host)
  })
  afterEach(async () => {
    await act(async () => app.unmount()); host.remove()
    desktopHost.available = available; vi.restoreAllMocks(); vi.unstubAllGlobals()
  })

  it('loads confined bytes once while prose edits keep the same image paths, and releases removed URLs', async () => {
    await render('/project', ['figures/one.png', 'figures/two.png'])
    const first = result.urls['figures/one.png']
    const second = result.urls['figures/two.png']
    expect(first).toMatch(/^blob:/)
    expect(blobs[0].type).toBe('image/png')
    await render('/project', ['figures/two.png', 'figures/one.png', 'figures/one.png'])
    expect(desktopHost.readProjectFilePreview).toHaveBeenCalledTimes(2)
    expect(result.urls['figures/one.png']).toBe(first)
    await render('/project', ['figures/one.png'])
    expect(result.urls).toEqual({ 'figures/one.png': first })
    expect(revoke).toHaveBeenCalledWith(second)
    expect(revoke).not.toHaveBeenCalledWith(first)
    await render(undefined, [])
    expect(result.urls).toEqual({})
    expect(revoke).toHaveBeenCalledWith(first)
  })

  it('rejects traversal, non-images, truncated images and mismatched image bytes', async () => {
    vi.mocked(desktopHost.readProjectFilePreview).mockImplementation(async (_root, path) => path.endsWith('large.png')
      ? { ...preview(path), size: 8 * 1024 * 1024 + 1, truncated: true }
      : path.endsWith('invalid.png') ? preview(path, new TextEncoder().encode('<script>run()</script>')) : preview(path))
    await render('/project', ['../outside.png', 'file:///outside.png', 'https://outside.test/p.png', '.git/config', 'data.csv', 'large.png', 'invalid.png', 'good.png'])
    expect(desktopHost.readProjectFilePreview).toHaveBeenCalledTimes(3)
    expect(desktopHost.readProjectFilePreview).toHaveBeenCalledWith('/project', 'good.png', 8 * 1024 * 1024)
    expect(Object.keys(result.urls)).toEqual(['good.png'])
    expect(result.problems['large.png']).toContain('8 MiB')
    expect(result.problems['invalid.png']).toContain('do not match')
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('strips active and external SVG contents before creating an image URL', async () => {
    vi.mocked(desktopHost.readProjectFilePreview).mockResolvedValue(preview('figure.svg', new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>danger()</script><image href="https://external.test/image.png"/><rect width="10" height="10"/></svg>')))
    await render('/project', ['figure.svg'])
    expect(result.urls['figure.svg']).toMatch(/^blob:/)
    expect(blobs[0].type).toBe('image/svg+xml')
    const source = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error); reader.readAsText(blobs[0])
    })
    expect(source).toContain('<rect')
    expect(source).not.toMatch(/script|danger|image|external/)
  })

  it('never publishes an old project read into the next project and reloads an intentional revision', async () => {
    const pending: Array<(value: Preview) => void> = []
    vi.mocked(desktopHost.readProjectFilePreview).mockImplementation(() => new Promise((resolve) => pending.push(resolve)))
    await render('/first', ['figure.png'])
    await render('/second', ['figure.png'])
    expect(result.urls).toEqual({})
    await act(async () => pending[0](preview('figure.png')))
    expect(create).not.toHaveBeenCalled()
    await act(async () => pending[1](preview('figure.png')))
    const previous = result.urls['figure.png']
    expect(previous).toMatch(/^blob:/)
    await render('/second', ['figure.png'], 1)
    expect(result.urls).toEqual({})
    expect(revoke).toHaveBeenCalledWith(previous)
    await act(async () => pending[2](preview('figure.png')))
    expect(result.urls['figure.png']).not.toBe(previous)
  })

  it('bounds concurrent reads and the number of retained manuscript images', async () => {
    const pending: Array<(value: Preview) => void> = []
    vi.mocked(desktopHost.readProjectFilePreview).mockImplementation(() => new Promise((resolve) => pending.push(resolve)))
    const paths = Array.from({ length: 129 }, (_, index) => `figure-${String(index).padStart(3, '0')}.png`)
    await render('/project', paths)
    expect(pending).toHaveLength(4)
    expect(result.problems[paths[128]]).toContain('128')
    await act(async () => pending[0](preview(paths[0])))
    expect(pending).toHaveLength(5)
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('keeps the live URL after StrictMode effect replay and releases it on unmount', async () => {
    await render('/project', ['figure.png'], undefined, true)
    const current = result.urls['figure.png']
    expect(current).toMatch(/^blob:/)
    expect(create).toHaveBeenCalledTimes(1)
    expect(revoke).not.toHaveBeenCalledWith(current)
    await act(async () => app.unmount())
    expect(revoke).toHaveBeenCalledWith(current)
    app = createRoot(host)
  })

  it('ignores an image read that completes after unmount', async () => {
    let finish!: (value: Preview) => void
    vi.mocked(desktopHost.readProjectFilePreview).mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    await render('/project', ['figure.png'])
    await act(async () => app.unmount())
    await act(async () => finish(preview('figure.png')))
    expect(create).not.toHaveBeenCalled()
    app = createRoot(host)
  })
})
