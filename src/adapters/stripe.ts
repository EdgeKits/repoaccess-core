// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Gary Stupak

import type { NormalizedEvent, PaymentAdapter, RawRequest } from '../types'

/**
 * Stripe reference adapter - the canonical `hmac_sha256` example, verified against the provider's
 * webhook signature reference (docs.stripe.com/webhooks). Ships in the free core.
 *
 * Verification: `Stripe-Signature: t=<unix>,v1=<hex>[,v1=…][,v0=…]`. signed_payload = `${t}.${body}`,
 * HMAC-SHA256 keyed by the endpoint signing secret (`whsec_…`). Ignore every scheme except `v1`
 * (the `v0` test scheme is a downgrade-attack vector). Multiple `v1` appear during secret rotation -
 * the engine matches any. Reject outside the timestamp tolerance.
 */

const SIGNATURE_HEADER = 'stripe-signature'
const TOLERANCE_SEC = 300 // Stripe libraries' default replay window.

interface StripeSignature {
  t: string | undefined
  v1: string[]
}

/** Parse `t=…,v1=…,v0=…` → timestamp + the v1 signatures (v0/other schemes ignored). */
function parseStripeSignature(header: string): StripeSignature {
  let t: string | undefined
  const v1: string[] = []
  for (const part of header.split(',')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    const key = part.slice(0, eq).trim()
    const value = part.slice(eq + 1).trim()
    if (key === 't') t = value
    else if (key === 'v1') v1.push(value)
  }
  return { t, v1 }
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** github_username from a Checkout Session: `metadata.github_username`, else a github custom field. */
function githubUsername(session: Record<string, unknown>): string | null {
  const metadata = session.metadata as Record<string, unknown> | undefined
  const fromMetadata = asString(metadata?.github_username)
  if (fromMetadata) return fromMetadata

  const fields = session.custom_fields
  if (Array.isArray(fields)) {
    for (const field of fields) {
      const key = asString((field as Record<string, unknown>)?.key)
      if (!key || !key.toLowerCase().includes('github')) continue
      const text = (field as Record<string, unknown>).text as
        Record<string, unknown> | undefined
      const dropdown = (field as Record<string, unknown>).dropdown as
        Record<string, unknown> | undefined
      const value = asString(text?.value) ?? asString(dropdown?.value)
      if (value) return value
    }
  }
  return null
}

/** Product id for the team lookup - sellers set it in `metadata.product_id`, which the product→team map keys by. */
function productId(object: Record<string, unknown>): string {
  const metadata = object.metadata as Record<string, unknown> | undefined
  return asString(metadata?.product_id) ?? ''
}

interface StripeEvent {
  type?: unknown
  data?: { object?: Record<string, unknown> }
}

function readEvent(raw: RawRequest): StripeEvent | null {
  try {
    return JSON.parse(raw.bodyText) as StripeEvent
  } catch {
    return null
  }
}

/**
 * The grant a paid Checkout Session makes. Shared by `checkout.session.completed` and
 * `checkout.session.async_payment_succeeded`, so a purchase paid by a delayed method grants exactly
 * what an instantly paid one does: same transaction id, product, email, handle and redirect alias,
 * and therefore the same Workflow instance id.
 */
function paidSession(object: Record<string, unknown>): NormalizedEvent | null {
  // Gate: nothing is granted for a session whose money has not settled.
  if (object.payment_status !== 'paid') return null
  // transaction_id = payment_intent (stable across the order + its refund/dispute), NOT
  // checkout.session.id (absent from charge events).
  const transactionId = asString(object.payment_intent)
  if (!transactionId) return null
  const customer = object.customer_details as
    Record<string, unknown> | undefined
  return {
    event_type: 'payment_success',
    product_id: productId(object),
    transaction_id: transactionId,
    buyer_email: asString(customer?.email) ?? asString(object.customer_email),
    github_username: githubUsername(object),
    is_full_refund: null,
    // The success_url redirect carries the checkout session id (cs_...), not the
    // payment_intent. Alias it -> transaction_id so /claim/by-txn resolves from the redirect.
    redirect_alias_id: asString(object.id) ?? undefined, // cs_... (checkout session id)
  }
}

/**
 * Why a verified Checkout event is acknowledged with nothing to do, or null when it is not one of
 * those. These are recognised events whose correct outcome is "no grant": answering them 400 would
 * make Stripe retry a right decision for days.
 */
function nothingToGrant(event: StripeEvent): string | null {
  const status = event.data?.object?.payment_status
  if (event.type === 'checkout.session.completed') {
    // A delayed payment method (a bank debit, a voucher) completes the session before the money
    // settles; `async_payment_succeeded` follows when it does.
    if (status === 'unpaid') return 'payment not settled yet'
    if (status === 'no_payment_required') return 'no payment required'
  }
  if (event.type === 'checkout.session.async_payment_failed')
    return 'delayed payment failed'
  return null
}

export const stripe: PaymentAdapter = {
  name: 'stripe',

  verification: {
    kind: 'hmac',
    algo: 'SHA-256',
    secret: (env) => env.STRIPE_WEBHOOK_SECRET, // undefined → engine rejects (fail-closed)
    canonical: (raw: RawRequest) => {
      const { t } = parseStripeSignature(
        raw.headers.get(SIGNATURE_HEADER) ?? '',
      )
      return `${t ?? ''}.${raw.bodyText}`
    },
    extract: (headers) => {
      const { t, v1 } = parseStripeSignature(
        headers.get(SIGNATURE_HEADER) ?? '',
      )
      return { signature: v1, ts: t }
    },
    toleranceSec: TOLERANCE_SEC,
  },

  // Runs after verification and before parse. It claims only the recognised Checkout events whose
  // outcome is "no grant" and acknowledges them 200 without an enqueue; every other body (including
  // malformed JSON and event types this adapter does not know) returns null and falls through to
  // `parse` untouched, which still answers those 400.
  handle: async (raw: RawRequest): Promise<Response | null> => {
    const event = readEvent(raw)
    if (!event) return null
    const reason = nothingToGrant(event)
    if (!reason) return null
    console.log(
      JSON.stringify({
        level: 'info',
        msg: 'stripe webhook acknowledged, nothing to grant',
        event_type: event.type,
        reason,
      }),
    )
    return new Response('ok', { status: 200 })
  },

  parse: (raw: RawRequest): NormalizedEvent | null => {
    const event = readEvent(raw)
    if (!event) return null
    const object = event.data?.object
    if (typeof event.type !== 'string' || !object) return null

    switch (event.type) {
      case 'checkout.session.completed':
        return paidSession(object)

      // A delayed payment method has settled. It builds the same event - and so the same
      // `stripe-payment_success-<payment_intent>` instance id - as a paid `completed` for this session,
      // so if a seller's endpoint ever receives both for one purchase, the second enqueue is deduped
      // by that id and the buyer is granted once.
      case 'checkout.session.async_payment_succeeded':
        return paidSession(object)

      case 'charge.refunded': {
        const transactionId = asString(object.payment_intent)
        if (!transactionId) return null
        const amount = object.amount
        const refunded = object.amount_refunded
        const isFullRefund =
          typeof amount === 'number' && typeof refunded === 'number'
            ? refunded === amount
            : null
        const billing = object.billing_details as
          Record<string, unknown> | undefined
        return {
          event_type: 'refund',
          product_id: productId(object),
          transaction_id: transactionId,
          buyer_email: asString(billing?.email),
          github_username: null,
          is_full_refund: isFullRefund,
        }
      }

      case 'charge.dispute.created': {
        // data.object is a dispute; it carries payment_intent (the same correlation key).
        const transactionId = asString(object.payment_intent)
        if (!transactionId) return null
        return {
          event_type: 'chargeback',
          product_id: productId(object),
          transaction_id: transactionId,
          buyer_email: null,
          github_username: null,
          is_full_refund: null, // chargebacks always revoke under auto_revoke
        }
      }

      default:
        return null // unhandled event type → route returns 400
    }
  },
}
