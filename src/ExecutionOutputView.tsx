import { createElement, Fragment, type ReactNode } from 'react'
import type { Root } from 'mdast'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import type { JsonValue, NormalizedExecutionResult } from './executionProvider'
import { renderExecutionOutputs } from './outputRenderer'

interface MarkdownNode {
  type: string
  value?: string
  depth?: number
  ordered?: boolean
  url?: string
  alt?: string
  children?: MarkdownNode[]
}

function safeLink(url?: string) {
  return url && /^(?:https?:|mailto:|#)/i.test(url) ? url : undefined
}

function markdownNode(node: MarkdownNode, key: string): ReactNode {
  const children = node.children?.map((child, index) => markdownNode(child, `${key}-${index}`))
  switch (node.type) {
    case 'root': return <Fragment key={key}>{children}</Fragment>
    case 'paragraph': return <p key={key}>{children}</p>
    case 'text': return node.value
    case 'emphasis': return <em key={key}>{children}</em>
    case 'strong': return <strong key={key}>{children}</strong>
    case 'inlineCode': return <code key={key}>{node.value}</code>
    case 'code': return <pre key={key}><code>{node.value}</code></pre>
    case 'heading': {
      const heading = `h${Math.min(6, Math.max(1, node.depth ?? 3))}`
      return createElement(heading, { key }, children)
    }
    case 'blockquote': return <blockquote key={key}>{children}</blockquote>
    case 'list': return node.ordered ? <ol key={key}>{children}</ol> : <ul key={key}>{children}</ul>
    case 'listItem': return <li key={key}>{children}</li>
    case 'link': {
      const href = safeLink(node.url)
      return href ? <a key={key} href={href} target="_blank" rel="noreferrer noopener">{children}</a> : <span key={key}>{children}</span>
    }
    case 'image': return <span key={key}>[Image: {node.alt ?? 'output'}]</span>
    case 'break': return <br key={key} />
    case 'thematicBreak': return <hr key={key} />
    case 'html': return <code key={key}>{node.value}</code>
    default: return <Fragment key={key}>{children}</Fragment>
  }
}

function SafeMarkdown({ source }: { source: string }) {
  const tree = unified().use(remarkParse).parse(source) as Root
  return <div className="execution-markdown">{markdownNode(tree as unknown as MarkdownNode, 'markdown')}</div>
}

function tableCell(value: JsonValue) {
  return typeof value === 'string' ? value : JSON.stringify(value)
}

export function ExecutionOutputView({
  result,
  artifactUrl = (path) => path,
}: {
  result: NormalizedExecutionResult
  artifactUrl?: (path: string) => string
}) {
  const outputs = renderExecutionOutputs(result)
  return <div className="execution-output-stack" aria-live="polite">
    {outputs.map((output, index) => {
      if (output.kind === 'stream') return <pre key={index} className={`execution-stream ${output.stream.name}`}>{output.stream.text}</pre>
      if (output.kind === 'error') return <div key={index} className="execution-error" role="alert"><strong>{output.error.name}</strong><span>{output.error.message}</span>{output.error.traceback.length > 0 && <pre>{output.error.traceback.join('\n')}</pre>}</div>
      if (output.kind === 'image') return <figure key={index} className="execution-image"><img src={output.artifactPath ? artifactUrl(output.source) : output.source} alt={output.alt} />{output.artifactPath && <figcaption>{output.artifactPath}</figcaption>}</figure>
      if (output.kind === 'html') return <iframe key={index} className="execution-html" title={`Isolated HTML output ${index + 1}`} sandbox={output.sandbox} referrerPolicy="no-referrer" srcDoc={output.sourceDocument} />
      if (output.kind === 'markdown') return <SafeMarkdown key={index} source={output.source} />
      if (output.kind === 'text') return <pre key={index} className="execution-text">{output.source}</pre>
      if (output.kind === 'table') return <div key={index} className="execution-table-wrap"><table><thead><tr>{output.columns.map((column) => <th key={column}>{column}</th>)}</tr></thead><tbody>{output.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((value, columnIndex) => <td key={output.columns[columnIndex]}>{tableCell(value)}</td>)}</tr>)}</tbody></table></div>
      return <div key={index} className="execution-artifact"><span>{output.artifact.path}</span><small>{output.artifact.mediaType ?? 'file'} · {output.artifact.bytes.toLocaleString()} bytes</small></div>
    })}
  </div>
}
