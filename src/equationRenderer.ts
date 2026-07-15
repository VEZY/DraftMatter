import katex from 'katex'

export interface RenderedEquation {
  html: string
  error?: string
}

export function renderEquation(tex: string, displayMode = false): RenderedEquation {
  if (/\\(?:href|url|includegraphics|htmlClass|htmlId|htmlStyle|htmlData)\b/.test(tex)) {
    return { html: '', error: 'Equation contains a command that is disabled in portable manuscripts.' }
  }
  try {
    return {
      html: katex.renderToString(tex, {
        displayMode,
        output: 'htmlAndMathml',
        throwOnError: true,
        strict: 'ignore',
        trust: false,
        maxExpand: 500,
        maxSize: 20,
      }),
    }
  } catch {
    return { html: '', error: 'Equation could not be rendered. Open the equation editor to check its TeX.' }
  }
}
