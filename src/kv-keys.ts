// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Gary Stupak

// Centralized ENTITLEMENTS key builders + TTL. Shared by the grant/revoke workflow and
// the claim flow so the wire formats can never drift apart.

export const CLAIM_TTL_SEC = 30 * 24 * 60 * 60 // 30 days

// 180 days - covers the refund window + the ~120d card-chargeback window, and bounds KV accumulation
// so records don't grow unbounded.
export const GRANT_TTL_SEC = 180 * 24 * 60 * 60

// 24 hours - a terminal grant-failure marker so a buyer returning to /claim/by-txn within a day sees
// the `failed` state instead of perpetual `pending`. Deliberately short: this is a transient,
// best-effort UX signal; the authoritative failure record is the emitted access.failed event.
export const FAIL_TTL_SEC = 24 * 60 * 60

// 5 minutes - a short-lived "claim completing" marker written when a buyer submits a handle, so
// /claim/by-txn shows the polling `pending` view (not a 302 back to the still-present claim form) while
// the async grant runs. Only needs to bridge the ~1.5s grant + the ~60s KV miss-cache window; the
// workflow clears it on any terminal/fallback outcome, and this TTL is the backstop so it never lingers.
export const CLAIM_SUBMITTED_TTL_SEC = 5 * 60

/** Grant correlation record - 180d TTL, also deleted on revoke. */
export const grantKey = (adapter: string, txn: string) =>
  `grant:${adapter}:${txn}`

/** Pending claim by single-use token. */
export const claimKey = (token: string) => `claim:${token}`

/** Reverse index so revoke can find a still-pending claim by transaction (KV can't query by value). */
export const claimIndexKey = (adapter: string, txn: string) =>
  `claim_txn:${adapter}:${txn}`

/**
 * Terminal grant-failure marker, keyed by transaction so /claim/by-txn can show a `failed` state for a
 * doomed transaction instead of looping on `pending`. Value is the coarse, non-sensitive failure code
 * only (never handle/teams/secret). FAIL_TTL_SEC; written by the workflow's terminal-failure paths.
 */
export const failKey = (adapter: string, txn: string) =>
  `fail:${adapter}:${txn}`

/**
 * Short-lived "claim completing" marker, keyed by transaction. Written by `completeClaim` on a
 * successful grant enqueue; read by `resolveByTxn` (BEFORE the claim key) so a just-submitted claim
 * shows the polling "setting up" page instead of bouncing back to the still-present claim form.
 * Existence is all that matters (the value is a fixed sentinel; never handle/teams/secret). Cleared by
 * the workflow on any terminal/fallback outcome; CLAIM_SUBMITTED_TTL_SEC is the backstop.
 */
export const claimSubmittedKey = (adapter: string, txn: string) =>
  `claim_submitted:${adapter}:${txn}`

/**
 * Alias index: a merchant redirect id (e.g. Stripe checkout session id cs_...) -> transaction_id, so
 * /claim/by-txn resolves a redirect whose id differs from the claim/grant key. GRANT_TTL_SEC so it
 * outlives both the claim and the grant window. Adapters whose redirect id IS the transaction_id
 * write no alias.
 */
export const sessionTxnKey = (adapter: string, id: string) =>
  `session_txn:${adapter}:${id}`
