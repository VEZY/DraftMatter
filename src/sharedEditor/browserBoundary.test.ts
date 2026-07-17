import { describe, expect, it } from 'vitest'
import * as sharedEditor from './index'

const sources = import.meta.glob('/src/**/*.{ts,tsx}', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>
const entry = '/src/sharedEditor/index.ts'
const localImport = /(?:from\s+|import\s*\()(['"])(\.{1,2}\/[^'"]+)\1/g
const bannedSpecifier = /(?:^|\/)(?:desktopHost|kernelExecutionTransport|executionTrust|GitHistoryPanel|ExternalExportDialog)(?:\.|$)|@tauri-apps|(?:^|\/)(?:node:)?(?:fs|child_process|net)(?:\/|$)/
const bannedSource = /@tauri-apps|node:(?:fs|child_process|net)|from\s+['"](?:fs|child_process|net)['"]|\b(?:window\.__TAURI__|invoke\s*\()/

function normalizePath(path: string) {
  const parts: string[] = []
  for (const part of path.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return `/${parts.join('/')}`
}

function resolveModule(from: string, specifier: string) {
  const candidate = normalizePath(`${from.slice(0, from.lastIndexOf('/'))}/${specifier}`)
  const possibilities = /\.(?:ts|tsx)$/.test(candidate)
    ? [candidate]
    : [`${candidate}.ts`, `${candidate}.tsx`, `${candidate}/index.ts`, `${candidate}/index.tsx`]
  const resolved = possibilities.find((path) => path in sources)
  if (!resolved) throw new Error(`Could not resolve browser source ${specifier} from ${from}`)
  return resolved
}

function dependencyGraph(root: string) {
  const visited = new Set<string>()
  const queue = [root]
  const edges: { from: string; specifier: string }[] = []
  while (queue.length > 0) {
    const file = queue.shift()!
    if (visited.has(file)) continue
    visited.add(file)
    const source = sources[file]
    if (source === undefined) throw new Error(`Browser source ${file} is missing from the Vite module graph`)
    expect(source, `${file} contains a privileged browser API`).not.toMatch(bannedSource)
    for (const match of source.matchAll(localImport)) {
      const specifier = match[2]
      edges.push({ from: file, specifier })
      expect(specifier, `${file} imports a privileged adapter`).not.toMatch(bannedSpecifier)
      queue.push(resolveModule(file, specifier))
    }
  }
  return { visited, edges }
}

describe('browser-safe shared editor boundary', () => {
  it('exports a closed capability contract with no privileged operation', () => {
    expect(sharedEditor.sharedEditorCapabilities).toEqual({
      documentEditing: true,
      review: true,
      portableImport: true,
      cleanClientExport: true,
      localFilesystem: false,
      localProcesses: false,
      codeExecution: false,
      git: false,
      externalRenderers: false,
    })
    expect(Object.isFrozen(sharedEditor.sharedEditorCapabilities)).toBe(true)
    expect(Object.keys(sharedEditor)).not.toEqual(expect.arrayContaining([
      'desktopHost',
      'execute',
      'gitStatus',
      'openProject',
      'renderExternalExport',
    ]))
  })

  it('keeps every transitive source dependency free of desktop privileges', () => {
    const graph = dependencyGraph(entry)
    expect(graph.visited.size).toBeGreaterThan(8)
    expect(graph.edges.length).toBeGreaterThan(8)
  })
})
