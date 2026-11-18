import { expect, test } from '@playwright/test'
import axe from 'axe-core'

interface AxeViolationSummary {
  help: string
  id: string
  impact: string | null
  targets: string[][]
}

test.describe('DM-P1-07 accessibility baseline', () => {
  test('passes a rendered WCAG A/AA scan including color contrast', async ({ page }) => {
    await page.goto('/draft')
    await page.addScriptTag({ content: axe.source })

    const violations = await page.evaluate(async () => {
      const axeApi = (window as typeof window & {
        axe: {
          run: (context: Document, options: object) => Promise<{
            violations: Array<{
              help: string
              id: string
              impact: string | null
              nodes: Array<{ target: string[] }>
            }>
          }>
        }
      }).axe
      const result = await axeApi.run(document, {
        runOnly: {
          type: 'tag',
          values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'],
        },
      })

      return result.violations.map((violation) => ({
        help: violation.help,
        id: violation.id,
        impact: violation.impact,
        targets: violation.nodes.map((node) => node.target),
      })) satisfies AxeViolationSummary[]
    })

    expect(violations).toEqual([])
  })

  test('keeps keyboard focus visible and suppresses nonessential motion', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.goto('/draft')

    expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(true)
    await expect(page.locator('.editor-area')).toHaveCSS('scroll-behavior', 'auto')

    const motionDurations = await page.evaluate(() => {
      const saveIndicator = document.querySelector<HTMLElement>('.project-dot')!
      const chart = document.createElement('div')
      chart.className = 'chart-wrap'
      document.body.append(chart)
      saveIndicator.classList.add('saving')
      chart.classList.add('loading')
      const milliseconds = (value: string) => value.split(',').map((duration) => {
        const parsed = Number.parseFloat(duration)
        return duration.trim().endsWith('ms') ? parsed : parsed * 1_000
      })

      const durations = {
        animation: milliseconds(getComputedStyle(saveIndicator).animationDuration),
        pseudoAnimation: milliseconds(getComputedStyle(chart, '::after').animationDuration),
        transition: milliseconds(getComputedStyle(chart).transitionDuration),
      }
      chart.remove()
      return durations
    })
    expect(motionDurations.animation.every((duration) => duration <= 0.01)).toBe(true)
    expect(motionDurations.pseudoAnimation.every((duration) => duration <= 0.01)).toBe(true)
    expect(motionDurations.transition.every((duration) => duration <= 0.01)).toBe(true)

    const title = page.getByRole('textbox', { name: 'Manuscript title' })
    await title.focus()
    await page.keyboard.press('Tab')
    const editingFocus = page.locator(':focus-visible')
    await expect(editingFocus).toBeVisible()
    // Manuscript fields intentionally use their text caret instead of a frame
    // around the whole paper. Check that keyboard focus really entered an
    // editable field, then verify a visible ring on the next toolbar control.
    await expect.poll(() => editingFocus.evaluate((element) => element.contains(window.getSelection()?.focusNode ?? null))).toBe(true)
    const caret = await editingFocus.evaluate((element) => ({
      editable: (element as HTMLElement).isContentEditable,
      caretColor: getComputedStyle(element).caretColor,
      hasSelection: element.contains(window.getSelection()?.focusNode ?? null),
    }))
    expect(caret).toMatchObject({ editable: true, hasSelection: true })
    expect(caret.caretColor).not.toMatch(/transparent|rgba\([^)]*,\s*0\)$/)
    await page.keyboard.type('Keyboard caret probe ')
    await expect(editingFocus).toContainText('Keyboard caret probe')
    await page.keyboard.press('ControlOrMeta+z')
    await expect(editingFocus).not.toContainText('Keyboard caret probe')
    await page.getByRole('button', { name: 'Open command menu', exact: true }).focus()
    await page.keyboard.press('Tab')
    const focused = page.locator('button:focus-visible')
    await expect(focused).toBeVisible()
    const focusRing = await focused.evaluate((element) => {
      const style = getComputedStyle(element)
      return {
        outlineStyle: style.outlineStyle,
        outlineWidth: Number.parseFloat(style.outlineWidth),
        boxShadow: style.boxShadow,
      }
    })
    expect(
      (focusRing.outlineStyle === 'solid' && focusRing.outlineWidth >= 1)
      || focusRing.boxShadow !== 'none',
    ).toBe(true)

    await page.keyboard.press('Control+p')
    const commandMenu = page.getByRole('dialog', { name: 'Command menu' })
    await expect(commandMenu).toBeVisible()
    await expect(commandMenu.getByRole('textbox', { name: 'Search commands' })).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(commandMenu).toBeHidden()
  })
})
