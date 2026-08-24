// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Gary Stupak

import {
  env as testEnv,
  listDurableObjectIds,
  runInDurableObject,
} from 'cloudflare:test'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createWorker } from '../src/create-worker'
import { resolveByTxn, completeClaim } from '../src/claim/claim'
import { isValidGithubUsername } from '../src/username'
import type { PaymentAdapter, RepoAccessConfig } from '../src/types'

// BASELINE - claim lifecycle (GET form/JSON-no-PII, POST enqueue, single-flight 409, dedup,
// corrected-handle re-run). Retain/retry-on-user-not-found + TTL-from-creation live in
// workflow.test.ts (they're workflow-terminal-step behavior).
//
// Real ENTITLEMENTS KV + real CLAIM_GUARD Durable Object (cloudflare:test, isolated) + mocked Workflow
// binding. No adapters needed - the claim routes don't touch the adapter list.

afterEach(async () => {
  vi.restoreAllMocks()
  const { keys } = await testEnv.ENTITLEMENTS.list()
  await Promise.all(keys.map((k) => testEnv.ENTITLEMENTS.delete(k.name)))
  // Reset every claim-guard DO so single-flight state can't leak between tests.
  for (const id of await listDurableObjectIds(testEnv.CLAIM_GUARD)) {
    await runInDurableObject(testEnv.CLAIM_GUARD.get(id), (_i, state) =>
      state.storage.deleteAll(),
    )
  }
})

// Simulate the workflow releasing the single-flight lock after a user-not-found (so a corrected
// sequential resubmit can acquire). The route test mocks the workflow, so we step it manually.
async function releaseGuard(adapter = 'stub', txn = 'txn_1') {
  const ns = testEnv.CLAIM_GUARD
  await ns.get(ns.idFromName(`${adapter}:${txn}`)).release()
}

// The claim's single-flight state, read straight off the Durable Object: `idle` means no submission
// has ever acquired it. (Asking the namespace which ids EXIST would not do - an id lingers in that
// list once any test has touched it, so it reports the isolate's history, not this claim's state.)
async function guardStatus(adapter = 'stub', txn = 'txn_1') {
  const ns = testEnv.CLAIM_GUARD
  return ns.get(ns.idFromName(`${adapter}:${txn}`)).status()
}

function makeEnv(
  over: Partial<Record<string, unknown>> = {},
): CloudflareBindings {
  return {
    ...testEnv,
    ACCESS_WORKFLOW: { create: vi.fn(), createBatch: vi.fn(async () => []) },
    ...over,
  } as unknown as CloudflareBindings
}

// Config-as-code: claim-page branding now comes from config, not env vars. The seller
// brand "Acme Kits" exercises the no-hard-coded-EdgeKits path.
function makeConfig(over: Partial<RepoAccessConfig> = {}): RepoAccessConfig {
  return {
    githubOrg: 'testorg',
    productTeamMap: { defaults: { teams: [] } },
    branding: { name: 'Acme Kits' },
    ...over,
  }
}

const PENDING = {
  adapter: 'stub',
  product_id: 'prod_x',
  teams: ['kit-pro'],
  buyer_email: 'buyer@example.com',
  transaction_id: 'txn_1',
}

async function seedClaim(env: CloudflareBindings, token = 'tok_abc') {
  await env.ENTITLEMENTS.put(`claim:${token}`, JSON.stringify(PENDING), {
    expirationTtl: 60,
  })
  await env.ENTITLEMENTS.put('claim_txn:stub:txn_1', token, {
    expirationTtl: 60,
  })
  return token
}

const form = (body: string): RequestInit => ({
  method: 'POST',
  body,
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
})

// The browser claim is TWO submissions: the first renders the confirm screen, and only a submission
// carrying `confirmed=1` reaches the grant. A test about the grant path sends what the confirm
// screen's own form sends - the handle plus the hidden marker - rather than re-walking the screen.
// Tests about the screen itself are in `POST /claim/:token (confirmation step)` below.
const confirmed = (handle: string): RequestInit =>
  form(`github_username=${handle}&confirmed=1`)

const batchCalls = (env: CloudflareBindings) =>
  (env.ACCESS_WORKFLOW.createBatch as ReturnType<typeof vi.fn>).mock.calls

describe('claim/delivery security headers (harden)', () => {
  // Every claim/delivery response - form, 404, by-txn pending, redirect - must carry the full hardening
  // set: token out of Referer + shared caches, no content-type sniffing, and no framing (clickjacking).
  const expectHardened = (res: Response) => {
    expect(res.headers.get('referrer-policy')).toBe('no-referrer')
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('x-frame-options')).toBe('DENY')
  }

  it('GET /claim/:token (form, 200) is hardened', async () => {
    const env = makeEnv()
    const token = await seedClaim(env)
    const app = createWorker({ adapters: [], config: makeConfig() })
    expectHardened(await app.request(`/claim/${token}`, {}, env))
  })

  it('GET /claim/:token (unknown token, 404) is hardened', async () => {
    const env = makeEnv()
    const app = createWorker({ adapters: [], config: makeConfig() })
    expectHardened(await app.request('/claim/nope', {}, env))
  })

  it('GET /claim/by-txn (pending, 200) is hardened', async () => {
    const env = makeEnv()
    const app = createWorker({ adapters: [stubAdapter], config: makeConfig() })
    expectHardened(await app.request('/claim/by-txn/stub/txn_none', {}, env))
  })

  it('POST /claim/:token (303 redirect) is hardened', async () => {
    const env = makeEnv()
    const token = await seedClaim(env)
    const app = createWorker({ adapters: [], config: makeConfig() })
    const res = await app.request(`/claim/${token}`, confirmed('octocat'), env)
    expect(res.status).toBe(303)
    expectHardened(res)
  })
})

describe('GET /claim/:token', () => {
  it('unknown/expired token → 404 (KV-backed, neutral page)', async () => {
    const env = makeEnv()
    const app = createWorker({ adapters: [], config: makeConfig() })
    const res = await app.request('/claim/nope', {}, env)
    expect(res.status).toBe(404)
    // The rendered page, not just the status: a route that stopped existing would ALSO 404, and a bare
    // status assertion cannot tell that apart from the token lookup missing - which is the actual claim.
    expect(await res.text()).toContain(
      'This claim link is invalid or no longer active',
    )
  })

  it('valid token → 200 HTML form with the seller brand + username field', async () => {
    const env = makeEnv()
    const token = await seedClaim(env)
    const app = createWorker({ adapters: [], config: makeConfig() })
    const res = await app.request(`/claim/${token}`, {}, env)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    const html = await res.text()
    expect(html).toContain('Acme Kits') // seller branding, not hard-coded EdgeKits
    expect(html).toContain('name="github_username"')
    expect(html).toContain(`/claim/${token}`)
  })

  it('the form resets the by-txn poll budget on submit (fresh wait episode -> fresh budget)', async () => {
    // The by-txn poll cap is a per-path sessionStorage counter; every submit redirects to the SAME
    // by-txn path, so without the reset it accumulates across the whole flow (initial pending + each
    // submit/retry) and trips "taking longer" on a SUCCESSFUL grant (0.6.1). The submit script must
    // clear this claim's exact by-txn key before the form submits.
    const env = makeEnv()
    const token = await seedClaim(env)
    const app = createWorker({ adapters: [], config: makeConfig() })
    const res = await app.request(`/claim/${token}`, {}, env)
    const html = await res.text()
    expect(html).toContain(
      `sessionStorage.removeItem('repoaccess_bytxn:' + "/claim/by-txn/stub/txn_1")`,
    )
  })

  it('valid token + Accept JSON → 200 JSON projection (no buyer_email)', async () => {
    const env = makeEnv()
    const token = await seedClaim(env)
    const app = createWorker({ adapters: [], config: makeConfig() })
    const res = await app.request(
      `/claim/${token}`,
      { headers: { accept: 'application/json' } },
      env,
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      adapter: 'stub',
      product_id: 'prod_x',
      teams: ['kit-pro'],
      last_error: null,
    })
  })

  it('drops an unsafe branding logo/favicon URL (scheme allowlist) - brand-name text fallback, no favicon link', async () => {
    const env = makeEnv()
    const token = await seedClaim(env)
    const app = createWorker({
      adapters: [],
      config: makeConfig({
        branding: {
          name: 'Acme Kits',
          logoUrl: 'javascript:alert(1)',
          faviconUrl: 'data:image/x-icon;base64,AAAA',
        },
      }),
    })
    const res = await app.request(`/claim/${token}`, {}, env)
    expect(res.status).toBe(200)
    const html = await res.text()
    // Unsafe URLs never reach an href/src; the template falls back to the brand-name text + no favicon.
    expect(html).not.toContain('javascript:alert(1)')
    expect(html).not.toContain('data:image/x-icon')
    expect(html).not.toContain('rel="icon"')
    expect(html).toContain('Acme Kits')
  })

  it('a branding URL may be http or RELATIVE, not https alone - both reach the rendered page', async () => {
    // The scheme allowlist is an allowlist of SCHEMES, not an https rule: `safeUrl` permits http, https
    // and relative, and drops only a dangerous scheme. That distinction is what the setup guide promises
    // a seller ("a URL may be http, https or relative"), and it is asserted HERE, at the page, rather
    // than against `safeUrl` - a second unit assertion would restate the helper while leaving the gap
    // this test exists for. Harden the TEMPLATE to render https only and `safeUrl` stays green while the
    // seller's http logo silently disappears; that is the failure between the two instruments, and it
    // nearly shipped as a doc sentence claiming https was required.
    const env = makeEnv()
    const token = await seedClaim(env)
    const app = createWorker({
      adapters: [],
      config: makeConfig({
        branding: {
          name: 'Acme Kits',
          logoUrl: 'http://cdn.example.com/logo.png',
          faviconUrl: '/assets/favicon.ico',
        },
      }),
    })
    const res = await app.request(`/claim/${token}`, {}, env)
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('http://cdn.example.com/logo.png')
    expect(html).toContain('/assets/favicon.ico')
    expect(html).toContain('rel="icon"')
    // and neither collapsed to the brand-name text fallback that an unsafe scheme produces
    expect(html).not.toContain('class="brand"')
  })

  it('keeps a valid https branding logo + favicon', async () => {
    const env = makeEnv()
    const token = await seedClaim(env)
    const app = createWorker({
      adapters: [],
      config: makeConfig({
        branding: {
          name: 'Acme Kits',
          logoUrl: 'https://cdn.example.com/logo.png',
          faviconUrl: 'https://cdn.example.com/favicon.ico',
        },
      }),
    })
    const res = await app.request(`/claim/${token}`, {}, env)
    const html = await res.text()
    expect(html).toContain('https://cdn.example.com/logo.png')
    expect(html).toContain('https://cdn.example.com/favicon.ico')
  })

  it('a retained claim with last_error re-shows the form with the error', async () => {
    const env = makeEnv()
    const token = 'tok_err'
    await env.ENTITLEMENTS.put(
      `claim:${token}`,
      JSON.stringify({
        adapter: 'stub',
        product_id: 'prod_x',
        teams: ['kit-pro'],
        buyer_email: null,
        transaction_id: 'txn_1',
        last_error: 'GitHub user "ghost" was not found - check the spelling.',
      }),
      { expirationTtl: 60 },
    )
    const app = createWorker({ adapters: [], config: makeConfig() })
    const res = await app.request(`/claim/${token}`, {}, env)
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('was not found')
    expect(html).toContain('name="github_username"') // form re-shown for retry
  })
})

describe('claim/delivery page theming', () => {
  it('renders the shared token block + baseThemeCss, with the NEUTRAL defaults (visually equivalent to before)', async () => {
    const env = makeEnv()
    const token = await seedClaim(env)
    const app = createWorker({ adapters: [], config: makeConfig() }) // no theme -> neutral
    const html = await (await app.request(`/claim/${token}`, {}, env)).text()
    // The :root token block with the neutral light + dark defaults as light-dark() pairs.
    expect(html).toContain(':root')
    expect(html).toContain('--ra-brand: light-dark(#1f6feb, #4493f8)')
    expect(html).toContain('--ra-bg: light-dark(#f6f7f9, #0d1117)')
    expect(html).toContain('color-scheme: light dark')
    expect(html).toContain('system-ui, sans-serif')
    // The unified component sheet, written against the vars.
    expect(html).toContain('.card')
    expect(html).toContain('background: var(--ra-brand)')
    // The old standalone hard-coded stylesheet constant is gone (the look now comes from the tokens).
    expect(html).not.toContain('background: #1f6feb')
  })

  it('applies a seller theme (light + dark palettes) into the token block', async () => {
    const env = makeEnv()
    const token = await seedClaim(env)
    const app = createWorker({
      adapters: [],
      config: makeConfig({
        branding: {
          name: 'Acme Kits',
          theme: { light: { brand: '#7c3aed' }, dark: { brand: '#a78bfa' } },
        },
      }),
    })
    const html = await (await app.request(`/claim/${token}`, {}, env)).text()
    expect(html).toContain('--ra-brand: light-dark(#7c3aed, #a78bfa)')
    // Browser-driven: always the light-dark pair, never a forced mode.
    expect(html).toContain('color-scheme: light dark')
    // Untouched tokens keep the neutral defaults (both schemes).
    expect(html).toContain('--ra-text: light-dark(#111, #e6edf3)')
  })

  it('injects seller customCss but strips a </style> breakout attempt', async () => {
    const env = makeEnv()
    const token = await seedClaim(env)
    const app = createWorker({
      adapters: [],
      config: makeConfig({
        branding: {
          name: 'Acme Kits',
          customCss:
            '.card { outline: 2px solid green } </style><script>alert(1)</script>',
        },
      }),
    })
    const html = await (await app.request(`/claim/${token}`, {}, env)).text()
    // The legitimate seller rule is present...
    expect(html).toContain('.card { outline: 2px solid green }')
    // ...but the injected `</style>` is stripped, so the style element is closed exactly ONCE (its own
    // real close tag) and the `<script>` can never break out of the style context to execute.
    expect(html.match(/<\/style>/gi)?.length).toBe(1)
    expect(html).not.toContain('</style><script>')
  })
})

describe('POST /claim/:token', () => {
  it('valid username → acquires the lock, enqueues one grant under the claim_completed id, retains the token, redirects to by-txn', async () => {
    const env = makeEnv()
    const token = await seedClaim(env)
    const app = createWorker({ adapters: [], config: makeConfig() })

    const res = await app.request(`/claim/${token}`, confirmed('octocat'), env)
    // A successful submit routes the browser to the by-txn resolver (polls to granted/failed) instead
    // of the static token page (which would 404 to `invalid` once the workflow consumes the token).
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe('/claim/by-txn/stub/txn_1')

    const calls = batchCalls(env)
    expect(calls).toHaveLength(1)
    expect(calls[0][0]).toEqual([
      {
        // Handle folded into the id; distinct from stub-payment_success-txn_1.
        id: 'stub-claim_completed-txn_1-octocat',
        params: {
          adapter: 'stub',
          from_claim: true,
          event: expect.objectContaining({
            event_type: 'payment_success',
            github_username: 'octocat',
            product_id: 'prod_x',
            transaction_id: 'txn_1',
            buyer_email: 'buyer@example.com',
          }),
        },
      },
    ])

    // Token is RETAINED by the route - the workflow consumes it on success / non-user-not-found.
    expect(await env.ENTITLEMENTS.get(`claim:${token}`)).not.toBeNull()
    expect(await env.ENTITLEMENTS.get('claim_txn:stub:txn_1')).toBe(token)
  })

  it('valid username + Accept JSON → 200 { status: processing } (API path keeps JSON, no redirect)', async () => {
    const env = makeEnv()
    const token = await seedClaim(env)
    const app = createWorker({ adapters: [], config: makeConfig() })

    const res = await app.request(
      `/claim/${token}`,
      {
        method: 'POST',
        body: 'github_username=octocat',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
      },
      env,
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      status: 'processing',
      github_username: 'octocat',
    })
    // The API path is unchanged by the browser-redirect fix; still exactly one enqueue. Note the
    // body carries NO `confirmed` marker: a JSON caller is a program supplying a handle deliberately,
    // so it skips the browser's confirmation step rather than being made to fake one.
    expect(batchCalls(env)).toHaveLength(1)
  })

  it('malformed username → 400 re-prompt, no enqueue, claim untouched', async () => {
    const env = makeEnv()
    const token = await seedClaim(env)
    const app = createWorker({ adapters: [], config: makeConfig() })

    const res = await app.request(
      `/claim/${token}`,
      form('github_username=double--hyphen'),
      env,
    )
    expect(res.status).toBe(400)
    const html = await res.text()
    expect(html).toContain('valid GitHub username') // re-prompted with an error
    expect(html).toContain('name="github_username"')
    // Re-prompted, never confirmed: the confirm screen must not read back a handle the engine would
    // refuse anyway, so the format check runs BEFORE it (same rule, `isValidGithubUsername`).
    expect(html).not.toContain('Confirm your GitHub username')
    // The re-prompted form also carries the poll-budget reset (same as GET) so the eventual
    // successful submit still starts its by-txn wait with a fresh budget.
    expect(html).toContain(
      `sessionStorage.removeItem('repoaccess_bytxn:' + "/claim/by-txn/stub/txn_1")`,
    )

    expect(env.ACCESS_WORKFLOW.createBatch).not.toHaveBeenCalled()
    expect(await env.ENTITLEMENTS.get(`claim:${token}`)).not.toBeNull()
  })

  it('resubmitting the SAME handle reuses the same id (dedup backstop)', async () => {
    const env = makeEnv()
    const token = await seedClaim(env)
    const app = createWorker({ adapters: [], config: makeConfig() })

    await app.request(`/claim/${token}`, confirmed('octocat'), env)
    await releaseGuard() // workflow user-not-found would release the lock before a sequential retry
    await app.request(`/claim/${token}`, confirmed('octocat'), env)

    const calls = batchCalls(env)
    expect(calls).toHaveLength(2)
    expect(calls[0][0][0].id).toBe('stub-claim_completed-txn_1-octocat')
    expect(calls[1][0][0].id).toBe(calls[0][0][0].id) // same id → engine dedups the re-run
  })

  it('a CORRECTED handle on retry produces a DISTINCT id (so it actually re-runs)', async () => {
    const env = makeEnv()
    const token = await seedClaim(env)
    const app = createWorker({ adapters: [], config: makeConfig() })

    // First attempt with a typo'd (but format-valid) handle; workflow releases on user-not-found;
    // then a corrected one.
    await app.request(`/claim/${token}`, confirmed('octocta'), env)
    await releaseGuard()
    await app.request(`/claim/${token}`, confirmed('octocat'), env)

    const calls = batchCalls(env)
    expect(calls[0][0][0].id).toBe('stub-claim_completed-txn_1-octocta')
    expect(calls[1][0][0].id).toBe('stub-claim_completed-txn_1-octocat')
    expect(calls[1][0][0].id).not.toBe(calls[0][0][0].id)
  })

  it('A06: two concurrent DISTINCT valid handles → EXACTLY ONE enqueue (single-flight)', async () => {
    const env = makeEnv()
    const token = await seedClaim(env)
    const app = createWorker({ adapters: [], config: makeConfig() })

    const [r1, r2] = await Promise.all([
      app.request(`/claim/${token}`, confirmed('alice'), env),
      app.request(`/claim/${token}`, confirmed('bob'), env),
    ])

    // One submission wins (303 redirect to by-txn), the other is rejected in-flight (409) - never two
    // grants.
    expect([r1.status, r2.status].sort()).toEqual([303, 409])
    expect(batchCalls(env)).toHaveLength(1)
  })

  it('A06: a second submit while one is in flight is rejected (409), no second enqueue', async () => {
    const env = makeEnv()
    const token = await seedClaim(env)
    const app = createWorker({ adapters: [], config: makeConfig() })

    const first = await app.request(
      `/claim/${token}`,
      confirmed('octocat'),
      env,
    )
    const second = await app.request(`/claim/${token}`, confirmed('mona'), env)
    expect(first.status).toBe(303) // winner redirects to by-txn
    expect(second.status).toBe(409)
    expect(batchCalls(env)).toHaveLength(1)
  })

  it('POST on an unknown token → 404, no enqueue', async () => {
    const env = makeEnv()
    const app = createWorker({ adapters: [], config: makeConfig() })
    const res = await app.request(
      '/claim/nope',
      form('github_username=octocat'),
      env,
    )
    expect(res.status).toBe(404)
    // Same reason as the GET above: `not.toHaveBeenCalled()` proves nothing was enqueued, but a route
    // that no longer exists would satisfy that too. The page is what says the TOKEN was the problem.
    expect(await res.text()).toContain(
      'This claim link is invalid or no longer active',
    )
    expect(env.ACCESS_WORKFLOW.createBatch).not.toHaveBeenCalled()
  })
})

// The confirmation step. A GitHub handle has an unrecoverable failure mode - a well-formed handle
// that belongs to a REAL account which is not the buyer's grants to that stranger, consumes the
// token and leaves the buyer with no access and no retry - so the browser path reads the handle back
// before it grants, and offers a way to correct it that costs nothing.
//
// NO-JS IS THE DEFAULT HERE, NOT A VARIANT. These tests run in workerd: there is no DOM and no script
// engine, so nothing on the page can execute. `submitForm` below goes further and deletes every
// <script> element before reading the markup, then builds the next request from a <form>'s action and
// its inputs alone - which is exactly what a browser with JavaScript off does. A step that needed the
// page's script could not pass.
describe('POST /claim/:token (confirmation step)', () => {
  const noScript = (html: string) =>
    html.replace(/<script[\s\S]*?<\/script>/g, '')

  // Find the <form> carrying a given hidden marker in the scriptless markup and replay it: same
  // action, same fields, same method. Throws if the markup does not actually contain such a form -
  // so an assertion built on it cannot pass by accident.
  function submitForm(html: string, marker: string) {
    const forms = noScript(html).match(/<form\b[\s\S]*?<\/form>/g) ?? []
    const target = forms.find((f) => f.includes(`name="${marker}"`))
    if (!target) throw new Error(`no scriptless form carrying "${marker}"`)
    const action = /action="([^"]*)"/.exec(target)?.[1] ?? ''
    const fields: string[] = []
    for (const input of target.matchAll(/<input\b[^>]*>/g)) {
      const name = /name="([^"]*)"/.exec(input[0])?.[1]
      if (!name) continue
      const value = /value="([^"]*)"/.exec(input[0])?.[1] ?? ''
      fields.push(`${encodeURIComponent(name)}=${encodeURIComponent(value)}`)
    }
    return { action, init: form(fields.join('&')) }
  }

  it('a first submit renders the confirm screen: the handle read back, whose responsibility it is, and NO grant', async () => {
    const env = makeEnv()
    const token = await seedClaim(env)
    const app = createWorker({ adapters: [], config: makeConfig() })

    const res = await app.request(
      `/claim/${token}`,
      form('github_username=octocat'),
      env,
    )
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('Confirm your GitHub username')
    expect(html).toContain('octocat') // read back, so the buyer can proof-read it
    // The blunt part, which is the reason the screen exists at all.
    expect(html).toContain('to this account and to no other')
    expect(html).toContain('that is on you, not on the seller')
    expect(html).toContain('cannot be undone from this page')

    // Nothing has happened yet: no enqueue, no guard, no completing marker, token untouched.
    expect(env.ACCESS_WORKFLOW.createBatch).not.toHaveBeenCalled()
    expect(await guardStatus()).toBe('idle')
    expect(await env.ENTITLEMENTS.get('claim_submitted:stub:txn_1')).toBeNull()
    expect(await env.ENTITLEMENTS.get(`claim:${token}`)).not.toBeNull()
  })

  // ONE test on purpose, because these two are a COUPLING rather than two separate facts. The claim
  // token lives in the URL PATH, and this screen now links OUT to github.com. `Referrer-Policy:
  // no-referrer` on the response and `rel="noreferrer"` on the anchor are two halves of keeping that
  // path out of a third party's request log, and nothing else in the code ties them together: relax
  // the header later for analytics and this link quietly becomes a leak path, while a test that
  // pinned only the header would stay green while it happened. Pinning them in one place is what
  // makes the dependency visible to whoever touches either one.
  //
  // Not an overstatement of what the header buys: current browsers already default to sending only
  // the ORIGIN cross-origin, not the path. The point is that the guarantee must not DEPEND on the
  // client's default, and a claim link is very often opened in an in-app webview.
  //
  // AND THE HEADER'S REACH IS WIDER THAN THIS ANCHOR - which is the reason it can never be narrowed to
  // one. `rel="noreferrer"` covers this link alone. The header covers every request the page makes,
  // including the SELLER-CONFIGURED SUBRESOURCES: `branding.logoUrl` renders into an `<img src>` and
  // `branding.faviconUrl` into a `<link href>`, so without it a claim page fetch would carry the claim
  // URL - token in the path - to whatever CDN the seller pointed those at. That exposure is quieter
  // than the deliberate outbound link and likelier to happen, because it needs no buyer to click
  // anything. So if a future change proposes dropping the header because "the anchor already has
  // noreferrer", this is the case it misses.
  it('the profile link and no-referrer are pinned together: the token is in the path, the link goes off-site', async () => {
    const env = makeEnv()
    const token = await seedClaim(env)
    const app = createWorker({ adapters: [], config: makeConfig() })

    const res = await app.request(
      `/claim/${token}`,
      form('github_username=octocat'),
      env,
    )
    expect(res.status).toBe(200)

    // Half one: the response CARRYING the link must not send its own URL onward.
    expect(res.headers.get('referrer-policy')).toBe('no-referrer')

    // Half two: the anchor, read from the SCRIPTLESS markup - both attributes are literals in the
    // template, so no code path and no handler can render this link without them.
    const anchor = /<a\b[^>]*href="https:\/\/github\.com\/[^"]*"[^>]*>/.exec(
      noScript(await res.text()),
    )?.[0]
    expect(anchor).toBeDefined()
    expect(anchor).toContain('href="https://github.com/octocat"')
    expect(anchor).toContain('target="_blank"')
    expect(anchor).toContain('rel="noopener noreferrer"')
  })

  // The read-back and the href do NOT share a source, and this pins which one the link follows.
  // `username` is the raw string (so the buyer sees what they wrote, uncleaned); the grant runs on
  // the trimmed value. A link built from the raw string would name a different account than the one
  // being granted, which is the exact failure this screen exists to catch.
  it('the profile link names the account that will be granted, not the raw string that was typed', async () => {
    const env = makeEnv()
    const token = await seedClaim(env)
    const app = createWorker({ adapters: [], config: makeConfig() })

    const res = await app.request(
      `/claim/${token}`,
      form('github_username=%20%20octocat%20%20'),
      env,
    )
    expect(res.status).toBe(200)
    const html = await res.text()

    // The href follows the value the engine will act on.
    expect(html).toContain('href="https://github.com/octocat"')
    // And the read-back still carries the raw string, untouched by the link's needs.
    expect(html).toMatch(/name="github_username"[^>]*value="  octocat  "/)

    // The proof that "the value the engine will act on" is the same one: replaying the confirm form
    // from this very markup grants to the trimmed handle.
    const { action, init } = submitForm(html, 'confirmed')
    expect((await app.request(action, init, env)).status).toBe(303)
    expect(batchCalls(env)[0][0][0].id).toBe(
      'stub-claim_completed-txn_1-octocat',
    )
  })

  it('the confirm action grants - driven from the scriptless markup alone (no-JS route)', async () => {
    const env = makeEnv()
    const token = await seedClaim(env)
    const app = createWorker({ adapters: [], config: makeConfig() })

    const screen = await (
      await app.request(`/claim/${token}`, form('github_username=octocat'), env)
    ).text()

    // Everything the second request needs is in the markup: the marker is in a hidden input, never on
    // the button (a script that disables the submitter can drop its name/value from the entry list).
    const { action, init } = submitForm(screen, 'confirmed')
    expect(action).toBe(`/claim/${token}`)
    const res = await app.request(action, init, env)

    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe('/claim/by-txn/stub/txn_1')
    const calls = batchCalls(env)
    expect(calls).toHaveLength(1)
    expect(calls[0][0][0].id).toBe('stub-claim_completed-txn_1-octocat')
  })

  it('the way back is in the markup, returns the value to the field, and spends nothing', async () => {
    const env = makeEnv()
    const token = await seedClaim(env)
    const app = createWorker({ adapters: [], config: makeConfig() })

    const screen = await (
      await app.request(`/claim/${token}`, form('github_username=octocta'), env)
    ).text()
    expect(screen).toContain('Change the username')

    // A real submission, not history.back(): a POSTed confirm screen reached without JavaScript does
    // not necessarily return to a populated form, so "back" has to be a request the markup can make.
    const { action, init } = submitForm(screen, 'edit')
    const back = await app.request(action, init, env)

    expect(back.status).toBe(200)
    const html = await back.text()
    // The input screen again, with the typo still in the field - so the buyer fixes one character
    // instead of retyping the handle they are trying to proof-read.
    expect(html).toContain('name="github_username"')
    expect(html).toMatch(/name="github_username"[^>]*value="octocta"/)
    expect(html).not.toContain('Confirm your GitHub username')

    // Going back consumed nothing: no enqueue, no guard instance, no completing marker, and the token
    // and its reverse index are exactly as they were.
    expect(env.ACCESS_WORKFLOW.createBatch).not.toHaveBeenCalled()
    expect(await guardStatus()).toBe('idle')
    expect(await env.ENTITLEMENTS.get('claim_submitted:stub:txn_1')).toBeNull()
    expect(await env.ENTITLEMENTS.get(`claim:${token}`)).not.toBeNull()
    expect(await env.ENTITLEMENTS.get('claim_txn:stub:txn_1')).toBe(token)
  })

  it('round-tripping through the confirm screen many times leaves the token fully usable', async () => {
    const env = makeEnv()
    const token = await seedClaim(env)
    const app = createWorker({ adapters: [], config: makeConfig() })

    // Three go-arounds with three different handles, each time reading the screen and walking back.
    for (const handle of ['octocta', 'octocaat', 'octoca']) {
      const screen = await (
        await app.request(
          `/claim/${token}`,
          form(`github_username=${handle}`),
          env,
        )
      ).text()
      expect(screen).toContain('Confirm your GitHub username')
      const back = submitForm(screen, 'edit')
      const res = await app.request(back.action, back.init, env)
      expect(res.status).toBe(200)
      expect(await res.text()).toMatch(
        new RegExp(`name="github_username"[^>]*value="${handle}"`),
      )
    }
    expect(env.ACCESS_WORKFLOW.createBatch).not.toHaveBeenCalled()

    // And the corrected handle still grants - the claim was never spent by the walking.
    const screen = await (
      await app.request(`/claim/${token}`, form('github_username=octocat'), env)
    ).text()
    const go = submitForm(screen, 'confirmed')
    const res = await app.request(go.action, go.init, env)
    expect(res.status).toBe(303)
    expect(batchCalls(env)).toHaveLength(1)
    expect(batchCalls(env)[0][0][0].id).toBe(
      'stub-claim_completed-txn_1-octocat',
    )
  })

  it('the handle is read back exactly as typed, not normalized', async () => {
    const env = makeEnv()
    const token = await seedClaim(env)
    const app = createWorker({ adapters: [], config: makeConfig() })

    // GitHub handles are case-insensitive to resolve but the buyer is here to spot a TYPO, and a
    // value silently cleaned up on the way back hides the very thing they are checking.
    const res = await app.request(
      `/claim/${token}`,
      form('github_username=OctoCat-Dev'),
      env,
    )
    expect(await res.text()).toContain('OctoCat-Dev')
  })

  it('a malformed handle is re-prompted with the value kept, never confirmed', async () => {
    const env = makeEnv()
    const token = await seedClaim(env)
    const app = createWorker({ adapters: [], config: makeConfig() })

    const res = await app.request(
      `/claim/${token}`,
      form('github_username=double--hyphen'),
      env,
    )
    expect(res.status).toBe(400)
    const html = await res.text()
    expect(html).toContain('valid GitHub username')
    expect(html).toMatch(/name="github_username"[^>]*value="double--hyphen"/)
    expect(html).not.toContain('Confirm your GitHub username')
    expect(env.ACCESS_WORKFLOW.createBatch).not.toHaveBeenCalled()
  })

  it('an unknown token never reaches the confirm screen', async () => {
    const env = makeEnv()
    const app = createWorker({ adapters: [], config: makeConfig() })
    const res = await app.request(
      '/claim/nope',
      form('github_username=octocat'),
      env,
    )
    expect(res.status).toBe(404)
    const html = await res.text()
    expect(html).toContain('This claim link is invalid or no longer active')
    expect(html).not.toContain('Confirm your GitHub username')
  })

  it('the username placeholder describes what to type and can never BE a username', async () => {
    const env = makeEnv()
    const token = await seedClaim(env)
    const app = createWorker({ adapters: [], config: makeConfig() })

    const html = await (await app.request(`/claim/${token}`, {}, env)).text()
    const placeholder = /placeholder="([^"]*)"/.exec(html)?.[1]
    expect(placeholder).toBe('your GitHub username')
    // The rule, not the string: people type what a placeholder shows, and on this field a
    // concrete-looking example that happens to be a registered account hands over the purchase. A
    // value the grammar rejects cannot be acted on literally.
    expect(isValidGithubUsername(placeholder)).toBe(false)
  })
})

// Resolve-by-transaction endpoint (claim-link delivery). Re-queryable lookup the
// deployer wires their post-checkout redirect to: claim_txn:{adapter}:{txn} → token → 302 /claim/{token},
// or a neutral `pending` view (200) while the async grant workflow has not yet written claim_txn.
// Minimal stub adapter so `:adapter` resolves (the endpoint reads only the name; never verify/parse).
const stubAdapter: PaymentAdapter = {
  name: 'stub',
  verification: {
    kind: 'hmac',
    algo: 'SHA-256',
    secret: () => 'unused',
    canonical: (r) => r.bodyText,
    extract: () => ({ signature: '' }),
  },
  parse: () => null,
}

describe('GET /claim/by-txn/:adapter/:txn', () => {
  it('present claim_txn → 302 to the exact /claim/:token (no token leaked in body)', async () => {
    const env = makeEnv()
    const token = await seedClaim(env)
    const app = createWorker({ adapters: [stubAdapter], config: makeConfig() })

    const res = await app.request('/claim/by-txn/stub/txn_1', {}, env)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe(`/claim/${token}`)
  })

  it('no claim but a grant record present → 200 neutral granted view (username happy path, no detail echoed)', async () => {
    const env = makeEnv()
    // grant_mode:username happy path writes a grant: record and NO claim_txn:.
    await env.ENTITLEMENTS.put(
      'grant:stub:txn_1',
      JSON.stringify({
        github_username: 'octocat',
        org: 'testorg',
        teams: ['kit-pro'],
        product_id: 'prod_x',
        granted_at: 1,
      }),
      { expirationTtl: 60 },
    )
    const app = createWorker({ adapters: [stubAdapter], config: makeConfig() })

    const res = await app.request('/claim/by-txn/stub/txn_1', {}, env)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    const html = await res.text()
    expect(html).toContain('Access granted')
    // Existence check only - never echo the grant detail.
    expect(html).not.toContain('octocat')
    expect(html).not.toContain('kit-pro')
    expect(html).not.toContain('/claim/') // no claim token / no redirect
    // Terminal view: NO auto-poll script (the poll loop must self-terminate here).
    expect(html).not.toContain('repoaccess_bytxn')
  })

  it('no claim/grant but a terminal-failure marker present → 200 neutral failed view (no detail, no poll)', async () => {
    const env = makeEnv()
    // The workflow writes fail:{adapter}:{txn} = coarse reason on a terminal grant failure.
    await env.ENTITLEMENTS.put('fail:stub:txn_1', 'github_error', {
      expirationTtl: 60,
    })
    const app = createWorker({ adapters: [stubAdapter], config: makeConfig() })

    const res = await app.request('/claim/by-txn/stub/txn_1', {}, env)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    const html = await res.text()
    expect(html).toContain('Something went wrong')
    // Existence check only - the coarse marker value is never echoed.
    expect(html).not.toContain('github_error')
    expect(html).not.toContain('/claim/') // no token / no redirect
    // Terminal view: NO auto-poll script.
    expect(html).not.toContain('repoaccess_bytxn')
  })

  it('neither claim_txn nor grant present → 200 neutral pending view (no token, no 404), with the auto-poll script', async () => {
    const env = makeEnv()
    const app = createWorker({ adapters: [stubAdapter], config: makeConfig() })

    const res = await app.request('/claim/by-txn/stub/txn_missing', {}, env)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    const html = await res.text()
    expect(html).toContain('Setting up your access')
    // Payment-neutral copy that is HONEST about the ~60s KV miss-cache window (a successful grant can read
    // as pending for up to a minute) and names the auto-refresh - so a buyer does not panic at second 15.
    expect(html).toContain('This normally takes up to about a minute')
    expect(html).toContain('the page refreshes itself')
    // the pending state does NOT push people to support (the ~100s #bytxn-slow line owns that, later)
    expect(html).not.toContain('contact support')
    expect(html).not.toContain('/claim/') // no claim token exposed
    // The pending view (and ONLY it) carries the core auto-poll script so the page self-refreshes
    // across the ~60s KV miss-cache window; the loop self-terminates once a terminal view replaces it.
    expect(html).toContain('repoaccess_bytxn')
    expect(html).toContain('location.reload')
    // The hidden #bytxn-slow line fires only AFTER the ~100s poll cap is exceeded; it points at the
    // SELLER (not "support"), which is the correct escalation for a self-hosted deployment.
    expect(html).toContain('This is taking longer than usual')
    expect(html).toContain('contact the seller with your order details')
  })

  it('a grant marker AND a fail marker both present → grant wins (granted, not failed)', async () => {
    const env = makeEnv()
    // Resolution order is grant → completing → claim → fail → pending: a grant record must take precedence.
    await env.ENTITLEMENTS.put('grant:stub:txn_1', JSON.stringify({ x: 1 }), {
      expirationTtl: 60,
    })
    await env.ENTITLEMENTS.put('fail:stub:txn_1', 'github_error', {
      expirationTtl: 60,
    })
    const app = createWorker({ adapters: [stubAdapter], config: makeConfig() })

    const res = await app.request('/claim/by-txn/stub/txn_1', {}, env)
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('Access granted')
    expect(html).not.toContain('Something went wrong')
  })

  it('after a submit (completing marker set) → 200 pending poll page, NOT a 302 back to the form', async () => {
    // The claim-completion → delivery bounce: the token is still present right after submit, so
    // without the completing marker by-txn would 302 back to the claim form and hang. The marker makes
    // it render the polling "setting up" page that advances to granted.
    const env = makeEnv()
    const token = await seedClaim(env)
    const app = createWorker({ adapters: [stubAdapter], config: makeConfig() })

    // Submit a valid handle through the engine (writes the completing marker; retains the token).
    const submit = await completeClaim(env, makeConfig(), token, 'octocat')
    expect(submit.status).toBe('submitted')

    const res = await app.request('/claim/by-txn/stub/txn_1', {}, env)
    expect(res.status).toBe(200) // NOT 302
    const html = await res.text()
    expect(html).toContain('Setting up your access') // the polling view
    expect(html).toContain('repoaccess_bytxn') // auto-poll script present
    expect(html).not.toContain('name="github_username"') // NOT the claim form
    expect(html).not.toContain(`/claim/${token}`) // no redirect / token leak

    // Once the grant record lands (grant checked first), by-txn advances to granted.
    await env.ENTITLEMENTS.put('grant:stub:txn_1', JSON.stringify({ x: 1 }), {
      expirationTtl: 60,
    })
    const granted = await app.request('/claim/by-txn/stub/txn_1', {}, env)
    expect(granted.status).toBe(200)
    expect(await granted.text()).toContain('Access granted')
  })

  it('unknown adapter → 404 (mirrors the /wh adapter lookup)', async () => {
    const env = makeEnv()
    // Seed a claim so a present index can't be the reason for a non-404 - the adapter gate is.
    await seedClaim(env)
    const app = createWorker({ adapters: [stubAdapter], config: makeConfig() })

    const res = await app.request('/claim/by-txn/ghost/txn_1', {}, env)
    expect(res.status).toBe(404)
  })

  // Stripe-style session->txn alias: the redirect carries cs_... (!= the pi_... claim key). The
  // workflow wrote session_txn:{adapter}:{cs_} -> {pi_}; the endpoint resolves it transparently.
  it('alias present (session id) → resolves to the real-txn claim → 302 /claim/:token', async () => {
    const env = makeEnv()
    const token = await seedClaim(env) // claim_txn:stub:txn_1 -> token
    await env.ENTITLEMENTS.put('session_txn:stub:cs_1', 'txn_1', {
      expirationTtl: 60,
    })
    const app = createWorker({ adapters: [stubAdapter], config: makeConfig() })

    const res = await app.request('/claim/by-txn/stub/cs_1', {}, env)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe(`/claim/${token}`)
  })

  it('alias resolves to a grant (no claim) → 200 granted', async () => {
    const env = makeEnv()
    await env.ENTITLEMENTS.put('session_txn:stub:cs_2', 'txn_1', {
      expirationTtl: 60,
    })
    await env.ENTITLEMENTS.put(
      'grant:stub:txn_1',
      JSON.stringify({
        github_username: 'octocat',
        org: 'testorg',
        teams: ['kit-pro'],
        product_id: 'prod_x',
        granted_at: 1,
      }),
      { expirationTtl: 60 },
    )
    const app = createWorker({ adapters: [stubAdapter], config: makeConfig() })

    const res = await app.request('/claim/by-txn/stub/cs_2', {}, env)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('Access granted')
  })

  it('alias present but neither claim nor grant at the real txn → 200 pending', async () => {
    const env = makeEnv()
    await env.ENTITLEMENTS.put('session_txn:stub:cs_3', 'txn_gone', {
      expirationTtl: 60,
    })
    const app = createWorker({ adapters: [stubAdapter], config: makeConfig() })

    const res = await app.request('/claim/by-txn/stub/cs_3', {}, env)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('Setting up your access')
  })

  it('a direct transaction_id with no alias entry still resolves → 302 (mapped === null)', async () => {
    const env = makeEnv()
    const token = await seedClaim(env) // claim at txn_1, NO session_txn alias
    const app = createWorker({ adapters: [stubAdapter], config: makeConfig() })

    const res = await app.request('/claim/by-txn/stub/txn_1', {}, env)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe(`/claim/${token}`)
  })
})

// The extracted by-txn resolver is the single source of truth the HTTP surface above and
// Pro's RPC `resolveDelivery` both call. Assert its state machine + the token-leak posture directly.
describe('resolveByTxn (engine primitive)', () => {
  it('pending claim present → { state: "claim", token }', async () => {
    const env = makeEnv()
    const token = await seedClaim(env) // claim_txn:stub:txn_1 -> token
    expect(await resolveByTxn(env, 'stub', 'txn_1')).toEqual({
      state: 'claim',
      token,
    })
  })

  it('no claim but a grant record present → { state: "granted" } and NO token', async () => {
    const env = makeEnv()
    await env.ENTITLEMENTS.put(
      'grant:stub:txn_1',
      JSON.stringify({ github_username: 'octocat', teams: ['kit-pro'] }),
      { expirationTtl: 60 },
    )
    const r = await resolveByTxn(env, 'stub', 'txn_1')
    expect(r).toEqual({ state: 'granted' })
    expect(r.token).toBeUndefined()
  })

  it('no claim/grant but a fail marker present → { state: "failed" } and NO token', async () => {
    const env = makeEnv()
    await env.ENTITLEMENTS.put('fail:stub:txn_1', 'github_error', {
      expirationTtl: 60,
    })
    const r = await resolveByTxn(env, 'stub', 'txn_1')
    expect(r).toEqual({ state: 'failed' })
    expect(r.token).toBeUndefined()
  })

  it('no key present → { state: "pending" } and NO token', async () => {
    const env = makeEnv()
    const r = await resolveByTxn(env, 'stub', 'txn_missing')
    expect(r).toEqual({ state: 'pending' })
    expect(r.token).toBeUndefined()
  })

  it('resolution order: grant wins over a stale fail marker → { state: "granted" }', async () => {
    const env = makeEnv()
    await env.ENTITLEMENTS.put('grant:stub:txn_1', JSON.stringify({ x: 1 }), {
      expirationTtl: 60,
    })
    await env.ENTITLEMENTS.put('fail:stub:txn_1', 'github_error', {
      expirationTtl: 60,
    })
    expect((await resolveByTxn(env, 'stub', 'txn_1')).state).toBe('granted')
  })

  it('a completing marker present alongside the claim → { state: "pending" } (poll, do NOT 302 to the form)', async () => {
    const env = makeEnv()
    await seedClaim(env) // claim_txn:stub:txn_1 -> token (still present after submit)
    await env.ENTITLEMENTS.put('claim_submitted:stub:txn_1', '1', {
      expirationTtl: 60,
    })
    // The completing marker is checked BEFORE the claim key: a just-submitted buyer polls instead of
    // bouncing back to the still-present claim form.
    const r = await resolveByTxn(env, 'stub', 'txn_1')
    expect(r).toEqual({ state: 'pending' })
    expect(r.token).toBeUndefined()
  })

  it('grant wins over a stale completing marker → { state: "granted" }', async () => {
    const env = makeEnv()
    await env.ENTITLEMENTS.put('grant:stub:txn_1', JSON.stringify({ x: 1 }), {
      expirationTtl: 60,
    })
    await env.ENTITLEMENTS.put('claim_submitted:stub:txn_1', '1', {
      expirationTtl: 60,
    })
    // Grant is checked first, so a just-completed claim resolves to `granted` before the marker expires.
    expect((await resolveByTxn(env, 'stub', 'txn_1')).state).toBe('granted')
  })

  it('alias (session id) resolves to the real-txn claim → { state: "claim", token }', async () => {
    const env = makeEnv()
    const token = await seedClaim(env) // claim at txn_1
    await env.ENTITLEMENTS.put('session_txn:stub:cs_1', 'txn_1', {
      expirationTtl: 60,
    })
    expect(await resolveByTxn(env, 'stub', 'cs_1')).toEqual({
      state: 'claim',
      token,
    })
  })

  it('a direct transaction_id with no alias entry resolves unchanged', async () => {
    const env = makeEnv()
    const token = await seedClaim(env) // no session_txn alias
    expect(await resolveByTxn(env, 'stub', 'txn_1')).toEqual({
      state: 'claim',
      token,
    })
  })
})

// The extracted claim-completion engine that the HTTP `POST /claim/:token` route AND Pro's
// submitClaim RPC both call. Assert its four outcomes + the folded-in claim_completed id directly,
// with no HTTP layer in the way.
describe('completeClaim (engine primitive)', () => {
  it('unknown token → { status: "not_found" }, no enqueue', async () => {
    const env = makeEnv()
    const r = await completeClaim(env, makeConfig(), 'nope', 'octocat')
    expect(r).toEqual({ status: 'not_found' })
    expect(env.ACCESS_WORKFLOW.createBatch).not.toHaveBeenCalled()
  })

  it('malformed handle → { status: "invalid_handle" } (+ txn ref), no enqueue, claim untouched', async () => {
    const env = makeEnv()
    const token = await seedClaim(env)
    const r = await completeClaim(env, makeConfig(), token, 'double--hyphen')
    expect(r).toEqual({
      status: 'invalid_handle',
      adapter: 'stub',
      transactionId: 'txn_1',
    })
    expect(env.ACCESS_WORKFLOW.createBatch).not.toHaveBeenCalled()
    expect(await env.ENTITLEMENTS.get(`claim:${token}`)).not.toBeNull()
  })

  it('valid handle → { status: "submitted" } (+ txn ref), enqueues one grant under the folded-in claim_completed id, retains the token', async () => {
    const env = makeEnv()
    const token = await seedClaim(env)
    const r = await completeClaim(env, makeConfig(), token, '  octocat  ')
    // The txn ref lets the POST route redirect a submitted buyer to /claim/by-txn/<adapter>/<txn>.
    expect(r).toEqual({
      status: 'submitted',
      adapter: 'stub',
      transactionId: 'txn_1',
    })

    const calls = batchCalls(env)
    expect(calls).toHaveLength(1)
    expect(calls[0][0]).toEqual([
      {
        // Handle trimmed + folded into the id; distinct from stub-payment_success-txn_1.
        id: 'stub-claim_completed-txn_1-octocat',
        params: {
          adapter: 'stub',
          from_claim: true,
          event: expect.objectContaining({
            event_type: 'payment_success',
            github_username: 'octocat',
            product_id: 'prod_x',
            transaction_id: 'txn_1',
            buyer_email: 'buyer@example.com',
          }),
        },
      },
    ])

    // The engine never deletes the token - the workflow owns its lifecycle.
    expect(await env.ENTITLEMENTS.get(`claim:${token}`)).not.toBeNull()
    expect(await env.ENTITLEMENTS.get('claim_txn:stub:txn_1')).toBe(token)
    // A successful submit writes the completing marker so /claim/by-txn polls instead of bouncing back
    // to the still-present claim form.
    expect(await env.ENTITLEMENTS.get('claim_submitted:stub:txn_1')).toBe('1')
  })

  it('a not_found / invalid_handle / busy outcome writes NO completing marker', async () => {
    const env = makeEnv()
    const token = await seedClaim(env)

    // not_found: unknown token.
    await completeClaim(env, makeConfig(), 'nope', 'octocat')
    // invalid_handle: never enqueues, so never marks completing.
    await completeClaim(env, makeConfig(), token, 'double--hyphen')
    expect(await env.ENTITLEMENTS.get('claim_submitted:stub:txn_1')).toBeNull()

    // busy: the second concurrent submit is rejected in-flight → no second marker semantics to assert
    // beyond the first submit already having written it.
    await completeClaim(env, makeConfig(), token, 'alice') // submitted (writes marker)
    const before = await env.ENTITLEMENTS.get('claim_submitted:stub:txn_1')
    const busy = await completeClaim(env, makeConfig(), token, 'bob')
    expect(busy.status).toBe('busy')
    expect(await env.ENTITLEMENTS.get('claim_submitted:stub:txn_1')).toBe(
      before,
    )
  })

  it('a second completion while one is in flight → { status: "busy", code: "in_progress" }, no second enqueue', async () => {
    const env = makeEnv()
    const token = await seedClaim(env)

    const first = await completeClaim(env, makeConfig(), token, 'alice')
    expect(first).toEqual({
      status: 'submitted',
      adapter: 'stub',
      transactionId: 'txn_1',
    })
    // The guard is still held (the workflow would release it on user-not-found; not simulated here).
    const second = await completeClaim(env, makeConfig(), token, 'bob')
    expect(second).toEqual({
      status: 'busy',
      code: 'in_progress',
      adapter: 'stub',
      transactionId: 'txn_1',
    })
    expect(batchCalls(env)).toHaveLength(1)
  })

  it('a corrected handle after the guard is released → distinct id, re-runs', async () => {
    const env = makeEnv()
    const token = await seedClaim(env)

    await completeClaim(env, makeConfig(), token, 'octocta')
    await releaseGuard() // workflow user-not-found releases the lock before a sequential retry
    const r = await completeClaim(env, makeConfig(), token, 'octocat')
    expect(r).toEqual({
      status: 'submitted',
      adapter: 'stub',
      transactionId: 'txn_1',
    })

    const calls = batchCalls(env)
    expect(calls[0][0][0].id).toBe('stub-claim_completed-txn_1-octocta')
    expect(calls[1][0][0].id).toBe('stub-claim_completed-txn_1-octocat')
    expect(calls[1][0][0].id).not.toBe(calls[0][0][0].id)
  })
})
