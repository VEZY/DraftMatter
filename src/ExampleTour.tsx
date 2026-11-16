import { useEffect, useState } from 'react'
import { Icon } from './Icon'
import './exampleTour.css'

const steps: ReadonlyArray<{
  title: string
  detail: string
  target: string
  desktopOnly?: boolean
}> = [
  {
    title: 'Explore a finished paper',
    detail: 'Explore writing, citations, figures, tables, equations, and review in one manuscript. Code is optional; you can write a complete paper without running it.',
    target: '.structured-manuscript',
  },
  {
    title: 'Find any tool in seconds',
    detail: 'Press ⌘P (Ctrl+P on Windows and Linux) to open the command palette and jump straight to tools and actions without breaking your writing flow.',
    target: '.command-button',
  },
  {
    title: 'Add a citation',
    detail: 'Place the cursor in the manuscript and choose Cite in the writing toolbar. Search your project references or your local Zotero library, select a reference, and insert it.',
    target: '.toolbar-cite-button',
  },
  {
    title: 'Add a figure',
    detail: 'Choose Insert → Figure to pick an image, or drop an image directly into the manuscript. Add a caption and a description. Figures, editable tables, and equation previews work in the browser too.',
    target: '[aria-label="Insert"]',
  },
  {
    title: 'Find your project files',
    detail: 'Choose Files on the left to browse your project folders. Select a file to open a manuscript, insert an image, or download a copy. Sharing and transfers are available below the file tree.',
    target: '[aria-label="Files"]',
  },
  {
    title: 'Optional: create a figure from code',
    detail: 'In a local desktop copy, choose Insert → Reproducible figure, select a language, and add your code. Choose Run; DraftMatter helps prepare the language before continuing the computation.',
    target: '[aria-label="Insert"]',
    desktopOnly: true,
  },
  {
    title: 'Optional: manage analysis packages',
    detail: 'Open Code & computation in a local desktop project to manage packages for Python, R, or Julia. Writing, inserting images, and editing tables do not need this setup.',
    target: '.topbar-code-workspace',
    desktopOnly: true,
  },
  {
    title: 'Optional: insert a computed value',
    detail: 'Create and run a named calculation, then choose Insert → Computed value to place its saved result in the text. Collaborators can read it online without running the code.',
    target: '[aria-label="Insert"]',
    desktopOnly: true,
  },
]

export function ExampleTour({ onClose }: { onClose: () => void }) {
  const [index, setIndex] = useState(0)
  const step = steps[index]

  useEffect(() => {
    const target = document.querySelector<HTMLElement>(step.target)
    if (!target) return
    target.classList.add('example-tour-target')
    target.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
    return () => target.classList.remove('example-tour-target')
  }, [step])

  return (
    <aside className="example-tour" aria-labelledby="example-tour-title" aria-live="polite">
      <header>
        <span><Icon name="spark" size={14} />Guided tour · {index + 1} of {steps.length}</span>
        <button onClick={onClose} aria-label="Skip guided tour"><Icon name="close" size={15} /></button>
      </header>
      <div className="example-tour-progress" aria-hidden="true">
        {steps.map((item, stepIndex) => <span className={stepIndex <= index ? 'current' : ''} key={item.title} />)}
      </div>
      <div className="example-tour-copy">
        <h2 id="example-tour-title">{step.title}</h2>
        {step.desktopOnly && <span className="example-tour-desktop"><Icon name="folder" size={12} />Desktop only</span>}
        <p>{step.detail}</p>
      </div>
      <footer>
        <button className="example-tour-skip" onClick={onClose}>Skip tour</button>
        <span>
          {index > 0 && <button onClick={() => setIndex((current) => current - 1)}>Back</button>}
          <button className="primary-button" onClick={() => index === steps.length - 1 ? onClose() : setIndex((current) => current + 1)}>
            {index === steps.length - 1 ? 'Finish' : 'Next'}
            {index < steps.length - 1 && <Icon name="arrowRight" size={14} />}
          </button>
        </span>
      </footer>
    </aside>
  )
}
