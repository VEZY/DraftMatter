import { expect, test } from '@playwright/test'

const source = `# Reordering

## Introduction

First introduction block.

Second introduction block.

## Methods

Methods stay with this heading.

## Results

Results stay last.
`

test.describe('section and block drag handles', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript((portableSource) => {
      localStorage.setItem('draftmatter.structured-source.v1', portableSource)
      localStorage.setItem('draftmatter.structured-mode.v1', 'true')
    }, source)
    await page.goto('/')
  })

  test('moves a section with its content and moves one paragraph independently', async ({ page }) => {
    const methods = page.getByRole('button', { name: 'Move section Methods' })
    const introduction = page.getByRole('button', { name: 'Move section Introduction' })
    await methods.dragTo(introduction)

    await expect.poll(async () => {
      const portable = await page.evaluate(() => localStorage.getItem('draftmatter.structured-source.v1') ?? '')
      return portable.indexOf('## Methods') < portable.indexOf('Methods stay with this heading.')
        && portable.indexOf('Methods stay with this heading.') < portable.indexOf('## Introduction')
    }).toBe(true)

    const second = page.getByRole('button', { name: 'Move block paragraph “Second introduction block.”' })
    const first = page.getByRole('button', { name: 'Move block paragraph “First introduction block.”' })
    await second.dragTo(first)

    await expect.poll(async () => {
      const portable = await page.evaluate(() => localStorage.getItem('draftmatter.structured-source.v1') ?? '')
      return portable.indexOf('## Introduction') < portable.indexOf('Second introduction block.')
        && portable.indexOf('Second introduction block.') < portable.indexOf('First introduction block.')
        && portable.indexOf('First introduction block.') < portable.indexOf('## Results')
    }).toBe(true)
  })
})
