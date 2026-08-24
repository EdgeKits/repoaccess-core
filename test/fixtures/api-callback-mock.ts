// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Gary Stupak

import type {
  NormalizedEvent,
  PaymentAdapter,
  RawRequest,
  VerifiedEntity,
} from '../../src/types'

/**
 * Synthetic `api_callback` adapter - TEST-ONLY, never composed into a deployed entry, never shipped
 * (the `files` allowlist excludes `test/`). It exercises the core api_callback contract end-to-end
 * with NO real provider: the inbound ping carries only a lookup id; `fetchEntity` does the (mocked)
 * provider GET; `parse` maps the grant from the FETCHED entity, never the ping body.
 *
 * Mirrors the shape a real api_callback adapter takes, minus provider specifics.
 */

export const CB_SECRET_PATH = 'sekret-path-abc123'
export const CB_PROVIDER_API = 'https://api.example.test/v1/sales'

/** Build a form-urlencoded ping body carrying the sale id (what the provider POSTs). */
export function pingBody(saleId: string): string {
  return new URLSearchParams({ sale_id: saleId, seller_id: 's_1' }).toString()
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

export function apiCallbackMock(): PaymentAdapter {
  return {
    name: 'cbmock',

    verification: {
      kind: 'api_callback',
      // Self-describing path credential (mirrors hmac's secret). A test reads a synthetic constant
      // instead of an env var, because this adapter is never deployed.
      secretPath: () => CB_SECRET_PATH,
      // Outbound fetch of the authoritative entity - runs in the Workflow, mocked via global fetch in
      // tests. A non-2xx (forged/unknown id) → null → terminal reject (never-trust anchor).
      fetchEntity: async (raw: RawRequest): Promise<VerifiedEntity | null> => {
        const id = raw.bodyForm?.get('sale_id') ?? ''
        const res = await fetch(`${CB_PROVIDER_API}/${encodeURIComponent(id)}`)
        if (!res.ok) return null
        return (await res.json()) as VerifiedEntity
      },
    },

    // Maps the FETCHED entity (arg 2), never `raw`. `kind` drives the event type.
    parse: (
      _raw: RawRequest,
      entity?: VerifiedEntity,
    ): NormalizedEvent | null => {
      if (!entity) return null
      const e = entity as Record<string, unknown>
      const txn = asString(e.id)
      if (!txn) return null
      if (e.kind === 'sale') {
        return {
          event_type: 'payment_success',
          product_id: asString(e.product_id) ?? '',
          transaction_id: txn,
          buyer_email: asString(e.email),
          github_username: asString(e.github_username),
          is_full_refund: null,
        }
      }
      if (e.kind === 'refund') {
        return {
          event_type: 'refund',
          product_id: asString(e.product_id) ?? '',
          transaction_id: txn,
          buyer_email: null,
          github_username: null,
          is_full_refund: e.is_full_refund === true,
        }
      }
      return null // unhandled entity kind → terminal access.failed in the workflow
    },
  }
}
