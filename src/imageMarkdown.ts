/** The standalone image syntax shared by authoring and publication exports. */
export const standaloneImagePattern = /^\s*!\[((?:\\.|[^\]\\\r\n])*)\]\((<(?:(?:\\.)|[^>\\\r\n])*>|(?:\\.|[^\\)\s])+)(?:\s+(?:"((?:\\.|[^"\\\r\n])*)"|'((?:\\.|[^'\\\r\n])*)'))?\)(?:\s*\{([^}\r\n]+)\})?\s*$/

export function unescapeImageText(value: string) {
  return value.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, '$1')
}

export function parseMarkdownImage(line: string) {
  const image = line.match(standaloneImagePattern)
  if (!image) return undefined
  return {
    alt: unescapeImageText(image[1]),
    source: unescapeImageText(image[2].startsWith('<') ? image[2].slice(1, -1) : image[2]),
    title: image[3] !== undefined || image[4] !== undefined ? unescapeImageText(image[3] ?? image[4]) : null,
    attributes: image[5] || null,
  }
}
