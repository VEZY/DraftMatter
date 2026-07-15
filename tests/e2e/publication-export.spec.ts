import { readFile } from 'node:fs/promises'
import { expect, test } from '@playwright/test'

const figure = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 220"><rect width="640" height="220" fill="#fff"/><g stroke="#e5ebe7"><path d="M45 35H610M45 80H610M45 125H610M45 170H610"/></g><polyline points="45,175 135,158 225,132 315,102 405,73 495,51 585,39" fill="none" stroke="#466f5c" stroke-width="5"/><polyline points="45,175 135,164 225,148 315,128 405,111 495,96 585,83" fill="none" stroke="#b9785c" stroke-width="5"/><g fill="#466f5c"><circle cx="45" cy="175" r="5"/><circle cx="315" cy="102" r="5"/><circle cx="585" cy="39" r="5"/></g><g fill="#b9785c"><circle cx="45" cy="175" r="5"/><circle cx="315" cy="128" r="5"/><circle cx="585" cy="83" r="5"/></g></svg>`).toString('base64')

const source = `---
title: "Independent canopy synthesis"
author:
  - Ada Researcher
  - Lin Reviewer
---

# Independent canopy synthesis

## Results {#results}

Canopy area differed by **18%** [@field2026]. The fitted response was $y = ax + b$; see @fig-response.

$$
R^2 = 0.94
$$

![Canopy response through time](data:image/svg+xml;base64,${figure}){#fig-response}

| Treatment | Final area |
| --- | ---: |
| Control | 100 |
| Drought | 82 |

\`\`\`python {#fit .execute}
print("must remain inert")
\`\`\`
`

test.describe('DM-P5-01/02 native publication exports', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript((portableSource) => {
      localStorage.setItem('draftmatter.structured-source.v1', portableSource)
      localStorage.setItem('draftmatter.structured-mode.v1', 'true')
    }, source)
    await page.goto('/')
  })

  test('downloads and renders the opened manuscript rather than the demo article', async ({ page, context }) => {
    await page.getByRole('button', { name: 'Export' }).click()
    const htmlDownloadEvent = page.waitForEvent('download')
    await page.getByRole('button', { name: /Native HTML/ }).click()
    const htmlDownload = await htmlDownloadEvent
    const htmlPath = await htmlDownload.path()
    expect(htmlPath).not.toBeNull()
    const html = await readFile(htmlPath!, 'utf8')

    expect(htmlDownload.suggestedFilename()).toBe('canopy-drought.html')
    expect(html).toContain('<title>Independent canopy synthesis</title>')
    expect(html).toContain('<p class="authors">Ada Researcher · Lin Reviewer</p>')
    expect(html.match(/<h1>/g)).toHaveLength(1)
    expect(html).not.toContain('<main><h1')
    expect(html).toContain('Canopy area differed by <strong>18%</strong>')
    expect(html).toContain('<figure id="fig-response">')
    expect(html).toContain('<table>')
    expect(html).toContain('role="math"')
    expect(html).toContain('print(&quot;must remain inert&quot;)')
    expect(html).not.toContain('Drought acclimation reshapes canopy development')
    expect(html).not.toMatch(/<script|\.dm-anchor|\.draftmatter-reviews/)

    const rendered = await context.newPage()
    await rendered.setContent(html, { waitUntil: 'load' })
    await expect(rendered).toHaveScreenshot('native-html-publication.png', { fullPage: true })
    await rendered.close()

    await page.getByRole('button', { name: 'Export' }).click()
    const docxDownloadEvent = page.waitForEvent('download')
    await page.getByRole('button', { name: /Clean DOCX/ }).click()
    const docxDownload = await docxDownloadEvent
    const docxPath = await docxDownload.path()
    expect(docxPath).not.toBeNull()
    const docx = await readFile(docxPath!)
    const readableDocx = docx.toString('utf8')

    expect(docxDownload.suggestedFilename()).toBe('canopy-drought.docx')
    expect(docx.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]))
    expect(readableDocx).toContain('Independent canopy synthesis')
    expect(readableDocx).toContain('word/document.xml')
    expect(readableDocx).not.toContain('Drought acclimation reshapes canopy development')
    expect(readableDocx).not.toMatch(/\.dm-anchor|\.draftmatter-reviews|<w:(?:ins|del)\b/)
  })
})
