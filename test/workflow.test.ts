// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Gary Stupak

import {
  env as testEnv,
  listDurableObjectIds,
  runInDurableObject,
} from 'cloudflare:test'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { makeStep } from './helpers'
import {
  executeAccessWorkflow,
  type AccessFailedReason,
} from '../src/workflow/workflow'
import { completeClaim } from '../src/claim/claim'
import type { EventEnvelope } from '../src/events'
import type {
  NormalizedEvent,
  ProductTeamMap,
  RepoAccessConfig,
} from '../src/types'

// BASELINE - revoke reconciliation (full → revoke, partial → skip, chargeback → revoke,
// org-membership reconcile) + grant reconciliation + claim retain/retry-on-user-not-found +
// TTL-from-creation. Reconciliation reads live GitHub state and converges, so retries are no-ops.
//
// Real ENTITLEMENTS KV (cloudflare:test, isolated per test) + mocked GitHub fetch + recording sink.
// No real GitHub API. Step is faked: do() just runs the callback; sleep() records the duration.

afterEach(async () => {
  vi.restoreAllMocks()
  // Clear KV between tests (don't rely on pool storage isolation).
  const { keys } = await testEnv.ENTITLEMENTS.list()
  await Promise.all(keys.map((k) => testEnv.ENTITLEMENTS.delete(k.name)))
  // Reset claim-guard DOs so single-flight state can't leak between tests.
  for (const id of await listDurableObjectIds(testEnv.CLAIM_GUARD)) {
    await runInDurableObject(testEnv.CLAIM_GUARD.get(id), (_i, state) =>
      state.storage.deleteAll(),
    )
  }
})

// Drive / read the claim-guard DO directly (the route does this in production).
async function preAcquireGuard(adapter = 'stripe', txn = 'pi_1') {
  const ns = testEnv.CLAIM_GUARD
  await ns.get(ns.idFromName(`${adapter}:${txn}`)).acquire()
}
async function releaseGuard(adapter = 'stripe', txn = 'pi_1') {
  const ns = testEnv.CLAIM_GUARD
  await ns.get(ns.idFromName(`${adapter}:${txn}`)).release()
}
async function guardStatus(adapter = 'stripe', txn = 'pi_1') {
  const ns = testEnv.CLAIM_GUARD
  return runInDurableObject(
    ns.get(ns.idFromName(`${adapter}:${txn}`)),
    (_i, s) => s.storage.get<string>('status'),
  )
}

const PTM: ProductTeamMap = {
  stripe: {
    prod_x: {
      teams: ['kit-pro'],
      grant_mode: 'username',
      revoke_policy: { mode: 'auto_revoke', full_refund_only: true },
    },
  },
  defaults: {
    teams: [],
    grant_mode: 'claim',
    revoke_policy: { mode: 'log_only' },
  },
}

// Bindings + secrets only (GITHUB_TOKEN is a secret). Non-secret config moved to makeConfig.
function makeEnv(): CloudflareBindings {
  return {
    ...testEnv,
    GITHUB_TOKEN: 'test_token',
  } as unknown as CloudflareBindings
}

// Deployment config object passed to executeAccessWorkflow (config-as-code).
function makeConfig(ptm: ProductTeamMap = PTM): RepoAccessConfig {
  return { githubOrg: 'testorg', productTeamMap: ptm }
}

type Reply = {
  status: number
  body?: unknown
  headers?: Record<string, string>
}

function mockFetch(handler: (method: string, path: string) => Reply) {
  return vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : (input as Request).url
      const path = url.replace('https://api.github.com', '')
      const method = ((init as RequestInit)?.method ?? 'GET').toUpperCase()
      const r = handler(method, path)
      return new Response(
        r.body === undefined ? null : JSON.stringify(r.body),
        {
          status: r.status,
          headers: { 'content-type': 'application/json', ...(r.headers ?? {}) },
        },
      )
    })
}

function evt(over: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return {
    event_type: 'payment_success',
    product_id: 'prod_x',
    transaction_id: 'pi_1',
    buyer_email: null,
    github_username: 'octocat',
    is_full_refund: null,
    ...over,
  }
}

const recorder = () => {
  const events: EventEnvelope[] = []
  return { events, sink: (e: EventEnvelope) => void events.push(e) }
}
const typesOf = (events: EventEnvelope[]) => events.map((e) => e.event_type)
// The coarse, stable code carried on the first access.failed envelope (Info-1: never raw error text).
const failedReason = (
  events: EventEnvelope[],
): AccessFailedReason | undefined =>
  events.find((e) => e.event_type === 'access.failed')?.reason as
    AccessFailedReason | undefined

const GRANT_RECORD = JSON.stringify({
  github_username: 'octocat',
  org: 'testorg',
  teams: ['kit-pro'],
  product_id: 'prod_x',
  granted_at: '2026-01-01T00:00:00Z',
})

describe('AccessWorkflow - redirect alias (session_txn)', () => {
  it('payment_success with redirect_alias_id writes session_txn → transaction_id on the direct-grant path', async () => {
    const env = makeEnv()
    const config = makeConfig()
    mockFetch((m, p) => {
      if (m === 'GET' && p.includes('/memberships/')) return { status: 404 }
      if (m === 'PUT' && p.includes('/memberships/'))
        return { status: 200, body: { state: 'pending' } }
      return { status: 500 }
    })
    const { step } = makeStep()
    const { sink } = recorder()

    await executeAccessWorkflow(
      step,
      env,
      config,
      { adapter: 'stripe', event: evt({ redirect_alias_id: 'cs_direct' }) },
      sink,
    )

    expect(await env.ENTITLEMENTS.get('session_txn:stripe:cs_direct')).toBe(
      'pi_1',
    )
    // The alias outlives the grant window: ~180d TTL (GRANT_TTL_SEC), not the 30d claim TTL.
    const { keys } = await env.ENTITLEMENTS.list({
      prefix: 'session_txn:stripe:cs_direct',
    })
    const nowSec = Math.floor(Date.now() / 1000)
    const oneDay = 24 * 60 * 60
    expect(keys[0]?.expiration).toBeGreaterThan(nowSec + 179 * oneDay)
    expect(await env.ENTITLEMENTS.get('grant:stripe:pi_1')).not.toBeNull()
  })

  it('writes session_txn even when the grant falls back to claim (alias covers BOTH outcomes)', async () => {
    const env = makeEnv()
    const config = makeConfig()
    const fetchSpy = mockFetch(() => ({ status: 500 }))
    const { step } = makeStep()
    const { sink } = recorder()

    await executeAccessWorkflow(
      step,
      env,
      config,
      {
        adapter: 'stripe',
        // malformed handle → claim fallback (no GitHub calls); the alias write precedes the branch.
        event: evt({
          github_username: 'double--hyphen',
          redirect_alias_id: 'cs_claim',
        }),
      },
      sink,
    )

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(await env.ENTITLEMENTS.get('session_txn:stripe:cs_claim')).toBe(
      'pi_1',
    )
    expect(await env.ENTITLEMENTS.get('claim_txn:stripe:pi_1')).toBeTruthy()
  })

  it('no redirect_alias_id → no session_txn written (an adapter whose redirect id IS the txn)', async () => {
    const env = makeEnv()
    const config = makeConfig()
    mockFetch((m, p) => {
      if (m === 'GET' && p.includes('/memberships/')) return { status: 404 }
      if (m === 'PUT' && p.includes('/memberships/'))
        return { status: 200, body: { state: 'pending' } }
      return { status: 500 }
    })
    const { step } = makeStep()
    const { sink } = recorder()

    await executeAccessWorkflow(
      step,
      env,
      config,
      { adapter: 'stripe', event: evt() },
      sink,
    )

    const { keys } = await env.ENTITLEMENTS.list({ prefix: 'session_txn:' })
    expect(keys).toHaveLength(0)
  })
})

describe('AccessWorkflow - grant', () => {
  it('new user → PUT invite, writes grant record, emits access.granted', async () => {
    const env = makeEnv()
    const config = makeConfig()
    const calls: string[] = []
    mockFetch((m, p) => {
      calls.push(`${m} ${p}`)
      if (m === 'GET' && p.includes('/memberships/')) return { status: 404 }
      if (m === 'PUT' && p.includes('/memberships/'))
        return { status: 200, body: { state: 'pending' } }
      return { status: 500 }
    })
    const { step } = makeStep()
    const { events, sink } = recorder()

    await executeAccessWorkflow(
      step,
      env,
      config,
      { adapter: 'stripe', event: evt() },
      sink,
    )

    expect(calls).toContain(
      'PUT /orgs/testorg/teams/kit-pro/memberships/octocat',
    )
    const record = await env.ENTITLEMENTS.get('grant:stripe:pi_1', 'json')
    expect(record).toMatchObject({
      github_username: 'octocat',
      teams: ['kit-pro'],
      product_id: 'prod_x',
      org: 'testorg',
    })
    // The grant record carries a ~180d TTL (parity with the claim-TTL assertion). Cheap
    // insurance that a future change can't silently drop the grant TTL back to no-expiry.
    const { keys } = await env.ENTITLEMENTS.list({
      prefix: 'grant:stripe:pi_1',
    })
    const nowSec = Math.floor(Date.now() / 1000)
    const oneDay = 24 * 60 * 60
    expect(keys[0]?.expiration).toBeGreaterThan(nowSec + 179 * oneDay) // ~180d, not 30d / no-TTL
    expect(keys[0]?.expiration).toBeLessThan(nowSec + 181 * oneDay)
    const granted = events.find((e) => e.event_type === 'access.granted')
    expect(granted).toMatchObject({
      github_username: 'octocat',
      teams: ['kit-pro'],
      status: 'success',
    })
  })

  it('already a member (or pending) → no PUT (reconciliation no-op)', async () => {
    const env = makeEnv()
    const config = makeConfig()
    const calls: string[] = []
    mockFetch((m, p) => {
      calls.push(`${m} ${p}`)
      if (m === 'GET' && p.includes('/memberships/'))
        return { status: 200, body: { state: 'active' } }
      return { status: 500 }
    })
    const { step } = makeStep()
    const { events, sink } = recorder()

    await executeAccessWorkflow(
      step,
      env,
      config,
      { adapter: 'stripe', event: evt() },
      sink,
    )

    expect(calls.some((c) => c.startsWith('PUT'))).toBe(false)
    expect(typesOf(events)).toContain('access.granted')
  })

  it('grant-mode Option 1: a CLAIM-mode product with a valid up-front handle grants DIRECTLY (no claim page)', async () => {
    // A present + well-formed github_username drives a direct grant in ANY mode; grant_mode
    // governs only the no-handle case. Product is `claim` mode, event carries a good handle -> direct
    // grant (NOT a claim fallback), so a worker-hosted checkout that collected the handle delivers
    // without bouncing the buyer to the claim page.
    const env = makeEnv()
    const config = makeConfig({
      stripe: { prod_x: { teams: ['kit-pro'], grant_mode: 'claim' } },
      defaults: { teams: [], grant_mode: 'claim' },
    })
    const calls: string[] = []
    mockFetch((m, p) => {
      calls.push(`${m} ${p}`)
      if (m === 'GET' && p.includes('/memberships/')) return { status: 404 }
      if (m === 'PUT' && p.includes('/memberships/'))
        return { status: 200, body: { state: 'pending' } }
      return { status: 500 }
    })
    const { step } = makeStep()
    const { events, sink } = recorder()

    await executeAccessWorkflow(
      step,
      env,
      config,
      { adapter: 'stripe', event: evt() }, // octocat, NOT from_claim
      sink,
    )

    expect(calls).toContain(
      'PUT /orgs/testorg/teams/kit-pro/memberships/octocat',
    )
    expect(
      await env.ENTITLEMENTS.get('grant:stripe:pi_1', 'json'),
    ).toMatchObject({ github_username: 'octocat', teams: ['kit-pro'] })
    expect(typesOf(events)).toContain('access.granted')
    // No claim fallback: no token, no claim.pending.
    expect(await env.ENTITLEMENTS.get('claim_txn:stripe:pi_1')).toBeNull()
    expect(typesOf(events)).not.toContain('claim.pending')
  })

  it('grant-mode Option 1: a CLAIM-mode product with NO handle still claims (handle-less unchanged)', async () => {
    // The no-handle case is unchanged by Option 1: a claim-mode product whose event carries no handle
    // falls back to the claim page as before.
    const env = makeEnv()
    const config = makeConfig({
      stripe: { prod_x: { teams: ['kit-pro'], grant_mode: 'claim' } },
      defaults: { teams: [], grant_mode: 'claim' },
    })
    const fetchSpy = mockFetch(() => ({ status: 500 }))
    const { step } = makeStep()
    const { events, sink } = recorder()

    await executeAccessWorkflow(
      step,
      env,
      config,
      { adapter: 'stripe', event: evt({ github_username: null }) },
      sink,
    )

    expect(fetchSpy).not.toHaveBeenCalled() // no handle -> claim fallback, no GitHub calls
    expect(await env.ENTITLEMENTS.get('claim_txn:stripe:pi_1')).toBeTruthy()
    expect(typesOf(events)).toContain('claim.pending')
    expect(await env.ENTITLEMENTS.get('grant:stripe:pi_1')).toBeNull()
  })

  it('malformed username → claim fallback (claim KV + index written, claim.pending) WITH last_error, no GitHub calls', async () => {
    const env = makeEnv()
    const config = makeConfig()
    const fetchSpy = mockFetch(() => ({ status: 500 }))
    const { step } = makeStep()
    const { events, sink } = recorder()

    await executeAccessWorkflow(
      step,
      env,
      config,
      { adapter: 'stripe', event: evt({ github_username: 'double--hyphen' }) },
      sink,
    )

    expect(fetchSpy).not.toHaveBeenCalled()
    const token = await env.ENTITLEMENTS.get('claim_txn:stripe:pi_1')
    expect(token).toBeTruthy()
    const claim = (await env.ENTITLEMENTS.get(`claim:${token}`, 'json')) as {
      last_error?: string
    } | null
    expect(claim).toMatchObject({
      adapter: 'stripe',
      transaction_id: 'pi_1',
      teams: ['kit-pro'],
    })
    // The buyer TYPED something (malformed, e.g. an email) → the fallback stamps last_error so the
    // claim form EXPLAINS the re-ask (0.6.1; parity with the nonexistent-handle C1 case below).
    expect(claim?.last_error).toContain('not a valid GitHub username')
    const pending = events.find((e) => e.event_type === 'claim.pending')
    expect(pending).toMatchObject({
      claim_url: `/claim/${token}`,
      teams: ['kit-pro'],
    })
    expect(await env.ENTITLEMENTS.get('grant:stripe:pi_1')).toBeNull()
  })

  it('NO username → claim fallback stays unexplained (no last_error - nothing typed to correct)', async () => {
    const env = makeEnv()
    const config = makeConfig()
    mockFetch(() => ({ status: 500 }))
    const { step } = makeStep()
    const { sink } = recorder()

    await executeAccessWorkflow(
      step,
      env,
      config,
      { adapter: 'stripe', event: evt({ github_username: null }) },
      sink,
    )

    const token = await env.ENTITLEMENTS.get('claim_txn:stripe:pi_1')
    expect(token).toBeTruthy()
    const claim = (await env.ENTITLEMENTS.get(`claim:${token}`, 'json')) as {
      last_error?: string
    } | null
    expect(claim?.last_error).toBeUndefined()
  })

  it('well-formed but non-existent username (404 on PUT), non-claim → claim fallback (claim.pending), NO access.failed, no grant record', async () => {
    const env = makeEnv()
    const config = makeConfig()
    mockFetch((m, p) => {
      if (m === 'GET' && p.includes('/memberships/')) return { status: 404 }
      if (m === 'PUT' && p.includes('/memberships/'))
        return { status: 404, body: { message: 'Not Found' } }
      return { status: 500 }
    })
    const { step, sleeps } = makeStep()
    const { events, sink } = recorder()

    await executeAccessWorkflow(
      step,
      env,
      config,
      { adapter: 'stripe', event: evt() },
      sink,
    )

    // The buyer's up-front handle doesn't exist on GitHub → the whole grant falls back to a claim so
    // they can self-correct, instead of a terminal access.failed. The 404 lands on the first team-add,
    // so no teams were granted.
    const pending = events.find((e) => e.event_type === 'claim.pending')
    expect(pending).toMatchObject({ teams: ['kit-pro'] })
    expect(typesOf(events)).not.toContain('access.failed')
    expect(sleeps).toHaveLength(0) // the PUT 404 is terminal, not retried
    expect(await env.ENTITLEMENTS.get('grant:stripe:pi_1')).toBeNull()
  })

  it('username mode + non-existent handle (404) → mints a claim token + reverse index for self-correction', async () => {
    const env = makeEnv()
    const config = makeConfig()
    mockFetch((m, p) => {
      if (m === 'GET' && p.includes('/memberships/')) return { status: 404 }
      if (m === 'PUT' && p.includes('/memberships/'))
        return { status: 404, body: { message: 'Not Found' } }
      return { status: 500 }
    })
    const { step } = makeStep()
    const { events, sink } = recorder()

    await executeAccessWorkflow(
      step,
      env,
      config,
      { adapter: 'stripe', event: evt() },
      sink,
    )

    // A fresh single-use claim token + reverse index are written (same as the no/ malformed-username
    // fallback), so the buyer can land on the claim page and supply a valid handle.
    const token = await env.ENTITLEMENTS.get('claim_txn:stripe:pi_1')
    expect(token).toBeTruthy()
    const claim = (await env.ENTITLEMENTS.get(`claim:${token}`, 'json')) as {
      last_error?: string
    } | null
    expect(claim).toMatchObject({
      adapter: 'stripe',
      transaction_id: 'pi_1',
      teams: ['kit-pro'],
    })
    // C1: the fallback records last_error naming the bad handle, so the claim FORM explains the re-ask
    // ("we could not find <handle>") rather than silently re-prompting. (Surfacing is covered by the
    // GET /claim/:token form test in claim.test.ts.)
    expect(claim?.last_error).toContain('octocat')
    const pending = events.find((e) => e.event_type === 'claim.pending')
    expect(pending).toMatchObject({
      claim_url: `/claim/${token}`,
      teams: ['kit-pro'],
    })
    expect(typesOf(events)).not.toContain('access.failed')
  })

  it('rate-limit (429 then 404) → step.sleep backoff, then succeeds (never fails the grant)', async () => {
    const env = makeEnv()
    const config = makeConfig()
    let gets = 0
    mockFetch((m, p) => {
      if (m === 'GET' && p.includes('/memberships/')) {
        gets++
        return gets === 1
          ? { status: 429, headers: { 'retry-after': '1' } }
          : { status: 404 }
      }
      if (m === 'PUT') return { status: 200, body: { state: 'pending' } }
      return { status: 500 }
    })
    const { step, sleeps } = makeStep()
    const { events, sink } = recorder()

    await executeAccessWorkflow(
      step,
      env,
      config,
      { adapter: 'stripe', event: evt() },
      sink,
    )

    expect(sleeps).toContain(1000) // honored Retry-After: 1s
    expect(typesOf(events)).toContain('access.granted')
  })

  it('idempotency: re-delivery (run twice) → exactly one PUT (reconciliation)', async () => {
    const env = makeEnv()
    const config = makeConfig()
    let membership = 404
    let puts = 0
    mockFetch((m, p) => {
      if (m === 'GET' && p.includes('/memberships/'))
        return { status: membership }
      if (m === 'PUT') {
        puts++
        membership = 200
        return { status: 200, body: { state: 'pending' } }
      }
      return { status: 500 }
    })
    const { step } = makeStep()
    const { sink } = recorder()

    await executeAccessWorkflow(
      step,
      env,
      config,
      { adapter: 'stripe', event: evt() },
      sink,
    )
    await executeAccessWorkflow(
      step,
      env,
      config,
      { adapter: 'stripe', event: evt() },
      sink,
    )

    expect(puts).toBe(1)
  })

  it('grant dies on exhausted GitHub retries → access.failed reason grant_error, then rethrows', async () => {
    const env = makeEnv()
    const config = makeConfig()
    // team-get always 500 → ghStep exhausts MAX_GH_ATTEMPTS and throws (sleeps are no-ops here). The
    // entrypoint catch emits access.failed with the coarse grant_error code, then rethrows.
    mockFetch(() => ({ status: 500 }))
    const { step } = makeStep()
    const { events, sink } = recorder()

    await expect(
      executeAccessWorkflow(
        step,
        env,
        config,
        { adapter: 'stripe', event: evt() },
        sink,
      ),
    ).rejects.toThrow()

    expect(failedReason(events)).toBe('grant_error')
    expect(await env.ENTITLEMENTS.get('grant:stripe:pi_1')).toBeNull()
    // 0.2.5: a non-claim grant that died on exhausted retries writes a terminal-failure marker so
    // /claim/by-txn shows `failed` instead of perpetual `pending`. Value = the coarse code only.
    expect(await env.ENTITLEMENTS.get('fail:stripe:pi_1')).toBe('grant_error')
  })

  it('non-claim terminal GitHub error (team-get 403) → access.failed + fail marker, no grant/claim', async () => {
    const env = makeEnv()
    const config = makeConfig()
    // team-get returns 403 (bad token / permission) → not 200, not 404, not retried → terminalFailure
    // (github_error) on a non-claim grant.
    mockFetch(() => ({ status: 403 }))
    const { step, sleeps } = makeStep()
    const { events, sink } = recorder()

    await executeAccessWorkflow(
      step,
      env,
      config,
      { adapter: 'stripe', event: evt() },
      sink,
    )

    expect(failedReason(events)).toBe('github_error')
    expect(sleeps).toHaveLength(0) // 403 terminal, not retried
    expect(await env.ENTITLEMENTS.get('grant:stripe:pi_1')).toBeNull()
    expect(await env.ENTITLEMENTS.get('claim_txn:stripe:pi_1')).toBeNull()
    expect(await env.ENTITLEMENTS.get('fail:stripe:pi_1')).toBe('github_error')
  })
})

describe('AccessWorkflow - claim completion (from_claim)', () => {
  async function seedPendingClaim(
    env: CloudflareBindings,
    token = 'tok_seed',
    ttlSec = 120,
  ) {
    const expiresAt = Math.floor(Date.now() / 1000) + ttlSec
    await env.ENTITLEMENTS.put(
      `claim:${token}`,
      JSON.stringify({
        adapter: 'stripe',
        product_id: 'prod_claim',
        teams: ['kit-pro'],
        buyer_email: null,
        transaction_id: 'pi_1',
        expires_at: expiresAt,
      }),
      { expirationTtl: ttlSec },
    )
    await env.ENTITLEMENTS.put('claim_txn:stripe:pi_1', token, {
      expirationTtl: ttlSec,
    })
    return token
  }

  it('forces username over a claim-mode product → grant + claim.completed + CONSUMES the token', async () => {
    // Product configured as `claim` mode - without from_claim this would loop back into a claim.
    const env = makeEnv()
    const config = makeConfig({
      stripe: { prod_claim: { teams: ['kit-pro'], grant_mode: 'claim' } },
      defaults: { teams: [], grant_mode: 'claim' },
    })
    const token = await seedPendingClaim(env)
    await preAcquireGuard() // route acquired the single-flight lock before the workflow ran
    const calls: string[] = []
    mockFetch((m, p) => {
      calls.push(`${m} ${p}`)
      if (m === 'GET' && p.includes('/memberships/')) return { status: 404 }
      if (m === 'PUT' && p.includes('/memberships/'))
        return { status: 200, body: { state: 'pending' } }
      return { status: 500 }
    })
    const { step } = makeStep()
    const { events, sink } = recorder()

    await executeAccessWorkflow(
      step,
      env,
      config,
      {
        adapter: 'stripe',
        event: evt({ product_id: 'prod_claim' }),
        from_claim: true,
      },
      sink,
    )

    expect(calls).toContain(
      'PUT /orgs/testorg/teams/kit-pro/memberships/octocat',
    )
    expect(
      await env.ENTITLEMENTS.get('grant:stripe:pi_1', 'json'),
    ).toMatchObject({ github_username: 'octocat', teams: ['kit-pro'] })
    const completed = events.find((e) => e.event_type === 'claim.completed')
    expect(completed).toMatchObject({ status: 'success', teams: ['kit-pro'] })
    // Success consumes the single-use token + reverse index, and finalizes the guard (locked).
    expect(await env.ENTITLEMENTS.get(`claim:${token}`)).toBeNull()
    expect(await env.ENTITLEMENTS.get('claim_txn:stripe:pi_1')).toBeNull()
    expect(await guardStatus()).toBe('granted')
  })

  it('user-not-found (PUT 404) → access.failed, RETAINS token, stamps last_error', async () => {
    const env = makeEnv()
    const config = makeConfig({
      stripe: { prod_claim: { teams: ['kit-pro'], grant_mode: 'claim' } },
      defaults: { teams: [], grant_mode: 'claim' },
    })
    const token = await seedPendingClaim(env, 'tok_seed', 120)
    await preAcquireGuard()
    // The claim POST set the completing marker (buyer just submitted the corrected handle).
    await env.ENTITLEMENTS.put('claim_submitted:stripe:pi_1', '1', {
      expirationTtl: 300,
    })
    mockFetch((m, p) => {
      if (m === 'GET' && p.includes('/memberships/')) return { status: 404 }
      if (m === 'PUT' && p.includes('/memberships/'))
        return { status: 404, body: { message: 'Not Found' } }
      return { status: 500 }
    })
    const { step, sleeps } = makeStep()
    const { events, sink } = recorder()

    await executeAccessWorkflow(
      step,
      env,
      config,
      {
        adapter: 'stripe',
        event: evt({ product_id: 'prod_claim', github_username: 'ghost' }),
        from_claim: true,
      },
      sink,
    )

    expect(typesOf(events)).toContain('access.failed')
    // Wire reason = coarse code; a 404 login-not-found maps to invalid_username (Info-1 hardening).
    expect(failedReason(events)).toBe('invalid_username')
    expect(sleeps).toHaveLength(0) // 404 terminal, not retried
    // Token RETAINED so the buyer can correct the handle; last_error surfaced for GET.
    const claim = (await env.ENTITLEMENTS.get(`claim:${token}`, 'json')) as {
      last_error?: string
    } | null
    expect(claim?.last_error).toContain('ghost')
    expect(await env.ENTITLEMENTS.get('claim_txn:stripe:pi_1')).toBe(token)
    // Guard RELEASED so a corrected sequential resubmit can acquire. (A06)
    expect(await guardStatus()).toBe('idle')
    // Buyer-correctable → NOT terminal → NO fail marker (and /claim/by-txn 302s to the retained claim).
    expect(await env.ENTITLEMENTS.get('fail:stripe:pi_1')).toBeNull()
    // The completing marker is CLEARED so /claim/by-txn drops back to the claim form (now carrying
    // the new last_error) instead of sticking on the polling "setting up" page.
    expect(await env.ENTITLEMENTS.get('claim_submitted:stripe:pi_1')).toBeNull()

    // A10: the re-put preserved the original ~120s expiry - NOT reset to a fresh 30 days.
    const { keys } = await env.ENTITLEMENTS.list({ prefix: `claim:${token}` })
    const nowSec = Math.floor(Date.now() / 1000)
    expect(keys[0]?.expiration).toBeGreaterThan(nowSec)
    expect(keys[0]?.expiration).toBeLessThan(nowSec + 600) // well under 30d (2_592_000s)
  })

  it('non-user-not-found terminal failure (PUT 422) → access.failed + CONSUMES the token', async () => {
    const env = makeEnv()
    const config = makeConfig({
      stripe: { prod_claim: { teams: ['kit-pro'], grant_mode: 'claim' } },
      defaults: { teams: [], grant_mode: 'claim' },
    })
    const token = await seedPendingClaim(env)
    await env.ENTITLEMENTS.put('claim_submitted:stripe:pi_1', '1', {
      expirationTtl: 300,
    })
    mockFetch((m, p) => {
      if (m === 'GET' && p.includes('/memberships/')) return { status: 404 }
      if (m === 'PUT' && p.includes('/memberships/'))
        return { status: 422, body: { message: 'Validation Failed' } }
      return { status: 500 }
    })
    const { step } = makeStep()
    const { events, sink } = recorder()

    await executeAccessWorkflow(
      step,
      env,
      config,
      {
        adapter: 'stripe',
        event: evt({ product_id: 'prod_claim' }),
        from_claim: true,
      },
      sink,
    )

    expect(typesOf(events)).toContain('access.failed')
    // A 422 is an un-correctable GitHub error → coarse code github_error (Info-1 hardening).
    expect(failedReason(events)).toBe('github_error')
    expect(await env.ENTITLEMENTS.get(`claim:${token}`)).toBeNull()
    expect(await env.ENTITLEMENTS.get('claim_txn:stripe:pi_1')).toBeNull()
    // Token consumed + claim finalized → terminal → fail marker written so /claim/by-txn (claim now
    // gone) shows `failed` rather than `pending`.
    expect(await env.ENTITLEMENTS.get('fail:stripe:pi_1')).toBe('github_error')
    // The completing marker is CLEARED (it's checked before the fail marker), so by-txn resolves
    // to `failed` instead of sticking on the polling view.
    expect(await env.ENTITLEMENTS.get('claim_submitted:stripe:pi_1')).toBeNull()
  })
})

describe('AccessWorkflow - revoke', () => {
  it('full refund (auto_revoke) → remove team + cancel invite + reconcile org + delete records + access.revoked', async () => {
    const env = makeEnv()
    const config = makeConfig()
    await env.ENTITLEMENTS.put('grant:stripe:pi_1', GRANT_RECORD)
    const calls: string[] = []
    mockFetch((m, p) => {
      calls.push(`${m} ${p}`)
      if (
        m === 'DELETE' &&
        p === '/orgs/testorg/teams/kit-pro/memberships/octocat'
      )
        return { status: 204 }
      if (m === 'GET' && p === '/orgs/testorg/invitations?per_page=100&page=1')
        return { status: 200, body: [{ id: 7, login: 'octocat' }] }
      if (m === 'DELETE' && p === '/orgs/testorg/invitations/7')
        return { status: 204 }
      if (
        m === 'GET' &&
        p === '/orgs/testorg/teams/kit-pro/memberships/octocat'
      )
        return { status: 404 }
      if (m === 'DELETE' && p === '/orgs/testorg/memberships/octocat')
        return { status: 204 }
      return { status: 500 }
    })
    const { step } = makeStep()
    const { events, sink } = recorder()

    await executeAccessWorkflow(
      step,
      env,
      config,
      {
        adapter: 'stripe',
        event: evt({
          event_type: 'refund',
          is_full_refund: true,
          github_username: null,
        }),
      },
      sink,
    )

    expect(calls).toContain(
      'DELETE /orgs/testorg/teams/kit-pro/memberships/octocat',
    )
    expect(calls).toContain('DELETE /orgs/testorg/invitations/7')
    expect(calls).toContain('DELETE /orgs/testorg/memberships/octocat')
    expect(await env.ENTITLEMENTS.get('grant:stripe:pi_1')).toBeNull()
    expect(events.find((e) => e.event_type === 'access.revoked')).toMatchObject(
      {
        github_username: 'octocat',
        trigger: 'refund',
      },
    )
  })

  // A revoke that CANNOT reach GitHub must never look like one that succeeded. Before this matrix, every
  // ghStep result on the revoke path was discarded, so an expired/narrowed PAT produced the worst
  // possible shape: each call 401s, the team-check 401 reads as "not in a team" so org removal is
  // attempted too, the KV cleanup then runs (it needs no GitHub auth) and DELETES the grant record, and
  // access.revoked is emitted. The buyer keeps paid access, the record a retry would need is gone, and
  // the seller is told it worked. Each case below pins the opposite on both auth statuses.
  describe('degraded GitHub token → revoke fails loudly, changes nothing', () => {
    // Where the token can die, and what has to succeed first to reach that phase. team-del and
    // team-check share a path and differ only by method (DELETE vs GET), which is what separates them.
    const PHASES = [
      {
        phase: 'team-del',
        method: 'DELETE',
        path: '/orgs/testorg/teams/kit-pro/memberships/octocat',
      },
      {
        phase: 'invites-list',
        method: 'GET',
        path: '/orgs/testorg/invitations?per_page=100&page=1',
      },
      {
        phase: 'invite-cancel',
        method: 'DELETE',
        path: '/orgs/testorg/invitations/7',
      },
      {
        phase: 'team-check',
        method: 'GET',
        path: '/orgs/testorg/teams/kit-pro/memberships/octocat',
      },
      {
        phase: 'org-del',
        method: 'DELETE',
        path: '/orgs/testorg/memberships/octocat',
      },
    ]

    for (const { phase, method, path } of PHASES) {
      for (const status of [401, 403]) {
        it(`${status} at ${phase} → grant + claim keys INTACT, no access.revoked, access.failed(github_token_degraded), instance throws`, async () => {
          const env = makeEnv()
          const config = makeConfig()
          await env.ENTITLEMENTS.put('grant:stripe:pi_1', GRANT_RECORD)
          // A pending claim for the same purchase: the cleanup would delete BOTH of these, so their
          // survival is what proves the cleanup never ran.
          await env.ENTITLEMENTS.put('claim_txn:stripe:pi_1', 'tok_1')
          await env.ENTITLEMENTS.put('claim:tok_1', '{"adapter":"stripe"}')

          mockFetch((m, p) => {
            // The phase under test fails with the auth status; every earlier phase succeeds so the
            // revoke actually reaches it.
            if (m === method && p === path) return { status }
            if (
              m === 'DELETE' &&
              p === '/orgs/testorg/teams/kit-pro/memberships/octocat'
            )
              return { status: 204 }
            if (
              m === 'GET' &&
              p === '/orgs/testorg/invitations?per_page=100&page=1'
            )
              return { status: 200, body: [{ id: 7, login: 'octocat' }] }
            if (m === 'DELETE' && p === '/orgs/testorg/invitations/7')
              return { status: 204 }
            if (
              m === 'GET' &&
              p === '/orgs/testorg/teams/kit-pro/memberships/octocat'
            )
              return { status: 404 }
            if (m === 'DELETE' && p === '/orgs/testorg/memberships/octocat')
              return { status: 204 }
            return { status: 500 }
          })
          const { step } = makeStep()
          const { events, sink } = recorder()

          // The instance must end Errored - Errored + access.failed is the documented signature.
          await expect(
            executeAccessWorkflow(
              step,
              env,
              config,
              {
                adapter: 'stripe',
                event: evt({
                  event_type: 'refund',
                  is_full_refund: true,
                  github_username: null,
                }),
              },
              sink,
            ),
          ).rejects.toThrow(/token can no longer manage org members/)

          // The diagnostic and the retry artifact both survive.
          expect(await env.ENTITLEMENTS.get('grant:stripe:pi_1')).not.toBeNull()
          expect(
            await env.ENTITLEMENTS.get('claim_txn:stripe:pi_1'),
          ).not.toBeNull()
          expect(await env.ENTITLEMENTS.get('claim:tok_1')).not.toBeNull()

          // The seller is never told access went away when it did not.
          expect(typesOf(events)).not.toContain('access.revoked')

          // ...and IS told what broke, with what they need to finish by hand.
          expect(
            events.find((e) => e.event_type === 'access.failed'),
          ).toMatchObject({
            github_username: 'octocat',
            teams: ['kit-pro'],
            reason: 'github_token_degraded',
            trigger: 'refund',
          })
        })
      }
    }

    it('403 at team-check never reads as "not in a team" → org membership is NOT removed', async () => {
      // The over-revoke direction of the same defect, worth its own pin: an inconclusive team-check
      // used to fall through to `stillInATeam = false`, dropping org membership from a buyer who may
      // still hold other entitlements - on the strength of a read that never happened.
      const env = makeEnv()
      const config = makeConfig()
      await env.ENTITLEMENTS.put('grant:stripe:pi_1', GRANT_RECORD)
      const calls: string[] = []
      mockFetch((m, p) => {
        calls.push(`${m} ${p}`)
        if (
          m === 'DELETE' &&
          p === '/orgs/testorg/teams/kit-pro/memberships/octocat'
        )
          return { status: 204 }
        if (
          m === 'GET' &&
          p === '/orgs/testorg/invitations?per_page=100&page=1'
        )
          return { status: 200, body: [] }
        if (
          m === 'GET' &&
          p === '/orgs/testorg/teams/kit-pro/memberships/octocat'
        )
          return { status: 403 }
        return { status: 500 }
      })
      const { step } = makeStep()
      const { events, sink } = recorder()

      await expect(
        executeAccessWorkflow(
          step,
          env,
          config,
          {
            adapter: 'stripe',
            event: evt({
              event_type: 'refund',
              is_full_refund: true,
              github_username: null,
            }),
          },
          sink,
        ),
      ).rejects.toThrow()

      expect(calls).not.toContain('DELETE /orgs/testorg/memberships/octocat')
      expect(typesOf(events)).not.toContain('access.revoked')
    })
  })

  it('partial refund → no revoke (full_refund_only gate)', async () => {
    const env = makeEnv()
    const config = makeConfig()
    await env.ENTITLEMENTS.put('grant:stripe:pi_1', GRANT_RECORD)
    const fetchSpy = mockFetch(() => ({ status: 500 }))
    const { step } = makeStep()
    const { events, sink } = recorder()

    await executeAccessWorkflow(
      step,
      env,
      config,
      {
        adapter: 'stripe',
        event: evt({ event_type: 'refund', is_full_refund: false }),
      },
      sink,
    )

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(await env.ENTITLEMENTS.get('grant:stripe:pi_1')).not.toBeNull()
    expect(typesOf(events)).not.toContain('access.revoked')
  })

  it('chargeback → always revokes (is_full_refund null)', async () => {
    const env = makeEnv()
    const config = makeConfig()
    await env.ENTITLEMENTS.put('grant:stripe:pi_1', GRANT_RECORD)
    const calls: string[] = []
    mockFetch((m, p) => {
      calls.push(`${m} ${p}`)
      if (m === 'DELETE' && p.includes('/teams/kit-pro/memberships/'))
        return { status: 204 }
      if (m === 'GET' && p.includes('/invitations'))
        return { status: 200, body: [] }
      if (m === 'GET' && p.includes('/teams/kit-pro/memberships/'))
        return { status: 404 }
      if (m === 'DELETE' && p === '/orgs/testorg/memberships/octocat')
        return { status: 204 }
      return { status: 500 }
    })
    const { step } = makeStep()
    const { events, sink } = recorder()

    await executeAccessWorkflow(
      step,
      env,
      config,
      {
        adapter: 'stripe',
        event: evt({ event_type: 'chargeback', is_full_refund: null }),
      },
      sink,
    )

    expect(calls).toContain(
      'DELETE /orgs/testorg/teams/kit-pro/memberships/octocat',
    )
    expect(events.find((e) => e.event_type === 'access.revoked')).toMatchObject(
      { trigger: 'chargeback' },
    )
  })

  it('org-membership reconcile: still in ANOTHER product team → keep org membership (live re-read, not a KV scan)', async () => {
    // Two products → two distinct teams. The buyer holds both; we revoke only prod_x (kit-pro). Org
    // membership must survive because they remain in kit-extra.
    const env = makeEnv()
    const config = makeConfig({
      stripe: {
        prod_x: {
          teams: ['kit-pro'],
          revoke_policy: { mode: 'auto_revoke', full_refund_only: true },
        },
        prod_y: { teams: ['kit-extra'] },
      },
      defaults: { teams: [], revoke_policy: { mode: 'log_only' } },
    })
    await env.ENTITLEMENTS.put('grant:stripe:pi_1', GRANT_RECORD) // record teams = ['kit-pro']
    const calls: string[] = []
    mockFetch((m, p) => {
      calls.push(`${m} ${p}`)
      if (
        m === 'DELETE' &&
        p === '/orgs/testorg/teams/kit-pro/memberships/octocat'
      )
        return { status: 204 }
      if (m === 'GET' && p === '/orgs/testorg/invitations?per_page=100&page=1')
        return { status: 200, body: [] }
      // Reconcile re-read: removed from kit-pro, but STILL active in kit-extra.
      if (
        m === 'GET' &&
        p === '/orgs/testorg/teams/kit-pro/memberships/octocat'
      )
        return { status: 404 }
      if (
        m === 'GET' &&
        p === '/orgs/testorg/teams/kit-extra/memberships/octocat'
      )
        return { status: 200, body: { state: 'active' } }
      return { status: 500 }
    })
    const { step } = makeStep()
    const { events, sink } = recorder()

    await executeAccessWorkflow(
      step,
      env,
      config,
      {
        adapter: 'stripe',
        event: evt({ event_type: 'refund', is_full_refund: true }),
      },
      sink,
    )

    expect(calls).toContain(
      'DELETE /orgs/testorg/teams/kit-pro/memberships/octocat',
    )
    // Org membership reconciled away ONLY when no product team remains - here it must NOT be removed.
    expect(calls).not.toContain('DELETE /orgs/testorg/memberships/octocat')
    expect(events.find((e) => e.event_type === 'access.revoked')).toMatchObject(
      {
        trigger: 'refund',
      },
    )
  })

  it('log_only policy → no revoke', async () => {
    const env = makeEnv()
    const config = makeConfig({
      stripe: {
        prod_x: { teams: ['kit-pro'], revoke_policy: { mode: 'log_only' } },
      },
      defaults: { teams: [], revoke_policy: { mode: 'log_only' } },
    })
    await env.ENTITLEMENTS.put('grant:stripe:pi_1', GRANT_RECORD)
    const fetchSpy = mockFetch(() => ({ status: 500 }))
    const { step } = makeStep()
    const { events, sink } = recorder()

    await executeAccessWorkflow(
      step,
      env,
      config,
      {
        adapter: 'stripe',
        event: evt({ event_type: 'refund', is_full_refund: true }),
      },
      sink,
    )

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(await env.ENTITLEMENTS.get('grant:stripe:pi_1')).not.toBeNull()
    expect(typesOf(events)).not.toContain('access.revoked')
  })

  it("refund with empty event product_id → policy resolves from the GRANT RECORD's product_id (auto_revoke), so revoke FIRES (not defaults/log_only)", async () => {
    // Regression: some refund/adjustment events carry product_id='' (they reference a line-item id,
    // not a product). Resolving the revoke policy from the EVENT would fall through to `defaults`
    // (log_only) and wrongly SKIP - even though the product that was sold (prod_x, from the grant
    // record) is auto_revoke. The policy must come from record.product_id.
    const env = makeEnv() // PTM: stripe.prod_x = auto_revoke; defaults = log_only
    const config = makeConfig()
    await env.ENTITLEMENTS.put('grant:stripe:pi_1', GRANT_RECORD) // record.product_id = 'prod_x'
    const calls: string[] = []
    mockFetch((m, p) => {
      calls.push(`${m} ${p}`)
      if (
        m === 'DELETE' &&
        p === '/orgs/testorg/teams/kit-pro/memberships/octocat'
      )
        return { status: 204 }
      if (m === 'GET' && p === '/orgs/testorg/invitations?per_page=100&page=1')
        return { status: 200, body: [] }
      if (
        m === 'GET' &&
        p === '/orgs/testorg/teams/kit-pro/memberships/octocat'
      )
        return { status: 404 }
      if (m === 'DELETE' && p === '/orgs/testorg/memberships/octocat')
        return { status: 204 }
      return { status: 500 }
    })
    const { step } = makeStep()
    const { events, sink } = recorder()

    await executeAccessWorkflow(
      step,
      env,
      config,
      {
        adapter: 'stripe',
        event: evt({
          event_type: 'refund',
          is_full_refund: true,
          product_id: '', // adjustment payload has no product_id
          github_username: null,
        }),
      },
      sink,
    )

    expect(calls).toContain(
      'DELETE /orgs/testorg/teams/kit-pro/memberships/octocat',
    )
    expect(await env.ENTITLEMENTS.get('grant:stripe:pi_1')).toBeNull()
    expect(events.find((e) => e.event_type === 'access.revoked')).toMatchObject(
      { github_username: 'octocat', trigger: 'refund' },
    )
  })

  it('grant record absent → reconciliation warning, no crash, no revoke', async () => {
    const env = makeEnv()
    const config = makeConfig()
    const fetchSpy = mockFetch(() => ({ status: 500 }))
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { step } = makeStep()
    const { events, sink } = recorder()

    await executeAccessWorkflow(
      step,
      env,
      config,
      {
        adapter: 'stripe',
        event: evt({
          event_type: 'refund',
          is_full_refund: true,
          github_username: null,
        }),
      },
      sink,
    )

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(typesOf(events)).not.toContain('access.revoked')
    expect(
      logSpy.mock.calls
        .flat()
        .some((a) => String(a).includes('grant record absent')),
    ).toBe(true)
  })

  // --- refunded pending claim -----------------------------------------------
  //
  // A claim fallback writes NO grant record, so a refund used to return at the "grant record absent"
  // branch above - BEFORE the cleanup step - and the claim token stayed live for its full 30 days.
  // The buyer could redeem it after being refunded and land in the team. These pin the redeemability
  // itself (the redeem ATTEMPT), not just the KV key: deleting the index while leaving `claim:{token}`
  // would pass a key-only assertion and still grant.

  /** Redeem `token` on a fresh env whose Workflow binding is a spy - the observable outcome. */
  async function redeem(token: string, handle = 'octocat') {
    const env = {
      ...testEnv,
      ACCESS_WORKFLOW: { create: vi.fn(), createBatch: vi.fn(async () => []) },
    } as unknown as CloudflareBindings
    const result = await completeClaim(env, makeConfig(), token, handle)
    return { result, enqueue: env.ACCESS_WORKFLOW.createBatch }
  }

  /** Drive a claim fallback (no handle) and return the minted token. */
  async function mintClaim(config = makeConfig()) {
    const env = makeEnv()
    const { step } = makeStep()
    const { sink } = recorder()
    await executeAccessWorkflow(
      step,
      env,
      config,
      { adapter: 'stripe', event: evt({ github_username: null }) },
      sink,
    )
    const token = await env.ENTITLEMENTS.get('claim_txn:stripe:pi_1')
    expect(token).not.toBeNull()
    return { env, token: token as string }
  }

  it('claim fallback → full refund (auto_revoke) → the claim can no longer be REDEEMED', async () => {
    const config = makeConfig()
    const { env, token } = await mintClaim(config)
    // Liveness pre-check, then step the guard back to idle exactly as the workflow does on a
    // user-not-found - otherwise the lock this submit leaves behind would reject the redeem below
    // as `in_progress` and the test would pass without ever exercising the refund.
    expect((await redeem(token)).result.status).toBe('submitted')
    await releaseGuard()
    expect(await guardStatus()).toBe('idle')

    mockFetch(() => ({ status: 404 }))
    const { step } = makeStep()
    const { events, sink } = recorder()
    await executeAccessWorkflow(
      step,
      env,
      config,
      {
        adapter: 'stripe',
        event: evt({
          event_type: 'refund',
          is_full_refund: true,
          github_username: null,
        }),
      },
      sink,
    )

    // The observable outcome: redeeming the URL the buyer still holds must not enqueue a grant.
    const { result, enqueue } = await redeem(token)
    expect(result.status).not.toBe('submitted')
    expect(enqueue).not.toHaveBeenCalled()
    // ...and the bearer credential itself is gone, not merely unreachable.
    expect(await env.ENTITLEMENTS.get(`claim:${token}`)).toBeNull()
    expect(await env.ENTITLEMENTS.get('claim_txn:stripe:pi_1')).toBeNull()
    expect(await guardStatus()).toBe('revoked')
    expect(typesOf(events)).toContain('access.revoked')
  })

  it('claim fallback → chargeback → the claim can no longer be REDEEMED', async () => {
    const config = makeConfig()
    const { env, token } = await mintClaim(config)

    mockFetch(() => ({ status: 404 }))
    const { step } = makeStep()
    const { sink } = recorder()
    await executeAccessWorkflow(
      step,
      env,
      config,
      {
        adapter: 'stripe',
        event: evt({ event_type: 'chargeback', github_username: null }),
      },
      sink,
    )

    const { result, enqueue } = await redeem(token)
    expect(result.status).not.toBe('submitted')
    expect(enqueue).not.toHaveBeenCalled()
  })

  it('log_only + pending claim → the claim SURVIVES and still redeems (log_only means log only)', async () => {
    // A seller who chose log_only asked for a refund NOT to withdraw access. A pending claim IS the
    // access they bought, so destroying it would withdraw access behind their back - and under
    // log_only a COMPLETED claim keeps its team membership, so an uncompleted one must keep its token.
    const config = makeConfig({
      stripe: {
        prod_x: {
          teams: ['kit-pro'],
          grant_mode: 'username',
          revoke_policy: { mode: 'log_only' },
        },
      },
      defaults: { teams: [], revoke_policy: { mode: 'log_only' } },
    })
    const { env, token } = await mintClaim(config)

    const { step } = makeStep()
    const { sink } = recorder()
    await executeAccessWorkflow(
      step,
      env,
      config,
      {
        adapter: 'stripe',
        event: evt({
          event_type: 'refund',
          is_full_refund: true,
          github_username: null,
        }),
      },
      sink,
    )

    const { result, enqueue } = await redeem(token)
    expect(result.status).toBe('submitted')
    expect(enqueue).toHaveBeenCalled()
    expect(await env.ENTITLEMENTS.get(`claim:${token}`)).not.toBeNull()
  })

  it('partial refund under full_refund_only + pending claim → the claim SURVIVES (same gate as a grant)', async () => {
    const config = makeConfig() // PTM: prod_x = auto_revoke, full_refund_only
    const { env, token } = await mintClaim(config)

    const { step } = makeStep()
    const { sink } = recorder()
    await executeAccessWorkflow(
      step,
      env,
      config,
      {
        adapter: 'stripe',
        event: evt({
          event_type: 'refund',
          is_full_refund: false,
          github_username: null,
        }),
      },
      sink,
    )

    expect((await redeem(token)).result.status).toBe('submitted')
  })

  it('refund BEFORE the claim exists → the later grant neither grants nor mints a claim', async () => {
    // Ordering is not guaranteed: both are provider events. A refund that arrives first must not be
    // overtaken by the payment_success behind it, which would otherwise mint a fresh 30-day token.
    const env = makeEnv()
    const config = makeConfig()
    const { step } = makeStep()
    const { events, sink } = recorder()

    mockFetch(() => ({ status: 404 }))
    await executeAccessWorkflow(
      step,
      env,
      config,
      {
        adapter: 'stripe',
        event: evt({
          event_type: 'refund',
          is_full_refund: true,
          github_username: null,
        }),
      },
      sink,
    )
    await executeAccessWorkflow(
      step,
      env,
      config,
      { adapter: 'stripe', event: evt({ github_username: null }) },
      sink,
    )

    expect(await env.ENTITLEMENTS.get('claim_txn:stripe:pi_1')).toBeNull()
    expect(await env.ENTITLEMENTS.get('grant:stripe:pi_1')).toBeNull()
    expect(typesOf(events)).not.toContain('claim.pending')
    expect(typesOf(events)).not.toContain('access.granted')
  })

  it('refund while a submit is IN FLIGHT (guard held, grant not yet written) → the grant is refused', async () => {
    // The race: completeClaim acquired the guard and enqueued, the grant record does not exist yet,
    // and the refund lands in between. `revoked` wins from `processing`, so the already-enqueued grant
    // must abort rather than complete into a refunded transaction.
    const config = makeConfig()
    const { env, token } = await mintClaim(config)

    // Buyer submits: guard → processing, grant enqueued, grant record NOT yet written.
    expect((await redeem(token)).result.status).toBe('submitted')
    expect(await guardStatus()).toBe('processing')

    mockFetch(() => ({ status: 404 }))
    const { step } = makeStep()
    const { sink } = recorder()
    await executeAccessWorkflow(
      step,
      env,
      config,
      {
        adapter: 'stripe',
        event: evt({
          event_type: 'refund',
          is_full_refund: true,
          github_username: null,
        }),
      },
      sink,
    )
    expect(await guardStatus()).toBe('revoked')

    // Now the enqueued claim-completion grant runs. It must not grant.
    const calls: string[] = []
    mockFetch((m, p) => {
      calls.push(`${m} ${p}`)
      return { status: 404 }
    })
    const { step: step2 } = makeStep()
    const { events, sink: sink2 } = recorder()
    await executeAccessWorkflow(
      step2,
      env,
      config,
      {
        adapter: 'stripe',
        event: evt({ github_username: 'octocat' }),
        from_claim: true,
      },
      sink2,
    )

    expect(calls.filter((c) => c.startsWith('PUT'))).toEqual([])
    expect(await env.ENTITLEMENTS.get('grant:stripe:pi_1')).toBeNull()
    expect(typesOf(events)).not.toContain('access.granted')
  })

  // A full first page of OTHER users' invitations (100 = INVITE_PAGE_SIZE, so the loop pages on).
  const fullPageOfOthers = Array.from({ length: 100 }, (_, i) => ({
    id: 1000 + i,
    login: `other-${i}`,
  }))

  it('invitation on PAGE 2 is found and cancelled (pagination past the 100/page cap)', async () => {
    // >100 pending invites: the buyer's invitation sits on page 2. Revoke must paginate to find it,
    // or a refunded buyer could still accept it. "A refund revokes access" has to hold at volume.
    const env = makeEnv()
    const config = makeConfig()
    await env.ENTITLEMENTS.put('grant:stripe:pi_1', GRANT_RECORD)
    const calls: string[] = []
    mockFetch((m, p) => {
      calls.push(`${m} ${p}`)
      if (
        m === 'DELETE' &&
        p === '/orgs/testorg/teams/kit-pro/memberships/octocat'
      )
        return { status: 204 }
      if (m === 'GET' && p === '/orgs/testorg/invitations?per_page=100&page=1')
        return { status: 200, body: fullPageOfOthers } // full page → keep paging
      if (m === 'GET' && p === '/orgs/testorg/invitations?per_page=100&page=2')
        return { status: 200, body: [{ id: 42, login: 'octocat' }] } // the buyer's invite
      if (m === 'DELETE' && p === '/orgs/testorg/invitations/42')
        return { status: 204 }
      if (
        m === 'GET' &&
        p === '/orgs/testorg/teams/kit-pro/memberships/octocat'
      )
        return { status: 404 }
      if (m === 'DELETE' && p === '/orgs/testorg/memberships/octocat')
        return { status: 204 }
      return { status: 500 }
    })
    const { step } = makeStep()
    const { events, sink } = recorder()

    await executeAccessWorkflow(
      step,
      env,
      config,
      {
        adapter: 'stripe',
        event: evt({
          event_type: 'refund',
          is_full_refund: true,
          github_username: null,
        }),
      },
      sink,
    )

    // Both pages were fetched and the page-2 invite was cancelled.
    expect(calls).toContain('GET /orgs/testorg/invitations?per_page=100&page=1')
    expect(calls).toContain('GET /orgs/testorg/invitations?per_page=100&page=2')
    expect(calls).toContain('DELETE /orgs/testorg/invitations/42')
    // Found on page 2 → stop paging (no wasted page-3 fetch).
    expect(calls).not.toContain(
      'GET /orgs/testorg/invitations?per_page=100&page=3',
    )
    expect(events.find((e) => e.event_type === 'access.revoked')).toMatchObject(
      {
        github_username: 'octocat',
        trigger: 'refund',
      },
    )
  })

  it('org with NO pending invites still revokes cleanly (short first page → stop paging)', async () => {
    const env = makeEnv()
    const config = makeConfig()
    await env.ENTITLEMENTS.put('grant:stripe:pi_1', GRANT_RECORD)
    const calls: string[] = []
    mockFetch((m, p) => {
      calls.push(`${m} ${p}`)
      if (
        m === 'DELETE' &&
        p === '/orgs/testorg/teams/kit-pro/memberships/octocat'
      )
        return { status: 204 }
      if (m === 'GET' && p === '/orgs/testorg/invitations?per_page=100&page=1')
        return { status: 200, body: [] } // short page → last page, nobody to cancel
      if (
        m === 'GET' &&
        p === '/orgs/testorg/teams/kit-pro/memberships/octocat'
      )
        return { status: 404 }
      if (m === 'DELETE' && p === '/orgs/testorg/memberships/octocat')
        return { status: 204 }
      return { status: 500 }
    })
    const { step } = makeStep()
    const { events, sink } = recorder()

    await executeAccessWorkflow(
      step,
      env,
      config,
      {
        adapter: 'stripe',
        event: evt({
          event_type: 'refund',
          is_full_refund: true,
          github_username: null,
        }),
      },
      sink,
    )

    // Only page 1 fetched (empty → last page), no invite cancel, revoke still completes.
    expect(calls).toContain('GET /orgs/testorg/invitations?per_page=100&page=1')
    expect(calls).not.toContain(
      'GET /orgs/testorg/invitations?per_page=100&page=2',
    )
    expect(
      calls.some((c) => c.startsWith('DELETE /orgs/testorg/invitations/')),
    ).toBe(false)
    expect(await env.ENTITLEMENTS.get('grant:stripe:pi_1')).toBeNull()
    expect(events.find((e) => e.event_type === 'access.revoked')).toMatchObject(
      {
        trigger: 'refund',
      },
    )
  })

  it('paginated revoke is idempotent on a Workflow retry (second run converges, no error)', async () => {
    const env = makeEnv()
    const config = makeConfig()
    await env.ENTITLEMENTS.put('grant:stripe:pi_1', GRANT_RECORD)
    // Page 2 holds the invite on the first run; a retry re-reads live state (team gone → 404, invite
    // already cancelled → 404) and must still converge. DELETE is idempotent (204 or 404 both fine).
    let inviteCancelled = false
    mockFetch((m, p) => {
      if (
        m === 'DELETE' &&
        p === '/orgs/testorg/teams/kit-pro/memberships/octocat'
      )
        return { status: 204 }
      if (m === 'GET' && p === '/orgs/testorg/invitations?per_page=100&page=1')
        return { status: 200, body: fullPageOfOthers }
      if (m === 'GET' && p === '/orgs/testorg/invitations?per_page=100&page=2')
        return {
          status: 200,
          body: inviteCancelled ? [] : [{ id: 42, login: 'octocat' }],
        }
      if (m === 'DELETE' && p === '/orgs/testorg/invitations/42') {
        inviteCancelled = true
        return { status: 204 }
      }
      if (
        m === 'GET' &&
        p === '/orgs/testorg/teams/kit-pro/memberships/octocat'
      )
        return { status: 404 }
      if (m === 'DELETE' && p === '/orgs/testorg/memberships/octocat')
        return { status: 204 }
      return { status: 500 }
    })
    const { step } = makeStep()

    const run = () => {
      const { events, sink } = recorder()
      return executeAccessWorkflow(
        step,
        env,
        config,
        {
          adapter: 'stripe',
          event: evt({
            event_type: 'refund',
            is_full_refund: true,
            github_username: null,
          }),
        },
        sink,
      ).then(() => events)
    }

    const first = await run()
    expect(first.find((e) => e.event_type === 'access.revoked')).toBeDefined()

    // Model a durable retry: the grant-read step is replayed (record still present), and GitHub state is
    // already converged (team removed → 404, the page-2 invite already cancelled → page 2 now empty). The
    // paginated path must re-run cleanly - deterministic per-page step ids, idempotent DELETEs - and still
    // emit access.revoked, never access.failed or a double-cancel.
    await env.ENTITLEMENTS.put('grant:stripe:pi_1', GRANT_RECORD)
    const second = await run()
    expect(second.find((e) => e.event_type === 'access.revoked')).toBeDefined()
    expect(second.some((e) => e.event_type === 'access.failed')).toBe(false)
  })
})

// A stored record that is not valid JSON. The grant and claim reads hand back the stored TEXT and parse
// it outside the durable step, so the parse throws in the workflow body rather than inside the step.
// These pin the terminal outcome of that: the error reaches the same terminal catch, is logged there and
// re-thrown to fail the instance, no event is emitted on a revoke, no GitHub call is made, and every
// stored record is left exactly as it was. A malformed record is a permanent condition, so the only thing
// that ever differed was the wasted step retries before this same end state.
describe('AccessWorkflow - a malformed stored record fails terminally', () => {
  const refund = () =>
    evt({ event_type: 'refund', is_full_refund: true, github_username: null })

  const terminalFailures = (logSpy: {
    mock: { calls: unknown[][] }
  }): Record<string, unknown>[] =>
    logSpy.mock.calls
      .map((call) => JSON.parse(String(call[0])) as Record<string, unknown>)
      .filter((entry) => entry.msg === 'workflow terminal failure')

  it('malformed grant record → terminal catch, re-thrown, no event, no GitHub call, record untouched', async () => {
    const env = makeEnv()
    await env.ENTITLEMENTS.put('grant:stripe:pi_1', '{not json')
    const fetchSpy = mockFetch(() => ({ status: 500 }))
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { step } = makeStep()
    const { events, sink } = recorder()

    await expect(
      executeAccessWorkflow(
        step,
        env,
        makeConfig(),
        { adapter: 'stripe', event: refund() },
        sink,
      ),
    ).rejects.toThrow(SyntaxError)

    // It reached the TERMINAL catch, which is the whole point - not some earlier branch that swallowed it.
    const failures = terminalFailures(logSpy)
    expect(failures).toHaveLength(1)
    expect(failures[0]).toMatchObject({
      transaction_id: 'pi_1',
      event_type: 'refund',
    })
    // A revoke emits nothing from that catch (access.failed is the payment_success arm only).
    expect(typesOf(events)).toEqual([])
    expect(fetchSpy).not.toHaveBeenCalled()
    // Nothing was withdrawn and nothing was deleted: the malformed record is still exactly as stored.
    expect(await env.ENTITLEMENTS.get('grant:stripe:pi_1')).toBe('{not json')
  })

  it('malformed claim record → terminal catch, re-thrown, no event, claim + index left in place', async () => {
    const env = makeEnv()
    // No grant record, so the revoke takes the pending-claim path: the index resolves, then the claim
    // record itself fails to parse.
    await env.ENTITLEMENTS.put('claim_txn:stripe:pi_1', 'tok_malformed')
    await env.ENTITLEMENTS.put('claim:tok_malformed', '{not json')
    const fetchSpy = mockFetch(() => ({ status: 500 }))
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { step } = makeStep()
    const { events, sink } = recorder()

    await expect(
      executeAccessWorkflow(
        step,
        env,
        makeConfig(),
        { adapter: 'stripe', event: refund() },
        sink,
      ),
    ).rejects.toThrow(SyntaxError)

    expect(terminalFailures(logSpy)).toHaveLength(1)
    expect(typesOf(events)).toEqual([])
    expect(fetchSpy).not.toHaveBeenCalled()
    // The token is a live bearer credential and this run did NOT decide anything about it, so it must
    // still be here for the retry that can.
    expect(await env.ENTITLEMENTS.get('claim:tok_malformed')).toBe('{not json')
    expect(await env.ENTITLEMENTS.get('claim_txn:stripe:pi_1')).toBe(
      'tok_malformed',
    )
  })
})
