// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Gary Stupak

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createWorker } from '../src/create-worker'
import { mockConfig, mockEnv } from './helpers'
import {
  sharedSecretMock,
  secretHeaderPost,
  SSH_HEADER,
} from './fixtures/shared-secret-mock'

// The additive shared_secret_header contract + optional handle() hook:
// the route timing-safe compares a fixed header against the adapter's secret (fail-closed → 401),
// then - only AFTER verify passes - delegates to handle() if present (a returned Response IS the
// ack, no enqueue; null falls through to parse → enqueue). SYNTHETIC adapter only - no real
// provider and no provider-specific detail.

const JSON_HEADERS = { 'content-type': 'application/json' }

const handshake = (id: string) => JSON.stringify({ kind: 'handshake', id })
const payment = (txn: string, product = 'prod_x', username?: string) =>
  JSON.stringify({ kind: 'payment', id: txn, product, username })

describe('createWorker - shared_secret_header ack path', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch')
  })
  afterEach(() => {
    fetchSpy.mockRestore()
  })

  it('missing secret header → 401, handle NOT called, no parse, no enqueue', async () => {
    const env = mockEnv()
    const adapter = sharedSecretMock()
    const handleSpy = vi.spyOn(adapter, 'handle')
    const parseSpy = vi.spyOn(adapter, 'parse')
    const app = createWorker({ adapters: [adapter], config: mockConfig() })

    // No secret header at all.
    const res = await app.request(
      '/wh/sshmock/x',
      { method: 'POST', body: handshake('q1'), headers: JSON_HEADERS },
      env,
    )

    expect(res.status).toBe(401)
    expect(await res.text()).toBe('invalid signature')
    expect(handleSpy).not.toHaveBeenCalled()
    expect(parseSpy).not.toHaveBeenCalled()
    expect(env.ACCESS_WORKFLOW.createBatch).not.toHaveBeenCalled()
  })

  it('wrong secret header → 401, handle NOT called, no parse, no enqueue', async () => {
    const env = mockEnv()
    const adapter = sharedSecretMock()
    const handleSpy = vi.spyOn(adapter, 'handle')
    const parseSpy = vi.spyOn(adapter, 'parse')
    const app = createWorker({ adapters: [adapter], config: mockConfig() })

    const res = await app.request(
      '/wh/sshmock/x',
      secretHeaderPost(payment('txn_1'), {
        ...JSON_HEADERS,
        [SSH_HEADER]: 'not-the-secret',
      }),
      env,
    )

    expect(res.status).toBe(401)
    expect(await res.text()).toBe('invalid signature')
    expect(handleSpy).not.toHaveBeenCalled()
    expect(parseSpy).not.toHaveBeenCalled()
    expect(env.ACCESS_WORKFLOW.createBatch).not.toHaveBeenCalled()
  })

  it('valid header + handle → Response → that Response is the ack, NO enqueue', async () => {
    const env = mockEnv()
    const adapter = sharedSecretMock()
    const parseSpy = vi.spyOn(adapter, 'parse')
    const app = createWorker({ adapters: [adapter], config: mockConfig() })

    const res = await app.request(
      '/wh/sshmock/x',
      secretHeaderPost(handshake('q1')),
      env,
    )

    expect(res.status).toBe(200)
    // The router returned the adapter's own Response - the handshake is acked, never parsed/enqueued.
    expect(await res.json()).toEqual({ ok: true, answered: 'q1' })
    expect(parseSpy).not.toHaveBeenCalled()
    expect(env.ACCESS_WORKFLOW.createBatch).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('valid header + handle → null → parse → enqueue (exactly one workflow)', async () => {
    const env = mockEnv()
    const app = createWorker({
      adapters: [sharedSecretMock()],
      config: mockConfig(),
    })

    const res = await app.request(
      '/wh/sshmock/x',
      secretHeaderPost(payment('txn_1', 'prod_x', 'octocat')),
      env,
    )

    expect(res.status).toBe(200)
    expect(env.ACCESS_WORKFLOW.createBatch).toHaveBeenCalledTimes(1)
    expect(
      (env.ACCESS_WORKFLOW.createBatch as ReturnType<typeof vi.fn>).mock
        .calls[0][0],
    ).toEqual([
      {
        id: 'sshmock-payment_success-txn_1',
        params: {
          adapter: 'sshmock',
          event: expect.objectContaining({
            transaction_id: 'txn_1',
            github_username: 'octocat',
          }),
          // A matched shared secret authenticates the transport, so this is the webhook channel.
          origin: 'webhook',
        },
      },
    ])
    // Body authentic after the header match - no entity fetch, no other outbound on the ack path.
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('adapter WITHOUT handle → valid header still verify + parse + enqueue unchanged', async () => {
    const env = mockEnv()
    const adapter = sharedSecretMock({ withHandle: false })
    expect(adapter.handle).toBeUndefined()
    const app = createWorker({ adapters: [adapter], config: mockConfig() })

    const res = await app.request(
      '/wh/sshmock/x',
      secretHeaderPost(payment('txn_2')),
      env,
    )

    expect(res.status).toBe(200)
    expect(env.ACCESS_WORKFLOW.createBatch).toHaveBeenCalledTimes(1)
    expect(
      (env.ACCESS_WORKFLOW.createBatch as ReturnType<typeof vi.fn>).mock
        .calls[0][0][0].id,
    ).toBe('sshmock-payment_success-txn_2')
  })

  it('no-handle adapter + handshake body → 400 (unhandled parse, no enqueue)', async () => {
    const env = mockEnv()
    const app = createWorker({
      adapters: [sharedSecretMock({ withHandle: false })],
      config: mockConfig(),
    })

    // Without the hook, a handshake body reaches parse → null → 400. Verify still passed (not 401).
    const res = await app.request(
      '/wh/sshmock/x',
      secretHeaderPost(handshake('q9')),
      env,
    )

    expect(res.status).toBe(400)
    expect(await res.text()).toBe('unprocessable entity')
    expect(env.ACCESS_WORKFLOW.createBatch).not.toHaveBeenCalled()
  })
})
