import { parseRetainedPublishedValues, replacePublishedValueMarkup } from './publishedValues'

function executableFence(value: string) {
  const match = value.match(/^[ \t]*(`{3,}|~{3,})(.*)$/)
  if (!match) return undefined
  const info = match[2]
  if (!/(?:^|[\s{])\.execute(?:[\s}]|$)|\bexecute\s*=\s*(?:"true"|'true'|true)\b/.test(info)) return undefined
  return match[1]
}

function closingFence(value: string, fence: string) {
  const marker = fence[0]
  return new RegExp(`^[ \\t]*\\${marker}{${fence.length},}[ \\t]*$`).test(value)
}

export function projectComputationsForPublication(
  source: string,
  options: { stripOutputMarkers?: boolean } = {},
) {
  const ending = source.includes('\r\n') ? '\r\n' : source.includes('\r') ? '\r' : '\n'
  const lines = source.replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n')
  const retained = parseRetainedPublishedValues(source)
  const projected: string[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const fence = executableFence(lines[index])
    if (fence) {
      index += 1
      while (index < lines.length && !closingFence(lines[index], fence)) index += 1
      continue
    }
    if (/^<!--\s*dm-published-value\b[^>]*-->\s*$/.test(lines[index])) continue
    if (
      options.stripOutputMarkers
      && /^<!--\s*dm-output:(?:start\b[^>]*|end\s*)-->\s*$/.test(lines[index])
    ) continue
    projected.push(lines[index])
  }
  return replacePublishedValueMarkup(projected.join(ending), retained.values)
}
