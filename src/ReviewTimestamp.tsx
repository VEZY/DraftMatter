const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export interface PortableReviewTime {
  dateTime: string
  label: string
}

export function portableReviewTime(value?: string): PortableReviewTime | null {
  if (!value?.trim()) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  const dateTime = date.toISOString()
  const day = date.getUTCDate()
  const month = MONTHS[date.getUTCMonth()]
  const year = date.getUTCFullYear()
  const hour = String(date.getUTCHours()).padStart(2, '0')
  const minute = String(date.getUTCMinutes()).padStart(2, '0')
  return { dateTime, label: `${day} ${month} ${year} · ${hour}:${minute} UTC` }
}

export function ReviewTimestamp({
  value,
  fallback,
  detail,
}: {
  value?: string
  fallback: string
  detail?: string
}) {
  const timestamp = portableReviewTime(value)
  if (!timestamp) return <>{fallback}</>
  return <><time dateTime={timestamp.dateTime} title={`Recorded ${timestamp.label}`}>{timestamp.label}</time>{detail ? ` · ${detail}` : ''}</>
}
