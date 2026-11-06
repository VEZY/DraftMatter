export function isSafePortableLinkDestination(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const destination = value.trim()
  return Boolean(destination)
    && !/[\u0000-\u001f\u007f\s]/.test(destination)
    && !/^(?:javascript|vbscript|data):/i.test(destination)
}
