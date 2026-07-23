import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import 'katex/dist/katex.min.css'
import { DraftMatterApplication } from './DraftMatterApplication'
import './styles.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <DraftMatterApplication />
  </StrictMode>,
)
