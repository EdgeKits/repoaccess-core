// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Gary Stupak

import type {
  NormalizedEvent,
  PaymentAdapter,
  RawRequest,
} from '../../src/types'

/**
 * Synthetic `shared_secret_header` adapter - TEST-ONLY, never composed into a deployed entry, never
 * shipped (the `files` allowlist excludes `test/`). It exercises the core shared_secret_header
 * contract + the optional `handle()` hook end-to-end with NO real provider and ZERO provider
 * specifics: a generic bot-style webhook whose authenticity is a shared secret echoed in a header
 * (no HMAC, no entity re-fetch), and an interactive two-step flow where one update shape is a
 * handshake the adapter answers in `handle()` and another is the terminal event that flows through
 * `parse → enqueue`.
 *
 * Synthetic webhook shapes (JSON body, provider "sshmock"):
 *   { "kind": "handshake", "id": "<query id>" }                         // answered by handle() → Response
 *   { "kind": "payment", "id": "<txn>", "product": "<id>", "username"?: "<handle>" }  // parse() → grant
 *
 * Verification: a shared secret echoed in the `X-Test-Secret-Token` header, timing-safe compared
 * against the configured secret. The secret authenticates the transport; once it matches, the body
 * is authentic and read directly (no fetch).
 */

export const SSH_SECRET = 'shared-secret-token-xyz'
export const SSH_HEADER = 'x-test-secret-token'

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/**
 * Build the adapter. `withHandle: false` produces an otherwise-identical adapter that OMITS the
 * optional hook - used to prove a shared_secret_header adapter without `handle()` still verifies +
 * parses + enqueues unchanged.
 */
export function sharedSecretMock({
  withHandle = true,
}: { withHandle?: boolean } = {}): PaymentAdapter {
  const adapter: PaymentAdapter = {
    name: 'sshmock',

    verification: {
      kind: 'shared_secret_header',
      header: SSH_HEADER,
      // Self-describing secret (mirrors hmac's secret). A test reads a synthetic constant instead of
      // an env var, because this adapter is never deployed.
      secret: () => SSH_SECRET,
    },

    parse: (raw: RawRequest): NormalizedEvent | null => {
      let body: Record<string, unknown>
      try {
        body = JSON.parse(raw.bodyText) as Record<string, unknown>
      } catch {
        return null
      }
      // Only the terminal payment shape maps to an event; a handshake reaching parse (e.g. when the
      // no-handle variant is used) is an unhandled type → null → route 400.
      if (body.kind !== 'payment') return null
      const txn = asString(body.id)
      if (!txn) return null
      return {
        event_type: 'payment_success',
        product_id: asString(body.product) ?? '',
        transaction_id: txn,
        buyer_email: null,
        github_username: asString(body.username),
        is_full_refund: null,
      }
    },
  }

  if (withHandle) {
    // Interactive-handshake hook: answer the handshake update (return a Response = the ack, no
    // enqueue); let the terminal payment update fall through to parse → enqueue (return null).
    adapter.handle = async (raw: RawRequest): Promise<Response | null> => {
      let body: Record<string, unknown>
      try {
        body = JSON.parse(raw.bodyText) as Record<string, unknown>
      } catch {
        return null
      }
      if (body.kind === 'handshake') {
        // The adapter's own bounded ack back to the provider would happen here; the synthetic just
        // returns the 200 the router relays as the webhook ack.
        return new Response(JSON.stringify({ ok: true, answered: body.id }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return null
    }
  }

  return adapter
}

/** A POST RequestInit carrying the valid shared secret header over `body`. */
export function secretHeaderPost(
  body: string,
  header: Record<string, string> = { [SSH_HEADER]: SSH_SECRET },
): RequestInit {
  return { method: 'POST', body, headers: header }
}
