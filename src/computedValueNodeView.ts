import type { Node as ProseMirrorNode } from 'prosemirror-model'
import type { NodeView } from 'prosemirror-view'
import type { ExecutionFreshnessStatus } from './executionFreshness'
import { publishedValueDomAttributes } from './manuscriptSchema'

export type SelectComputedValue = (name: string, anchor: HTMLElement, action: 'inspect' | 'source') => void
export type ComputedValueMenu = { anchor: HTMLElement; name: string; x: number; y: number }

export function computedValueNodeView(
  initialNode: ProseMirrorNode,
  statuses: () => Record<string, ExecutionFreshnessStatus> | undefined,
  select: () => SelectComputedValue | undefined,
  openMenu: (menu: ComputedValueMenu) => void,
): NodeView {
  let node = initialNode
  const dom = document.createElement('span')
  dom.contentEditable = 'false'
  let previous: Record<string, string> = {}
  const render = () => {
    const states = statuses()
    const { cellId } = node.attrs
    const status = states && cellId ? (Object.hasOwn(states, cellId) ? states[cellId] : 'stale') : node.attrs.status
    const attributes = publishedValueDomAttributes(node, status)
    if (select()) {
      attributes.role = 'button'
      attributes.tabindex = '0'
      attributes['aria-haspopup'] = 'dialog'
      attributes['aria-label'] = `Inspect computed value ${node.attrs.name}: ${node.attrs.rendered}`
    }
    for (const key of Object.keys(previous)) {
      if (!(key in attributes)) dom.removeAttribute(key)
    }
    for (const [key, value] of Object.entries(attributes)) {
      if (previous[key] !== value) dom.setAttribute(key, value)
    }
    if (dom.textContent !== node.attrs.rendered) dom.textContent = node.attrs.rendered
    previous = attributes
  }
  render()
  dom.addEventListener('dm-computed-value-presentation', render)
  let hoverTimer: number | undefined
  const cancelHover = () => window.clearTimeout(hoverTimer)
  dom.addEventListener('pointerenter', (event) => {
    if (event.pointerType !== 'mouse' || event.buttons || !select()) return
    hoverTimer = window.setTimeout(() => select()?.(node.attrs.name, dom, 'inspect'), 300)
  })
  dom.addEventListener('pointerleave', cancelHover)
  dom.addEventListener('pointerdown', cancelHover)
  dom.addEventListener('mousedown', (event) => {
    if (select()) event.preventDefault()
  })
  dom.addEventListener('click', (event) => {
    if (!select() || event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    select()?.(node.attrs.name, dom, event.metaKey || event.ctrlKey ? 'source' : 'inspect')
  })
  dom.addEventListener('keydown', (event) => {
    if (!select() || event.isComposing) return
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
      event.preventDefault()
      event.stopPropagation()
      const rect = dom.getBoundingClientRect()
      openMenu({ name: node.attrs.name, anchor: dom, x: rect.left, y: rect.bottom })
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      event.stopPropagation()
      if (!event.repeat) select()?.(node.attrs.name, dom, event.metaKey || event.ctrlKey ? 'source' : 'inspect')
    }
  })
  dom.addEventListener('contextmenu', (event) => {
    if (!select()) return
    event.preventDefault()
    event.stopPropagation()
    // On macOS Control-click may produce only a contextmenu event.
    if (event.ctrlKey && event.button !== 2) select()?.(node.attrs.name, dom, 'source')
    else openMenu({ name: node.attrs.name, anchor: dom, x: event.clientX, y: event.clientY })
  })
  return {
    dom,
    destroy: cancelHover,
    ignoreMutation: (mutation) => mutation.type !== 'selection',
    stopEvent: (event) => Boolean(select()) && ['mousedown', 'click', 'keydown', 'contextmenu'].includes(event.type),
    update(next) {
      if (next.type !== node.type || next.attrs.name !== node.attrs.name || next.attrs.id !== node.attrs.id) return false
      node = next
      render()
      return true
    },
  }
}
