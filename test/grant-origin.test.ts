// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Gary Stupak

import {
  env as testEnv,
  listDurableObjectIds,
  runInDurableObject,
} from 'cloudflare:test'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createWorker } from '../src/create-worker'
import { executeAccessWorkflow } from '../src/workflow/workflow'
import { completeClaim } from '../src/claim/claim'
import type { EventEnvelope } from '../src/events'
import type {
  GrantOrigin,
  NormalizedEvent,
  ProductTeamMap,
  RepoAccessConfig,
} from '../src/types'
import {
  makeStep,
  mockConfig,
  mockEnv,
  signedPost,
  stubAdapter,
} from './helpers'
import {
  apiCallbackMock,
  CB_SECRET_PATH,
  pingBody,
} from './fixtures/api-callback-mock'

// PROVENANCE. A grant born from a verified provider webhook and one born from a direct call by a
// worker bound on the same account used to be indistinguishable: the grant record held the handle,
// the org, the teams, the product and the time, and said nothing about how any of it was authorized.
// A seller could not reconcile by channel, could not tell which channel produced a grant when their
// own funnel misbehaved, and had no trace of the direct-call path in an incident.
//
// What these pin, and the order matters because the first is the one that survives:
//   - THE RECORD, first. Delivery can exhaust - core logs that and carries on, by design, because
//     outbound delivery must never fail a grant - so provenance carried only on an envelope is gone
//     exactly when somebody goes looking for it.
//   - THE ENVELOPE, on every event the instance emits, so a consumer sees it without reading KV.
//   - THE WEBHOOK ROUTE SETS IT EXPLICITLY. That is what keeps core's default off the webhook path
//     entirely: the default exists for enqueues core did not make, and it should never be the thing
//     deciding what an ordinary sale is recorded as.
//   - THE CLAIM PATH CARRIES IT ACROSS THE GAP. A claim completion enqueues its OWN instance, and its
//     authorization descends from the payment rather than from the buyer typing a handle. The claim
//     record is the only artifact spanning the two - a claim fallback writes no grant record - so the
//     value rides there.

afterEach(async () => {
  vi.restoreAllMocks()
  const { keys } = await testEnv.ENTITLEMENTS.list()
  await Promise.all(keys.map((k) => testEnv.ENTITLEMENTS.delete(k.name)))
  for (const id of await listDurableObjectIds(testEnv.CLAIM_GUARD)) {
    await runInDurableObject(testEnv.CLAIM_GUARD.get(id), (_i, state) =>
      state.storage.deleteAll(),
    )
  }
})

// --- the two webhook enqueue sites ------------------------------------------

const paramsOf = (env: CloudflareBindings) =>
  (env.ACCESS_WORKFLOW.createBatch as ReturnType<typeof vi.fn>).mock
    .calls[0][0][0].params

describe('the webhook route states its own provenance', () => {
  it('a verified hmac delivery enqueues origin: webhook', async () => {
    const env = mockEnv()
    const app = createWorker({
      adapters: [stubAdapter()],
      config: mockConfig(),
    })
    const body = JSON.stringify({ transaction_id: 'pi_1' })
    const res = await app.request(
      '/wh/stub/whatever',
      await signedPost(body),
      env,
    )
    expect(res.status).toBe(200)
    expect(paramsOf(env).origin).toBe('webhook')
  })

  // An api_callback ping is not signed, but it still arrives over HTTP from the provider and its
  // secret-path credential was checked before this enqueue - so it is the same channel, not a third.
  it('a credentialed api_callback ping enqueues origin: webhook', async () => {
    const env = mockEnv()
    const app = createWorker({
      adapters: [apiCallbackMock()],
      config: mockConfig(),
    })
    const res = await app.request(
      `/wh/cbmock/${CB_SECRET_PATH}`,
      {
        method: 'POST',
        body: pingBody('sale_1'),
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      },
      env,
    )
    expect(res.status).toBe(200)
    expect(paramsOf(env).origin).toBe('webhook')
  })
})

// --- the record and the envelopes -------------------------------------------

const PTM: ProductTeamMap = {
  stripe: {
    prod_x: {
      teams: ['kit-pro'],
      grant_mode: 'username',
      revoke_policy: { mode: 'auto_revoke' },
    },
  },
  defaults: {
    teams: [],
    grant_mode: 'claim',
    revoke_policy: { mode: 'log_only' },
  },
}

function wfEnv(): CloudflareBindings {
  return {
    ...testEnv,
    GITHUB_TOKEN: 'test_token',
  } as unknown as CloudflareBindings
}
const wfConfig = (): RepoAccessConfig => ({
  githubOrg: 'testorg',
  productTeamMap: PTM,
})

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

/** Every envelope must carry the instance's origin - a missing one is as much a defect as a wrong one. */
function expectEveryEnvelope(events: EventEnvelope[], origin: GrantOrigin) {
  expect(events.length).toBeGreaterThan(0)
  expect(events.map((e) => `${e.event_type}=${String(e.origin)}`)).toEqual(
    events.map((e) => `${e.event_type}=${origin}`),
  )
}

/** GitHub says "not a member", then accepts the invite - the ordinary direct-grant path. */
function mockGrantingGithub() {
  return vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : (input as Request).url
      const method = ((init as RequestInit)?.method ?? 'GET').toUpperCase()
      if (url.includes('/memberships/') && method === 'GET')
        return new Response(null, { status: 404 })
      if (url.includes('/memberships/') && method === 'PUT')
        return new Response(JSON.stringify({ state: 'pending' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      return new Response(null, { status: 500 })
    })
}

describe('the grant record and every envelope carry the origin', () => {
  it.each<[string, { origin?: GrantOrigin }, GrantOrigin]>([
    ['webhook', { origin: 'webhook' }, 'webhook'],
    ['rpc', { origin: 'rpc' }, 'rpc'],
    // Nothing said → core's default. Pinned by VALUE rather than by "whatever the constant says", so
    // flipping the default is a decision this test forces somebody to take on purpose.
    ['nothing at all (core defaults it)', {}, 'rpc'],
  ])(
    'a grant enqueued as %s records and emits it',
    async (_label, extra, expected) => {
      const env = wfEnv()
      mockGrantingGithub()
      const { step } = makeStep()
      const { events, sink } = recorder()

      await executeAccessWorkflow(
        step,
        env,
        wfConfig(),
        { adapter: 'stripe', event: evt(), ...extra },
        sink,
      )

      const record = JSON.parse(
        (await env.ENTITLEMENTS.get('grant:stripe:pi_1')) as string,
      )
      expect(record.origin).toBe(expected)
      expectEveryEnvelope(events, expected)
    },
  )

  it('a failed grant says how the attempt was authorized', async () => {
    const env = wfEnv()
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 422 }),
    )
    const { step } = makeStep()
    const { events, sink } = recorder()

    await executeAccessWorkflow(
      step,
      env,
      wfConfig(),
      { adapter: 'stripe', event: evt(), origin: 'webhook' },
      sink,
    )

    expect(events.map((e) => e.event_type)).toContain('access.failed')
    expectEveryEnvelope(events, 'webhook')
  })

  it('a revoke says how the REVOKE was authorized - the same question asked of the withdrawal', async () => {
    const env = wfEnv()
    await env.ENTITLEMENTS.put(
      'grant:stripe:pi_1',
      JSON.stringify({
        github_username: 'octocat',
        org: 'testorg',
        teams: ['kit-pro'],
        product_id: 'prod_x',
        granted_at: '2026-01-01T00:00:00Z',
        origin: 'webhook',
      }),
    )
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : (input as Request).url
      const method = ((init as RequestInit)?.method ?? 'GET').toUpperCase()
      if (method === 'DELETE') return new Response(null, { status: 204 })
      if (url.includes('/invitations'))
        return new Response('[]', { status: 200 })
      return new Response(null, { status: 404 })
    })
    const { step } = makeStep()
    const { events, sink } = recorder()

    await executeAccessWorkflow(
      step,
      env,
      wfConfig(),
      {
        adapter: 'stripe',
        event: evt({ event_type: 'refund', is_full_refund: true }),
        origin: 'rpc',
      },
      sink,
    )

    expect(events.map((e) => e.event_type)).toContain('access.revoked')
    expectEveryEnvelope(events, 'rpc')
  })
})

// --- across the claim gap ----------------------------------------------------

describe('a claim completion inherits the payment it descends from', () => {
  // The fallback is the only writer of the claim record, and the completion is its only reader for
  // this value, so the two are pinned together: a fallback that stopped writing it would otherwise
  // just look like a completion that defaulted.
  it('the claim fallback writes the origin onto the claim record', async () => {
    const env = wfEnv()
    const { step } = makeStep()
    const { events, sink } = recorder()

    await executeAccessWorkflow(
      step,
      env,
      wfConfig(),
      {
        adapter: 'stripe',
        event: evt({ github_username: null }),
        origin: 'webhook',
      },
      sink,
    )

    const token = (await env.ENTITLEMENTS.get(
      'claim_txn:stripe:pi_1',
    )) as string
    const claim = JSON.parse(
      (await env.ENTITLEMENTS.get(`claim:${token}`)) as string,
    )
    expect(claim.origin).toBe('webhook')
    expectEveryEnvelope(events, 'webhook')
  })

  // THE CASE THE DEFAULT MUST NOT TOUCH. A claim minted before the field existed was born from a
  // provider webhook this worker verified; its completion has nothing to forward. Defaulting there
  // does not under-state, it states something FALSE - a verified sale written down as a direct call.
  // A direct enqueue reaching the same line is a different fact, so the two are pinned together: the
  // completion records nothing, and the direct enqueue still records `rpc`.
  it('a claim completion with nothing to forward records NO origin, and says nothing on the wire', async () => {
    const env = wfEnv()
    mockGrantingGithub()
    const { step } = makeStep()
    const { events, sink } = recorder()

    await executeAccessWorkflow(
      step,
      env,
      wfConfig(),
      { adapter: 'stripe', event: evt(), from_claim: true },
      sink,
    )

    const record = JSON.parse(
      (await env.ENTITLEMENTS.get('grant:stripe:pi_1')) as string,
    )
    expect('origin' in record).toBe(false)
    expect(events.length).toBeGreaterThan(0)
    for (const envelope of events) {
      expect(`${envelope.event_type}:${'origin' in envelope}`).toBe(
        `${envelope.event_type}:false`,
      )
    }
  })

  it('a claim completion that DOES carry one still records it', async () => {
    const env = wfEnv()
    mockGrantingGithub()
    const { step } = makeStep()
    const { events, sink } = recorder()

    await executeAccessWorkflow(
      step,
      env,
      wfConfig(),
      { adapter: 'stripe', event: evt(), from_claim: true, origin: 'webhook' },
      sink,
    )

    const record = JSON.parse(
      (await env.ENTITLEMENTS.get('grant:stripe:pi_1')) as string,
    )
    expect(record.origin).toBe('webhook')
    expectEveryEnvelope(events, 'webhook')
  })

  it.each([
    [
      'a claim carrying an origin forwards it',
      { origin: 'webhook' },
      'webhook',
    ],
    // A claim minted before the field existed. It cannot be recovered, so it lands on the default -
    // stated here rather than left to be discovered, because the field is NOT universal on old records.
    ['a claim predating the field falls to the default', {}, undefined],
  ])('%s', async (_label, extra, expected) => {
    const env = {
      ...testEnv,
      ACCESS_WORKFLOW: { create: vi.fn(), createBatch: vi.fn(async () => []) },
    } as unknown as CloudflareBindings
    await env.ENTITLEMENTS.put(
      'claim:tok_abc',
      JSON.stringify({
        adapter: 'stripe',
        product_id: 'prod_x',
        teams: ['kit-pro'],
        buyer_email: null,
        transaction_id: 'pi_1',
        ...extra,
      }),
      { expirationTtl: 60 },
    )

    const result = await completeClaim(env, wfConfig(), 'tok_abc', 'octocat')
    expect(result.status).toBe('submitted')
    expect(paramsOf(env).origin).toBe(expected)
  })
})
