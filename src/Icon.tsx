import type { SVGProps } from 'react'

type IconName =
  | 'document' | 'message' | 'book' | 'history' | 'settings' | 'search' | 'chevronDown'
  | 'play' | 'check' | 'x' | 'more' | 'plus' | 'download' | 'code' | 'quote'
  | 'link' | 'image' | 'table' | 'undo' | 'redo' | 'eye' | 'clock' | 'branch'
  | 'panelLeft' | 'panelRight' | 'spark' | 'close' | 'arrowRight' | 'command'
  | 'folder' | 'users' | 'focus' | 'info'

const paths: Record<IconName, React.ReactNode> = {
  document: <><path d="M6 2.75h8l4 4v14.5H6z"/><path d="M14 2.75v4h4M9 11h6M9 15h6"/></>,
  message: <><path d="M4 5.5h16v11H9l-5 4z"/><path d="M8 9h8M8 13h5"/></>,
  book: <><path d="M4 4.5h6.5A3.5 3.5 0 0 1 14 8v12a3.5 3.5 0 0 0-3.5-3.5H4z"/><path d="M20 4.5h-6A3.5 3.5 0 0 0 10.5 8v8.5H20z"/></>,
  history: <><path d="M4 6v5h5"/><path d="M5.3 16.4A8 8 0 1 0 6 6.2L4 11"/><path d="M12 8v4l3 2"/></>,
  settings: <><circle cx="12" cy="12" r="3"/><path d="M19 12a7 7 0 0 0-.1-1l2-1.6-2-3.5-2.5 1A8 8 0 0 0 14.7 6L14.3 3h-4.1L9.8 6a8 8 0 0 0-1.7 1L5.6 6l-2 3.5 2 1.6a7 7 0 0 0 0 2L3.5 14.7l2 3.5 2.5-1a8 8 0 0 0 1.7 1l.4 2.9h4.1l.4-2.9a8 8 0 0 0 1.7-1l2.5 1 2-3.5-2-1.6a7 7 0 0 0 .2-1z"/></>,
  search: <><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/></>,
  chevronDown: <path d="m7 9.5 5 5 5-5"/>,
  play: <path d="m9 7 8 5-8 5z"/>,
  check: <path d="m5 12.5 4 4 10-10"/>,
  x: <path d="m7 7 10 10M17 7 7 17"/>,
  more: <><circle cx="5" cy="12" r="1" fill="currentColor"/><circle cx="12" cy="12" r="1" fill="currentColor"/><circle cx="19" cy="12" r="1" fill="currentColor"/></>,
  plus: <path d="M12 5v14M5 12h14"/>,
  download: <><path d="M12 3v12m-4-4 4 4 4-4"/><path d="M5 20h14"/></>,
  code: <path d="m8 8-4 4 4 4m8-8 4 4-4 4m-2-11-4 14"/>,
  quote: <path d="M6 17h4V9H5v5h3m6 3h4V9h-5v5h3"/>,
  link: <><path d="m9 15 6-6"/><path d="M7.5 17.5h-1a4 4 0 0 1 0-8h3M16.5 6.5h1a4 4 0 0 1 0 8h-3"/></>,
  image: <><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m4 17 5-5 4 4 2-2 5 5"/></>,
  table: <><rect x="3" y="4" width="18" height="16" rx="1"/><path d="M3 10h18M9 4v16M15 4v16"/></>,
  undo: <><path d="M9 7 4 12l5 5"/><path d="M5 12h8a6 6 0 0 1 6 6"/></>,
  redo: <><path d="m15 7 5 5-5 5"/><path d="M19 12h-8a6 6 0 0 0-6 6"/></>,
  eye: <><path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6"/><circle cx="12" cy="12" r="2.5"/></>,
  clock: <><circle cx="12" cy="12" r="8"/><path d="M12 7v5l3 2"/></>,
  branch: <><circle cx="7" cy="5" r="2"/><circle cx="17" cy="7" r="2"/><circle cx="7" cy="19" r="2"/><path d="M7 7v10M9 8c4 0 4-1 6-1"/></>,
  panelLeft: <><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/></>,
  panelRight: <><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/></>,
  spark: <path d="m12 3 1.4 5.6L19 10l-5.6 1.4L12 17l-1.4-5.6L5 10l5.6-1.4z"/>,
  close: <path d="M6 6l12 12M18 6 6 18"/>,
  arrowRight: <path d="M5 12h14m-5-5 5 5-5 5"/>,
  command: <path d="M9 6.5A2.5 2.5 0 1 0 6.5 9H17.5A2.5 2.5 0 1 0 15 6.5V17.5A2.5 2.5 0 1 0 17.5 15H6.5A2.5 2.5 0 1 0 9 17.5z"/>,
  folder: <path d="M3 6.5h7l2 2h9v10H3z"/>,
  users: <><circle cx="9" cy="8" r="3"/><path d="M3.5 19v-1.5A4.5 4.5 0 0 1 8 13h2a4.5 4.5 0 0 1 4.5 4.5V19M15 5.5a3 3 0 0 1 0 5.5M16.5 13.5a4 4 0 0 1 4 4V19"/></>,
  focus: <><path d="M8 4H4v4M16 4h4v4M20 16v4h-4M4 16v4h4"/><path d="M9 9h6v6H9z"/></>,
  info: <><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5h.01"/></>,
}

export function Icon({ name, size = 18, ...props }: { name: IconName; size?: number } & SVGProps<SVGSVGElement>) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
      {paths[name]}
    </svg>
  )
}
