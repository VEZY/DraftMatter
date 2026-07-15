export interface ParsedDisplayEquation {
  tex: string
  label?: string
  sourceAttributes?: string
  end: number
  closed: boolean
}

function closingLine(value: string) {
  const match = value.match(/^(.*?)\$\$\s*(?:\{([^}\r\n]+)\})?\s*$/)
  if (!match) return undefined
  const sourceAttributes = match[2]?.trim()
  return {
    before: match[1],
    sourceAttributes,
    label: sourceAttributes?.match(/(?:^|\s)#([a-zA-Z][\w.:-]*)/)?.[1],
  }
}

export function parseDisplayEquation(lines: readonly string[], start: number): ParsedDisplayEquation | undefined {
  const opening = lines[start]?.match(/^\s*\$\$(.*)$/)
  if (!opening) return undefined

  const tex: string[] = []
  const sameLineClose = closingLine(opening[1])
  if (sameLineClose) {
    if (sameLineClose.before.trim()) tex.push(sameLineClose.before)
    return {
      tex: tex.join('\n').trim(),
      label: sameLineClose.label,
      sourceAttributes: sameLineClose.sourceAttributes,
      end: start + 1,
      closed: true,
    }
  }
  if (opening[1].trim()) tex.push(opening[1])

  for (let index = start + 1; index < lines.length; index += 1) {
    const close = closingLine(lines[index])
    if (close) {
      if (close.before.trim()) tex.push(close.before)
      return {
        tex: tex.join('\n').trim(),
        label: close.label,
        sourceAttributes: close.sourceAttributes,
        end: index + 1,
        closed: true,
      }
    }
    tex.push(lines[index])
  }

  return { tex: tex.join('\n').trim(), end: lines.length, closed: false }
}
