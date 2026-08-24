// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Gary Stupak

import { env as testEnv } from 'cloudflare:test'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createWorker } from '../src/create-worker'
import { executeAccessWorkflow } from '../src/workflow/workflow'
import { apiCallbackInstanceId } from '../src/workflow/workflow-id'
import type { EventEnvelope } from '../src/events'
import type { AccessWorkflowParams, RepoAccessConfig } from '../src/types'
import { makeStep, mockConfig, mockEnv } from './helpers'
import {
  apiCallbackMock,
  CB_PROVIDER_API,
  CB_SECRET_PATH,
  pingBody,
} from './fixtures/api-callback-mock'

// The deferred api_callback core contract: route does only the :secret_path credential check + enqueue
// the RAW ping (no fetch, no parse on the ack path); the entity fetch + parse run in a durable Workflow
// step, mapping the grant from the FETCHED entity (never the ping body). SYNTHETIC adapter only - no
// real provider, no Pro content.

const FORM_HEADERS = { 'content-type': 'application/x-www-form-urlencoded' }

function formPost(body: string): RequestInit {
  return { method: 'POST', body, headers: FORM_HEADERS }
}

// --- ack path (route) -------------------------------------------------------

describe('createWorker - api_callback ack path', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch')
  })
  afterEach(() => {
    fetchSpy.mockRestore()
  })

  const app = () =>
    createWorker({ adapters: [apiCallbackMock()], config: mockConfig() })

  it('wrong :secret_path → 401, fetchEntity NEVER called, no enqueue', async () => {
    const env = mockEnv()
    const res = await app().request(
      '/wh/cbmock/wrong-path',
      formPost(pingBody('sale_1')),
      env,
    )
    expect(res.status).toBe(401)
    expect(await res.text()).toBe('unauthorized')
    expect(env.ACCESS_WORKFLOW.createBatch).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled() // no entity fetch on the ack path, ever
  })

  it('valid :secret_path → 200, exactly one enqueue with the ping + deterministic id, zero outbound fetch', async () => {
    const env = mockEnv()
    const body = pingBody('sale_1')
    const res = await app().request(
      `/wh/cbmock/${CB_SECRET_PATH}`,
      formPost(body),
      env,
    )
    expect(res.status).toBe(200)
    expect(env.ACCESS_WORKFLOW.createBatch).toHaveBeenCalledTimes(1)
    const expectedId = await apiCallbackInstanceId('cbmock', body)
    expect(
      (env.ACCESS_WORKFLOW.createBatch as ReturnType<typeof vi.fn>).mock
        .calls[0][0],
    ).toEqual([
      {
        id: expectedId,
        params: {
          adapter: 'cbmock',
          ping: {
            bodyText: body,
            form: { sale_id: 'sale_1', seller_id: 's_1' },
          },
          // Nothing is signed here, but the ping still arrived over HTTP from the provider and its
          // secret-path credential was checked before this enqueue - the same channel, not a third.
          origin: 'webhook',
        },
      },
    ])
    // Fast-ack invariant: the fetch is deferred to the Workflow, NOT done here.
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(expectedId).toMatch(/^cbmock-apicallback-[0-9a-f]{64}$/)
  })

  it('duplicate identical ping → identical id (idempotent dedupe key)', async () => {
    const env = mockEnv()
    const body = pingBody('sale_1')
    await app().request(`/wh/cbmock/${CB_SECRET_PATH}`, formPost(body), env)
    await app().request(`/wh/cbmock/${CB_SECRET_PATH}`, formPost(body), env)
    const calls = (env.ACCESS_WORKFLOW.createBatch as ReturnType<typeof vi.fn>)
      .mock.calls
    expect(calls).toHaveLength(2)
    expect(calls[0][0][0].id).toBe(calls[1][0][0].id) // same body → same id → createBatch dedupes
  })

  it('distinct events (different bodies) → distinct ids', async () => {
    const env = mockEnv()
    await app().request(
      `/wh/cbmock/${CB_SECRET_PATH}`,
      formPost(pingBody('sale_1')),
      env,
    )
    await app().request(
      `/wh/cbmock/${CB_SECRET_PATH}`,
      formPost(pingBody('sale_2')),
      env,
    )
    const calls = (env.ACCESS_WORKFLOW.createBatch as ReturnType<typeof vi.fn>)
      .mock.calls
    expect(calls[0][0][0].id).not.toBe(calls[1][0][0].id)
  })
})

// --- workflow path (fetch-in-step) ------------------------------------------

afterEach(async () => {
  vi.restoreAllMocks()
  const { keys } = await testEnv.ENTITLEMENTS.list()
  await Promise.all(keys.map((k) => testEnv.ENTITLEMENTS.delete(k.name)))
})

function makeEnv(): CloudflareBindings {
  return {
    ...testEnv,
    GITHUB_TOKEN: 'test_token',
  } as unknown as CloudflareBindings
}

function makeConfig(): RepoAccessConfig {
  return {
    githubOrg: 'testorg',
    productTeamMap: {
      cbmock: {
        prod_cb: {
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
    },
  }
}

const recorder = () => {
  const events: EventEnvelope[] = []
  return { events, sink: (e: EventEnvelope) => void events.push(e) }
}

/** Route global fetch to the provider entity API and/or GitHub. */
function mockFetch(opts: {
  provider?: (id: string) => { status: number; body?: unknown }
  github?: (method: string, path: string) => { status: number; body?: unknown }
}) {
  return vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : (input as Request).url
      const method = ((init as RequestInit)?.method ?? 'GET').toUpperCase()
      let r: { status: number; body?: unknown }
      if (url.startsWith(CB_PROVIDER_API)) {
        const id = decodeURIComponent(url.slice(CB_PROVIDER_API.length + 1))
        r = (opts.provider ?? (() => ({ status: 404 })))(id)
      } else if (url.includes('api.github.com')) {
        const path = url.replace('https://api.github.com', '')
        r = (opts.github ?? (() => ({ status: 500 })))(method, path)
      } else {
        r = { status: 500 }
      }
      return new Response(
        r.body === undefined ? null : JSON.stringify(r.body),
        {
          status: r.status,
          headers: { 'content-type': 'application/json' },
        },
      )
    })
}

const pingParams = (saleId: string): AccessWorkflowParams => ({
  adapter: 'cbmock',
  ping: {
    bodyText: pingBody(saleId),
    form: { sale_id: saleId, seller_id: 's_1' },
  },
})

describe('AccessWorkflow - api_callback fetch + parse', () => {
  it('fetched sale entity → parse → grant runs (access.granted + grant record)', async () => {
    const env = makeEnv()
    mockFetch({
      provider: (id) => ({
        status: 200,
        body: {
          id,
          kind: 'sale',
          product_id: 'prod_cb',
          github_username: 'octocat',
        },
      }),
      github: (m, p) => {
        if (m === 'GET' && p.includes('/memberships/')) return { status: 404 }
        if (m === 'PUT' && p.includes('/memberships/'))
          return { status: 200, body: { state: 'pending' } }
        return { status: 500 }
      },
    })
    const { events, sink } = recorder()

    await executeAccessWorkflow(
      makeStep().step,
      env,
      makeConfig(),
      pingParams('sale_1'),
      sink,
      [apiCallbackMock()],
    )

    const granted = events.find((e) => e.event_type === 'access.granted')
    expect(granted).toMatchObject({
      github_username: 'octocat',
      teams: ['kit-pro'],
      transaction_id: 'sale_1', // mapped from the FETCHED entity, not the ping
      status: 'success',
    })
    expect(
      await env.ENTITLEMENTS.get('grant:cbmock:sale_1', 'json'),
    ).toMatchObject({
      github_username: 'octocat',
      teams: ['kit-pro'],
      product_id: 'prod_cb',
    })
  })

  it('forged/unknown id → fetch returns null → access.failed, no grant (never-trust anchor)', async () => {
    const env = makeEnv()
    const ghCalls: string[] = []
    mockFetch({
      provider: () => ({ status: 404 }), // entity not found
      github: (m, p) => {
        ghCalls.push(`${m} ${p}`)
        return { status: 200 }
      },
    })
    const { events, sink } = recorder()

    await executeAccessWorkflow(
      makeStep().step,
      env,
      makeConfig(),
      pingParams('forged_1'),
      sink,
      [apiCallbackMock()],
    )

    expect(events.map((e) => e.event_type)).toContain('access.failed')
    // Wire reason is the coarse code, never raw text (Info-1 hardening).
    expect(events.find((e) => e.event_type === 'access.failed')?.reason).toBe(
      'fetch_failed',
    )
    expect(
      events.find((e) => e.event_type === 'access.granted'),
    ).toBeUndefined()
    expect(ghCalls).toHaveLength(0) // no GitHub side effect on a failed fetch
    expect(await env.ENTITLEMENTS.get('grant:cbmock:forged_1')).toBeNull()
  })

  it('entity fetched but parse returns null (unhandled kind) → access.failed, no grant', async () => {
    const env = makeEnv()
    mockFetch({
      provider: (id) => ({ status: 200, body: { id, kind: 'weird' } }),
    })
    const { events, sink } = recorder()

    await executeAccessWorkflow(
      makeStep().step,
      env,
      makeConfig(),
      pingParams('sale_3'),
      sink,
      [apiCallbackMock()],
    )

    expect(events.map((e) => e.event_type)).toContain('access.failed')
    expect(events.find((e) => e.event_type === 'access.failed')?.reason).toBe(
      'unhandled_event',
    )
    expect(
      events.find((e) => e.event_type === 'access.granted'),
    ).toBeUndefined()
    expect(await env.ENTITLEMENTS.get('grant:cbmock:sale_3')).toBeNull()
  })

  it('parse() throws on the fetched entity → access.failed reason parse_failed', async () => {
    const env = makeEnv()
    mockFetch({
      provider: (id) => ({
        status: 200,
        body: { id, kind: 'sale', product_id: 'prod_cb' },
      }),
    })
    const { events, sink } = recorder()
    // A valid entity is fetched, but this adapter's parse throws → coarse parse_failed on the wire.
    const throwingAdapter = {
      ...apiCallbackMock(),
      parse: () => {
        throw new Error('boom parsing entity')
      },
    }

    await executeAccessWorkflow(
      makeStep().step,
      env,
      makeConfig(),
      pingParams('sale_5'),
      sink,
      [throwingAdapter],
    )

    expect(events.find((e) => e.event_type === 'access.failed')?.reason).toBe(
      'parse_failed',
    )
    expect(
      events.find((e) => e.event_type === 'access.granted'),
    ).toBeUndefined()
    expect(await env.ENTITLEMENTS.get('grant:cbmock:sale_5')).toBeNull()
  })

  it('adapter not in the workflow set → fail-closed access.failed (no grant)', async () => {
    const env = makeEnv()
    mockFetch({
      provider: (id) => ({
        status: 200,
        body: { id, kind: 'sale', product_id: 'prod_cb' },
      }),
    })
    const { events, sink } = recorder()

    // adapters omitted (defaults to []) → the workflow can't resolve cbmock's fetchEntity.
    await executeAccessWorkflow(
      makeStep().step,
      env,
      makeConfig(),
      pingParams('sale_4'),
      sink,
    )

    expect(events.map((e) => e.event_type)).toContain('access.failed')
    expect(events.find((e) => e.event_type === 'access.failed')?.reason).toBe(
      'unverifiable_adapter',
    )
    expect(await env.ENTITLEMENTS.get('grant:cbmock:sale_4')).toBeNull()
  })
})
