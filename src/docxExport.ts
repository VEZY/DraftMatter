import { validateCleanProjection } from './document'
import { formatCrossReferenceTarget } from './crossReference'
import { parseDisplayEquation } from './displayEquation'
import { resolveFootnotes, type ResolvedFootnote } from './footnotes'
import { buildPublicationByline, parsePublicationMetadata, removeDuplicateLeadingTitle, type PublicationMetadata } from './publicationMetadata'
import { isPipeTableSeparator, parseTableCaptionLine, pipeTableAlignments, pipeTableCells, type TableAlignment } from './tableSyntax'
import { projectComputationsForPublication } from './publicationComputation'
import { createStoredZip } from './zipArchive'
import { isExplicitlyUnnumbered, numberedManuscriptObjects } from './numberedObjects'
import { parseStructuredManuscript } from './structuredManuscript'
import { publicationImageDimensions, publicationImageType, resolvePublicationImage, validatePublicationAssets, type PublicationAssetOptions } from './publicationAssets'
import { publicationOfficeMath } from './publicationMath'
import { isSafePortableLinkDestination } from './portableLink'

export interface DocxExportDiagnostic {
  code: 'figure-reference' | 'raw-source'
  level: 'info' | 'warning'
  message: string
}

export interface DocxExportResult {
  bytes: Uint8Array<ArrayBuffer>
  diagnostics: DocxExportDiagnostic[]
}

export interface DocxExportOptions extends PublicationAssetOptions {
  citationLabels?: Record<string, string>
  bibliography?: Array<{ id: string; value: string }>
  objectLabels?: Record<string, string>
}

interface DocxImage { name: string; bytes: Uint8Array; mimeType: string; relationshipId: string }
interface DocxLink { target: string; relationshipId: string }
interface DocxRenderOptions extends DocxExportOptions { images: DocxImage[]; links: DocxLink[] }

function xml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

function paragraph(value: string, style?: string) {
  const properties = style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''
  const lines = value.split('\n')
  const runs = lines.map((line, index) => `${index ? '<w:r><w:br/></w:r>' : ''}<w:r><w:t xml:space="preserve">${xml(line)}</w:t></w:r>`).join('')
  return `<w:p>${properties}${runs}</w:p>`
}

function table(rows: string[][], alignments: TableAlignment[], numbers: Record<string, number>, options: DocxRenderOptions) {
  const columns = Math.max(...rows.map((row) => row.length))
  return `<w:tbl><w:tblPr><w:tblStyle w:val="DraftMatterTable"/><w:tblW w:w="0" w:type="auto"/><w:tblBorders><w:top w:val="single" w:sz="4" w:color="D9E0DC"/><w:left w:val="nil"/><w:bottom w:val="single" w:sz="4" w:color="D9E0DC"/><w:right w:val="nil"/><w:insideH w:val="single" w:sz="4" w:color="E6EBE8"/><w:insideV w:val="nil"/></w:tblBorders></w:tblPr><w:tblGrid>${Array.from({ length: columns }, () => '<w:gridCol w:w="2400"/>').join('')}</w:tblGrid>${rows.map((row, rowIndex) => `<w:tr>${Array.from({ length: columns }, (_unused, index) => `<w:tc><w:tcPr><w:tcW w:w="2400" w:type="dxa"/></w:tcPr>${paragraphWithFootnotes(stripInlineMarkdown(row[index] ?? '', options), numbers, rowIndex === 0 ? 'TableHeader' : undefined, alignments[index], options)}</w:tc>`).join('')}</w:tr>`).join('')}</w:tbl>`
}

function stripInlineMarkdown(value: string, options: DocxExportOptions) {
  return value
    .replace(/\[[^\]\r\n]*@[a-zA-Z0-9_:.+-]+[^\]\r\n]*\]/g, (cluster) => {
      const citekeys = [...cluster.matchAll(/@([a-zA-Z0-9_:.+-]+)/g)].map((item) => item[1])
      return options.citationLabels?.[cluster] ?? '(' + citekeys.join('; ') + ')'
    })
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/@(fig|tbl|eq|sec)-[a-zA-Z0-9](?:[a-zA-Z0-9_.:-]*[a-zA-Z0-9])?/g, (reference) => options.objectLabels?.[reference.slice(1)] ?? formatCrossReferenceTarget(reference))
}

function inlineRuns(value: string, numbers: Record<string, number>, options?: DocxRenderOptions, properties = ''): string {
  const runs: string[] = []
  const plain = (text: string) => `<w:r>${properties ? `<w:rPr>${properties}</w:rPr>` : ''}<w:t xml:space="preserve">${xml(text)}</w:t></w:r>`
  let cursor = 0
  const pattern = /\\[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]| {2,}\n|\\\n|`[^`\r\n]+`|\*\*[^*\r\n]+\*\*|\*[^*\r\n]+\*|\$[^$\r\n]+\$|\[[^\]\r\n]+\]\([^)\r\n]+\)|\[\^[a-zA-Z0-9_.:-]+\]/g
  for (const match of value.matchAll(pattern)) {
    const start = match.index ?? 0
    if (start > cursor) runs.push(plain(value.slice(cursor, start)))
    const raw = match[0]
    const link = raw.match(/^\[([^\]]+)\]\(([^)]+)\)$/)
    if (/^(?: {2,}|\\)\n$/.test(raw)) runs.push('<w:r><w:br/></w:r>')
    else if (raw.startsWith('\\')) runs.push(plain(raw.slice(1)))
    else if (raw.startsWith('`')) runs.push(plain(raw.slice(1, -1)))
    else if (raw.startsWith('**')) runs.push(inlineRuns(raw.slice(2, -2), numbers, options, `${properties}<w:b/>`))
    else if (raw.startsWith('*')) runs.push(inlineRuns(raw.slice(1, -1), numbers, options, `${properties}<w:i/>`))
    else if (raw.startsWith('$')) runs.push(publicationOfficeMath(raw.slice(1, -1)))
    else if (link) {
      const target = link[2].replace(/\s+["'][^"']*["']$/, '')
      if (options && isSafePortableLinkDestination(target) && /^https?:\/\//i.test(target)) {
        let reference = options.links.find((candidate) => candidate.target === target)
        if (!reference) { reference = { target, relationshipId: `rIdLink${options.links.length + 1}` }; options.links.push(reference) }
        runs.push(`<w:hyperlink r:id="${reference.relationshipId}">${inlineRuns(link[1], numbers, options, `${properties}<w:u w:val="single"/>`)}</w:hyperlink>`)
      } else runs.push(inlineRuns(link[1], numbers, options, properties))
    } else {
      const label = raw.slice(2, -1)
      const number = numbers[label]
      runs.push(number ? `<w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteReference w:id="${number}"/></w:r>` : plain(raw))
    }
    cursor = start + raw.length
  }
  if (cursor < value.length) runs.push(plain(value.slice(cursor)))
  return runs.join('') || plain('')
}

function paragraphWithFootnotes(value: string, numbers: Record<string, number>, style?: string, alignment?: TableAlignment, options?: DocxRenderOptions) {
  const propertyContent = `${style ? `<w:pStyle w:val="${style}"/>` : ''}${alignment ? `<w:jc w:val="${alignment}"/>` : ''}`
  const properties = propertyContent ? `<w:pPr>${propertyContent}</w:pPr>` : ''
  return `<w:p>${properties}${inlineRuns(value, numbers, options)}</w:p>`
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

function imageParagraph(source: string, description: string, options: DocxRenderOptions) {
  const asset = resolvePublicationImage(source, options)
  if (!asset) return undefined
  const type = publicationImageType(asset.bytes)
  const ordinal = options.images.filter((image) => !image.relationshipId.startsWith('rIdSvg')).length + 1
  const primaryBytes = type.extension === 'svg' ? asset.fallbackPng ?? asset.bytes : asset.bytes
  if (type.extension === 'svg' && !asset.fallbackPng && options.requireAssets) throw new Error(`Figure needs a PNG fallback for Word. Prepare the SVG before exporting: ${source}.`)
  const primaryType = publicationImageType(primaryBytes)
  const relationshipId = `rIdImage${ordinal}`
  options.images.push({ name: `image${ordinal}.${primaryType.extension}`, bytes: primaryBytes, mimeType: primaryType.mimeType, relationshipId })
  let extension = ''
  if (type.extension === 'svg' && asset.fallbackPng) {
    const svgId = `rIdSvg${ordinal}`
    options.images.push({ name: `image${ordinal}.svg`, bytes: asset.bytes, mimeType: type.mimeType, relationshipId: svgId })
    extension = `<a:extLst><a:ext uri="{96DAC541-7B7A-43D3-8B79-37D633B846F1}"><asvg:svgBlip r:embed="${svgId}"/></a:ext></a:extLst>`
  }
  const dimensions = publicationImageDimensions(asset.bytes)
  const scale = Math.min(9525, 5_486_400 / dimensions.width, 6_858_000 / dimensions.height)
  const width = Math.max(1, Math.round(dimensions.width * scale))
  const height = Math.max(1, Math.round(dimensions.height * scale))
  return `<w:p><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${width}" cy="${height}"/><wp:docPr id="${ordinal}" name="Figure ${ordinal}" descr="${xml(description)}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="${ordinal}" name="Figure ${ordinal}" descr="${xml(description)}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${relationshipId}">${extension}</a:blip><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${width}" cy="${height}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`
}

function documentBody(source: string, diagnostics: DocxExportDiagnostic[], options: DocxRenderOptions) {
  const metadata = parsePublicationMetadata(source)
  const body = removeDuplicateLeadingTitle(metadata.body, metadata.title)
  const resolvedFootnotes = resolveFootnotes(body)
  const lines = resolvedFootnotes.body.replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n')
  const parts: string[] = []
  if (metadata.title) parts.push(paragraph(metadata.title, 'Title'))
  parts.push(...publicationBylineParagraphs(metadata))
  let index = 0
  const counters = { figure: 0, table: 0, equation: 0 }
  while (index < lines.length) {
    const line = lines[index]
    if (!line.trim() || /^<!--\s*dm-output:(?:start|end)\b/.test(line)) {
      index += 1
      continue
    }
    const heading = line.match(/^(#{1,6})\s+(.+?)(?:\s+\{#[^}]+\})?\s*$/)
    if (heading) {
      parts.push(paragraphWithFootnotes(stripInlineMarkdown(heading[2], options), resolvedFootnotes.numbers, `Heading${Math.min(heading[1].length, 3)}`, undefined, options))
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
      const unnumbered = isExplicitlyUnnumbered(equation.sourceAttributes)
      const number = unnumbered ? undefined : ++counters.equation
      const caption = equation.closed ? parseTableCaptionLine(lines[equation.end] ?? '') : null
      if (equation.closed) {
        parts.push(`<w:p><w:pPr><w:pStyle w:val="Equation"/></w:pPr>${publicationOfficeMath(equation.tex, true)}${number ? `<w:r><w:t xml:space="preserve">    (${number})</w:t></w:r>` : ''}</w:p>`)
        if (caption) parts.push(paragraphWithFootnotes(`${number ? `Equation ${number}. ` : ''}${stripInlineMarkdown(caption.captionMarkdown, options)}`, resolvedFootnotes.numbers, 'Caption', undefined, options))
      } else {
        parts.push(paragraph(lines.slice(index, equation.end).join('\n'), 'CodeBlock'))
        diagnostics.push({ code: 'raw-source', level: 'warning', message: 'An unclosed display equation was preserved as visible source in the DOCX.' })
      }
      index = equation.end + (caption ? 1 : 0)
      continue
    }
    const figure = line.match(/^\s*!\[([^\]]*)\]\((<[^>]+>|[^)\s]+)(?:\s+["'][^"']*["'])?\)(?:\{([^}]*)\})?\s*$/)
    if (figure) {
      const attributes = figure[3]?.trim()
      const unnumbered = isExplicitlyUnnumbered(attributes)
      const number = unnumbered ? undefined : ++counters.figure
      const caption = parseTableCaptionLine(lines[index + 1] ?? '')
      const source = figure[2].startsWith('<') ? figure[2].slice(1, -1) : figure[2]
      const embedded = /^data:image\//i.test(source)
      const reference = embedded ? 'embedded image not included in native DOCX' : source
      const captionText = caption?.captionMarkdown || figure[1]
      const drawing = imageParagraph(source, figure[1], options)
      if (drawing) parts.push(drawing)
      parts.push(paragraphWithFootnotes(`${number ? `Figure ${number}. ` : ''}${stripInlineMarkdown(captionText, options)}${drawing ? '' : ` — ${reference}`}`, resolvedFootnotes.numbers, 'Caption', undefined, options))
      if (!drawing) diagnostics.push({
        code: 'figure-reference',
        level: 'warning',
        message: embedded
          ? `Figure “${figure[1]}” uses an embedded data image. Reinsert it in Word if a self-contained DOCX is required.`
          : `Figure “${figure[1]}” remains a portable path reference (${source}). Embed it in Word after export if a self-contained DOCX is required.`,
      })
      index += caption ? 2 : 1
      continue
    }
    if (line.includes('|') && isPipeTableSeparator(lines[index + 1] ?? '')) {
      const rows = [pipeTableCells(line)]
      const alignments = pipeTableAlignments(lines[index + 1])
      index += 2
      while (index < lines.length && lines[index].includes('|') && lines[index].trim()) {
        rows.push(pipeTableCells(lines[index]))
        index += 1
      }
      const caption = parseTableCaptionLine(lines[index] ?? '')
      if (caption) index += 1
      const unnumbered = isExplicitlyUnnumbered(caption?.sourceAttributes)
      const number = unnumbered ? undefined : ++counters.table
      if (number || caption) parts.push(paragraphWithFootnotes(`${number ? `Table ${number}.` : ''}${caption ? `${number ? ' ' : ''}${stripInlineMarkdown(caption.captionMarkdown, options)}` : ''}`, resolvedFootnotes.numbers, 'Caption', undefined, options))
      parts.push(table(rows, alignments, resolvedFootnotes.numbers, options))
      continue
    }
    if (/^\s*(?:[-+*]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d/.test(line)
      let ordinal = 1
      while (index < lines.length && (ordered ? /^\s*\d+[.)]\s+/.test(lines[index]) : /^\s*[-+*]\s+/.test(lines[index]))) {
        const item = lines[index].replace(/^\s*(?:[-+*]|\d+[.)])\s+/, '')
        parts.push(paragraphWithFootnotes(`${ordered ? `${ordinal}.` : '•'} ${stripInlineMarkdown(item, options)}`, resolvedFootnotes.numbers, 'ListParagraph', undefined, options))
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
    parts.push(paragraphWithFootnotes(stripInlineMarkdown(text.join('\n'), options), resolvedFootnotes.numbers, undefined, undefined, options))
  }
  if (options.bibliography?.length) {
    parts.push(paragraph('References', 'Heading1'))
    for (const entry of options.bibliography) parts.push(paragraph(entry.value, 'ListParagraph'))
  }
  return { body: parts.join(''), footnotes: resolvedFootnotes.footnotes }
}

function contentTypes(hasFootnotes: boolean, images: DocxImage[]) {
  const footnotes = hasFootnotes ? '<Override PartName="/word/footnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"/>' : ''
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${[...new Map(images.map((image) => [image.name.split('.').at(-1), image.mimeType])).entries()].map(([extension, mimeType]) => `<Default Extension="${extension}" ContentType="${mimeType}"/>`).join('')}<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>${footnotes}<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`
}

const relationships = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`

function documentRelationships(hasFootnotes: boolean, options: DocxRenderOptions) {
  const footnotes = hasFootnotes ? '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes" Target="footnotes.xml"/>' : ''
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>${footnotes}${options.images.map((image) => `<Relationship Id="${image.relationshipId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${image.name}"/>`).join('')}${options.links.map((link) => `<Relationship Id="${link.relationshipId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${xml(link.target)}" TargetMode="External"/>`).join('')}</Relationships>`
}

const baseStyles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Aptos" w:hAnsi="Aptos"/><w:sz w:val="22"/><w:color w:val="26312C"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="140" w:line="320" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:rPr><w:rFonts w:ascii="Aptos Display"/><w:sz w:val="42"/><w:b/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Subtitle"><w:name w:val="Subtitle"/><w:rPr><w:color w:val="69756F"/><w:sz w:val="20"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Affiliation"><w:name w:val="Affiliation"/><w:pPr><w:spacing w:after="40"/></w:pPr><w:rPr><w:color w:val="69756F"/><w:sz w:val="17"/></w:rPr></w:style>${[1, 2, 3].map((level) => `<w:style w:type="paragraph" w:styleId="Heading${level}"><w:name w:val="heading ${level}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="${level + 8}"/><w:qFormat/><w:rPr><w:rFonts w:ascii="Aptos Display"/><w:b/><w:color w:val="33433B"/><w:sz w:val="${34 - level * 4}"/></w:rPr></w:style>`).join('')}<w:style w:type="paragraph" w:styleId="Caption"><w:name w:val="Caption"/><w:rPr><w:i/><w:color w:val="69756F"/><w:sz w:val="18"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="CodeBlock"><w:name w:val="Code Block"/><w:pPr><w:shd w:val="clear" w:fill="F4F6F4"/><w:ind w:left="180" w:right="180"/><w:spacing w:before="100" w:after="100"/></w:pPr><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:sz w:val="18"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Equation"><w:name w:val="Equation"/><w:pPr><w:jc w:val="center"/></w:pPr><w:rPr><w:rFonts w:ascii="Cambria Math"/><w:sz w:val="22"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:pPr><w:ind w:left="360" w:hanging="180"/></w:pPr></w:style><w:style w:type="paragraph" w:styleId="TableHeader"><w:name w:val="Table Header"/><w:rPr><w:b/></w:rPr></w:style><w:style w:type="table" w:styleId="DraftMatterTable"><w:name w:val="DraftMatter Table"/><w:tblPr><w:tblCellMar><w:top w:w="80" w:type="dxa"/><w:left w:w="100" w:type="dxa"/><w:bottom w:w="80" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style></w:styles>`

const footnoteStyles = '<w:style w:type="paragraph" w:styleId="FootnoteText"><w:name w:val="footnote text"/><w:basedOn w:val="Normal"/><w:next w:val="FootnoteText"/><w:uiPriority w:val="99"/><w:semiHidden/><w:unhideWhenUsed/><w:rPr><w:sz w:val="18"/></w:rPr></w:style><w:style w:type="character" w:styleId="FootnoteReference"><w:name w:val="footnote reference"/><w:uiPriority w:val="99"/><w:semiHidden/><w:unhideWhenUsed/><w:rPr><w:vertAlign w:val="superscript"/></w:rPr></w:style>'
const styles = baseStyles.replace('</w:styles>', `${footnoteStyles}</w:styles>`)

function footnotesXml(footnotes: ResolvedFootnote[], options: DocxRenderOptions) {
  const notes = footnotes.map((footnote) => {
    const content = stripInlineMarkdown(footnote.content, options).replace(/\[\^([a-zA-Z0-9_.:-]+)\]/g, (_reference, label: string) => `[${label}]`)
    return `<w:footnote w:id="${footnote.number}"><w:p><w:pPr><w:pStyle w:val="FootnoteText"/></w:pPr><w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteRef/></w:r>${inlineRuns(` ${content}`, {}, options)}</w:p></w:footnote>`
  }).join('')
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote><w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote>${notes}</w:footnotes>`
}

export function renderDocxExport(source: string, options: DocxExportOptions = {}): DocxExportResult {
  validatePublicationAssets(options.assets)
  const cleanDiagnostics = validateCleanProjection(source)
  if (cleanDiagnostics.some((diagnostic) => diagnostic.code === 'clean-anchor-leak' || diagnostic.code === 'clean-review-leak')) {
    throw new Error('DOCX export accepts only a clean DraftMatter projection without review storage markers.')
  }
  const publicationSource = projectComputationsForPublication(source)
  const objectLabels = Object.fromEntries(numberedManuscriptObjects(parseStructuredManuscript(publicationSource).document)
    .filter((object) => object.label && object.number)
    .map((object) => [object.label!, `${object.kind === 'figure' ? 'Figure' : object.kind === 'table' ? 'Table' : 'Equation'} ${object.number}`]))
  const renderOptions: DocxRenderOptions = { ...options, objectLabels, images: [], links: [] }
  const diagnostics: DocxExportDiagnostic[] = []
  const rendered = documentBody(publicationSource, diagnostics, renderOptions)
  const metadata = parsePublicationMetadata(publicationSource)
  const hasFootnotes = rendered.footnotes.length > 0
  const footnotesContent = hasFootnotes ? footnotesXml(rendered.footnotes, renderOptions) : ''
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" xmlns:asvg="http://schemas.microsoft.com/office/drawing/2016/SVG/main"><w:body>${rendered.body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`
  const created = new Date(0).toISOString()
  const creator = metadata.authors.length ? metadata.authors.join('; ') : 'DraftMatter'
  const core = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:creator>${xml(creator)}</dc:creator><cp:lastModifiedBy>DraftMatter</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">${created}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${created}</dcterms:modified><dc:description>Clean resolved manuscript export. DraftMatter review records and Word tracked changes are not included.</dc:description></cp:coreProperties>`
  const entries = [
    { name: '[Content_Types].xml', content: contentTypes(hasFootnotes, renderOptions.images) },
    { name: '_rels/.rels', content: relationships },
    { name: 'docProps/core.xml', content: core },
    { name: 'word/document.xml', content: documentXml },
    { name: 'word/styles.xml', content: styles },
    { name: 'word/_rels/document.xml.rels', content: documentRelationships(hasFootnotes, renderOptions) },
  ]
  if (hasFootnotes) {
    entries.push({ name: 'word/footnotes.xml', content: footnotesContent })
    if (renderOptions.links.length) entries.push({ name: 'word/_rels/footnotes.xml.rels', content: documentRelationships(false, { ...renderOptions, images: [] }) })
  }
  return {
    bytes: createStoredZip([...entries.map((entry) => ({ name: entry.name, bytes: entry.content })), ...renderOptions.images.map((image) => ({ name: `word/media/${image.name}`, bytes: image.bytes }))]),
    diagnostics,
  }
}
