export type NewDraftTemplateId = 'blank' | 'imrad' | 'short-communication' | 'protocol' | 'import'

export interface NewDraftTemplate {
  id: NewDraftTemplateId
  name: string
  description: string
  sections: string[]
}

export const NEW_DRAFT_TEMPLATES: NewDraftTemplate[] = [
  {
    id: 'blank',
    name: 'Blank manuscript',
    description: 'A title and author, with an open page.',
    sections: [],
  },
  {
    id: 'imrad',
    name: 'Standard research article',
    description: 'Abstract, Introduction, Methods, Results, and Discussion.',
    sections: ['Abstract', 'Introduction', 'Methods', 'Results', 'Discussion'],
  },
  {
    id: 'short-communication',
    name: 'Short communication',
    description: 'A compact research narrative for a focused result.',
    sections: ['Abstract', 'Main text', 'Acknowledgements'],
  },
  {
    id: 'protocol',
    name: 'Methods or protocol',
    description: 'Purpose, materials, procedure, quality control, and analysis.',
    sections: ['Purpose', 'Materials', 'Procedure', 'Quality control', 'Analysis'],
  },
  {
    id: 'import',
    name: 'Import an existing manuscript',
    description: 'Start from a portable Markdown or Quarto manuscript.',
    sections: [],
  },
]

export interface NewDraftDetails {
  title: string
  leadAuthor: string
  additionalAuthors?: string[]
  language: 'en' | 'fr'
  citationStyle: 'draftmatter-author-date' | 'draftmatter-numeric'
}

function yamlString(value: string) {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', ' ')}"`
}

function sectionId(name: string) {
  return name.toLocaleLowerCase().replaceAll(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

function sectionPrompt(section: string) {
  const prompts: Record<string, string> = {
    Abstract: 'Summarize the question, approach, principal results, and conclusion.',
    Introduction: 'Establish the context, identify the gap, and state the research question.',
    Methods: 'Describe the study design, materials, measurements, and analysis.',
    Results: 'Report the observations that answer the research question most directly.',
    Discussion: 'Interpret the findings, limitations, and implications.',
    'Main text': 'Develop the central result in a concise, evidence-led narrative.',
    Acknowledgements: 'Acknowledge contributions and support.',
    Purpose: 'State what this method or protocol is designed to accomplish.',
    Materials: 'List the materials, data, software, and preparation required.',
    Procedure: 'Describe each procedure in an order another researcher can follow.',
    'Quality control': 'Record checks, controls, acceptance criteria, and likely failure modes.',
    Analysis: 'Explain how observations and outputs should be evaluated.',
  }
  return prompts[section] ?? 'Begin writing here.'
}

export function buildNewDraftSource(templateId: Exclude<NewDraftTemplateId, 'import'>, details: NewDraftDetails) {
  const template = NEW_DRAFT_TEMPLATES.find((candidate) => candidate.id === templateId)
  if (!template) throw new Error('Choose a supported starting point.')
  const authors = [details.leadAuthor, ...(details.additionalAuthors ?? [])].map((author) => author.trim()).filter(Boolean)
  if (!details.title.trim()) throw new Error('Enter a working title.')
  if (!authors.length) throw new Error('Enter the lead author name.')
  const frontmatter = [
    '---',
    `title: ${yamlString(details.title.trim())}`,
    'author:',
    ...authors.map((author) => `  - name: ${yamlString(author)}`),
    `lang: ${details.language}`,
    `citation-style: ${details.citationStyle}`,
    'format:',
    '  html:',
    '    number-sections: true',
    '---',
  ]
  const body = template.sections.flatMap((section) => [
    '',
    `## ${section} {#sec-${sectionId(section)}}`,
    '',
    sectionPrompt(section),
  ])
  return `${frontmatter.join('\n')}\n\n# ${details.title.trim()}\n${body.join('\n')}\n`
}

export function portableDraftId(title: string) {
  const normalized = title.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase().replaceAll(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 64)
  return /^[a-z]/.test(normalized) ? normalized : 'manuscript'
}
