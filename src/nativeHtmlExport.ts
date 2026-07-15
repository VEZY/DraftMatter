import { validateCleanProjection } from './document'
import { formatCrossReferenceTarget } from './crossReference'
import { parseDisplayEquation } from './displayEquation'
import { resolveFootnotes, type ResolvedFootnoteDocument } from './footnotes'
import { parsePublicationMetadata, removeDuplicateLeadingTitle } from './publicationMetadata'
import { parseTableCaptionLine, pipeTableAlignments, pipeTableCells } from './tableSyntax'

export interface NativeHtmlExportOptions {
  title?: string
  language?: string
  citationLabels?: Record<string, string>
  bibliography?: Array<{ id: string; value: string }>
}

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function safeId(value: string) {
  const id = value.trim().toLowerCase().replace(/[^a-z0-9_.:-]+/g, '-').replace(/^-+|-+$/g, '')
  return id || 'section'
}

function safeAssetUrl(value: string) {
  const trimmed = value.trim()
  if (!trimmed || /^(?:javascript|vbscript|file):/i.test(trimmed)) return ''
  if (/^data:/i.test(trimmed) && !/^data:image\/(?:png|gif|jpeg|webp|svg\+xml);base64,/i.test(trimmed)) return ''
  return escapeHtml(trimmed)
}

interface FootnoteRenderContext {
  numbers: Record<string, number>
  occurrences: Record<string, number>
}

function renderInline(value: string, options: NativeHtmlExportOptions, footnotes?: FootnoteRenderContext) {
  const token = /(\[[^\]\r\n]*@[a-zA-Z0-9_:.+-]+[^\]\r\n]*\]|`[^`\r\n]*`|\[\^[a-zA-Z0-9_.:-]+\]|\$[^$\r\n]+\$|@(?:fig|tbl|eq|sec)-[a-zA-Z0-9](?:[a-zA-Z0-9_.:-]*[a-zA-Z0-9])?)/g
  let html = ''
  let cursor = 0
  for (const match of value.matchAll(token)) {
    const start = match.index ?? 0
    html += escapeHtml(value.slice(cursor, start))
    const raw = match[0]
    if (raw.startsWith('`')) {
      html += `<code>${escapeHtml(raw.slice(1, -1))}</code>`
    } else if (raw.startsWith('[^')) {
      const label = raw.slice(2, -1)
      const number = footnotes?.numbers[label]
      if (number) {
        const occurrence = (footnotes.occurrences[label] ?? 0) + 1
        footnotes.occurrences[label] = occurrence
        const suffix = occurrence === 1 ? '' : `-${occurrence}`
        html += `<sup id="fnref-${safeId(label)}${suffix}"><a class="footnote-reference" href="#fn-${safeId(label)}" role="doc-noteref" aria-label="Footnote ${number}">${number}</a></sup>`
      } else {
        html += escapeHtml(raw)
      }
    } else if (raw.startsWith('$')) {
      const equation = raw.slice(1, -1)
      html += `<span class="equation inline-equation" data-tex="${escapeHtml(equation)}" role="math">${escapeHtml(equation)}</span>`
    } else if (raw.startsWith('@')) {
      const id = raw.slice(1)
      html += `<a class="cross-reference" href="#${escapeHtml(id)}">${escapeHtml(formatCrossReferenceTarget(id))}</a>`
    } else {
      const citekeys = [...raw.matchAll(/@([a-zA-Z0-9_:.+-]+)/g)].map((item) => item[1])
      const label = options.citationLabels?.[raw] ?? `(${citekeys.join('; ')})`
      html += `<cite class="citation" data-citekeys="${escapeHtml(citekeys.join(' '))}">${escapeHtml(label)}</cite>`
    }
    cursor = start + raw.length
  }
  html += escapeHtml(value.slice(cursor))
  return html
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label: string, url: string) => {
      const safe = safeAssetUrl(url)
      return safe ? `<a href="${safe}">${label}</a>` : label
    })
}

function isTableSeparator(line: string) {
  return /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line)
}

function startsBlock(lines: string[], index: number) {
  const line = lines[index] ?? ''
  return /^\s*(?:#{1,6}\s+|```|~~~|>\s?|[-+*]\s+|\d+[.)]\s+|\$\$|!\[[^\]]*\]\([^)]*\))/.test(line)
    || (line.includes('|') && isTableSeparator(lines[index + 1] ?? ''))
}

function renderBody(source: string, options: NativeHtmlExportOptions, footnotes: FootnoteRenderContext) {
  const lines = source.replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n')
  const html: string[] = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index]
    if (!line.trim() || /^<!--\s*dm-output:(?:start|end)\b/.test(line)) {
      index += 1
      continue
    }
    const heading = line.match(/^(#{1,6})\s+(.+?)(?:\s+\{#([a-zA-Z][\w.:-]*)[^}]*\})?\s*$/)
    if (heading) {
      const level = heading[1].length
      const label = heading[2]
      html.push(`<h${level} id="${escapeHtml(heading[3] ?? safeId(label))}">${renderInline(label, options, footnotes)}</h${level}>`)
      index += 1
      continue
    }
    const fence = line.match(/^\s*(`{3,}|~{3,})([^\s{]*)\s*(.*)$/)
    if (fence) {
      const marker = fence[1][0]
      const length = fence[1].length
      const code: string[] = []
      index += 1
      while (index < lines.length && !new RegExp(`^\\s*${marker}{${length},}\\s*$`).test(lines[index])) {
        code.push(lines[index])
        index += 1
      }
      if (index < lines.length) index += 1
      const language = safeId(fence[2] || 'text')
      html.push(`<figure class="source-code"><figcaption>${escapeHtml(language)} source · not executed during export</figcaption><pre><code class="language-${escapeHtml(language)}">${escapeHtml(code.join('\n'))}</code></pre></figure>`)
      continue
    }
    const equation = parseDisplayEquation(lines, index)
    if (equation) {
      if (equation.closed) {
        const id = equation.label ? ` id="${escapeHtml(equation.label)}"` : ''
        html.push(`<div${id} class="equation display-equation" data-tex="${escapeHtml(equation.tex)}" role="math">${escapeHtml(equation.tex)}</div>`)
      } else {
        html.push(`<pre class="raw-source" aria-label="Unclosed display equation">${escapeHtml(lines.slice(index, equation.end).join('\n'))}</pre>`)
      }
      index = equation.end
      continue
    }
    const figure = line.match(/^\s*!\[([^\]]*)\]\(([^)]+)\)(?:\{#([a-zA-Z][\w.:-]*)[^}]*\})?\s*$/)
    if (figure) {
      const url = safeAssetUrl(figure[2])
      const id = figure[3] ? ` id="${escapeHtml(figure[3])}"` : ''
      html.push(url
        ? `<figure${id}><img src="${url}" alt="${escapeHtml(figure[1])}"><figcaption>${renderInline(figure[1], options, footnotes)}</figcaption></figure>`
        : `<figure${id} class="missing-asset"><figcaption>${renderInline(figure[1], options, footnotes)} · unsafe or missing asset path</figcaption></figure>`)
      index += 1
      continue
    }
    if (line.includes('|') && isTableSeparator(lines[index + 1] ?? '')) {
      const headers = pipeTableCells(line)
      const alignments = pipeTableAlignments(lines[index + 1])
      index += 2
      const rows: string[][] = []
      while (index < lines.length && lines[index].includes('|') && lines[index].trim()) {
        rows.push(pipeTableCells(lines[index]))
        index += 1
      }
      const caption = parseTableCaptionLine(lines[index] ?? '')
      if (caption) index += 1
      const id = caption?.label ? ` id="${escapeHtml(caption.label)}"` : ''
      const alignment = (cellIndex: number) => alignments[cellIndex] ? ` style="text-align:${alignments[cellIndex]}"` : ''
      html.push(`<div class="table-wrap"><table${id}>${caption ? `<caption>${renderInline(caption.captionMarkdown, options, footnotes)}</caption>` : ''}<thead><tr>${headers.map((cell, cellIndex) => `<th${alignment(cellIndex)}>${renderInline(cell, options, footnotes)}</th>`).join('')}</tr></thead><tbody>${rows.map((row) => `<tr>${headers.map((_header, cellIndex) => `<td${alignment(cellIndex)}>${renderInline(row[cellIndex] ?? '', options, footnotes)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`)
      continue
    }
    if (/^\s*(?:[-+*]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d/.test(line)
      const items: string[] = []
      while (index < lines.length && (ordered ? /^\s*\d+[.)]\s+/.test(lines[index]) : /^\s*[-+*]\s+/.test(lines[index]))) {
        items.push(lines[index].replace(/^\s*(?:[-+*]|\d+[.)])\s+/, ''))
        index += 1
      }
      const tag = ordered ? 'ol' : 'ul'
      html.push(`<${tag}>${items.map((item) => `<li>${renderInline(item, options, footnotes)}</li>`).join('')}</${tag}>`)
      continue
    }
    if (/^\s*>/.test(line)) {
      const quote: string[] = []
      while (index < lines.length && /^\s*>/.test(lines[index])) {
        quote.push(lines[index].replace(/^\s*>\s?/, ''))
        index += 1
      }
      html.push(`<blockquote>${renderInline(quote.join(' '), options, footnotes)}</blockquote>`)
      continue
    }
    if (/^\s*(?:<[^>]+>|:{3,}\s*\{)/.test(line)) {
      const raw: string[] = [line]
      index += 1
      while (index < lines.length && lines[index].trim() && !startsBlock(lines, index)) {
        raw.push(lines[index])
        index += 1
      }
      html.push(`<pre class="raw-source" aria-label="Escaped raw source">${escapeHtml(raw.join('\n'))}</pre>`)
      continue
    }
    const paragraph = [line]
    index += 1
    while (index < lines.length && lines[index].trim() && !startsBlock(lines, index)) {
      paragraph.push(lines[index])
      index += 1
    }
    html.push(`<p>${renderInline(paragraph.join(' '), options, footnotes)}</p>`)
  }
  return html.join('\n')
}

function renderFootnotes(resolved: ResolvedFootnoteDocument, options: NativeHtmlExportOptions, context: FootnoteRenderContext) {
  if (!resolved.footnotes.length) return ''
  const items = resolved.footnotes.map((footnote) => {
    const missing = footnote.missing ? ' class="missing-footnote"' : ''
    const hasReference = (context.occurrences[footnote.label] ?? 0) > 0
    const backlink = hasReference ? ` <a class="footnote-backref" href="#fnref-${safeId(footnote.label)}" aria-label="Back to footnote ${footnote.number}">↩</a>` : ''
    return `<li id="fn-${safeId(footnote.label)}"${missing}>${renderInline(footnote.content, options, context)}${backlink}</li>`
  }).join('')
  return `<section class="footnotes" role="doc-endnotes" aria-label="Footnotes"><hr><ol>${items}</ol></section>`
}

export function renderNativeHtmlExport(source: string, options: NativeHtmlExportOptions = {}) {
  const diagnostics = validateCleanProjection(source)
  if (diagnostics.some((diagnostic) => diagnostic.code === 'clean-anchor-leak' || diagnostic.code === 'clean-review-leak')) {
    throw new Error('Native HTML export accepts only a clean DraftMatter projection without review storage markers.')
  }
  const metadata = parsePublicationMetadata(source)
  const title = options.title ?? metadata.title ?? 'DraftMatter manuscript'
  const authors = metadata.authors.length
    ? `<p class="authors">${metadata.authors.map(escapeHtml).join(' · ')}</p>`
    : ''
  const bibliography = options.bibliography?.length
    ? `<section class="bibliography" aria-labelledby="references"><h2 id="references">References</h2>${options.bibliography.map((entry) => `<p id="ref-${safeId(entry.id)}">${escapeHtml(entry.value)}</p>`).join('')}</section>`
    : ''
  const cleanBody = removeDuplicateLeadingTitle(metadata.body, title)
  const resolvedFootnotes = resolveFootnotes(cleanBody)
  const footnoteContext: FootnoteRenderContext = { numbers: resolvedFootnotes.numbers, occurrences: {} }
  const renderedBody = renderBody(resolvedFootnotes.body, options, footnoteContext)
  const footnotes = renderFootnotes(resolvedFootnotes, options, footnoteContext)
  return `<!doctype html>
<html lang="${escapeHtml(options.language ?? 'en')}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
:root{color-scheme:light;--ink:#26312c;--muted:#69756f;--line:#dfe4e0;--paper:#fff;--wash:#f5f7f5;--accent:#466b59}*{box-sizing:border-box}html{background:var(--wash);font-family:Georgia,"Times New Roman",serif;color:var(--ink);line-height:1.65}body{background:var(--paper);box-shadow:0 10px 40px rgba(31,44,37,.08);margin:40px auto;max-width:840px;padding:72px 84px}h1,h2,h3,h4,h5,h6{font-family:Inter,system-ui,sans-serif;line-height:1.25;margin:1.8em 0 .65em}h1{font-size:2.35rem;margin-top:0}h2{border-bottom:1px solid var(--line);font-size:1.35rem;padding-bottom:.35em}p{margin:.75em 0}.authors{color:var(--muted);font-family:Inter,system-ui,sans-serif;margin-top:-1.4rem}a{color:var(--accent)}cite{font-style:normal;color:#385e4c}.equation{font-family:"STIX Two Math",Cambria,serif}.display-equation{margin:1.4rem 0;overflow:auto;text-align:center}figure{margin:1.6rem 0}figure img{display:block;height:auto;max-width:100%}figcaption{color:var(--muted);font-family:Inter,system-ui,sans-serif;font-size:.82rem;margin-top:.45rem}.source-code{background:#f7f8f7;border:1px solid var(--line);border-radius:6px;padding:.8rem 1rem}.source-code pre{overflow:auto;margin:.5rem 0 0}.source-code code,.raw-source{font-family:"SFMono-Regular",Consolas,monospace;font-size:.78rem}.raw-source{background:#fff8f3;border-left:3px solid #c98b65;overflow:auto;padding:.75rem}.table-wrap{overflow-x:auto}table{border-collapse:collapse;margin:1.25rem 0;width:100%}caption{caption-side:bottom;color:var(--muted);font-family:Inter,system-ui,sans-serif;font-size:.82rem;padding-top:.45rem;text-align:left}th,td{border-bottom:1px solid var(--line);padding:.5rem;text-align:left}th{font-family:Inter,system-ui,sans-serif;font-size:.82rem}blockquote{border-left:3px solid #afbeb6;color:#53615a;margin:1.2rem 0;padding:.2rem 1rem}.footnote-reference{font-size:.75em;text-decoration:none;vertical-align:super}.footnotes{color:#46534c;font-size:.85rem;margin-top:2rem}.footnotes hr{border:0;border-top:1px solid var(--line);margin:0 0 1rem;width:28%}.footnotes li{padding-left:.25rem}.footnote-backref{text-decoration:none}.missing-footnote{color:#8b4f36}.bibliography p{font-size:.9rem;padding-left:1.5rem;text-indent:-1.5rem}@media print{html{background:#fff}body{box-shadow:none;margin:0;max-width:none;padding:0}@page{margin:18mm 16mm}a{color:inherit;text-decoration:none}h1{font-size:2.1rem}h1,h2,h3{break-after:avoid}h2{margin-top:1.2em}.display-equation,figure,table{margin-top:1rem;margin-bottom:1rem}.source-code,figure,table,.footnotes li,.bibliography p{break-inside:avoid}.bibliography h2{margin-top:1em}}@media(max-width:700px){body{box-shadow:none;margin:0;padding:36px 24px}}
</style>
</head>
<body>
<header><h1>${escapeHtml(title)}</h1>${authors}</header>
<main>${renderedBody}</main>
${footnotes}
${bibliography}
</body>
</html>
`
}

export function printNativeHtml(html: string) {
  const frame = document.createElement('iframe')
  frame.setAttribute('title', 'DraftMatter print preview')
  frame.style.position = 'fixed'
  frame.style.width = '1px'
  frame.style.height = '1px'
  frame.style.opacity = '0'
  frame.style.pointerEvents = 'none'
  frame.srcdoc = html
  frame.onload = () => {
    frame.contentWindow?.focus()
    frame.contentWindow?.print()
    window.setTimeout(() => frame.remove(), 1_000)
  }
  document.body.append(frame)
}
