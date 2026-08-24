// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Gary Stupak

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import type { ClaimView, VerificationStrategy } from '../src/lib'

// PUBLIC SURFACE GUARD.
//
// This does NOT classify a release. Major, minor or patch is a judgement about consumers and no test
// makes it. What it removes is the only failure that has actually occurred: NOBODY LOOKED. A
// `confirm` variant was added to `ClaimView` - an exported union that a documented extension point
// consumes - and the tree carried a PATCH version until a human happened to notice. This guard fails
// the moment that surface moves, so the number becomes a decision somebody takes rather than one that
// gets taken by default.
//
// It reads SOURCE TEXT rather than the loaded module, and that is the point rather than an
// implementation detail: `Object.keys(await import('../src/lib'))` reaches only VALUE exports, and
// most of this package's public surface is `export type`, which is erased before anything runs. A
// runtime name check would have watched the type contract widen and reported nothing. Source text
// sees both halves, needs no network, and stays inside the suite where this project's guards live.
//
// It lives in the `node` vitest project because it reads files from disk; workerd has no `node:fs`.

const RULE =
  'RULE: an exported type a documented extension point consumes is public API, so widening it is a MINOR release - even when nothing inside the package behaves differently.'

// The failure text is half the guard. It must never read as "a snapshot needs updating", or the list
// below gets refreshed reflexively and the whole thing becomes a formality.
function meaning(what: string): string {
  return [
    ``,
    `THE PACKAGE'S PUBLIC SURFACE CHANGED: ${what}.`,
    ``,
    `This is not a stale fixture. Re-running with the new value pasted in is exactly how this guard`,
    `stops working, because the defect it exists for was never a wrong list - it was that nobody`,
    `looked at the list at all.`,
    ``,
    RULE,
    ``,
    `So classify the change before it ships. A consumer who wrote against the previous version meets`,
    `one of two outcomes, and core supplies no fallback for either: an exhaustive switch with a`,
    `never-check FAILS TO COMPILE, or a switch with a default SILENTLY RENDERS THE WRONG SCREEN.`,
    `Neither is a patch. Decide the version number, then update this file in the same commit.`,
    ``,
  ].join('\n')
}

// Resolved from this file rather than from the process cwd, so the guard reads the same sources
// however the suite is invoked.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (path: string) => readFileSync(join(REPO_ROOT, path), 'utf8')

/**
 * Every name `src/lib.ts` exports, values and types alike, in source order-independent sorted form.
 *
 * Only the two brace forms are understood (`export { a } from '...'` / `export type { a } from '...'`),
 * which is every statement the barrel uses. Any other export form - `export *` above all, which would
 * widen the surface invisibly - is rejected rather than silently under-counted, because a parser that
 * quietly misses an export is worse than no parser.
 */
function barrelExports(source: string): string[] {
  // Deliberately requires the braces: an `export * from '…'` must NOT be understood, so that it
  // shows up as an unparsed statement in the count check below rather than being silently skipped.
  const statements =
    source.match(/^export (?:type )?\{[\s\S]*?\} from '[^']+'/gm) ?? []
  const declared = source.match(/^export\b/gm)?.length ?? 0
  expect(
    statements.length,
    `src/lib.ts uses an export form this guard does not parse (${declared} export statements, ${statements.length} understood). ` +
      `Only \`export { … } from '…'\` and \`export type { … } from '…'\` are supported; \`export *\` in particular would widen the ` +
      `public surface without this guard seeing it. Teach the parser before adding the form.`,
  ).toBe(declared)

  const names: string[] = []
  for (const statement of statements) {
    // The regex above guaranteed a brace pair, so this cannot miss.
    const inner = /\{([\s\S]*?)\}/.exec(statement)![1]
    for (const name of inner.split(',')) {
      const trimmed = name.trim()
      if (trimmed) names.push(trimmed)
    }
  }
  return [...new Set(names)].sort()
}

/**
 * The `kind` literals of a `kind:`-discriminated exported union, read from the source of the file
 * that declares it. The block runs from the type's own `export type X =` to the next top-level
 * `export`, so a variant added anywhere inside it is seen.
 */
function unionKinds(source: string, typeName: string): string[] {
  const header = `export type ${typeName} =`
  const start = source.indexOf(header)
  expect(start, `no exported union named ${typeName}`).toBeGreaterThan(-1)
  const rest = source.slice(start + header.length)
  const end = rest.search(/\nexport /)
  const block = end === -1 ? rest : rest.slice(0, end)
  const kinds = [...block.matchAll(/\bkind: '([a-z_]+)'/g)].map((m) => m[1])
  expect(kinds.length, `${typeName} yielded no kind literals`).toBeGreaterThan(
    0,
  )
  return [...new Set(kinds)].sort()
}

// --- half 1: the barrel's export list ---------------------------------------

// Every name a consumer can import from `repoaccess-core`. `exports['.']` points straight at
// src/lib.ts (core ships TypeScript source, so there is no declaration artifact to diff), which is
// why this list IS the published surface rather than a proxy for it.
const PUBLIC_EXPORTS = [
  'AccessWorkflowParams',
  'apiCallbackInstanceId',
  'baseThemeCss',
  'Branding',
  'ByTxnResolution',
  'ByTxnState',
  'ClaimGuard',
  'ClaimTemplate',
  'ClaimView',
  'claimIndexKey',
  'claimKey',
  'CLAIM_TTL_SEC',
  'completeClaim',
  'CompleteClaimResult',
  'createAccessWorkflow',
  'createWorker',
  'CreateWorkerOptions',
  'defaultClaimTemplate',
  'EventWebhookConfig',
  'failKey',
  'FAIL_TTL_SEC',
  'fetchVerifiedEntity',
  'FetchEntityOptions',
  'grantKey',
  'GrantMode',
  'GrantOrigin',
  'GRANT_TTL_SEC',
  'hardenHtmlHeaders',
  'NormalizedEvent',
  'Palette',
  'PaymentAdapter',
  'ProductConfig',
  'ProductTeamMap',
  'RawRequest',
  'RepoAccessConfig',
  'resolveByTxn',
  'RevokePolicy',
  'safeUrl',
  'sanitizeCustomCss',
  'sessionTxnKey',
  'Theme',
  'themeVars',
  'VerificationStrategy',
  'VerifiedEntity',
  'workflowInstanceId',
].sort()

// --- half 2: the public discriminated unions --------------------------------

// The pinned member sets are the KEYS of these records, not a second hand-written list, and that is
// what makes them trustworthy rather than merely self-consistent: `Record<Union, true>` is checked by
// `tsc` in both directions - a variant added to the real union leaves a key MISSING here, a variant
// removed leaves an EXTRA one, and either fails `npm run typecheck`. The runtime assertions below
// then tie those keys to the source text, so the guard bites in the suite as well.
const CLAIM_VIEW_KINDS: Record<ClaimView['kind'], true> = {
  busy: true,
  confirm: true,
  failed: true,
  form: true,
  granted: true,
  invalid: true,
  pending: true,
  submitted: true,
}

const VERIFICATION_KINDS: Record<VerificationStrategy['kind'], true> = {
  api_callback: true,
  hmac: true,
  shared_secret_header: true,
}

describe('public surface', () => {
  it('src/lib.ts exports exactly the pinned set of names', () => {
    const actual = barrelExports(read('src/lib.ts'))
    const added = actual.filter((n) => !PUBLIC_EXPORTS.includes(n))
    const removed = PUBLIC_EXPORTS.filter((n) => !actual.includes(n))
    expect(
      actual,
      meaning(
        `src/lib.ts now exports ${actual.length} names instead of ${PUBLIC_EXPORTS.length}` +
          (added.length ? `; added: ${added.join(', ')}` : '') +
          (removed.length ? `; removed: ${removed.join(', ')}` : ''),
      ),
    ).toEqual(PUBLIC_EXPORTS)
  })

  // The one that would have caught the last release. A downstream template is handed a `ClaimView`
  // and switches on `kind`; core supplies no fallback for a variant it does not recognise.
  it('ClaimView carries exactly the pinned variants', () => {
    const actual = unionKinds(read('src/claim/claim-template.tsx'), 'ClaimView')
    const pinned = Object.keys(CLAIM_VIEW_KINDS).sort()
    expect(
      actual,
      meaning(`ClaimView's variants are now ${actual.join(', ')}`),
    ).toEqual(pinned)
  })

  // Same class, different consumer: an adapter author builds a `VerificationStrategy`, and anything
  // that switches on one (an engine a downstream composes, a test double) breaks the same way.
  it('VerificationStrategy carries exactly the pinned strategies', () => {
    const actual = unionKinds(read('src/types.ts'), 'VerificationStrategy')
    const pinned = Object.keys(VERIFICATION_KINDS).sort()
    expect(
      actual,
      meaning(`VerificationStrategy's strategies are now ${actual.join(', ')}`),
    ).toEqual(pinned)
  })
})

// NOT COVERED, stated so the guard's edge is known rather than assumed. It pins the NAMES on the
// barrel and the MEMBERS of two `kind:`-discriminated unions. It does not read the shape of any
// exported interface, so a field added to `RepoAccessConfig` or a parameter added to `PaymentAdapter`
// passes here; nor does it see the plain string unions (`ByTxnState`, `GrantMode`, `RevokePolicy`,
// `CompleteClaimResult['status']`), which have no `kind:` to scrape and would need their own reader.
// Those are real surface too - this guard narrows the gap, it does not close it.
