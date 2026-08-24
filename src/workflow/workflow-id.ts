// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Gary Stupak

/**
 * Cloudflare Workflows instance-id constraints. Verified against BOTH the public docs
 * (workflows/build/workers-api: "up to 100 characters") and the bundled `workflows-shared`
 * runtime that miniflare/production use:
 *
 *   ALLOWED_STRING_ID_PATTERN = "^[a-zA-Z0-9_][a-zA-Z0-9-_]*$"   (max 100 chars)
 *
 * Allowed: letters, digits, `_`, `-`. NOTABLY the colon `:` from the original id scheme's
 * `{adapter}:{event_type}:{transaction_id}` is REJECTED ("Workflow instance has invalid id").
 */
export const WORKFLOW_INSTANCE_ID_PATTERN = /^[a-zA-Z0-9_][a-zA-Z0-9_-]*$/
export const MAX_WORKFLOW_INSTANCE_ID_LENGTH = 100

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(input),
  )
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * How much of the purchase a refund event says came back, as the id sees it.
 *
 * It is a TRI-STATE and every value is an answer: `full` and `partial` are what the provider reported,
 * `unknown` is the provider declining to say (`is_full_refund: null`). There is deliberately no
 * "absent" member: every refund maps to one of these three, so no argument a caller can pass will
 * produce a scopeless refund id.
 */
export type RefundScope = 'full' | 'partial' | 'unknown'

/** The engine's only question to a refund, in the id's vocabulary. */
export function refundScopeOf(isFullRefund: boolean | null): RefundScope {
  if (isFullRefund === true) return 'full'
  if (isFullRefund === false) return 'partial'
  return 'unknown'
}

/**
 * Build the deterministic Workflow instance id = the idempotency key. Components are
 * joined with `-` (the `:` separator is rejected by the runtime). `adapter` and `eventType` come from a
 * fixed, charset-safe vocabulary; `transactionId` is provider-defined and may (for some future
 * provider) contain out-of-charset characters or be very long.
 *
 * Security-gate decision (availability): do NOT throw on such a transactionId - a
 * thrown id denies a paying buyer access AND makes the webhook retry forever. Instead fall back to a
 * SHA-256 hash of the transaction_id: always charset-valid, length-bounded, and collision-resistant
 * (so dedupe stays correct - unlike lossy character-sanitization). Deterministic, so the same txn
 * always yields the same id (idempotency holds). The readable form is kept for the common case
 * (e.g. Stripe `payment_intent`, which is charset-safe).
 *
 * A REFUND ID ALSO CARRIES ITS SCOPE, and that suffix is the whole reason a refund paid in stages
 * works. The id used to be `{adapter}-refund-{txn}` for every refund on a transaction. Under
 * `full_refund_only` a partial refund runs and correctly skips the revoke; when a later event
 * completed the amount it carried the same transaction, built the same id, and `createBatch` dedupled
 * it away in silence - so a fully refunded buyer kept their access, which is the one case that flag
 * exists to handle. The engine's only question to a refund is "is it full NOW", and the answer already
 * rides on the event, so the id asks it too: a retry of one delivery reports the same answer, keeps
 * its id and still dedups; a completion flips `partial` to `full`, mints a new id, and the revoke
 * runs. Grant and chargeback ids are untouched - the suffix is gated on the event type, not on the
 * field, so a stray `is_full_refund` on a non-refund cannot move them.
 *
 * `isFullRefund` is REQUIRED rather than optional, and that is the safety property, not a style
 * choice: an enqueue site that forgets the scope does not quietly produce an old-shaped id, it fails
 * to compile. Non-refund callers pass `null` and it is ignored.
 *
 * DEPLOY SAFETY. No step shape changes and no stored record changes, so a deploy carrying this needs
 * no migration and no drain. The one behavioural effect is at the boundary: an event arriving after
 * the deploy builds a new-shape id, so it does NOT collide with an old-shape instance that already
 * ran for the same transaction, and a revoke can therefore run a second time. That is safe by
 * construction - revoke is reconciliation against LIVE GitHub state (a membership already removed
 * reads as gone and the DELETE is a no-op), which is the same property that makes every retry in this
 * engine harmless. The reverse case, an old-shape instance still in flight, is unaffected: it keeps
 * its own id and finishes normally.
 */
export async function workflowInstanceId(
  adapter: string,
  eventType: string,
  transactionId: string,
  isFullRefund: boolean | null,
): Promise<string> {
  // Gated on the event type, and the suffix joins BEFORE the length check so a readable id that only
  // fits without its scope is correctly sent down the hash path rather than shipped scopeless.
  const suffix = eventType === 'refund' ? `-${refundScopeOf(isFullRefund)}` : ''
  const readable = `${adapter}-${eventType}-${transactionId}${suffix}`
  if (
    readable.length <= MAX_WORKFLOW_INSTANCE_ID_LENGTH &&
    WORKFLOW_INSTANCE_ID_PATTERN.test(readable)
  ) {
    return readable
  }
  const digest = await sha256Hex(transactionId)
  // adapter + eventType are controlled vocab (charset-safe); the slice guards the pathological length.
  // Room is reserved for the suffix and it is appended AFTER, because both scopes of one transaction
  // hash the same digest - a suffix lost to the slice here would restore the whole defect for exactly
  // the providers whose transaction ids are awkward.
  const hashed = `${adapter}-${eventType}-${digest}`.slice(
    0,
    MAX_WORKFLOW_INSTANCE_ID_LENGTH - suffix.length,
  )
  return `${hashed}${suffix}`
}

/**
 * Deterministic Workflow id for an `api_callback` ping. The event_type and transaction_id are
 * UNKNOWN before the entity is fetched (which happens in the Workflow, not on the ack path), so the
 * id hashes the RAW ping body instead: identical retried pings collide → idempotent dedupe (the same
 * `createBatch` guarantee as hmac); distinct events (sale vs refund vs dispute → different bodies)
 * hash to distinct ids. `apicallback` is a fixed, charset-safe event-type slot. The SHA-256 hex is
 * charset-safe and length-bounded; `adapter` is controlled vocab (slice guards a pathological name).
 */
export async function apiCallbackInstanceId(
  adapter: string,
  rawBody: string,
): Promise<string> {
  const digest = await sha256Hex(rawBody)
  return `${adapter}-apicallback-${digest}`.slice(
    0,
    MAX_WORKFLOW_INSTANCE_ID_LENGTH,
  )
}
