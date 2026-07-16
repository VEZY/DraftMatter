export function articleSizedFixture(pages = 90) {
  const sections = Array.from({ length: pages }, (_unused, index) => `## Section ${index + 1}

${`Canopy architecture and drought response remained measurable across cohort ${index + 1}. `.repeat(34)} [@vezy2020].

| Week | Control | Drought |
| ---: | ---: | ---: |
| ${index + 1} | ${100 + index} | ${82 + index} |
`).join('\n')
  return `---\ntitle: "Article-sized resilience fixture"\n---\n\n${sections}`
}
