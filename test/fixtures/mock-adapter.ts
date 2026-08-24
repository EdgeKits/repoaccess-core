// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Gary Stupak

import type {
  NormalizedEvent,
  PaymentAdapter,
  RawRequest,
} from '../../src/types'

/**
 * Mock reference adapter - a TEST-ONLY `PaymentAdapter` that lives under `test/`, so it is NOT shipped
 * in the published package and is NOT importable from it (only `stripe.ts` ships under `src/adapters/`).
 * It is the synthetic acceptance fixture the test suite relies on: a minimal adapter exercised through
 * the real router. It is never composed into the deployed worker (`src/index.ts`), so it never serves a
 * real route. SYNTHETIC only.
 *
 * Webhook shape (synthetic provider "mock"):
 *   { "type": "order.paid" | "order.refunded" | "order.chargeback",
 *     "id": "<order id>",            // stable correlation key - same on the order and its refund
 *     "product": "<product id>",
 *     "github_username"?: "<handle>",
 *     "amount"?: <int>, "amount_refunded"?: <int> }   // amounts present on order.refunded
 *
 * Verification: HMAC-SHA256 over the raw body (hex), in the `X-Mock-Signature` header.
 */

const SIGNATURE_HEADER = 'x-mock-signature'

/**
 * A real adapter reads its own typed binding via `secret: (env) => env.<NAME>_WEBHOOK_SECRET` (add
 * the var to `.dev.vars`, then `npm run typegen`). The mock exists only as a test fixture and is never
 * deployed, so it uses a synthetic constant secret instead - the tests sign with this same value.
 */
export const MOCK_SECRET = 'mock-signing-secret'

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

export const mock: PaymentAdapter = {
  name: 'mock',

  verification: {
    kind: 'hmac',
    algo: 'SHA-256',
    secret: () => MOCK_SECRET,
    canonical: (raw: RawRequest) => raw.bodyText,
    extract: (headers) => ({ signature: headers.get(SIGNATURE_HEADER) ?? '' }),
  },

  parse: (raw: RawRequest): NormalizedEvent | null => {
    let body: Record<string, unknown>
    try {
      body = JSON.parse(raw.bodyText) as Record<string, unknown>
    } catch {
      return null
    }

    const transactionId = asString(body.id)
    if (!transactionId) return null
    const productId = asString(body.product) ?? ''
    const username = asString(body.github_username)

    switch (body.type) {
      case 'order.paid':
        return {
          event_type: 'payment_success',
          product_id: productId,
          transaction_id: transactionId,
          buyer_email: null,
          github_username: username,
          is_full_refund: null,
        }

      case 'order.refunded': {
        const amount = body.amount
        const refunded = body.amount_refunded
        const isFullRefund =
          typeof amount === 'number' && typeof refunded === 'number'
            ? refunded === amount
            : null
        return {
          event_type: 'refund',
          product_id: productId,
          transaction_id: transactionId,
          buyer_email: null,
          github_username: null,
          is_full_refund: isFullRefund,
        }
      }

      case 'order.chargeback':
        return {
          event_type: 'chargeback',
          product_id: productId,
          transaction_id: transactionId,
          buyer_email: null,
          github_username: null,
          is_full_refund: null, // chargebacks always revoke under auto_revoke
        }

      default:
        return null // unhandled type → route returns 400
    }
  },
}
