import { copyFile, readFile } from 'node:fs/promises'
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
    await page.addInitScript(({ portableSource, citations }) => {
      localStorage.setItem('draftmatter.structured-source.v1', portableSource)
      localStorage.setItem('draftmatter.structured-mode.v1', 'true')
      localStorage.setItem('draftmatter.citations.v1', JSON.stringify(citations))
    }, {
      portableSource: source,
      citations: [{
        citekey: 'field2026',
        type: 'article-journal',
        title: 'Independent measurements of canopy area',
        authors: ['Ari Field', 'Mira Stone'],
        year: '2026',
        container: 'Journal of Field Synthesis',
        doi: '10.1000/field.2026',
        source: 'csl-json',
        availability: 'cached',
        provenance: { origin: 'manual-import', locator: 'references.json' },
      }],
    })
    await page.goto('/')
  })

  test('downloads and renders the opened manuscript rather than the demo article', async ({ page, context }, testInfo) => {
    await expect(page.getByText('(Field and Stone, 2026)')).toBeVisible()
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
    expect(html).toContain('<cite class="citation" data-citekeys="field2026">(Field and Stone, 2026)</cite>')
    expect(html).toContain('Independent measurements of canopy area')
    expect(html).toContain('<figure id="fig-response">')
    expect(html).toContain('<table>')
    expect(html).toContain('role="math"')
    expect(html).toContain('print(&quot;must remain inert&quot;)')
    expect(html).not.toContain('Drought acclimation reshapes canopy development')
    expect(html).not.toMatch(/<script|\.dm-anchor|\.draftmatter-reviews/)

    const rendered = await context.newPage()
    await rendered.setContent(html, { waitUntil: 'load' })
    await expect(rendered).toHaveScreenshot('native-html-publication.png', { fullPage: true })
    await rendered.emulateMedia({ media: 'print' })
    await expect(rendered).toHaveScreenshot('native-print-publication.png', { fullPage: true })
    const pdfPath = testInfo.outputPath('native-publication.pdf')
    const pdf = await rendered.pdf({
      path: pdfPath,
      format: 'A4',
      printBackground: true,
      tagged: true,
      outline: true,
    })
    expect(pdf.subarray(0, 5).toString('ascii')).toBe('%PDF-')
    expect(pdf.byteLength).toBeGreaterThan(20_000)
    await testInfo.attach('native-publication.pdf', { path: pdfPath, contentType: 'application/pdf' })
    await rendered.close()

    await page.getByRole('button', { name: 'Export' }).click()
    await page.getByRole('button', { name: /Print \/ PDF/ }).click()
    const printFrame = page.locator('iframe[title="DraftMatter print preview"]')
    await expect(printFrame).toHaveCount(1)
    await expect(page.getByText('Clean print view opened · choose Save as PDF')).toBeVisible()
    expect(await printFrame.getAttribute('srcdoc')).toContain('<title>Independent canopy synthesis</title>')
    expect(await printFrame.getAttribute('srcdoc')).not.toMatch(/\.dm-anchor|\.draftmatter-reviews/)

    await page.getByRole('button', { name: 'Export' }).click()
    const docxDownloadEvent = page.waitForEvent('download')
    await page.getByRole('button', { name: /Clean DOCX/ }).click()
    const docxDownload = await docxDownloadEvent
    const docxPath = await docxDownload.path()
    expect(docxPath).not.toBeNull()
    const docx = await readFile(docxPath!)
    const docxArtifactPath = testInfo.outputPath('native-publication.docx')
    await copyFile(docxPath!, docxArtifactPath)
    await testInfo.attach('native-publication.docx', {
      path: docxArtifactPath,
      contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    })
    const readableDocx = docx.toString('utf8')

    expect(docxDownload.suggestedFilename()).toBe('canopy-drought.docx')
    expect(docx.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]))
    expect(readableDocx).toContain('Independent canopy synthesis')
    expect(readableDocx.match(/Independent canopy synthesis/g)).toHaveLength(1)
    expect(readableDocx).toContain('Ada Researcher · Lin Reviewer')
    expect(readableDocx).toContain('(Field and Stone, 2026)')
    expect(readableDocx).toContain('Independent measurements of canopy area')
    expect(readableDocx).not.toContain('[@field2026]')
    expect(readableDocx).toContain('Figure: Canopy response through time — embedded image not included in native DOCX')
    expect(readableDocx).not.toContain('data:image/svg+xml;base64')
    expect(readableDocx).not.toContain('$y = ax + b$')
    expect(readableDocx).not.toContain('@fig-response')
    expect(readableDocx).toContain('word/document.xml')
    expect(readableDocx).not.toContain('Drought acclimation reshapes canopy development')
    expect(readableDocx).not.toMatch(/\.dm-anchor|\.draftmatter-reviews|<w:(?:ins|del)\b/)
  })
})
