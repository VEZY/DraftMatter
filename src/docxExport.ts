import { validateCleanProjection } from './document'
import { formatCrossReferenceTarget } from './crossReference'
import { parseDisplayEquation } from './displayEquation'
import { resolveFootnotes, type ResolvedFootnote } from './footnotes'
import { buildPublicationByline, parsePublicationMetadata, removeDuplicateLeadingTitle, type PublicationMetadata } from './publicationMetadata'
import { parseTableCaptionLine, pipeTableAlignments, pipeTableCells, type TableAlignment } from './tableSyntax'
import { projectComputationsForPublication } from './publicationComputation'

export interface DocxExportDiagnostic {
  code: 'figure-reference' | 'raw-source'
  level: 'info' | 'warning'
  message: string
}

export interface DocxExportResult {
  bytes: Uint8Array<ArrayBuffer>
  diagnostics: DocxExportDiagnostic[]
}

export interface DocxExportOptions {
  citationLabels?: Record<string, string>
  bibliography?: Array<{ id: string; value: string }>
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

function isTableSeparator(line: string) {
  return /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line)
}

function table(rows: string[][], alignments: TableAlignment[], numbers: Record<string, number>, options: DocxExportOptions) {
  const columns = Math.max(...rows.map((row) => row.length))
  return `<w:tbl><w:tblPr><w:tblStyle w:val="DraftMatterTable"/><w:tblW w:w="0" w:type="auto"/><w:tblBorders><w:top w:val="single" w:sz="4" w:color="D9E0DC"/><w:left w:val="nil"/><w:bottom w:val="single" w:sz="4" w:color="D9E0DC"/><w:right w:val="nil"/><w:insideH w:val="single" w:sz="4" w:color="E6EBE8"/><w:insideV w:val="nil"/></w:tblBorders></w:tblPr><w:tblGrid>${Array.from({ length: columns }, () => '<w:gridCol w:w="2400"/>').join('')}</w:tblGrid>${rows.map((row, rowIndex) => `<w:tr>${Array.from({ length: columns }, (_unused, index) => `<w:tc><w:tcPr><w:tcW w:w="2400" w:type="dxa"/></w:tcPr>${paragraphWithFootnotes(stripInlineMarkdown(row[index] ?? '', options), numbers, rowIndex === 0 ? 'TableHeader' : undefined, alignments[index])}</w:tc>`).join('')}</w:tr>`).join('')}</w:tbl>`
}

function stripInlineMarkdown(value: string, options: DocxExportOptions) {
  return value
    .replace(/\[[^\]\r\n]*@[a-zA-Z0-9_:.+-]+[^\]\r\n]*\]/g, (cluster) => {
      const citekeys = [...cluster.matchAll(/@([a-zA-Z0-9_:.+-]+)/g)].map((item) => item[1])
      return options.citationLabels?.[cluster] ?? '(' + citekeys.join('; ') + ')'
    })
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '$1')
    .replace(/\$([^$\r\n]+)\$/g, '$1')
    .replace(/@(fig|tbl|eq|sec)-[a-zA-Z0-9](?:[a-zA-Z0-9_.:-]*[a-zA-Z0-9])?/g, (reference) => formatCrossReferenceTarget(reference))
    .replace(/`([^`]+)`/g, '$1')
}

function paragraphWithFootnotes(value: string, numbers: Record<string, number>, style?: string, alignment?: TableAlignment) {
  const propertyContent = `${style ? `<w:pStyle w:val="${style}"/>` : ''}${alignment ? `<w:jc w:val="${alignment}"/>` : ''}`
  const properties = propertyContent ? `<w:pPr>${propertyContent}</w:pPr>` : ''
  const runs: string[] = []
  let cursor = 0
  for (const match of value.matchAll(/\[\^([a-zA-Z0-9_.:-]+)\]/g)) {
    const start = match.index ?? 0
    if (start > cursor) runs.push(`<w:r><w:t xml:space="preserve">${xml(value.slice(cursor, start))}</w:t></w:r>`)
    const number = numbers[match[1]]
    runs.push(number
      ? `<w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteReference w:id="${number}"/></w:r>`
      : `<w:r><w:t xml:space="preserve">${xml(match[0])}</w:t></w:r>`)
    cursor = start + match[0].length
  }
  if (cursor < value.length) runs.push(`<w:r><w:t xml:space="preserve">${xml(value.slice(cursor))}</w:t></w:r>`)
  if (!runs.length) runs.push('<w:r><w:t xml:space="preserve"></w:t></w:r>')
  return `<w:p>${properties}${runs.join('')}</w:p>`
}

function publicationBylineParagraphs(metadata: PublicationMetadata) {
  const byline = buildPublicationByline(metadata.authorDetails, metadata.authors)
  if (!byline.authors.length) return []
  const rich = byline.authors.some((author) => Boolean(author.orcid || author.affiliationNumbers.length))
  if (!rich) return [paragraph(byline.authors.map((author) => author.name).join(' · '), 'Subtitle')]
  const authorRuns = byline.authors.flatMap((author, index) => {
    const runs = [
      ...(index ? ['<w:r><w:t xml:space="preserve"> · </w:t></w:r>'] : []),
      `<w:r><w:t xml:space="preserve">${xml(author.name)}</w:t></w:r>`,
    ]
    if (author.affiliationNumbers.length) {
      runs.push(`<w:r><w:rPr><w:vertAlign w:val="superscript"/><w:sz w:val="14"/></w:rPr><w:t>${author.affiliationNumbers.join(',')}</w:t></w:r>`)
    }
    if (author.orcid) runs.push(`<w:r><w:rPr><w:sz w:val="16"/></w:rPr><w:t xml:space="preserve"> (ORCID ${xml(author.orcid)})</w:t></w:r>`)
    return runs
  })
  const authorParagraph = `<w:p><w:pPr><w:pStyle w:val="Subtitle"/></w:pPr>${authorRuns.join('')}</w:p>`
  const affiliations = byline.affiliations.map((affiliation, index) => `<w:p><w:pPr><w:pStyle w:val="Affiliation"/></w:pPr><w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:t>${index + 1}</w:t></w:r><w:r><w:t xml:space="preserve"> ${xml(affiliation)}</w:t></w:r></w:p>`)
  return [authorParagraph, ...affiliations]
}

function documentBody(source: string, diagnostics: DocxExportDiagnostic[], options: DocxExportOptions) {
  const metadata = parsePublicationMetadata(source)
  const body = removeDuplicateLeadingTitle(metadata.body, metadata.title)
  const resolvedFootnotes = resolveFootnotes(body)
  const lines = resolvedFootnotes.body.replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n')
  const parts: string[] = []
  if (metadata.title) parts.push(paragraph(metadata.title, 'Title'))
  parts.push(...publicationBylineParagraphs(metadata))
  let index = 0
  while (index < lines.length) {
    const line = lines[index]
    if (!line.trim() || /^<!--\s*dm-output:(?:start|end)\b/.test(line)) {
      index += 1
      continue
    }
    const heading = line.match(/^(#{1,6})\s+(.+?)(?:\s+\{#[^}]+\})?\s*$/)
    if (heading) {
      parts.push(paragraphWithFootnotes(stripInlineMarkdown(heading[2], options), resolvedFootnotes.numbers, `Heading${Math.min(heading[1].length, 3)}`))
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
      parts.push(paragraph(code.join('\n'), 'CodeBlock'))
      continue
    }
    const equation = parseDisplayEquation(lines, index)
    if (equation) {
      if (equation.closed) {
        parts.push(paragraph(equation.tex.replaceAll('\n', ' '), 'Equation'))
      } else {
        parts.push(paragraph(lines.slice(index, equation.end).join('\n'), 'CodeBlock'))
        diagnostics.push({ code: 'raw-source', level: 'warning', message: 'An unclosed display equation was preserved as visible source in the DOCX.' })
      }
      index = equation.end
      continue
    }
    const figure = line.match(/^\s*!\[([^\]]*)\]\(([^)]+)\)(?:\{#[^}]+\})?\s*$/)
    if (figure) {
      const embedded = /^data:image\//i.test(figure[2])
      const reference = embedded ? 'embedded image not included in native DOCX' : figure[2]
      parts.push(paragraphWithFootnotes(`Figure: ${stripInlineMarkdown(figure[1], options)} — ${reference}`, resolvedFootnotes.numbers, 'Caption'))
      diagnostics.push({
        code: 'figure-reference',
        level: 'warning',
        message: embedded
          ? `Figure “${figure[1]}” uses an embedded data image. Reinsert it in Word if a self-contained DOCX is required.`
          : `Figure “${figure[1]}” remains a portable path reference (${figure[2]}). Embed it in Word after export if a self-contained DOCX is required.`,
      })
      index += 1
      continue
    }
    if (line.includes('|') && isTableSeparator(lines[index + 1] ?? '')) {
      const rows = [pipeTableCells(line)]
      const alignments = pipeTableAlignments(lines[index + 1])
      index += 2
      while (index < lines.length && lines[index].includes('|') && lines[index].trim()) {
        rows.push(pipeTableCells(lines[index]))
        index += 1
      }
      const caption = parseTableCaptionLine(lines[index] ?? '')
      if (caption) index += 1
      parts.push(table(rows, alignments, resolvedFootnotes.numbers, options))
      if (caption) parts.push(paragraphWithFootnotes(`Table: ${stripInlineMarkdown(caption.captionMarkdown, options)}`, resolvedFootnotes.numbers, 'Caption'))
      continue
    }
    if (/^\s*(?:[-+*]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d/.test(line)
      let ordinal = 1
      while (index < lines.length && (ordered ? /^\s*\d+[.)]\s+/.test(lines[index]) : /^\s*[-+*]\s+/.test(lines[index]))) {
        const item = lines[index].replace(/^\s*(?:[-+*]|\d+[.)])\s+/, '')
        parts.push(paragraphWithFootnotes(`${ordered ? `${ordinal}.` : '•'} ${stripInlineMarkdown(item, options)}`, resolvedFootnotes.numbers, 'ListParagraph'))
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
    while (index < lines.length && lines[index].trim() && !/^(?:#{1,6}\s+|```|~~~|\s*\$\$|\s*!\[|\s*[-+*]\s+|\s*\d+[.)]\s+)/.test(lines[index])) {
      text.push(lines[index])
      index += 1
    }
    parts.push(paragraphWithFootnotes(stripInlineMarkdown(text.join(' '), options), resolvedFootnotes.numbers))
  }
  if (options.bibliography?.length) {
    parts.push(paragraph('References', 'Heading1'))
    for (const entry of options.bibliography) parts.push(paragraph(entry.value, 'ListParagraph'))
  }
  return { body: parts.join(''), footnotes: resolvedFootnotes.footnotes }
}

function contentTypes(hasFootnotes: boolean) {
  const footnotes = hasFootnotes ? '<Override PartName="/word/footnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"/>' : ''
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>${footnotes}<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`
}

const relationships = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`

function documentRelationships(hasFootnotes: boolean) {
  const footnotes = hasFootnotes ? '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes" Target="footnotes.xml"/>' : ''
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>${footnotes}</Relationships>`
}

const baseStyles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Aptos" w:hAnsi="Aptos"/><w:sz w:val="22"/><w:color w:val="26312C"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="140" w:line="320" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:rPr><w:rFonts w:ascii="Aptos Display"/><w:sz w:val="42"/><w:b/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Subtitle"><w:name w:val="Subtitle"/><w:rPr><w:color w:val="69756F"/><w:sz w:val="20"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Affiliation"><w:name w:val="Affiliation"/><w:pPr><w:spacing w:after="40"/></w:pPr><w:rPr><w:color w:val="69756F"/><w:sz w:val="17"/></w:rPr></w:style>${[1, 2, 3].map((level) => `<w:style w:type="paragraph" w:styleId="Heading${level}"><w:name w:val="heading ${level}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="${level + 8}"/><w:qFormat/><w:rPr><w:rFonts w:ascii="Aptos Display"/><w:b/><w:color w:val="33433B"/><w:sz w:val="${34 - level * 4}"/></w:rPr></w:style>`).join('')}<w:style w:type="paragraph" w:styleId="Caption"><w:name w:val="Caption"/><w:rPr><w:i/><w:color w:val="69756F"/><w:sz w:val="18"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="CodeBlock"><w:name w:val="Code Block"/><w:pPr><w:shd w:val="clear" w:fill="F4F6F4"/><w:ind w:left="180" w:right="180"/><w:spacing w:before="100" w:after="100"/></w:pPr><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:sz w:val="18"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Equation"><w:name w:val="Equation"/><w:pPr><w:jc w:val="center"/></w:pPr><w:rPr><w:rFonts w:ascii="Cambria Math"/><w:sz w:val="22"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:pPr><w:ind w:left="360" w:hanging="180"/></w:pPr></w:style><w:style w:type="paragraph" w:styleId="TableHeader"><w:name w:val="Table Header"/><w:rPr><w:b/></w:rPr></w:style><w:style w:type="table" w:styleId="DraftMatterTable"><w:name w:val="DraftMatter Table"/><w:tblPr><w:tblCellMar><w:top w:w="80" w:type="dxa"/><w:left w:w="100" w:type="dxa"/><w:bottom w:w="80" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style></w:styles>`

const footnoteStyles = '<w:style w:type="paragraph" w:styleId="FootnoteText"><w:name w:val="footnote text"/><w:basedOn w:val="Normal"/><w:next w:val="FootnoteText"/><w:uiPriority w:val="99"/><w:semiHidden/><w:unhideWhenUsed/><w:rPr><w:sz w:val="18"/></w:rPr></w:style><w:style w:type="character" w:styleId="FootnoteReference"><w:name w:val="footnote reference"/><w:uiPriority w:val="99"/><w:semiHidden/><w:unhideWhenUsed/><w:rPr><w:vertAlign w:val="superscript"/></w:rPr></w:style>'
const styles = baseStyles.replace('</w:styles>', `${footnoteStyles}</w:styles>`)

function footnotesXml(footnotes: ResolvedFootnote[], options: DocxExportOptions) {
  const notes = footnotes.map((footnote) => {
    const content = stripInlineMarkdown(footnote.content, options).replace(/\[\^([a-zA-Z0-9_.:-]+)\]/g, (_reference, label: string) => `[${label}]`)
    return `<w:footnote w:id="${footnote.number}"><w:p><w:pPr><w:pStyle w:val="FootnoteText"/></w:pPr><w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteRef/></w:r><w:r><w:t xml:space="preserve"> ${xml(content)}</w:t></w:r></w:p></w:footnote>`
  }).join('')
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote><w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote>${notes}</w:footnotes>`
}

export function renderDocxExport(source: string, options: DocxExportOptions = {}): DocxExportResult {
  const cleanDiagnostics = validateCleanProjection(source)
  if (cleanDiagnostics.some((diagnostic) => diagnostic.code === 'clean-anchor-leak' || diagnostic.code === 'clean-review-leak')) {
    throw new Error('DOCX export accepts only a clean DraftMatter projection without review storage markers.')
  }
  const publicationSource = projectComputationsForPublication(source)
  const diagnostics: DocxExportDiagnostic[] = []
  const rendered = documentBody(publicationSource, diagnostics, options)
  const metadata = parsePublicationMetadata(publicationSource)
  const hasFootnotes = rendered.footnotes.length > 0
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${rendered.body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`
  const created = new Date(0).toISOString()
  const creator = metadata.authors.length ? metadata.authors.join('; ') : 'DraftMatter'
  const core = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:creator>${xml(creator)}</dc:creator><cp:lastModifiedBy>DraftMatter</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">${created}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${created}</dcterms:modified><dc:description>Clean resolved manuscript export. DraftMatter review records and Word tracked changes are not included.</dc:description></cp:coreProperties>`
  const entries = [
    { name: '[Content_Types].xml', content: contentTypes(hasFootnotes) },
    { name: '_rels/.rels', content: relationships },
    { name: 'docProps/core.xml', content: core },
    { name: 'word/document.xml', content: documentXml },
    { name: 'word/styles.xml', content: styles },
    { name: 'word/_rels/document.xml.rels', content: documentRelationships(hasFootnotes) },
  ]
  if (hasFootnotes) entries.push({ name: 'word/footnotes.xml', content: footnotesXml(rendered.footnotes, options) })
  return {
    bytes: storedZip(entries),
    diagnostics,
  }
}
