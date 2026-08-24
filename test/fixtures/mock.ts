// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Gary Stupak

import type { WebhookFixture } from './format'

/**
 * Synthetic fixtures for the mock reference adapter (test/fixtures/mock-adapter.ts), in the canonical format.
 * Raw bytes verbatim - the route signs and the adapter parses these exact bytes. The order and its
 * refund share `id` ("ord_1") so the transaction_id correlation rule can be asserted.
 */

const CAPTURE_DATE = '2026-06-16'

function fixture(description: string, raw: string): WebhookFixture {
  return {
    provider: 'mock',
    capture_date: CAPTURE_DATE,
    synthetic: true,
    description,
    raw,
  }
}

export const orderPaid = fixture(
  'order.paid with a github_username → payment_success',
  '{"type":"order.paid","id":"ord_1","product":"prod_x","github_username":"octocat"}',
)

export const orderRefundedFull = fixture(
  'order.refunded (full) - same id as orderPaid → refund, is_full_refund true',
  '{"type":"order.refunded","id":"ord_1","product":"prod_x","amount":5000,"amount_refunded":5000}',
)

export const orderRefundedPartial = fixture(
  'order.refunded (partial) → refund, is_full_refund false',
  '{"type":"order.refunded","id":"ord_1","product":"prod_x","amount":5000,"amount_refunded":2000}',
)

export const orderChargeback = fixture(
  'order.chargeback → chargeback, is_full_refund null',
  '{"type":"order.chargeback","id":"ord_1","product":"prod_x"}',
)

export const unknownType = fixture(
  'unhandled event type → parse returns null',
  '{"type":"order.shipped","id":"ord_1","product":"prod_x"}',
)
