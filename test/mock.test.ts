// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Gary Stupak

import { describe, it, expect, vi } from 'vitest'
import { createWorker } from '../src/create-worker'
import { mock, MOCK_SECRET } from './fixtures/mock-adapter'
import type { RawRequest } from '../src/types'
import { hmacHex, mockConfig, mockEnv } from './helpers'
import * as fx from './fixtures/mock'

// Synthetic acceptance tests for a minimal PaymentAdapter (test/fixtures/mock-adapter.ts) driven
// through the real router: signature verification, parse, and enqueue. They exercise the adapter
// contract end to end against core's engine. SYNTHETIC fixtures only.

const SIGNATURE_HEADER = 'x-mock-signature'

/** A POST RequestInit with a valid mock signature over `body` (HMAC-SHA256 of the raw bytes). */
async function signedPost(body: string): Promise<RequestInit> {
  const signature = await hmacHex('SHA-256', MOCK_SECRET, body)
  return { method: 'POST', body, headers: { [SIGNATURE_HEADER]: signature } }
}

const raw = (body: string): RawRequest => ({
  bodyText: body,
  headers: new Headers(),
})

describe('mock adapter - verification (via the route)', () => {
  it('valid signature → 200, enqueues mock-payment_success-ord_1', async () => {
    const env = mockEnv()
    const app = createWorker({ adapters: [mock], config: mockConfig() })
    const res = await app.request(
      '/wh/mock/secret',
      await signedPost(fx.orderPaid.raw),
      env,
    )
    expect(res.status).toBe(200)
    expect(env.ACCESS_WORKFLOW.createBatch).toHaveBeenCalledTimes(1)
    const [[batch]] = (
      env.ACCESS_WORKFLOW.createBatch as ReturnType<typeof vi.fn>
    ).mock.calls
    expect(batch[0].id).toBe('mock-payment_success-ord_1')
  })

  it('tampered body → 401 (no enqueue)', async () => {
    const env = mockEnv()
    const app = createWorker({ adapters: [mock], config: mockConfig() })
    const init = await signedPost(fx.orderPaid.raw)
    const res = await app.request(
      '/wh/mock/secret',
      { ...init, body: fx.orderPaid.raw.replace('octocat', 'attacker') },
      env,
    )
    expect(res.status).toBe(401)
    expect(await res.text()).toBe('invalid signature')
    expect(env.ACCESS_WORKFLOW.createBatch).not.toHaveBeenCalled()
  })

  it('missing signature → 401', async () => {
    const env = mockEnv()
    const app = createWorker({ adapters: [mock], config: mockConfig() })
    const res = await app.request(
      '/wh/mock/secret',
      { method: 'POST', body: fx.orderPaid.raw },
      env,
    )
    expect(res.status).toBe(401)
    expect(await res.text()).toBe('invalid signature')
  })
})

describe('mock adapter - parse()', () => {
  it('order.paid → payment_success with the handle, id as transaction_id', () => {
    expect(mock.parse(raw(fx.orderPaid.raw))).toEqual({
      event_type: 'payment_success',
      product_id: 'prod_x',
      transaction_id: 'ord_1',
      buyer_email: null,
      github_username: 'octocat',
      is_full_refund: null,
    })
  })

  it('order.refunded full (amount_refunded === amount) → refund, is_full_refund true', () => {
    const event = mock.parse(raw(fx.orderRefundedFull.raw))
    expect(event?.event_type).toBe('refund')
    expect(event?.is_full_refund).toBe(true)
  })

  it('order.refunded partial → is_full_refund false', () => {
    expect(mock.parse(raw(fx.orderRefundedPartial.raw))?.is_full_refund).toBe(
      false,
    )
  })

  it('order.chargeback → chargeback, is_full_refund null', () => {
    const event = mock.parse(raw(fx.orderChargeback.raw))
    expect(event?.event_type).toBe('chargeback')
    expect(event?.is_full_refund).toBeNull()
  })

  it('unknown type → null; malformed JSON → null', () => {
    expect(mock.parse(raw(fx.unknownType.raw))).toBeNull()
    expect(mock.parse(raw('not json'))).toBeNull()
  })

  it('transaction_id (order id) is identical across an order and its refund', () => {
    const paid = mock.parse(raw(fx.orderPaid.raw))
    const refund = mock.parse(raw(fx.orderRefundedFull.raw))
    expect(paid?.transaction_id).toBe('ord_1')
    expect(refund?.transaction_id).toBe(paid?.transaction_id)
  })
})
