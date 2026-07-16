import { downloadBlob } from './projections'

export interface GeneratedFileExport {
  suggestedName: string
  bytes: Uint8Array
  mimeType: string
  formatLabel: string
  successMessage: string
}

interface WritableFileHandle {
  createWritable: () => Promise<{ write: (data: Blob) => Promise<void>; close: () => Promise<void> }>
}

type BrowserSavePicker = (options: {
  suggestedName: string
  types: Array<{ description: string; accept: Record<string, string[]> }>
}) => Promise<WritableFileHandle>

export function exportFilenameProblem(filename: string, suggestedName: string) {
  const trimmed = filename.trim()
  const expectedExtension = suggestedName.match(/(\.[A-Za-z0-9]+)$/)?.[1]?.toLowerCase()
  if (!trimmed) return 'Enter a file name.'
  if (trimmed.length > 180) return 'Use a file name shorter than 180 characters.'
  if (/[\\/\u0000-\u001f]/.test(trimmed) || trimmed === '.' || trimmed === '..') return 'Use a file name without folders or control characters.'
  if (expectedExtension && !trimmed.toLowerCase().endsWith(expectedExtension)) return `Keep the ${expectedExtension} extension for this export.`
  return ''
}

export async function saveGeneratedFileInBrowser(
  file: GeneratedFileExport,
  picker = (globalThis as typeof globalThis & { showSaveFilePicker?: BrowserSavePicker }).showSaveFilePicker,
) {
  const blob = new Blob([file.bytes.slice().buffer], { type: file.mimeType })
  if (!picker) {
    downloadBlob(file.suggestedName, blob, file.mimeType)
    return 'download' as const
  }
  const extension = file.suggestedName.match(/(\.[A-Za-z0-9]+)$/)?.[1] ?? ''
  try {
    const handle = await picker({
      suggestedName: file.suggestedName,
      types: [{ description: file.formatLabel, accept: { [file.mimeType.split(';')[0]]: extension ? [extension] : [] } }],
    })
    const writable = await handle.createWritable()
    await writable.write(blob)
    await writable.close()
    return 'picker' as const
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return 'cancelled' as const
    throw error
  }
}
