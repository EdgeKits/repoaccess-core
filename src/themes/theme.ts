// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Gary Stupak

import type { Theme, Palette } from '../types'

/**
 * The shared look for every worker-served page, driven by design tokens as CSS variables. Core owns
 * ONE source of the look: `themeVars(theme)` emits the `:root` block - `color-scheme: light dark`
 * plus the `--ra-*` custom properties, each color a `light-dark(<light>, <dark>)` pair so the
 * buyer's BROWSER preference picks the palette (no JS theme logic, no mode switch) - and
 * `baseThemeCss` is the unified component stylesheet written against those vars. The claim /
 * delivery pages (core) and Pro's `/checkout` both render
 * `themeVars(theme) + baseThemeCss + customCss` into a single `<style>` block, so they share one look
 * from one place. Core is provider-agnostic: it ships the primitives + ONE neutral theme (a light
 * AND a dark palette) and renders whatever tokens it is given.
 */

// Seller token values are injected RAW into a `<style>` declaration, so strip the chars that could
// close the declaration or the <style> element. A color / length / font-stack never legitimately
// contains `<>{};` or a newline, so removing them can't corrupt a valid value - it only stops a
// misconfigured or hostile config string from breaking out (defense-in-depth, same spirit as safeUrl).
function cssToken(value: string): string {
  return value
    .replace(/[<>{};]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

// Core's NEUTRAL palettes - the light one matches the original worker pages (understated light
// surface, blue action color); the dark one is its counterpart tuned for contrast on dark surfaces
// (lighter link blue, dark label on the light-blue button - white would fall short of AA there).
const NEUTRAL_LIGHT: Required<Palette> = {
  brand: '#1f6feb',
  brandContrast: '#fff',
  bg: '#f6f7f9',
  surface: '#fff',
  text: '#111',
  textMuted: '#555',
  border: '#e5e7eb',
}
const NEUTRAL_DARK: Required<Palette> = {
  brand: '#4493f8',
  brandContrast: '#0d1117',
  bg: '#0d1117',
  surface: '#161b22',
  text: '#e6edf3',
  textMuted: '#9198a1',
  border: '#30363d',
}

/**
 * Render the `:root` design-token block: `color-scheme: light dark` + the `--ra-*` custom
 * properties. Every color var is a `light-dark(<light>, <dark>)` pair built from the theme's two
 * palettes, so each resolves to the buyer's browser color-scheme preference - no JS, no mode
 * switch; `radius` / `font` are scheme-independent. Core's NEUTRAL light / dark default fills any
 * value the seller omits. A provided value is sanitized via `cssToken`; if it sanitizes to empty it
 * falls back to the default.
 */
export function themeVars(theme?: Theme): string {
  const t = theme ?? {}
  const v = (val: string | undefined, def: string): string =>
    val ? cssToken(val) || def : def
  const pair = (key: keyof Palette): string =>
    `light-dark(${v(t.light?.[key], NEUTRAL_LIGHT[key])}, ${v(t.dark?.[key], NEUTRAL_DARK[key])})`
  return `:root {
  color-scheme: light dark;
  --ra-brand: ${pair('brand')};
  --ra-brand-contrast: ${pair('brandContrast')};
  --ra-bg: ${pair('bg')};
  --ra-surface: ${pair('surface')};
  --ra-text: ${pair('text')};
  --ra-text-muted: ${pair('textMuted')};
  --ra-border: ${pair('border')};
  --ra-radius: ${v(t.radius, '12px')};
  --ra-font: ${v(t.font, 'system-ui, sans-serif')};
}`
}

/**
 * The unified component stylesheet, written entirely against the `--ra-*` vars. Covers BOTH the
 * claim / delivery components AND the checkout components (card, button, input, label, error, status,
 * the price summary rows, logo / brand line, links, refund notice, product catalog) so Pro's
 * `/checkout` migrates onto the same rules. Plain descendant selectors only (no `>` / `&`) so it
 * survives unescaped through `raw()` - the same constraint the claim template documents.
 *
 * EVERY SELECTOR HERE IS CAPPED AT ONE CLASS - (0,1,0) or lower - so a seller's `customCss`, which is
 * appended after this sheet, either ties a rule and wins on source order or beats it outright. That
 * cap is what makes "your rules come last" a promise rather than a hope: source order settles a tie
 * and nothing else, so a rule of ours at (0,2,0) would leave their stylesheet in the page, last, and
 * doing nothing. Where a rule needs a descendant or a qualifier to say what it means, the structural
 * half sits inside `:where()`, which contributes zero to specificity and so says the same thing
 * without outranking anybody. `test/specificity.test.ts` grades every selector the rendered page
 * carries and reds anything above the cap that is not declared in its registry.
 *
 * `button[disabled]` is the ONE exception, at (0,1,1), and it is in that registry with its reason. It
 * is the sheet's statement that a control is not pressable, and no capped selector can hold it:
 * lowered, it loses `cursor` to `.back` - our own rule, later in this same sheet and carrying a class
 * - on any control that wears both. The cost to a seller is bounded and worth naming: a disabled
 * button's `opacity` and `cursor` need more than a single class to override.
 *
 * Controls (input / button) use `calc(var(--ra-radius) - 4px)` so they stay a touch tighter than the
 * card (the neutral 12px card -> 8px controls, matching the current pages) while tracking the token.
 */
export const baseThemeCss = `
  body { font-family: var(--ra-font); margin: 0; padding: 2rem 1rem;
    display: flex; justify-content: center; background: var(--ra-bg); color: var(--ra-text) }
  .card { background: var(--ra-surface); max-width: 28rem; width: 100%; padding: 2rem;
    border-radius: var(--ra-radius); box-shadow: 0 1px 3px rgba(0,0,0,.12) }
  .logo { max-height: 48px; max-width: 100%; margin-bottom: 1rem }
  .brand { font-size: 1.1rem; margin: 0 0 1rem; color: var(--ra-text-muted) }
  h1 { margin: 0 0 .5rem; font-size: 1.5rem }
  h2 { margin: 0 0 .5rem; font-size: 1.4rem }
  p { line-height: 1.5; color: var(--ra-text) }
  .desc { line-height: 1.5; color: var(--ra-text); margin: 0 0 1.5rem }
  a { color: var(--ra-brand) }
  label { display: block; font-weight: 600; margin: 1rem 0 .35rem }
  input { width: 100%; box-sizing: border-box; padding: .6rem .75rem; font-size: 1rem;
    border: 1px solid var(--ra-border); border-radius: calc(var(--ra-radius) - 4px) }
  button { margin-top: 1.25rem; width: 100%; padding: .7rem; font-size: 1rem; font-weight: 600;
    color: var(--ra-brand-contrast); background: var(--ra-brand); border: 0;
    border-radius: calc(var(--ra-radius) - 4px); cursor: pointer }
  button[disabled] { opacity: .75; cursor: default }
  .error { color: #b00020; font-weight: 600; margin: .5rem 0 0 }
  .status { color: var(--ra-text-muted); margin: 0 0 1rem }
  .summary { margin: 1.5rem 0; border-top: 1px solid var(--ra-border); padding-top: 1rem }
  .row { display: flex; justify-content: space-between; padding: .25rem 0; color: var(--ra-text) }
  .row:where(.total) { font-weight: 700; border-top: 1px solid var(--ra-border); margin-top: .5rem;
    padding-top: .75rem }
  .frame { margin-top: 1rem; min-width: 312px }
  .refund { margin-top: 1.5rem; font-size: .9rem; color: var(--ra-text-muted) }
  .products { list-style: none; margin: 1.5rem 0 0; padding: 0 }
  .product { display: flex; justify-content: space-between; align-items: center; gap: 1rem;
    padding: 1rem 0; border-top: 1px solid var(--ra-border) }
  :where(.product) .info { flex: 1 }
  :where(.product .info) strong { display: block; font-size: 1.05rem }
  :where(.product .info) .desc { margin: .25rem 0 0; font-size: .9rem }
  .select-btn { margin: 0; width: auto; padding: .55rem 1rem; white-space: nowrap }
  .back { width: auto; margin: 0 0 1rem; padding: 0; background: none; color: var(--ra-brand);
    font-weight: 600; border: 0; cursor: pointer }
  .spinner { display: inline-block; width: 1em; height: 1em; margin-right: .5em; vertical-align: -.15em;
    border: 2px solid transparent; border-top-color: currentColor; border-radius: 50%;
    animation: ra-spin .6s linear infinite }
  @keyframes ra-spin { to { transform: rotate(360deg) } }
`

/**
 * Neutralize any `</style>` in seller-supplied `customCss` before it is injected raw into the page's
 * `<style>` block - a stray close tag would otherwise end the element and let the rest render as HTML.
 * Matches the end-tag open case-insensitively (any spacing / trailing attrs). customCss legitimately
 * contains `{ } ;`, so those are NOT touched here (unlike token values).
 *
 * ESCAPES rather than DELETES, and that choice is the security property, not a style preference.
 * Deleting is what makes a sanitizer need a loop: removing one match splices its neighbours together
 * and can forge a NEW one (`</sty</stylele` - delete the inner `</style` and `</sty` joins `le` into a
 * real close tag). Escaping removes nothing, so neighbours never become adjacent and no match can be
 * forged: ONE pass is sufficient BY CONSTRUCTION, not by iterating until it looks settled.
 *
 * The replacement rewrites only the `<` into `\3c ` (the CSS hex escape for `<`, the trailing space
 * terminating the escape). The HTML parser scans for a literal `</style` to close the element and no
 * longer finds one; a CSS parser reads `\3c ` back as `<`, so the seller's text is preserved rather
 * than silently truncated. Being escape-based it is also idempotent - re-sanitizing changes nothing.
 */
export function sanitizeCustomCss(customCss: string): string {
  return customCss.replace(/<(\/style)/gi, '\\3c $1')
}
