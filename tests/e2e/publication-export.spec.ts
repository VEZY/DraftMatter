import { copyFile, readFile } from 'node:fs/promises'
import { expect, test } from '@playwright/test'

const figure = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 220"><rect width="640" height="220" fill="#fff"/><g stroke="#e5ebe7"><path d="M45 35H610M45 80H610M45 125H610M45 170H610"/></g><polyline points="45,175 135,158 225,132 315,102 405,73 495,51 585,39" fill="none" stroke="#466f5c" stroke-width="5"/><polyline points="45,175 135,164 225,148 315,128 405,111 495,96 585,83" fill="none" stroke="#b9785c" stroke-width="5"/><g fill="#466f5c"><circle cx="45" cy="175" r="5"/><circle cx="315" cy="102" r="5"/><circle cx="585" cy="39" r="5"/></g><g fill="#b9785c"><circle cx="45" cy="175" r="5"/><circle cx="315" cy="128" r="5"/><circle cx="585" cy="83" r="5"/></g></svg>`).toString('base64')

const source = `---
title: "Independent canopy synthesis"
author:
  - name: Ada Researcher
    orcid: 0000-0001-2345-6789
    affiliations:
      - Field Institute
      - Open Methods Lab
  - name: Lin Reviewer
    affiliations:
      - Field Institute
---

# Independent canopy synthesis

## Results {#results}

Canopy area differed by **18%** [@field2026].[^methods] The fitted response was $y = ax + b$; see @fig-response and @tbl-summary.

$$
R^2 = 0.94
$$ {#eq-fit .unnumbered}

![Canopy response through time](data:image/svg+xml;base64,${figure}){#fig-response}

| Treatment | Final area |
| :--- | ---: |
| Control | 100 |
| Drought | 82 |
: Final canopy **area**. {#tbl-summary .striped}

\`\`\`python {#fit .execute}
print("must remain inert")
\`\`\`

<!-- dm-output:start cell="fit" run="sha256:test" -->
\`\`\`text
retained model output
\`\`\`
<!-- dm-output:end -->

[^methods]: Canopy area was checked against independent field measurements.
`

test.describe('DM-P5-01/02 native publication exports', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(({ portableSource, citations }) => {
      Object.defineProperty(window, 'showSaveFilePicker', { configurable: true, value: undefined })
      Object.defineProperty(window, 'print', {
        configurable: true,
        value: () => {
          const printState = window as Window & { __draftmatterPrintRequests?: number }
          printState.__draftmatterPrintRequests = (printState.__draftmatterPrintRequests ?? 0) + 1
        },
      })
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
    await page.getByRole('button', { name: /Native HTML/ }).click()
    const htmlDialog = page.getByRole('dialog', { name: 'Save clean HTML document' })
    await expect(htmlDialog.getByLabel('File name')).toHaveValue('canopy-drought.html')
    const htmlDownloadEvent = page.waitForEvent('download')
    await htmlDialog.getByRole('button', { name: 'Choose location…' }).click()
    const htmlDownload = await htmlDownloadEvent
    const htmlPath = await htmlDownload.path()
    expect(htmlPath).not.toBeNull()
    const html = await readFile(htmlPath!, 'utf8')

    expect(htmlDownload.suggestedFilename()).toBe('canopy-drought.html')
    expect(html).toContain('<title>Independent canopy synthesis</title>')
    expect(html).toContain('<span class="author-name">Ada Researcher</span>')
    expect(html).toContain('ORCID 0000-0001-2345-6789')
    expect(html).toContain('<span class="author-name">Lin Reviewer</span>')
    expect(html).toContain('<li id="affiliation-1">Field Institute</li>')
    expect(html).toContain('<li id="affiliation-2">Open Methods Lab</li>')
    expect(html.match(/<h1>/g)).toHaveLength(1)
    expect(html).not.toContain('<main><h1')
    expect(html).toContain('Canopy area differed by <strong>18%</strong>')
    expect(html).toContain('<cite class="citation" data-citekeys="field2026">(Field and Stone, 2026)</cite>')
    expect(html).toContain('role="doc-noteref" aria-label="Footnote 1">1</a></sup>')
    expect(html).toContain('<section class="footnotes" role="doc-endnotes" aria-label="Footnotes">')
    expect(html).toContain('Canopy area was checked against independent field measurements.')
    expect(html).not.toContain('[^methods]')
    expect(html).toContain('<a class="cross-reference" href="#fig-response">Figure response</a>')
    expect(html).toContain('<a class="cross-reference" href="#tbl-summary">Table summary</a>')
    expect(html).not.toContain('>@fig-response<')
    expect(html).toContain('Independent measurements of canopy area')
    expect(html).toContain('<figure id="fig-response">')
    expect(html).toContain('<div id="eq-fit" class="equation display-equation"')
    expect(html).not.toContain('{#eq-fit')
    expect(html).toContain('<table id="tbl-summary"><caption>Final canopy <strong>area</strong>.</caption>')
    expect(html).toContain('<th style="text-align:right">Final area</th>')
    expect(html).not.toContain('{#tbl-summary')
    expect(html).toContain('role="math"')
    expect(html).toContain('<pre class="source-code"><code class="language-python">')
    expect(html).toContain('print(&quot;must remain inert&quot;)')
    expect(html).toContain('<pre class="execution-output"><samp>retained model output</samp></pre>')
    expect(html).not.toContain('source · not executed during export')
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
    const printRoot = page.locator('[data-draftmatter-print-root]')
    await expect(printRoot).toHaveCount(1)
    await expect(printRoot).toBeHidden()
    await expect(page.getByText('System print dialog opened · choose Save as PDF')).toBeVisible()
    expect(await page.evaluate(() => (window as Window & { __draftmatterPrintRequests?: number }).__draftmatterPrintRequests)).toBe(1)
    expect(await printRoot.innerHTML()).toContain('<h1>Independent canopy synthesis</h1>')
    expect(await printRoot.innerHTML()).not.toMatch(/\.dm-anchor|\.draftmatter-reviews/)
    await expect(page.locator('iframe[title="DraftMatter print preview"]')).toHaveCount(0)
    await page.evaluate(() => window.dispatchEvent(new Event('afterprint')))
    await expect(printRoot).toHaveCount(0)

    await page.getByRole('button', { name: 'Export' }).click()
    await page.getByRole('button', { name: /Clean DOCX/ }).click()
    const docxDialog = page.getByRole('dialog', { name: 'Save clean Word document' })
    await expect(docxDialog.getByLabel('File name')).toHaveValue('canopy-drought.docx')
    const docxDownloadEvent = page.waitForEvent('download')
    await docxDialog.getByRole('button', { name: 'Choose location…' }).click()
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
    expect(readableDocx).toContain('Ada Researcher')
    expect(readableDocx).toContain('Lin Reviewer')
    expect(readableDocx).toContain('(ORCID 0000-0001-2345-6789)')
    expect(readableDocx.match(/Field Institute/g)).toHaveLength(1)
    expect(readableDocx).toContain('Open Methods Lab')
    expect(readableDocx).toContain('<dc:creator>Ada Researcher; Lin Reviewer</dc:creator>')
    expect(readableDocx).toContain('(Field and Stone, 2026)')
    expect(readableDocx).toContain('Independent measurements of canopy area')
    expect(readableDocx).not.toContain('[@field2026]')
    expect(readableDocx).toContain('word/footnotes.xml')
    expect(readableDocx).toContain('relationships/footnotes')
    expect(readableDocx).toContain('<w:footnoteReference w:id="1"/>')
    expect(readableDocx).toContain('<w:footnote w:id="1">')
    expect(readableDocx).toContain('Canopy area was checked against independent field measurements.')
    expect(readableDocx).not.toContain('[^methods]')
    expect(readableDocx).toContain('Figure: Canopy response through time — embedded image not included in native DOCX')
    expect(readableDocx).not.toContain('data:image/svg+xml;base64')
    expect(readableDocx).not.toContain('$y = ax + b$')
    expect(readableDocx).not.toContain('@fig-response')
    expect(readableDocx).toContain('Table summary')
    expect(readableDocx).toContain('Table: Final canopy area.')
    expect(readableDocx).toContain('<w:jc w:val="right"/>')
    expect(readableDocx).not.toContain('{#tbl-summary')
    expect(readableDocx).not.toContain('{#eq-fit')
    expect(readableDocx).toContain('print(&quot;must remain inert&quot;)')
    expect(readableDocx).toContain('retained model output')
    expect(readableDocx).not.toContain('source · not executed during export')
    expect(readableDocx).toContain('word/document.xml')
    expect(readableDocx).not.toContain('Drought acclimation reshapes canopy development')
    expect(readableDocx).not.toMatch(/\.dm-anchor|\.draftmatter-reviews|<w:(?:ins|del)\b/)
  })
})
