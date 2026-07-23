export function isSafePortableLinkDestination(value: string) {
  const destination = value.trim()
  return Boolean(destination)
    && !/[\u0000-\u001f\u007f\s]/.test(destination)
    && !/^(?:javascript|vbscript|data):/i.test(destination)
}
