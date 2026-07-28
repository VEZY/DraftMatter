export function normalizeSectionHeading(heading: string) {
  return heading
    .trim()
    .replace(/[ \t]+\{[^{}\r\n]*\}[ \t]*$/, '')
    .trim()
    .replace(/^\d+(?:\.\d+)*[.)]?\s+/, '')
    .toLowerCase()
}
