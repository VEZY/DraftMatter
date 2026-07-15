/**
 * Normalize an artifact path without ever allowing it to leave the project.
 * Paths are stored with POSIX separators so manifests remain portable between
 * Windows, macOS, and Linux.
 */
export function normalizeProjectRelativePath(path: string): string | null {
  if (!path || path.includes('\0')) return null
  if (/^[\\/]/.test(path) || /^[a-z][a-z0-9+.-]*:/i.test(path)) return null

  const segments: string[] = []
  for (const segment of path.split(/[\\/]+/)) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      if (segments.length === 0) return null
      segments.pop()
      continue
    }
    segments.push(segment)
  }
  return segments.length > 0 ? segments.join('/') : null
}

/** Join a portable project-relative path to either a POSIX or Windows root. */
export function projectFilePath(root: string, relative: string): string | null {
  const child = normalizeProjectRelativePath(relative)
  if (!child) return null

  const separator = root.includes('\\') && !root.includes('/') ? '\\' : '/'
  const base = root.replace(/[\\/]+$/, '')
  const portableChild = child.replaceAll('/', separator)
  if (!base) return `${separator}${portableChild}`
  return `${base}${separator}${portableChild}`
}
