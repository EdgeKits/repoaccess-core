// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Gary Stupak

import { describe, it, expect } from 'vitest'
import { themeVars, baseThemeCss, sanitizeCustomCss } from '../src/themes/theme'
import {
  themeVars as barrelThemeVars,
  baseThemeCss as barrelBaseThemeCss,
  sanitizeCustomCss as barrelSanitizeCustomCss,
} from '../src/lib'
import type { Theme } from '../src/types'

// Theme v2 (browser-driven light/dark, no mode): themeVars emits the :root var block -
// `color-scheme: light dark` + every color as a `light-dark(<light>, <dark>)` pair (seller palettes
// over neutral defaults, values sanitized) - so the buyer's browser preference picks the palette.
// baseThemeCss is the unified component stylesheet written against those vars.

describe('themeVars', () => {
  it('fills the neutral light + dark defaults when no theme is given', () => {
    const css = themeVars()
    expect(css).toContain('color-scheme: light dark')
    expect(css).toContain('--ra-brand: light-dark(#1f6feb, #4493f8)')
    expect(css).toContain('--ra-brand-contrast: light-dark(#fff, #0d1117)')
    expect(css).toContain('--ra-bg: light-dark(#f6f7f9, #0d1117)')
    expect(css).toContain('--ra-surface: light-dark(#fff, #161b22)')
    expect(css).toContain('--ra-text: light-dark(#111, #e6edf3)')
    expect(css).toContain('--ra-text-muted: light-dark(#555, #9198a1)')
    expect(css).toContain('--ra-border: light-dark(#e5e7eb, #30363d)')
    expect(css).toContain('--ra-radius: 12px')
    expect(css).toContain('--ra-font: system-ui, sans-serif')
  })

  it('an empty theme (or empty palettes) is identical to no theme (everything defaults)', () => {
    expect(themeVars({})).toBe(themeVars())
    expect(themeVars({ light: {}, dark: {} })).toBe(themeVars())
  })

  it('applies both seller palettes into the light-dark() pairs', () => {
    const theme: Theme = {
      light: { brand: '#7c3aed', bg: '#faf9ff', text: '#1a1523' },
      dark: { brand: '#a78bfa', bg: '#0b0b0f', text: '#f5f5f5' },
      radius: '4px',
      font: 'Inter, sans-serif',
    }
    const css = themeVars(theme)
    expect(css).toContain('--ra-brand: light-dark(#7c3aed, #a78bfa)')
    expect(css).toContain('--ra-bg: light-dark(#faf9ff, #0b0b0f)')
    expect(css).toContain('--ra-text: light-dark(#1a1523, #f5f5f5)')
    expect(css).toContain('--ra-radius: 4px')
    expect(css).toContain('--ra-font: Inter, sans-serif')
    // Untouched colors still fall back to each scheme's neutral default.
    expect(css).toContain('--ra-text-muted: light-dark(#555, #9198a1)')
    expect(css).toContain('--ra-brand-contrast: light-dark(#fff, #0d1117)')
  })

  it('a one-palette theme fills the OTHER scheme from the neutral defaults', () => {
    const css = themeVars({ light: { brand: '#7c3aed' } })
    expect(css).toContain('--ra-brand: light-dark(#7c3aed, #4493f8)')
    const css2 = themeVars({ dark: { bg: '#000' } })
    expect(css2).toContain('--ra-bg: light-dark(#f6f7f9, #000)')
  })

  it('always emits color-scheme: light dark (browser-driven, no mode switch)', () => {
    expect(themeVars()).toContain('color-scheme: light dark;')
    expect(themeVars({ dark: { bg: '#000' } })).toContain(
      'color-scheme: light dark;',
    )
  })

  it('sanitizes palette values: strips CSS/HTML breakout chars', () => {
    // A hostile/misconfigured value tries to close the declaration + the <style> element.
    const css = themeVars({
      light: { brand: 'red; } body{display:none} </style><script>' },
    })
    // No `<`/`>` survive anywhere, so neither `</style>` nor `<script>` can form.
    expect(css).not.toContain('<')
    expect(css).not.toContain('>')
    // The only braces are themeVars' own :root wrapper (exactly one pair) - the injected `{ }` are gone,
    // so the residue can't form a second rule; it stays confined to the single --ra-brand declaration.
    expect(css.match(/\{/g)?.length).toBe(1)
    expect(css.match(/\}/g)?.length).toBe(1)
    expect(css).toContain('--ra-brand: light-dark(red body')
  })

  it('a value that sanitizes to empty falls back to the scheme default', () => {
    // Nothing but breakout chars -> cssToken yields '' -> the neutral default is used.
    expect(themeVars({ light: { brand: '<>{};' } })).toContain(
      '--ra-brand: light-dark(#1f6feb, #4493f8)',
    )
  })

  it('a newline in a token value collapses to a space (single declaration line)', () => {
    const css = themeVars({ font: 'Inter,\n  sans-serif' })
    expect(css).toContain('--ra-font: Inter, sans-serif')
  })
})

describe('baseThemeCss', () => {
  it('is written against the --ra-* vars (no hard-coded brand/bg literals)', () => {
    expect(baseThemeCss).toContain('background: var(--ra-bg)')
    expect(baseThemeCss).toContain('color: var(--ra-text)')
    expect(baseThemeCss).toContain('background: var(--ra-surface)')
    expect(baseThemeCss).toContain('background: var(--ra-brand)')
    expect(baseThemeCss).toContain('color: var(--ra-brand-contrast)')
    expect(baseThemeCss).toContain('font-family: var(--ra-font)')
    // The neutral literals live ONLY in themeVars, not baked into the component sheet.
    expect(baseThemeCss).not.toContain('#1f6feb')
    expect(baseThemeCss).not.toContain('#f6f7f9')
  })

  it('covers both the claim/delivery AND the checkout components', () => {
    for (const sel of [
      '.card',
      'button',
      'button[disabled]',
      'input',
      'label',
      '.error',
      '.status',
      '.summary',
      '.row',
      // Capped at one class, so the emphasized-total qualifier rides inside `:where()`. The rule this
      // list is checking for is the same one; only its selector text moved.
      '.row:where(.total)',
      '.logo',
      '.brand',
      '.refund',
      '.products',
      '.product',
      '.select-btn',
      '.back',
      '.spinner',
    ]) {
      expect(baseThemeCss).toContain(sel)
    }
  })

  it('controls derive a tighter radius from the card token (neutral 12px -> 8px)', () => {
    expect(baseThemeCss).toContain('border-radius: var(--ra-radius)') // the card
    expect(baseThemeCss).toContain(
      'border-radius: calc(var(--ra-radius) - 4px)',
    ) // input/button
  })

  it('caps the logo in BOTH axes so a wide banner logo cannot overflow the card', () => {
    // max-height alone lets a wide image spill past the card edge; max-width: 100% makes the
    // browser fit it inside both constraints while preserving proportions. This rule is in the
    // base sheet served on EVERY page, so the cap holds even with no theme configured.
    expect(baseThemeCss).toContain(
      '.logo { max-height: 48px; max-width: 100%; margin-bottom: 1rem }',
    )
  })

  it('uses plain descendant selectors only (survives raw(): no > or & combinators)', () => {
    expect(baseThemeCss).not.toContain('>')
    expect(baseThemeCss).not.toContain('&')
  })
})

describe('sanitizeCustomCss', () => {
  it('neutralizes the </style> close tag (any spacing / attrs) but keeps { } ;', () => {
    const dirty = '.card { color: red } </style><script>alert(1)</script>'
    const clean = sanitizeCustomCss(dirty)
    expect(clean).not.toContain('</style')
    expect(clean).toContain('.card { color: red }') // legitimate CSS braces preserved
  })

  it('neutralizes odd-spaced / attribute-bearing close tags too', () => {
    expect(sanitizeCustomCss('a</STYLE >b')).not.toMatch(/<\/style/i)
    expect(sanitizeCustomCss('a</style foo="x">b')).not.toMatch(/<\/style/i)
  })

  it('ESCAPES rather than deletes: the < becomes the CSS hex escape, the text survives', () => {
    // Escaping is what makes one pass sufficient (nothing is removed, so nothing can splice), and it
    // also means the seller's text is preserved rather than silently truncated.
    const clean = sanitizeCustomCss('a</style>b')
    expect(clean).toBe('a\\3c /style>b')
    expect(clean).not.toMatch(/<\/style/i)
    // A real backslash, not a control character - a mangled escape would still "pass" a not-toMatch.
    expect(clean.charCodeAt(1)).toBe(92)
    expect([...clean].some((c) => c.charCodeAt(0) < 0x20)).toBe(false)
  })

  it('a nested close tag cannot reassemble - one pass is sufficient by construction', () => {
    // The exact string a security audit used to demonstrate the breakout against the old DELETING
    // sanitizer: neither edge of `</sty</stylele` is a close tag, but deleting the inner `</style`
    // spliced `</sty` to `le` and reconstituted a real one. Escaping removes nothing, so the neighbours
    // never become adjacent and no single pass can forge a match.
    const nested = 'body{}</sty</stylele><script>alert(1)</script>'
    const clean = sanitizeCustomCss(nested)
    expect(clean).not.toMatch(/<\/style/i)
    expect(clean).not.toContain('</style>')
  })

  it('is idempotent - re-sanitizing changes nothing', () => {
    const once = sanitizeCustomCss(
      'body{}</sty</stylele><script>alert(1)</script>',
    )
    expect(sanitizeCustomCss(once)).toBe(once)
  })

  it('COST: the pathological nested input stays linear-class (the old loop was quadratic)', () => {
    // Regression pin for the audit's measured finding. The deleting fixed-point loop needed one pass per
    // nesting level, so this exact 448k input took ~12s of CPU; the single-pass escape does it in ~0ms.
    // The bound is deliberately loose (a real quadratic regression is ~12,000ms, so this cannot flake on
    // a slow machine while still catching the defect).
    const n = 64000
    const pathological = '</sty'.repeat(n) + '</style' + 'le'.repeat(n)
    expect(pathological.length).toBe(448007)

    const started = Date.now()
    const clean = sanitizeCustomCss(pathological)
    const elapsedMs = Date.now() - started

    expect(elapsedMs).toBeLessThan(2000)
    expect(clean).not.toMatch(/<\/style/i) // still correct at size, not just fast
  })
})

describe('barrel exports', () => {
  it('re-exports the theme primitives - incl. sanitizeCustomCss - from the package root', () => {
    expect(barrelThemeVars).toBe(themeVars)
    expect(barrelBaseThemeCss).toBe(baseThemeCss)
    expect(barrelSanitizeCustomCss).toBe(sanitizeCustomCss)
  })
})
