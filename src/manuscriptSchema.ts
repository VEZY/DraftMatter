import { Schema, type MarkSpec, type NodeSpec } from 'prosemirror-model'
import { bulletList, listItem, orderedList } from 'prosemirror-schema-list'
import { tableNodes } from 'prosemirror-tables'

const identified = { id: { default: null } }

function atomDOM(name: string, text: (node: Parameters<NonNullable<NodeSpec['toDOM']>>[0]) => string): NonNullable<NodeSpec['toDOM']> {
  return (node) => ['span', { 'data-dm-node': name, 'data-dm-id': node.attrs.id ?? '' }, text(node)]
}

const tableSpecs = tableNodes({ tableGroup: 'block', cellContent: 'block+', cellAttributes: {} })

const nodes: Record<string, NodeSpec> = {
  doc: { content: 'block+' },
  text: { group: 'inline' },
  paragraph: {
    attrs: { ...identified, section: { default: null } },
    content: 'inline*',
    group: 'block',
    parseDOM: [{ tag: 'p', getAttrs: (element) => ({ id: (element as HTMLElement).dataset.dmId ?? null, section: (element as HTMLElement).dataset.section ?? null }) }],
    toDOM: (node) => ['p', { 'data-dm-id': node.attrs.id ?? '', 'data-section': node.attrs.section ?? '' }, 0],
  },
  heading: {
    attrs: {
      ...identified,
      level: { default: 2, validate: 'number' },
      section: { default: null },
      label: { default: null },
      sourceAttributes: { default: null },
    },
    content: 'inline*',
    group: 'block',
    defining: true,
    parseDOM: [1, 2, 3, 4, 5, 6].map((level) => ({ tag: `h${level}`, attrs: { level } })),
    toDOM: (node) => [`h${Math.min(6, Math.max(1, node.attrs.level))}`, {
      id: node.attrs.label ?? undefined,
      'data-dm-id': node.attrs.id ?? '',
      'data-section': node.attrs.section ?? '',
    }, 0],
  },
  blockquote: {
    attrs: identified,
    content: 'block+',
    group: 'block',
    defining: true,
    parseDOM: [{ tag: 'blockquote' }],
    toDOM: (node) => ['blockquote', { 'data-dm-id': node.attrs.id ?? '' }, 0],
  },
  horizontal_rule: {
    attrs: identified,
    group: 'block',
    atom: true,
    parseDOM: [{ tag: 'hr' }],
    toDOM: (node) => ['hr', { 'data-dm-id': node.attrs.id ?? '' }],
  },
  bullet_list: { ...bulletList, attrs: identified, content: 'list_item+', group: 'block' },
  ordered_list: { ...orderedList, attrs: { ...identified, order: { default: 1, validate: 'number' } }, content: 'list_item+', group: 'block' },
  list_item: { ...listItem, attrs: identified, content: 'paragraph block*' },
  equation_block: {
    attrs: { ...identified, tex: { default: '' }, label: { default: null }, sourceAttributes: { default: null } },
    group: 'block',
    atom: true,
    isolating: true,
    parseDOM: [{ tag: 'figure[data-dm-node="equation"]' }],
    toDOM: (node) => ['figure', {
      id: node.attrs.label ?? undefined,
      'data-dm-node': 'equation',
      'data-dm-id': node.attrs.id ?? '',
      'data-label': node.attrs.label ?? '',
    }, ['code', node.attrs.tex]],
  },
  figure: {
    attrs: identified,
    content: 'image caption?',
    group: 'block',
    defining: true,
    isolating: true,
    parseDOM: [{ tag: 'figure[data-dm-node="figure"]' }],
    toDOM: (node) => ['figure', { 'data-dm-node': 'figure', 'data-dm-id': node.attrs.id ?? '' }, 0],
  },
  image: {
    attrs: {
      ...identified,
      src: { default: '' },
      alt: { default: '' },
      title: { default: null },
      label: { default: null },
      sourceAttributes: { default: null },
    },
    group: 'block',
    atom: true,
    draggable: true,
    parseDOM: [{ tag: 'img[src]', getAttrs: (element) => {
      const image = element as HTMLImageElement
      return {
        src: image.getAttribute('src'),
        alt: image.getAttribute('alt') ?? '',
        title: image.getAttribute('title'),
        label: image.dataset.label || image.id || null,
        sourceAttributes: image.dataset.sourceAttributes ?? null,
      }
    } }],
    toDOM: (node) => ['img', {
      id: node.attrs.label ?? undefined,
      src: node.attrs.src,
      alt: node.attrs.alt,
      title: node.attrs.title,
      'data-label': node.attrs.label ?? '',
      'data-source-attributes': node.attrs.sourceAttributes ?? '',
      'data-dm-id': node.attrs.id ?? '',
    }],
  },
  caption: {
    attrs: identified,
    content: 'inline*',
    group: 'block',
    parseDOM: [{ tag: 'figcaption' }],
    toDOM: (node) => ['figcaption', { 'data-dm-id': node.attrs.id ?? '' }, 0],
  },
  footnote_definition: {
    attrs: { ...identified, label: {}, contentMarkdown: { default: '' } },
    group: 'block',
    atom: true,
    isolating: true,
    parseDOM: [{ tag: 'aside[data-dm-node="footnote"]' }],
    toDOM: (node) => ['aside', { 'data-dm-node': 'footnote', 'data-dm-id': node.attrs.id ?? '', 'data-label': node.attrs.label }, node.attrs.contentMarkdown],
  },
  code_cell: {
    attrs: {
      ...identified,
      language: { default: 'text' },
      code: { default: '' },
      outputKind: { default: null },
      status: { default: 'stale' },
      attributes: { default: {} },
    },
    group: 'block',
    atom: true,
    isolating: true,
    selectable: true,
    parseDOM: [{ tag: 'section[data-dm-node="code-cell"]' }],
    toDOM: (node) => ['section', { 'data-dm-node': 'code-cell', 'data-dm-id': node.attrs.id ?? '', 'data-language': node.attrs.language }, ['pre', ['code', node.attrs.code]]],
  },
  output_block: {
    attrs: { ...identified, cellId: {}, kind: { default: 'markdown' }, markdown: { default: '' }, runHash: { default: null } },
    group: 'block',
    atom: true,
    isolating: true,
    parseDOM: [{ tag: 'section[data-dm-node="output"]' }],
    toDOM: (node) => ['section', { 'data-dm-node': 'output', 'data-dm-id': node.attrs.id ?? '', 'data-cell': node.attrs.cellId }, ['pre', node.attrs.markdown]],
  },
  raw_block: {
    attrs: { ...identified, raw: { default: '' }, format: { default: null } },
    group: 'block',
    atom: true,
    isolating: true,
    parseDOM: [{ tag: 'pre[data-dm-node="raw"]' }],
    toDOM: (node) => ['pre', { 'data-dm-node': 'raw', 'data-dm-id': node.attrs.id ?? '', 'data-format': node.attrs.format ?? '' }, ['code', node.attrs.raw]],
  },
  hard_break: {
    inline: true,
    group: 'inline',
    selectable: false,
    parseDOM: [{ tag: 'br' }],
    toDOM: () => ['br'],
  },
  equation_inline: {
    attrs: { ...identified, tex: { default: '' } },
    inline: true,
    group: 'inline',
    atom: true,
    parseDOM: [{ tag: 'span[data-dm-node="equation-inline"]' }],
    toDOM: atomDOM('equation-inline', (node) => node.attrs.tex),
    leafText: (node) => node.attrs.tex,
  },
  citation: {
    attrs: {
      ...identified,
      keys: { default: [] },
      items: { default: [] },
      prefix: { default: '' },
      suffix: { default: '' },
      locator: { default: null },
      suppressAuthor: { default: false },
      rendered: { default: '' },
    },
    inline: true,
    group: 'inline',
    atom: true,
    selectable: true,
    parseDOM: [{ tag: 'span[data-dm-node="citation"]' }],
    toDOM: atomDOM('citation', (node) => node.attrs.rendered || `(${node.attrs.keys.join('; ')})`),
    leafText: (node) => node.attrs.rendered,
  },
  cross_reference: {
    attrs: { ...identified, target: {}, rendered: { default: '' } },
    inline: true,
    group: 'inline',
    atom: true,
    parseDOM: [{ tag: 'a[data-dm-node="cross-reference"]' }],
    toDOM: (node) => ['a', { href: `#${node.attrs.target}`, 'data-dm-node': 'cross-reference', 'data-dm-id': node.attrs.id ?? '' }, node.attrs.rendered || node.attrs.target],
    leafText: (node) => node.attrs.rendered || node.attrs.target,
  },
  footnote_reference: {
    attrs: { ...identified, label: {} },
    inline: true,
    group: 'inline',
    atom: true,
    parseDOM: [{ tag: 'sup[data-dm-node="footnote-reference"]' }],
    toDOM: (node) => ['sup', { 'data-dm-node': 'footnote-reference', 'data-dm-id': node.attrs.id ?? '' }, node.attrs.label],
    leafText: (node) => `[${node.attrs.label}]`,
  },
  review_anchor: {
    attrs: { ...identified, anchorId: {}, edge: { default: 'point' }, affinity: { default: 'after' }, sourceAttributes: { default: null } },
    inline: true,
    group: 'inline',
    atom: true,
    selectable: false,
    toDOM: (node) => ['span', { 'data-dm-node': 'review-anchor', 'data-dm-id': node.attrs.id ?? '', 'data-anchor': node.attrs.anchorId, 'data-edge': node.attrs.edge }],
    leafText: () => '',
  },
  table: { ...tableSpecs.table, attrs: identified },
  table_row: { ...tableSpecs.table_row, attrs: identified },
  table_cell: { ...tableSpecs.table_cell, attrs: { ...tableSpecs.table_cell.attrs, ...identified } },
  table_header: { ...tableSpecs.table_header, attrs: { ...tableSpecs.table_header.attrs, ...identified } },
}

const marks: Record<string, MarkSpec> = {
  strong: {
    parseDOM: [{ tag: 'strong' }, { tag: 'b', getAttrs: (node) => (node as HTMLElement).style.fontWeight !== 'normal' && null }],
    toDOM: () => ['strong', 0],
  },
  emphasis: {
    parseDOM: [{ tag: 'em' }, { tag: 'i' }, { style: 'font-style=italic' }],
    toDOM: () => ['em', 0],
  },
  link: {
    attrs: { href: {}, title: { default: null } },
    inclusive: false,
    parseDOM: [{ tag: 'a[href]:not([data-dm-node])', getAttrs: (node) => ({ href: (node as HTMLElement).getAttribute('href'), title: (node as HTMLElement).getAttribute('title') }) }],
    toDOM: (mark) => ['a', { href: mark.attrs.href, title: mark.attrs.title }, 0],
  },
  code: {
    code: true,
    excludes: '_',
    parseDOM: [{ tag: 'code' }],
    toDOM: () => ['code', 0],
  },
}

export const manuscriptSchema = new Schema({ nodes, marks })
