// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Gary Stupak

import { beforeAll, describe, it, expect } from 'vitest'
import { themeVars, baseThemeCss } from '../src/themes/theme'
import {
  defaultClaimTemplate,
  type ClaimView,
} from '../src/claim/claim-template'
import type { Branding } from '../src/types'

/**
 * THE CASCADE CONTRACT: nothing core injects out-specifies a seller's own rule.
 *
 * A seller restyles these pages with `branding.customCss`, which is appended after core's own
 * stylesheet. Source order settles nothing but a TIE, so "appended last" is a promise about
 * SPECIFICITY: every selector core injects has to compute to (0,1,0) - one class' worth - or lower,
 * so a seller's single-class rule either ties it and wins on order, or beats it outright. A core rule
 * at (0,2,0) or (1,0,1) silently outranks them, and the failure is the quiet kind: their stylesheet is
 * in the page, it is last, and it does nothing.
 *
 * So this grades every selector in every sheet a core page injects. THE SHEETS ARE TAKEN FROM THE
 * RENDERED PAGE rather than imported, so a sheet added to the page shell is graded without anybody
 * remembering to list it here: the whole style block is read, the pieces whose text is already
 * reachable are subtracted by name, and whatever is left over is graded as well.
 *
 * A seller's own `customCss` is deliberately NOT part of the fixture. It is theirs to write at any
 * specificity they like, and grading it would make this file police the wrong stylesheet.
 */

// --- fixtures -----------------------------------------------------------------------------------

// No logo and no favicon, so the shell renders its brand line rather than an image. Neither branch
// carries a stylesheet, and the block is asserted identical across every state below anyway.
const brand: Branding = { name: 'Fixture Seller', logoUrl: '', faviconUrl: '' }

/** One of every claim state, because a state is free to render a sheet the others do not. */
const VIEWS: ClaimView[] = [
  { kind: 'form', token: 'tok', submitScript: '' },
  {
    kind: 'confirm',
    token: 'tok',
    username: 'octocat',
    handle: 'octocat',
    submitScript: '',
  },
  { kind: 'submitted', token: 'tok', username: 'octocat' },
  { kind: 'busy', token: 'tok' },
  { kind: 'pending', pollScript: '' },
  { kind: 'granted' },
  { kind: 'failed' },
  { kind: 'invalid' },
]

// --- the exceptions registry --------------------------------------------------------------------

/**
 * Rules that beat the cap DELIBERATELY. Each one costs a seller the ability to override that
 * declaration with a single-class rule, so each needs a reason that survives being read out loud.
 *
 * A stale entry - one whose selector no longer appears in its sheet - reddens the guard. An exception
 * nobody needs any more is an exception nobody reviewed.
 */
const EXCEPTIONS: { sheet: string; selector: string; why: string }[] = [
  {
    sheet: 'baseThemeCss',
    selector: 'button[disabled]',
    why: "THE NOT-PRESSABLE PIN. This is the sheet's statement that a control cannot be pressed, and no capped selector holds it: lowered to (0,0,1) or (0,1,0) it loses `cursor` to `.back`, which is our OWN rule, sits later in the same sheet and carries a class - so on a control that wears both, a disabled button would show the pointer again. The loss is to source order inside core's own file rather than to anything a seller wrote, which is exactly the case an exception is for. What it costs a seller is bounded and worth stating: a disabled button's `opacity` and `cursor` need more than a single class to override",
  },
]

// --- reading the sheets off the rendered page -----------------------------------------------------

const styleBlockOf = (html: string): string => {
  const m = /<style[^>]*>([\s\S]*?)<\/style>/.exec(html)
  expect(m, 'the page carries no style block').toBeTruthy()
  return m![1]
}

/** Remove one exact substring, failing loudly if it was not there to remove. */
const subtract = (css: string, piece: string, what: string): string => {
  expect(css.includes(piece), `the style block does not carry ${what}`).toBe(
    true,
  )
  return css.replace(piece, '')
}

/** Every sheet a core page injects, keyed by name. */
async function injectedSheets(): Promise<Record<string, string>> {
  const tokens = themeVars(brand.theme)
  const blocks: string[] = []
  for (const view of VIEWS)
    blocks.push(
      styleBlockOf((await defaultClaimTemplate({ brand, view })).toString()),
    )

  // One shell renders every claim state, so every state carries the same block. Asserting that is what
  // makes grading one block the same thing as grading all of them.
  for (const block of blocks)
    expect(
      block,
      'the claim states do not all carry the same style block',
    ).toBe(blocks[0])

  let rest = subtract(blocks[0], tokens, 'the design-token block')
  rest = subtract(rest, baseThemeCss, 'the component stylesheet')

  return {
    'the design-token block': tokens,
    baseThemeCss,
    // Empty today. A sheet added to the shell lands here and is graded, rather than going unread
    // because nobody remembered this file.
    'the rest of the style block': rest,
  }
}

// --- the CSS reader -------------------------------------------------------------------------------

/** The index of the `}` matching the `{` at `open`. */
function matchBrace(css: string, open: number): number {
  let depth = 0
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++
    else if (css[i] === '}' && --depth === 0) return i
  }
  throw new Error('specificity: unbalanced braces in an injected sheet')
}

/** Split on a separator that is not inside parentheses or brackets. */
function splitTop(s: string, sep: string): string[] {
  const out: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === '(' || c === '[') depth++
    else if (c === ')' || c === ']') depth--
    else if (c === sep && depth === 0) {
      out.push(s.slice(start, i))
      start = i + 1
    }
  }
  out.push(s.slice(start))
  return out.map((p) => p.trim()).filter(Boolean)
}

/**
 * Every selector in a sheet, one per entry of every selector list, descending into `@media`.
 * Anything else at-rule-shaped throws rather than being skipped: a rule this cannot read is a rule it
 * would grade as clean by never seeing it, which is the one failure a guard must not have.
 */
function selectorsOf(css: string): string[] {
  const out: string[] = []
  let i = 0
  while (i < css.length) {
    const open = css.indexOf('{', i)
    if (open === -1) break
    const prelude = css.slice(i, open).trim()
    if (prelude.startsWith('@')) {
      const close = matchBrace(css, open)
      if (/^@media\b/i.test(prelude))
        out.push(...selectorsOf(css.slice(open + 1, close)))
      // A keyframe block holds KEYFRAME selectors (`from`, `to`, `40%`), which are not selectors at
      // all: they match no element and never meet a seller's rule in the cascade. Skipping it is
      // correct, where skipping a @media block would have hidden real rules.
      else if (/^@keyframes\b/i.test(prelude)) void 0
      else
        throw new Error(
          `specificity: unreadable at-rule "${prelude}" - teach this reader about it rather than letting its contents go ungraded`,
        )
      i = close + 1
      continue
    }
    out.push(...splitTop(prelude, ','))
    i = css.indexOf('}', open) + 1
  }
  return out
}

// --- the specificity algorithm --------------------------------------------------------------------

type Spec = [number, number, number]

// Identifier characters per the CSS syntax spec: ASCII word characters, `-`, everything from U+00A0
// up, and the escape backslash. The range is written as escapes rather than as the literal
// characters, because its literal form opens with a non-breaking space that reads as an ordinary one
// - and a reader that took a space for an identifier character would swallow the descendant
// combinator and under-report every descendant selector in the sheet.
const isIdent = (c: string) => /[-\w\u00a0-\uffff\\]/.test(c)

/** Drop every `:where(...)`, argument and all: it contributes zero by definition. */
function stripWhere(sel: string): string {
  let out = sel
  for (;;) {
    const at = out.toLowerCase().indexOf(':where(')
    if (at === -1) return out
    let depth = 0
    let end = at + ':where'.length
    for (; end < out.length; end++) {
      if (out[end] === '(') depth++
      else if (out[end] === ')' && --depth === 0) break
    }
    out = out.slice(0, at) + ' ' + out.slice(end + 1)
  }
}

/**
 * Specificity by the selectors-level-4 algorithm: [ids, classes + attributes + pseudo-classes,
 * element types + pseudo-elements]. `:where()` contributes zero and is removed first.
 *
 * `:is()`, `:not()` and `:has()` take the specificity of their most specific argument, which this does
 * NOT implement - it throws instead. No core sheet uses one outside a `:where()`, and a reader that
 * quietly graded them as a plain pseudo-class would under-report exactly the selectors most likely to
 * be hiding something.
 */
function specificity(selector: string): Spec {
  const sel = stripWhere(selector)
  if (/:(is|not|has)\s*\(/i.test(sel))
    throw new Error(
      `specificity: "${selector}" uses :is/:not/:has outside a :where() - this reader does not compute those`,
    )
  const spec: Spec = [0, 0, 0]
  let i = 0
  const skipIdent = () => {
    while (i < sel.length && isIdent(sel[i])) i++
  }
  const skipParens = () => {
    if (sel[i] !== '(') return
    let depth = 0
    for (; i < sel.length; i++) {
      if (sel[i] === '(') depth++
      else if (sel[i] === ')' && --depth === 0) {
        i++
        return
      }
    }
  }
  while (i < sel.length) {
    const c = sel[i]
    if (c === '#') {
      spec[0]++
      i++
      skipIdent()
    } else if (c === '.') {
      spec[1]++
      i++
      skipIdent()
    } else if (c === '[') {
      spec[1]++
      while (i < sel.length && sel[i] !== ']') i++
      i++
    } else if (c === ':') {
      if (sel[i + 1] === ':') {
        spec[2]++
        i += 2
      } else {
        spec[1]++
        i++
      }
      skipIdent()
      skipParens()
    } else if (c === '*') {
      i++
    } else if (isIdent(c)) {
      spec[2]++
      skipIdent()
    } else {
      i++
    }
  }
  return spec
}

const CAP: Spec = [0, 1, 0]
const above = (a: Spec, b: Spec) =>
  a[0] !== b[0] ? a[0] > b[0] : a[1] !== b[1] ? a[1] > b[1] : a[2] > b[2]
const show = (s: Spec) => `(${s[0]},${s[1]},${s[2]})`

// --- the guard --------------------------------------------------------------------------------------

describe('the cascade contract: no core rule out-specifies a seller', () => {
  const graded: { sheet: string; selector: string; spec: Spec }[] = []

  beforeAll(async () => {
    for (const [sheet, css] of Object.entries(await injectedSheets()))
      for (const selector of selectorsOf(css))
        if (!graded.some((g) => g.sheet === sheet && g.selector === selector))
          graded.push({ sheet, selector, spec: specificity(selector) })
  })

  const exempt = (sheet: string, selector: string) =>
    EXCEPTIONS.some((e) => e.sheet === sheet && e.selector === selector)

  it('reads a non-trivial number of selectors out of the sheets it knows by name', () => {
    // A reader that silently returned nothing would pass every assertion below. The token block is a
    // single `:root` rule by construction, so it is graded against 1 rather than against the
    // component sheet's bar.
    expect(
      graded.filter((g) => g.sheet === 'the design-token block').length,
      'the design-token block',
    ).toBe(1)
    expect(
      graded.filter((g) => g.sheet === 'baseThemeCss').length,
      'baseThemeCss',
    ).toBeGreaterThan(2)
  })

  it('computes specificity the way the spec does', () => {
    // The instrument, checked against answers that are known independently of it.
    expect(specificity('.product .info')).toEqual([0, 2, 0])
    expect(specificity(':where(.product) .info')).toEqual([0, 1, 0])
    expect(specificity('.row.total')).toEqual([0, 2, 0])
    expect(specificity('.row:where(.total)')).toEqual([0, 1, 0])
    expect(specificity('button[disabled]')).toEqual([0, 1, 1])
    expect(specificity('button:where([disabled])')).toEqual([0, 0, 1])
    expect(specificity('.product .info strong')).toEqual([0, 2, 1])
    expect(specificity(':where(.product .info) strong')).toEqual([0, 0, 1])
    expect(specificity('.product + .product')).toEqual([0, 2, 0])
    expect(specificity(':where(.product) + .product')).toEqual([0, 1, 0])
    expect(specificity('#claim-form input')).toEqual([1, 0, 1])
    expect(specificity(':where(#claim-form) input')).toEqual([0, 0, 1])
    expect(specificity('.card h1:first-child')).toEqual([0, 2, 1])
    expect(specificity('a:focus-visible')).toEqual([0, 1, 1])
    expect(specificity('p::first-line')).toEqual([0, 0, 2])
    expect(specificity(':root')).toEqual([0, 1, 0])
    expect(specificity('body')).toEqual([0, 0, 1])
    // And it refuses what it cannot compute rather than under-reporting it.
    expect(() => specificity('.a:not(.b)')).toThrow(/does not compute/)
  })

  it('holds every injected selector at or under one class', () => {
    const over = graded
      .filter((g) => above(g.spec, CAP) && !exempt(g.sheet, g.selector))
      .map((g) => `      ${g.sheet}: ${g.selector} ${show(g.spec)}`)
    expect(
      over,
      `these core rules out-specify a seller's single-class rule, so their customCss is last and ` +
        `does nothing:\n${over.join('\n')}\n`,
    ).toEqual([])
  })

  it('carries no stale exception', () => {
    const stale = EXCEPTIONS.filter(
      (e) =>
        !graded.some((g) => g.sheet === e.sheet && g.selector === e.selector),
    ).map((e) => `      ${e.sheet}: ${e.selector}`)
    expect(
      stale,
      `these exceptions name a selector their sheet no longer has - an exception nobody needs is ` +
        `an exception nobody reviewed:\n${stale.join('\n')}\n`,
    ).toEqual([])
  })

  it('states a reason for every exception', () => {
    for (const e of EXCEPTIONS)
      expect(e.why.length, `${e.sheet}: ${e.selector}`).toBeGreaterThan(40)
  })
})
