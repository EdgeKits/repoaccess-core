// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Gary Stupak

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createWorker } from '../src/create-worker'
import {
  mockConfig,
  mockEnv,
  signedPost,
  stubAdapter,
  STUB_SIGNATURE_HEADER,
} from './helpers'

describe('createWorker - webhook route', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch')
  })
  afterEach(() => {
    fetchSpy.mockRestore()
  })

  it('unknown :adapter → 404 (no enqueue)', async () => {
    const env = mockEnv()
    const app = createWorker({
      adapters: [stubAdapter()],
      config: mockConfig(),
    })
    const res = await app.request(
      '/wh/nope/secret',
      await signedPost('{}'),
      env,
    )
    expect(res.status).toBe(404)
    expect(env.ACCESS_WORKFLOW.createBatch).not.toHaveBeenCalled()
    // Positive control. `c.notFound()` returns Hono's generic body, so the 404 carries nothing that says
    // WHY - and a route that had been renamed or broken would 404 identically, passing this test while
    // the adapter gate went untested. Proving the SAME app routes a KNOWN adapter is the only evidence
    // available that the route matched and it was the adapter lookup that rejected.
    const known = await app.request(
      '/wh/stub/secret',
      await signedPost('{}'),
      env,
    )
    expect(known.status).not.toBe(404)
  })

  it('invalid signature → 401 (no enqueue, reject before parse)', async () => {
    const env = mockEnv()
    const app = createWorker({
      adapters: [stubAdapter()],
      config: mockConfig(),
    })
    const res = await app.request(
      '/wh/stub/secret',
      {
        method: 'POST',
        body: JSON.stringify({ transaction_id: 'txn_1' }),
        headers: { [STUB_SIGNATURE_HEADER]: 'deadbeef' },
      },
      env,
    )
    expect(res.status).toBe(401)
    expect(await res.text()).toBe('invalid signature')
    expect(env.ACCESS_WORKFLOW.createBatch).not.toHaveBeenCalled()
  })

  it('malformed body (valid sig) → 400 (no enqueue)', async () => {
    const env = mockEnv()
    const app = createWorker({
      adapters: [stubAdapter()],
      config: mockConfig(),
    })
    const res = await app.request(
      '/wh/stub/secret',
      await signedPost('not json'),
      env,
    )
    expect(res.status).toBe(400)
    expect(await res.text()).toBe('unprocessable entity')
    expect(env.ACCESS_WORKFLOW.createBatch).not.toHaveBeenCalled()
  })

  it('valid → 200, exactly one workflow enqueued with the deterministic id, zero outbound fetches', async () => {
    const env = mockEnv()
    const app = createWorker({
      adapters: [stubAdapter()],
      config: mockConfig(),
    })
    const res = await app.request(
      '/wh/stub/secret',
      await signedPost(
        JSON.stringify({ transaction_id: 'txn_1', product_id: 'prod_x' }),
      ),
      env,
    )
    expect(res.status).toBe(200)
    expect(env.ACCESS_WORKFLOW.createBatch).toHaveBeenCalledTimes(1)
    expect(
      (env.ACCESS_WORKFLOW.createBatch as ReturnType<typeof vi.fn>).mock
        .calls[0][0],
    ).toEqual([
      {
        id: 'stub-payment_success-txn_1',
        params: {
          adapter: 'stub',
          event: expect.objectContaining({ transaction_id: 'txn_1' }),
          // Provenance is stated by the ROUTE, not defaulted downstream: a verified delivery is the
          // one thing the Workflow cannot infer about an enqueue it did not make.
          origin: 'webhook',
        },
      },
    ])
    // Fast-ack invariant: no outbound network on the request path (hmac verify is local crypto).
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('createWorker - /health', () => {
  it('returns 200 ok and leaks no config', async () => {
    const app = createWorker({ adapters: [], config: mockConfig() })
    const res = await app.request('/health', {}, mockEnv())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ok' })
  })
})

// Claim-flow behavior is covered in claim.test.ts (needs a real KV); the earlier 501
// placeholder assertion was removed when the flow landed.
