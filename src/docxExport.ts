import { validateCleanProjection } from './document'

export interface DocxExportDiagnostic {
  code: 'figure-reference' | 'raw-source'
  level: 'info' | 'warning'
  message: string
}

export interface DocxExportResult {
  bytes: Uint8Array<ArrayBuffer>
  diagnostics: DocxExportDiagnostic[]
}

interface ZipEntry {
  name: string
  bytes: Uint8Array
  crc: number
  offset: number
}

const encoder = new TextEncoder()

function xml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function write16(view: DataView, offset: number, value: number) {
  view.setUint16(offset, value, true)
}

function write32(view: DataView, offset: number, value: number) {
  view.setUint32(offset, value, true)
}

function storedZip(files: Array<{ name: string; content: string }>): Uint8Array<ArrayBuffer> {
  const entries: ZipEntry[] = []
  const localParts: Uint8Array[] = []
  let offset = 0
  for (const file of files) {
    const name = encoder.encode(file.name)
    const bytes = encoder.encode(file.content)
    const header = new Uint8Array(30 + name.length)
    const view = new DataView(header.buffer)
    write32(view, 0, 0x04034b50)
    write16(view, 4, 20)
    write16(view, 6, 0x0800)
    write16(view, 8, 0)
    write32(view, 14, crc32(bytes))
    write32(view, 18, bytes.length)
    write32(view, 22, bytes.length)
    write16(view, 26, name.length)
    header.set(name, 30)
    entries.push({ name: file.name, bytes, crc: crc32(bytes), offset })
    localParts.push(header, bytes)
    offset += header.length + bytes.length
  }

  const centralParts: Uint8Array[] = []
  let centralSize = 0
  for (const entry of entries) {
    const name = encoder.encode(entry.name)
    const header = new Uint8Array(46 + name.length)
    const view = new DataView(header.buffer)
    write32(view, 0, 0x02014b50)
    write16(view, 4, 20)
    write16(view, 6, 20)
    write16(view, 8, 0x0800)
    write16(view, 10, 0)
    write32(view, 16, entry.crc)
    write32(view, 20, entry.bytes.length)
    write32(view, 24, entry.bytes.length)
    write16(view, 28, name.length)
    write32(view, 38, 0)
    write32(view, 42, entry.offset)
    header.set(name, 46)
    centralParts.push(header)
    centralSize += header.length
  }

  const end = new Uint8Array(22)
  const endView = new DataView(end.buffer)
  write32(endView, 0, 0x06054b50)
  write16(endView, 8, entries.length)
  write16(endView, 10, entries.length)
  write32(endView, 12, centralSize)
  write32(endView, 16, offset)
  const total = offset + centralSize + end.length
  const archive = new Uint8Array(total)
  let cursor = 0
  for (const part of [...localParts, ...centralParts, end]) {
    archive.set(part, cursor)
    cursor += part.length
  }
  return archive
}

function paragraph(value: string, style?: string) {
  const properties = style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''
  const lines = value.split('\n')
  const runs = lines.map((line, index) => `${index ? '<w:r><w:br/></w:r>' : ''}<w:r><w:t xml:space="preserve">${xml(line)}</w:t></w:r>`).join('')
  return `<w:p>${properties}${runs}</w:p>`
}

function tableCells(line: string) {
  return line.trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim())
}

function isTableSeparator(line: string) {
  return /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line)
}

function table(rows: string[][]) {
  const columns = Math.max(...rows.map((row) => row.length))
  return `<w:tbl><w:tblPr><w:tblStyle w:val="DraftMatterTable"/><w:tblW w:w="0" w:type="auto"/><w:tblBorders><w:top w:val="single" w:sz="4" w:color="D9E0DC"/><w:left w:val="nil"/><w:bottom w:val="single" w:sz="4" w:color="D9E0DC"/><w:right w:val="nil"/><w:insideH w:val="single" w:sz="4" w:color="E6EBE8"/><w:insideV w:val="nil"/></w:tblBorders></w:tblPr><w:tblGrid>${Array.from({ length: columns }, () => '<w:gridCol w:w="2400"/>').join('')}</w:tblGrid>${rows.map((row, rowIndex) => `<w:tr>${Array.from({ length: columns }, (_unused, index) => `<w:tc><w:tcPr><w:tcW w:w="2400" w:type="dxa"/></w:tcPr>${paragraph(row[index] ?? '', rowIndex === 0 ? 'TableHeader' : undefined)}</w:tc>`).join('')}</w:tr>`).join('')}</w:tbl>`
}

function stripInlineMarkdown(value: string) {
  return value
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
}

function documentBody(source: string, diagnostics: DocxExportDiagnostic[]) {
  const frontmatter = source.match(/^---(?:\r\n|\n|\r)([\s\S]*?)(?:\r\n|\n|\r)---(?:\r\n|\n|\r|$)/)
  const title = frontmatter?.[1].match(/^title\s*:\s*(.+)$/m)?.[1]?.trim().replace(/^(["'])(.*)\1$/, '$2')
  const authors = [...(frontmatter?.[1] ?? '').matchAll(/^\s*-\s*(.+)$/gm)].map((match) => match[1].trim())
  const body = frontmatter ? source.slice(frontmatter[0].length) : source
  const lines = body.replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n')
  const parts: string[] = []
  if (title) parts.push(paragraph(title, 'Title'))
  if (authors.length) parts.push(paragraph(authors.join(' · '), 'Subtitle'))
  let index = 0
  while (index < lines.length) {
    const line = lines[index]
    if (!line.trim() || /^<!--\s*dm-output:(?:start|end)\b/.test(line)) {
      index += 1
      continue
    }
    const heading = line.match(/^(#{1,6})\s+(.+?)(?:\s+\{#[^}]+\})?\s*$/)
    if (heading) {
      parts.push(paragraph(stripInlineMarkdown(heading[2]), `Heading${Math.min(heading[1].length, 3)}`))
      index += 1
      continue
    }
    const fence = line.match(/^\s*(`{3,}|~{3,})([^\s{]*)/)
    if (fence) {
      const code: string[] = []
      const marker = fence[1][0]
      const length = fence[1].length
      index += 1
      while (index < lines.length && !new RegExp(`^\\s*${marker}{${length},}\\s*$`).test(lines[index])) {
        code.push(lines[index])
        index += 1
      }
      if (index < lines.length) index += 1
      parts.push(paragraph(`${fence[2] || 'text'} source · not executed during export`, 'Caption'))
      parts.push(paragraph(code.join('\n'), 'CodeBlock'))
      continue
    }
    if (/^\s*\$\$\s*$/.test(line)) {
      const equation: string[] = []
      index += 1
      while (index < lines.length && !/^\s*\$\$\s*$/.test(lines[index])) {
        equation.push(lines[index])
        index += 1
      }
      if (index < lines.length) index += 1
      parts.push(paragraph(equation.join(' ').trim(), 'Equation'))
      continue
    }
    const figure = line.match(/^\s*!\[([^\]]*)\]\(([^)]+)\)(?:\{#[^}]+\})?\s*$/)
    if (figure) {
      parts.push(paragraph(`Figure: ${figure[1]} — ${figure[2]}`, 'Caption'))
      diagnostics.push({ code: 'figure-reference', level: 'warning', message: `Figure “${figure[1]}” remains a portable path reference (${figure[2]}). Embed it in Word after export if a self-contained DOCX is required.` })
      index += 1
      continue
    }
    if (line.includes('|') && isTableSeparator(lines[index + 1] ?? '')) {
      const rows = [tableCells(line)]
      index += 2
      while (index < lines.length && lines[index].includes('|') && lines[index].trim()) {
        rows.push(tableCells(lines[index]))
        index += 1
      }
      parts.push(table(rows))
      continue
    }
    if (/^\s*(?:[-+*]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d/.test(line)
      let ordinal = 1
      while (index < lines.length && (ordered ? /^\s*\d+[.)]\s+/.test(lines[index]) : /^\s*[-+*]\s+/.test(lines[index]))) {
        const item = lines[index].replace(/^\s*(?:[-+*]|\d+[.)])\s+/, '')
        parts.push(paragraph(`${ordered ? `${ordinal}.` : '•'} ${stripInlineMarkdown(item)}`, 'ListParagraph'))
        ordinal += 1
        index += 1
      }
      continue
    }
    if (/^\s*(?:<[^>]+>|:{3,}\s*\{)/.test(line)) {
      const raw = [line]
      index += 1
      while (index < lines.length && lines[index].trim()) {
        raw.push(lines[index])
        index += 1
      }
      parts.push(paragraph(raw.join('\n'), 'CodeBlock'))
      diagnostics.push({ code: 'raw-source', level: 'info', message: 'Unsupported raw markup was preserved as inert source text in the DOCX.' })
      continue
    }
    const text = [line]
    index += 1
    while (index < lines.length && lines[index].trim() && !/^(?:#{1,6}\s+|```|~~~|\s*!\[|\s*[-+*]\s+|\s*\d+[.)]\s+)/.test(lines[index])) {
      text.push(lines[index])
      index += 1
    }
    parts.push(paragraph(stripInlineMarkdown(text.join(' '))))
  }
  return parts.join('')
}

const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`

const relationships = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`

const documentRelationships = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`

const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Aptos" w:hAnsi="Aptos"/><w:sz w:val="22"/><w:color w:val="26312C"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="140" w:line="320" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:rPr><w:rFonts w:ascii="Aptos Display"/><w:sz w:val="42"/><w:b/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Subtitle"><w:name w:val="Subtitle"/><w:rPr><w:color w:val="69756F"/><w:sz w:val="20"/></w:rPr></w:style>${[1, 2, 3].map((level) => `<w:style w:type="paragraph" w:styleId="Heading${level}"><w:name w:val="heading ${level}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="${level + 8}"/><w:qFormat/><w:rPr><w:rFonts w:ascii="Aptos Display"/><w:b/><w:color w:val="33433B"/><w:sz w:val="${34 - level * 4}"/></w:rPr></w:style>`).join('')}<w:style w:type="paragraph" w:styleId="Caption"><w:name w:val="Caption"/><w:rPr><w:i/><w:color w:val="69756F"/><w:sz w:val="18"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="CodeBlock"><w:name w:val="Code Block"/><w:pPr><w:shd w:val="clear" w:fill="F4F6F4"/><w:ind w:left="180" w:right="180"/><w:spacing w:before="100" w:after="100"/></w:pPr><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:sz w:val="18"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Equation"><w:name w:val="Equation"/><w:pPr><w:jc w:val="center"/></w:pPr><w:rPr><w:rFonts w:ascii="Cambria Math"/><w:sz w:val="22"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:pPr><w:ind w:left="360" w:hanging="180"/></w:pPr></w:style><w:style w:type="paragraph" w:styleId="TableHeader"><w:name w:val="Table Header"/><w:rPr><w:b/></w:rPr></w:style><w:style w:type="table" w:styleId="DraftMatterTable"><w:name w:val="DraftMatter Table"/><w:tblPr><w:tblCellMar><w:top w:w="80" w:type="dxa"/><w:left w:w="100" w:type="dxa"/><w:bottom w:w="80" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style></w:styles>`

export function renderDocxExport(source: string): DocxExportResult {
  const cleanDiagnostics = validateCleanProjection(source)
  if (cleanDiagnostics.some((diagnostic) => diagnostic.code === 'clean-anchor-leak' || diagnostic.code === 'clean-review-leak')) {
    throw new Error('DOCX export accepts only a clean DraftMatter projection without review storage markers.')
  }
  const diagnostics: DocxExportDiagnostic[] = []
  const body = documentBody(source, diagnostics)
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`
  const created = new Date(0).toISOString()
  const core = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:creator>DraftMatter</dc:creator><cp:lastModifiedBy>DraftMatter</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">${created}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${created}</dcterms:modified><dc:description>Clean resolved manuscript export. DraftMatter review records and Word tracked changes are not included.</dc:description></cp:coreProperties>`
  return {
    bytes: storedZip([
      { name: '[Content_Types].xml', content: contentTypes },
      { name: '_rels/.rels', content: relationships },
      { name: 'docProps/core.xml', content: core },
      { name: 'word/document.xml', content: documentXml },
      { name: 'word/styles.xml', content: styles },
      { name: 'word/_rels/document.xml.rels', content: documentRelationships },
    ]),
    diagnostics,
  }
}
