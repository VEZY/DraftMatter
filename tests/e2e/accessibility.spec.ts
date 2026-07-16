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
    await page.goto('/')
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
    await page.goto('/')

    expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(true)
    await expect(page.locator('.editor-area')).toHaveCSS('scroll-behavior', 'auto')

    const motionDurations = await page.evaluate(() => {
      const saveIndicator = document.querySelector<HTMLElement>('.save-indicator')!
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
    const focused = page.locator(':focus-visible')
    await expect(focused).toBeVisible()
    const focusRing = await focused.evaluate((element) => {
      const style = getComputedStyle(element)
      return { style: style.outlineStyle, width: Number.parseFloat(style.outlineWidth) }
    })
    expect(focusRing.style).toBe('solid')
    expect(focusRing.width).toBeGreaterThanOrEqual(2)

    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k')
    const commandMenu = page.getByRole('dialog', { name: 'Command menu' })
    await expect(commandMenu).toBeVisible()
    await expect(commandMenu.getByRole('textbox', { name: 'Search commands' })).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(commandMenu).toBeHidden()
  })
})
