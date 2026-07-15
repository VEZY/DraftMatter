const CROSS_REFERENCE = /^(fig|tbl|eq|sec)-([a-zA-Z0-9](?:[a-zA-Z0-9_.:-]*[a-zA-Z0-9])?)$/

const kindLabels = {
  fig: 'Figure',
  tbl: 'Table',
  eq: 'Equation',
  sec: 'Section',
} as const

export function formatCrossReferenceTarget(value: string) {
  const target = value.trim().replace(/^@/, '')
  const match = target.match(CROSS_REFERENCE)
  if (!match) return value
  const description = match[2].replaceAll(/[-_.:]+/g, ' ').trim()
  return `${kindLabels[match[1] as keyof typeof kindLabels]} ${description}`
}

export function isCrossReferenceTarget(value: string) {
  return CROSS_REFERENCE.test(value.trim().replace(/^@/, ''))
}
