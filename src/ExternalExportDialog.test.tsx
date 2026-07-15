// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { desktopHost } from './desktopHost'
import { ExternalExportDialog } from './ExternalExportDialog'

async function flush() {
  await act(async () => new Promise((resolve) => window.setTimeout(resolve, 0)))
}

describe('external export dialog', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>
  let notices: string[]
  let closed: boolean

  beforeEach(async () => {
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    notices = []
    closed = false
    vi.spyOn(desktopHost, 'probeExternalExportTools').mockResolvedValue({
      pandoc: { adapter: 'pandoc', available: true, version: 'pandoc 3.6', executable: 'pandoc', message: 'detected' },
      quarto: { adapter: 'quarto', available: false, message: 'not installed' },
    })
    vi.spyOn(desktopHost, 'renderExternalExport').mockResolvedValue({ adapter: 'pandoc', format: 'html', path: '.draftmatter/exports/paper.html', bytes: 1200, message: 'No manuscript cells were executed.' })
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root.render(<ExternalExportDialog root="/research" source="# Clean" baseName="paper" onClose={() => { closed = true }} onNotice={(message) => notices.push(message)} />))
    await flush()
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    vi.restoreAllMocks()
    container.remove()
  })

  it('detects tools and starts only the selected explicit clean export', async () => {
    expect(container.textContent).toContain('pandoc 3.6')
    expect(container.textContent).toContain('quarto render')
    const exportButton = [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('Export with Pandoc'))!
    await act(async () => exportButton.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    await flush()

    expect(desktopHost.renderExternalExport).toHaveBeenCalledWith({ root: '/research', adapter: 'pandoc', format: 'html', source: '# Clean', outputName: 'paper.html' })
    expect(notices[0]).toContain('.draftmatter/exports/paper.html')
    expect(closed).toBe(true)
  })
})
