// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Gary Stupak

import { DurableObject } from 'cloudflare:workers'

/**
 * Single-flight guard for claim completion (closes the claim over-grant race).
 *
 * The claim token is a bearer credential. Without serialization, two concurrent POSTs of DISTINCT
 * valid handles for the same token both read the (still-present) claim and enqueue distinct
 * `claim_completed` instances → two grants for one purchase (over-grant / invite-spam). KV has no
 * atomic compare-and-swap, so we serialize through a Durable Object keyed by the claim
 * (`{adapter}:{transaction_id}`): a DO is single-threaded, so `acquire()` is atomic.
 *
 * State machine: `idle → processing → (idle on release | granted on finalize)`, with `revoked` as a
 * terminal state reachable from ANY of them.
 *   - route POST calls `acquire()` before enqueuing; a second concurrent submit sees `processing`
 *     and is rejected → at most one grant attempt in flight per claim.
 *   - the workflow terminal step calls `finalize()` on success / non-user-not-found (locked for good;
 *     the token is consumed anyway) or `release()` on user-not-found / transient exhaustion so a
 *     later SEQUENTIAL resubmit with a corrected handle can acquire and run (preserves the corrected-handle retry).
 *   - the revoke path calls `revoke()` when a refund or dispute arrives for this transaction.
 *
 * Why the revocation marker lives HERE and not in KV. A refunded transaction's claim token must stop
 * being redeemable, and the check has to beat two races that KV cannot: a submit already in flight
 * (the claim record is read, the guard is held, the grant record does not exist yet), and KV's
 * eventual consistency (a deleted `claim:{token}` can still read as present for up to ~60s, which is
 * ample time to redeem). This DO is single-threaded and strongly consistent, it is keyed by exactly
 * what a refund event carries (`{adapter}:{transaction_id}`), and `acquire()` is ALREADY on the
 * completion path - so the refusal costs no extra round trip and needs no second key. DO storage also
 * has no TTL, so the marker outlives the 30-day claim window by construction rather than by a TTL
 * someone has to keep in step with CLAIM_TTL_SEC.
 */

export type AcquireResult =
  | { ok: true }
  | { ok: false; code: 'in_progress' | 'already_claimed' | 'revoked' }

type GuardStatus = 'idle' | 'processing' | 'granted' | 'revoked'

export class ClaimGuard extends DurableObject {
  async acquire(): Promise<AcquireResult> {
    const status = (await this.ctx.storage.get<GuardStatus>('status')) ?? 'idle'
    if (status === 'revoked') return { ok: false, code: 'revoked' }
    if (status === 'granted') return { ok: false, code: 'already_claimed' }
    if (status === 'processing') return { ok: false, code: 'in_progress' }
    await this.ctx.storage.put('status', 'processing')
    return { ok: true }
  }

  /** Current state; `idle` when nothing has ever been stored. The grant path reads this to refuse a
   * transaction revoked while its completion was already enqueued. */
  async status(): Promise<GuardStatus> {
    return (await this.ctx.storage.get<GuardStatus>('status')) ?? 'idle'
  }

  /** Allow a sequential retry: only steps back from `processing` (never resurrects `granted`/`revoked`). */
  async release(): Promise<void> {
    if ((await this.ctx.storage.get<GuardStatus>('status')) === 'processing') {
      await this.ctx.storage.put('status', 'idle')
    }
  }

  /** Terminal: the claim is done; no further attempt may acquire. Never downgrades a `revoked`
   * transaction - a refund that lands mid-completion outranks the completion behind it. */
  async finalize(): Promise<void> {
    if ((await this.ctx.storage.get<GuardStatus>('status')) === 'revoked')
      return
    await this.ctx.storage.put('status', 'granted')
  }

  /** Terminal: this transaction was refunded or disputed, so its claim may never be redeemed. Wins
   * from EVERY state, `processing` included - an in-flight submit must not outlive the refund. */
  async revoke(): Promise<void> {
    await this.ctx.storage.put('status', 'revoked')
  }
}

/** Resolve the guard stub for a claim, keyed by adapter + transaction_id (route + workflow both have these). */
export function claimGuard(
  env: CloudflareBindings,
  adapter: string,
  txn: string,
) {
  const ns = env.CLAIM_GUARD
  return ns.get(ns.idFromName(`${adapter}:${txn}`))
}
