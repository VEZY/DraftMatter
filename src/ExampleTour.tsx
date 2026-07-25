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
    detail: 'This complete example combines citations, figures, tables, computed values, review, and code from Python, R, and Julia in one manuscript.',
    target: '.structured-manuscript',
  },
  {
    title: 'Find any tool in seconds',
    detail: 'Press ⌘P (Ctrl+P on Windows and Linux) to open the command palette and jump straight to tools and actions without breaking your writing flow.',
    target: '.command-button',
  },
  {
    title: 'Add a citation',
    detail: 'Place the cursor in the manuscript, then open Sources. Search or import a reference, select it, and insert the citation.',
    target: '[aria-label="Sources"]',
  },
  {
    title: 'Add a reproducible figure',
    detail: 'On desktop, choose Insert → Reproducible figure, select a language, and add the code that produces the retained figure.',
    target: '[aria-label="Insert"]',
    desktopOnly: true,
  },
  {
    title: 'Add a package',
    detail: 'In a local desktop project, open Code to manage the project environment and add packages for Python, R, or Julia.',
    target: '.topbar-code-workspace',
    desktopOnly: true,
  },
  {
    title: 'Insert a computed value',
    detail: 'Publish a named value from a code cell, then choose Insert → Published value to place the current result in the text.',
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
