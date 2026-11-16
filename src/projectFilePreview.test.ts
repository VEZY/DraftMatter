// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { parseTablePreview, previewImageMediaType, previewText, projectPreviewKind, sanitizePreviewSvg } from './projectFilePreview'

describe('safe bounded project file previews', () => {
  it('recognizes configuration and ignore files without treating arbitrary binaries as text', () => {
    for (const path of ['.gitignore', '.gitattributes', 'settings.toml', 'analysis.py', 'analysis.jl', 'README']) expect(projectPreviewKind(path)).toBe('text')
    expect(projectPreviewKind('data/archive.parquet')).toBe('unsupported')
    expect(projectPreviewKind('references/Article.PDF')).toBe('pdf')
    expect(previewText(Uint8Array.from([0, 1, 2]))).toBeNull()
    expect(previewText(Uint8Array.from([0xff]))).toBeNull()
    const split = Uint8Array.from([65, 0xe2, 0x82])
    expect(previewText(split)).toBeNull()
    expect(previewText(split, true)).toBe('A')
    expect(previewText(new TextEncoder().encode('\ufeffcontent'))).toBe('\ufeffcontent')
    expect(() => previewImageMediaType('image.png', new TextEncoder().encode('<svg/>'))).toThrow('do not match')
  })

  it('parses quoted commas, escaped quotes and multiline values, and keeps row numbers usable', () => {
    expect(parseTablePreview('name,value\r\n"alpha, beta","line 1\nline ""2"""\r\ngamma,3', ',')).toEqual({
      headers: ['name', 'value'], rows: [['alpha, beta', 'line 1\nline "2"'], ['gamma', '3']], truncated: false,
    })
    expect(parseTablePreview('name\tvalue\na\t1\nb\t2\nc\t3', '\t', false, 2)).toEqual({ headers: ['name', 'value'], rows: [['a', '1'], ['b', '2']], truncated: true })
    expect(parseTablePreview('name,value\na,1\npartial', ',', true)).toEqual({ headers: ['name', 'value'], rows: [['a', '1']], truncated: true })
  })

  it('strips active SVG, CSS and external resources while retaining internal drawing references', () => {
    const safe = sanitizePreviewSvg('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(1)</script><style>rect{fill:url(https://evil.test/a)}</style><foreignObject><iframe src="https://evil.test"/></foreignObject><image href="https://evil.test/a"/><a href="https://evil.test"><rect width="1"/></a><defs><linearGradient id="g"/></defs><rect width="10" fill="url(#g)" style="fill:red"/><use href="#g"/><path fill="url(/private)"/><path stroke="u\\72l(/private)"/></svg>')
    expect(safe).not.toMatch(/script|onload|style|foreignObject|iframe|image|evil|private|\\72/)
    expect(safe).toContain('fill="url(#g)"')
    expect(safe).toContain('href="#g"')
    expect(() => sanitizePreviewSvg('<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg/>')).toThrow('declarations')
    expect(() => sanitizePreviewSvg('<html/>')).toThrow('could not be read')
  })
})
