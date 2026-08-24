// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Gary Stupak

import type { WebhookFixture } from './format'

/**
 * Synthetic Stripe fixtures in the canonical format (test/fixtures/format.ts). Raw bytes are
 * verbatim string literals - the route signs and the adapter parses these exact bytes, so they
 * model a live capture without ever round-tripping through JSON.stringify.
 *
 * SYNTHETIC ONLY - no real captured Stripe payloads in core (Pro-isolation). The shapes
 * follow the provider reference: `payment_intent` is the stable correlation key,
 * carried identically on the session and its later refund/dispute.
 */

const CAPTURE_DATE = '2026-06-16'

function fixture(description: string, raw: string): WebhookFixture {
  return {
    provider: 'stripe',
    capture_date: CAPTURE_DATE,
    synthetic: true,
    description,
    raw,
  }
}

/** checkout.session.completed, paid - username via metadata. → payment_success, pi_test_123. */
export const sessionPaid = fixture(
  'checkout.session.completed (paid), github_username in metadata',
  '{"type":"checkout.session.completed","data":{"object":{"payment_status":"paid","payment_intent":"pi_test_123","customer_details":{"email":"buyer@example.com"},"metadata":{"product_id":"prod_ABC","github_username":"octocat"}}}}',
)

/**
 * checkout.session.completed, paid - includes the checkout session id (cs_...) on `object.id`. The
 * success_url redirect carries this id, NOT the payment_intent, so the adapter maps it to
 * redirect_alias_id for the /claim/by-txn session->txn alias (transaction_id stays the pi_).
 */
export const sessionPaidWithSession = fixture(
  'checkout.session.completed (paid) with checkout session id for the redirect alias',
  '{"type":"checkout.session.completed","data":{"object":{"id":"cs_test_abc","payment_status":"paid","payment_intent":"pi_test_123","metadata":{"product_id":"prod_ABC","github_username":"octocat"}}}}',
)

/** checkout.session.completed, paid - username via a github custom field instead of metadata. */
export const sessionPaidCustomField = fixture(
  'checkout.session.completed (paid), github_username in a custom field',
  '{"type":"checkout.session.completed","data":{"object":{"payment_status":"paid","payment_intent":"pi_cf_1","metadata":{"product_id":"prod_ABC"},"custom_fields":[{"key":"github_username","text":{"value":"viacustomfield"}}]}}}',
)

/** checkout.session.completed, NOT paid - gate rejects it → parse returns null. */
export const sessionUnpaid = fixture(
  'checkout.session.completed (unpaid) - payment_status gate',
  '{"type":"checkout.session.completed","data":{"object":{"payment_status":"unpaid","payment_intent":"pi_unpaid"}}}',
)

/** charge.refunded, full (amount_refunded === amount) → refund, is_full_refund true, same pi. */
export const chargeRefundedFull = fixture(
  'charge.refunded (full) - same payment_intent as sessionPaid',
  '{"type":"charge.refunded","data":{"object":{"payment_intent":"pi_test_123","amount":5000,"amount_refunded":5000,"billing_details":{"email":"buyer@example.com"}}}}',
)

/** charge.refunded, partial (amount_refunded < amount) → refund, is_full_refund false. */
export const chargeRefundedPartial = fixture(
  'charge.refunded (partial)',
  '{"type":"charge.refunded","data":{"object":{"payment_intent":"pi_test_123","amount":5000,"amount_refunded":2000}}}',
)

/** charge.dispute.created → chargeback, is_full_refund null, same pi. */
export const disputeCreated = fixture(
  'charge.dispute.created → chargeback',
  '{"type":"charge.dispute.created","data":{"object":{"payment_intent":"pi_test_123","amount":5000}}}',
)
