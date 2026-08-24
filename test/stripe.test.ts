// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Gary Stupak

import { describe, it, expect, vi } from 'vitest'
import { createWorker } from '../src/create-worker'
import { stripe } from '../src/adapters/stripe'
import type { RawRequest } from '../src/types'
import { hmacHex, mockConfig, mockEnv } from './helpers'
import * as fx from './fixtures/stripe'

// BASELINE - Stripe signature fixtures (valid / tampered / expired ts) + parse mapping.
// Fixtures are loaded from test/fixtures/stripe.ts in the canonical Conformance-Lab format
// (provider / capture date / raw bytes verbatim). SYNTHETIC ONLY - no real captured payloads in
// core (Pro-isolation).

// Bind each fixture's verbatim raw bytes - the route signs and the adapter parses these exact bytes.
const sessionPaid = fx.sessionPaid.raw
const sessionPaidCustomField = fx.sessionPaidCustomField.raw
const sessionUnpaid = fx.sessionUnpaid.raw
const chargeRefundedFull = fx.chargeRefundedFull.raw
const chargeRefundedPartial = fx.chargeRefundedPartial.raw
const disputeCreated = fx.disputeCreated.raw

const SECRET = 'whsec_test_secret'
const nowSec = () => Math.floor(Date.now() / 1000)

/** Build a Stripe-Signature header value over `${t}.${body}` for each provided secret. */
async function stripeSignature(
  body: string,
  t: number,
  secrets: string[] = [SECRET],
): Promise<string> {
  const sigs = await Promise.all(
    secrets.map((s) => hmacHex('SHA-256', s, `${t}.${body}`)),
  )
  return [`t=${t}`, ...sigs.map((v) => `v1=${v}`)].join(',')
}

async function signedRequest(
  body: string,
  t: number = nowSec(),
  signingSecret = SECRET,
): Promise<RequestInit> {
  const v1 = await hmacHex('SHA-256', signingSecret, `${t}.${body}`)
  return {
    method: 'POST',
    body,
    headers: { 'stripe-signature': `t=${t},v1=${v1}` },
  }
}

const raw = (body: string, header?: string): RawRequest => ({
  bodyText: body,
  headers: new Headers(header ? { 'stripe-signature': header } : {}),
})

describe('stripe adapter - verification (via the route, 401 on failure)', () => {
  it('valid signature → 200, enqueues stripe-payment_success-pi_test_123', async () => {
    const env = mockEnv({ STRIPE_WEBHOOK_SECRET: SECRET })
    const app = createWorker({ adapters: [stripe], config: mockConfig() })
    const res = await app.request(
      '/wh/stripe/whpath',
      await signedRequest(sessionPaid),
      env,
    )
    expect(res.status).toBe(200)
    expect(env.ACCESS_WORKFLOW.createBatch).toHaveBeenCalledTimes(1)
    const [[batch]] = (
      env.ACCESS_WORKFLOW.createBatch as ReturnType<typeof vi.fn>
    ).mock.calls
    expect(batch[0].id).toBe('stripe-payment_success-pi_test_123')
  })

  it('multiple v1 (one wrong, one right) → 200 (secret rotation)', async () => {
    const env = mockEnv({ STRIPE_WEBHOOK_SECRET: SECRET })
    const app = createWorker({ adapters: [stripe], config: mockConfig() })
    const t = nowSec()
    const header = await stripeSignature(sessionPaid, t, [
      'whsec_old_rotated',
      SECRET,
    ])
    const res = await app.request(
      '/wh/stripe/whpath',
      {
        method: 'POST',
        body: sessionPaid,
        headers: { 'stripe-signature': header },
      },
      env,
    )
    expect(res.status).toBe(200)
  })

  it('tampered body → 401 (no enqueue)', async () => {
    const env = mockEnv({ STRIPE_WEBHOOK_SECRET: SECRET })
    const app = createWorker({ adapters: [stripe], config: mockConfig() })
    const init = await signedRequest(sessionPaid)
    const res = await app.request(
      '/wh/stripe/whpath',
      { ...init, body: sessionPaid.replace('octocat', 'attacker') },
      env,
    )
    expect(res.status).toBe(401)
    expect(await res.text()).toBe('invalid signature')
    expect(env.ACCESS_WORKFLOW.createBatch).not.toHaveBeenCalled()
  })

  it('wrong secret → 401', async () => {
    const env = mockEnv({ STRIPE_WEBHOOK_SECRET: SECRET })
    const app = createWorker({ adapters: [stripe], config: mockConfig() })
    const res = await app.request(
      '/wh/stripe/whpath',
      await signedRequest(sessionPaid, nowSec(), 'whsec_wrong'),
      env,
    )
    expect(res.status).toBe(401)
    expect(await res.text()).toBe('invalid signature')
  })

  it('missing secret (env unset) → 401, fail-closed', async () => {
    const env = mockEnv() // no STRIPE_WEBHOOK_SECRET
    const app = createWorker({ adapters: [stripe], config: mockConfig() })
    const res = await app.request(
      '/wh/stripe/whpath',
      await signedRequest(sessionPaid),
      env,
    )
    expect(res.status).toBe(401)
    expect(await res.text()).toBe('invalid signature')
  })

  it('expired timestamp → 401 (even with a valid signature)', async () => {
    const env = mockEnv({ STRIPE_WEBHOOK_SECRET: SECRET })
    const app = createWorker({ adapters: [stripe], config: mockConfig() })
    const res = await app.request(
      '/wh/stripe/whpath',
      await signedRequest(sessionPaid, 1000),
      env,
    )
    expect(res.status).toBe(401)
    expect(await res.text()).toBe('invalid signature')
  })

  it('missing signature header → 401', async () => {
    const env = mockEnv({ STRIPE_WEBHOOK_SECRET: SECRET })
    const app = createWorker({ adapters: [stripe], config: mockConfig() })
    const res = await app.request(
      '/wh/stripe/whpath',
      { method: 'POST', body: sessionPaid },
      env,
    )
    expect(res.status).toBe(401)
    expect(await res.text()).toBe('invalid signature')
  })
})

describe('stripe adapter - parse()', () => {
  it('checkout.session.completed (paid) → payment_success with payment_intent + metadata username', () => {
    const event = stripe.parse(raw(sessionPaid))
    expect(event).toEqual({
      event_type: 'payment_success',
      product_id: 'prod_ABC',
      transaction_id: 'pi_test_123',
      buyer_email: 'buyer@example.com',
      github_username: 'octocat',
      is_full_refund: null,
    })
  })

  it('github_username falls back to a github custom field', () => {
    expect(stripe.parse(raw(sessionPaidCustomField))?.github_username).toBe(
      'viacustomfield',
    )
  })

  it('checkout.session.completed sets redirect_alias_id to the checkout session id (cs_), txn stays the pi_', () => {
    const event = stripe.parse(raw(fx.sessionPaidWithSession.raw))
    expect(event?.redirect_alias_id).toBe('cs_test_abc') // success_url carries cs_
    expect(event?.transaction_id).toBe('pi_test_123') // claim/grant key stays the payment_intent
  })

  it('a session without an id carries no redirect_alias_id', () => {
    expect(stripe.parse(raw(sessionPaid))?.redirect_alias_id).toBeUndefined()
  })

  it('refund / dispute carry no redirect_alias_id (no session id on those events)', () => {
    expect(
      stripe.parse(raw(chargeRefundedFull))?.redirect_alias_id,
    ).toBeUndefined()
    expect(stripe.parse(raw(disputeCreated))?.redirect_alias_id).toBeUndefined()
  })

  it('checkout.session.completed (not paid) → null (gate on payment_status)', () => {
    expect(stripe.parse(raw(sessionUnpaid))).toBeNull()
  })

  it('charge.refunded full (amount_refunded === amount) → refund, is_full_refund true', () => {
    const event = stripe.parse(raw(chargeRefundedFull))
    expect(event?.event_type).toBe('refund')
    expect(event?.is_full_refund).toBe(true)
    expect(event?.transaction_id).toBe('pi_test_123')
  })

  it('charge.refunded partial → is_full_refund false', () => {
    expect(stripe.parse(raw(chargeRefundedPartial))?.is_full_refund).toBe(false)
  })

  it('charge.dispute.created → chargeback, is_full_refund null', () => {
    const event = stripe.parse(raw(disputeCreated))
    expect(event?.event_type).toBe('chargeback')
    expect(event?.is_full_refund).toBeNull()
  })

  it('unknown event type → null; malformed JSON → null', () => {
    expect(
      stripe.parse(
        raw(JSON.stringify({ type: 'invoice.paid', data: { object: {} } })),
      ),
    ).toBeNull()
    expect(stripe.parse(raw('not json'))).toBeNull()
  })

  it('transaction_id (payment_intent) is identical across a session and its refund', () => {
    const session = stripe.parse(raw(sessionPaid))
    const refund = stripe.parse(raw(chargeRefundedFull))
    expect(session?.transaction_id).toBe('pi_test_123')
    expect(refund?.transaction_id).toBe('pi_test_123')
    expect(session?.transaction_id).toBe(refund?.transaction_id)
  })
})
