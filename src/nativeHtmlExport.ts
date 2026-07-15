import { validateCleanProjection } from './document'

export interface NativeHtmlExportOptions {
  title?: string
  language?: string
  citationLabels?: Record<string, string>
  bibliography?: Array<{ id: string; value: string }>
}

interface Frontmatter {
  title?: string
  authors: string[]
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

function parseFrontmatter(source: string): { body: string; frontmatter: Frontmatter } {
  const match = source.match(/^---(?:\r\n|\n|\r)([\s\S]*?)(?:\r\n|\n|\r)---(?:\r\n|\n|\r|$)/)
  if (!match) return { body: source, frontmatter: { authors: [] } }
  const yaml = match[1]
  const title = yaml.match(/^title\s*:\s*(.+)$/m)?.[1]?.trim().replace(/^(["'])(.*)\1$/, '$2')
  const authors: string[] = []
  const inlineAuthor = yaml.match(/^author\s*:\s*(?!$)(.+)$/m)?.[1]?.trim()
  if (inlineAuthor) authors.push(inlineAuthor.replace(/^(["'])(.*)\1$/, '$2'))
  const authorBlock = yaml.match(/^author\s*:\s*$([\s\S]*?)(?=^[a-zA-Z][\w-]*\s*:|\s*$)/m)?.[1]
  if (authorBlock) {
    for (const author of authorBlock.matchAll(/^\s*-\s*(.+)$/gm)) authors.push(author[1].trim().replace(/^(["'])(.*)\1$/, '$2'))
  }
  return { body: source.slice(match[0].length), frontmatter: { title, authors } }
}

function renderInline(value: string, options: NativeHtmlExportOptions) {
  const token = /(\[[^\]\r\n]*@[a-zA-Z0-9_:.+-]+[^\]\r\n]*\]|\$[^$\r\n]+\$|@(?:fig|tbl|eq)-[a-zA-Z0-9_.:-]+)/g
  let html = ''
  let cursor = 0
  for (const match of value.matchAll(token)) {
    const start = match.index ?? 0
    html += escapeHtml(value.slice(cursor, start))
    const raw = match[0]
    if (raw.startsWith('$')) {
      const equation = raw.slice(1, -1)
      html += `<span class="equation inline-equation" data-tex="${escapeHtml(equation)}" role="math">${escapeHtml(equation)}</span>`
    } else if (raw.startsWith('@')) {
      const id = raw.slice(1)
      html += `<a class="cross-reference" href="#${escapeHtml(id)}">${escapeHtml(raw)}</a>`
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
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label: string, url: string) => {
      const safe = safeAssetUrl(url)
      return safe ? `<a href="${safe}">${label}</a>` : label
    })
}

function isTableSeparator(line: string) {
  return /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line)
}

function tableCells(line: string) {
  return line.trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim())
}

function startsBlock(lines: string[], index: number) {
  const line = lines[index] ?? ''
  return /^\s*(?:#{1,6}\s+|```|~~~|>\s?|[-+*]\s+|\d+[.)]\s+|\$\$\s*$|!\[[^\]]*\]\([^)]*\))/.test(line)
    || (line.includes('|') && isTableSeparator(lines[index + 1] ?? ''))
}

function renderBody(source: string, options: NativeHtmlExportOptions) {
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
      html.push(`<h${level} id="${escapeHtml(heading[3] ?? safeId(label))}">${renderInline(label, options)}</h${level}>`)
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
    if (/^\s*\$\$\s*$/.test(line)) {
      const equation: string[] = []
      index += 1
      while (index < lines.length && !/^\s*\$\$\s*$/.test(lines[index])) {
        equation.push(lines[index])
        index += 1
      }
      if (index < lines.length) index += 1
      const tex = equation.join('\n').trim()
      html.push(`<div class="equation display-equation" data-tex="${escapeHtml(tex)}" role="math">${escapeHtml(tex)}</div>`)
      continue
    }
    const figure = line.match(/^\s*!\[([^\]]*)\]\(([^)]+)\)(?:\{#([a-zA-Z][\w.:-]*)[^}]*\})?\s*$/)
    if (figure) {
      const url = safeAssetUrl(figure[2])
      const id = figure[3] ? ` id="${escapeHtml(figure[3])}"` : ''
      html.push(url
        ? `<figure${id}><img src="${url}" alt="${escapeHtml(figure[1])}"><figcaption>${renderInline(figure[1], options)}</figcaption></figure>`
        : `<figure${id} class="missing-asset"><figcaption>${renderInline(figure[1], options)} · unsafe or missing asset path</figcaption></figure>`)
      index += 1
      continue
    }
    if (line.includes('|') && isTableSeparator(lines[index + 1] ?? '')) {
      const headers = tableCells(line)
      index += 2
      const rows: string[][] = []
      while (index < lines.length && lines[index].includes('|') && lines[index].trim()) {
        rows.push(tableCells(lines[index]))
        index += 1
      }
      html.push(`<div class="table-wrap"><table><thead><tr>${headers.map((cell) => `<th>${renderInline(cell, options)}</th>`).join('')}</tr></thead><tbody>${rows.map((row) => `<tr>${headers.map((_header, cellIndex) => `<td>${renderInline(row[cellIndex] ?? '', options)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`)
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
      html.push(`<${tag}>${items.map((item) => `<li>${renderInline(item, options)}</li>`).join('')}</${tag}>`)
      continue
    }
    if (/^\s*>/.test(line)) {
      const quote: string[] = []
      while (index < lines.length && /^\s*>/.test(lines[index])) {
        quote.push(lines[index].replace(/^\s*>\s?/, ''))
        index += 1
      }
      html.push(`<blockquote>${renderInline(quote.join(' '), options)}</blockquote>`)
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
    html.push(`<p>${renderInline(paragraph.join(' '), options)}</p>`)
  }
  return html.join('\n')
}

export function renderNativeHtmlExport(source: string, options: NativeHtmlExportOptions = {}) {
  const diagnostics = validateCleanProjection(source)
  if (diagnostics.some((diagnostic) => diagnostic.code === 'clean-anchor-leak' || diagnostic.code === 'clean-review-leak')) {
    throw new Error('Native HTML export accepts only a clean DraftMatter projection without review storage markers.')
  }
  const { body, frontmatter } = parseFrontmatter(source)
  const title = options.title ?? frontmatter.title ?? 'DraftMatter manuscript'
  const authors = frontmatter.authors.length
    ? `<p class="authors">${frontmatter.authors.map(escapeHtml).join(' · ')}</p>`
    : ''
  const bibliography = options.bibliography?.length
    ? `<section class="bibliography" aria-labelledby="references"><h2 id="references">References</h2>${options.bibliography.map((entry) => `<p id="ref-${safeId(entry.id)}">${escapeHtml(entry.value)}</p>`).join('')}</section>`
    : ''
  return `<!doctype html>
<html lang="${escapeHtml(options.language ?? 'en')}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
:root{color-scheme:light;--ink:#26312c;--muted:#69756f;--line:#dfe4e0;--paper:#fff;--wash:#f5f7f5;--accent:#466b59}*{box-sizing:border-box}html{background:var(--wash);font-family:Georgia,"Times New Roman",serif;color:var(--ink);line-height:1.65}body{background:var(--paper);box-shadow:0 10px 40px rgba(31,44,37,.08);margin:40px auto;max-width:840px;padding:72px 84px}h1,h2,h3,h4,h5,h6{font-family:Inter,system-ui,sans-serif;line-height:1.25;margin:1.8em 0 .65em}h1{font-size:2.35rem;margin-top:0}h2{border-bottom:1px solid var(--line);font-size:1.35rem;padding-bottom:.35em}p{margin:.75em 0}.authors{color:var(--muted);font-family:Inter,system-ui,sans-serif;margin-top:-1.4rem}a{color:var(--accent)}cite{font-style:normal;color:#385e4c}.equation{font-family:"STIX Two Math",Cambria,serif}.display-equation{margin:1.4rem 0;overflow:auto;text-align:center}figure{margin:1.6rem 0}figure img{display:block;height:auto;max-width:100%}figcaption{color:var(--muted);font-family:Inter,system-ui,sans-serif;font-size:.82rem;margin-top:.45rem}.source-code{background:#f7f8f7;border:1px solid var(--line);border-radius:6px;padding:.8rem 1rem}.source-code pre{overflow:auto;margin:.5rem 0 0}.source-code code,.raw-source{font-family:"SFMono-Regular",Consolas,monospace;font-size:.78rem}.raw-source{background:#fff8f3;border-left:3px solid #c98b65;overflow:auto;padding:.75rem}.table-wrap{overflow-x:auto}table{border-collapse:collapse;margin:1.25rem 0;width:100%}th,td{border-bottom:1px solid var(--line);padding:.5rem;text-align:left}th{font-family:Inter,system-ui,sans-serif;font-size:.82rem}blockquote{border-left:3px solid #afbeb6;color:#53615a;margin:1.2rem 0;padding:.2rem 1rem}.bibliography p{font-size:.9rem;padding-left:1.5rem;text-indent:-1.5rem}@media print{html{background:#fff}body{box-shadow:none;margin:0;max-width:none;padding:18mm 16mm}@page{margin:14mm}a{color:inherit;text-decoration:none}.source-code{break-inside:avoid}figure,table{break-inside:avoid}}@media(max-width:700px){body{box-shadow:none;margin:0;padding:36px 24px}}
</style>
</head>
<body>
<header><h1>${escapeHtml(title)}</h1>${authors}</header>
<main>${renderBody(body, options)}</main>
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
