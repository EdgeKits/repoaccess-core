// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Gary Stupak

import { DurableObject } from 'cloudflare:workers'
import { revokeGate } from '../config/config'
import { GRANT_TTL_SEC } from '../kv-keys'
import type { GrantOrigin, RevokePolicy } from '../types'

/**
 * The per-transaction guard: claim single-flight, and the ledger of the transaction's outcome.
 *
 * The claim token is a bearer credential. Without serialization, two concurrent POSTs of DISTINCT
 * valid handles for the same token both read the (still-present) claim and enqueue distinct
 * `claim_completed` instances → two grants for one purchase (over-grant / invite-spam). KV has no
 * atomic compare-and-swap, so we serialize through a Durable Object keyed by the transaction
 * (`{adapter}:{transaction_id}`): a DO is single-threaded, so every method here is atomic.
 *
 * State machine. `idle → processing` on `acquire()` (the claim route), and back to `idle` on
 * `release()` (a buyer-correctable failure or a transient exhaustion, so a sequential corrected
 * resubmit can acquire). `commitGrant()` is the ONLY way to reach `granted`, from `idle` or
 * `processing`, and a grant in either mode calls it once its work is done. `finalize()` reaches
 * `closed`: a claim completion that failed for good, locked with no grant behind it. `revoked` is
 * terminal and reachable from every state, through `revoke()`, through `revokeUnlessGranted()` from
 * any state but `granted`, or through `commitGrant()` finding that a recorded refund revokes this
 * product. `granted` and `closed` answer the claim route exactly
 * as a completed claim always has (`already_claimed`).
 *
 * Why the ledger lives HERE and not in KV. KV is eventually consistent: a key written in one location
 * can read as absent from another for up to about 60 seconds, which is ample time both to redeem a
 * deleted `claim:{token}` and for a refund to conclude that a grant written seconds ago does not
 * exist. This DO is strongly consistent and keyed by exactly what a refund event carries, so a
 * committed grant keeps a COPY of what was granted here (the KV grant record is still written, and
 * still what its other readers use), and a revoke asks the guard before it asks KV. DO storage has no
 * TTL, so the revocation marker outlives the claim window by construction.
 *
 * HOW LONG AN OBJECT LIVES. One rule, carried out by `alarm()`:
 *   - An object that has COMMITTED a grant keeps `status` and `sequence` for good, because they are the
 *     ledger of a real purchase; only its copy of the grant expires, at `granted_at + GRANT_TTL_SEC`, the
 *     moment the KV record it mirrors expires.
 *   - An object that has NEVER committed a grant - refund facts for a charge this worker never sold, a
 *     `revoked` tombstone for a refund that arrived before its grant, a claim lock that was released or
 *     closed - expires ENTIRELY `GRANT_TTL_SEC` after its last write. Stripe reports refunds for every
 *     charge on the account, so without this the population of such objects would grow for as long as the
 *     account exists.
 * The window is safe for the second kind: no legitimate grant arrives more than the grant record's own
 * retention after its refund, and a claim token lives 30 days, so a `processing` or `closed` lock that
 * old belongs to nothing. "Committed" needs no marker of its own: only `granted` and `revoked` mint a
 * sequence, and `revoked` is terminal, so an object has committed exactly when it is `granted`, or
 * `revoked` with a sequence of 2 or more (`granted` came first). `acquire()` does not arm the expiry; an
 * acquired lock is always followed by a commit, a release or a close, each of which does.
 *
 * BOTH WRITERS OF THE LEDGER CHECK AS THEY WRITE. A refund cannot know which product was sold, so its
 * first step records the FACTS of the refund (`recordRefund`) and reads back, in the same call, whether
 * a grant has already been committed. The grant passes its own product's policy into `commitGrant`,
 * which applies it to any recorded facts in the same atomic call. Whichever of the two writes second
 * sees the first.
 *
 * Every transition into `granted` or `revoked` mints the next value of a per-transaction `sequence`,
 * at most once per transition. The events those transitions decide carry it, so a consumer can tell
 * which of two events for one transaction is current whatever order they arrived in.
 *
 * THE SAME CLASS ALSO SERVES A SECOND ROLE: THE BUYER'S LEDGER. An object addressed as
 * `buyer:{github login, lowercased}` records which teams each of that buyer's transactions entitles,
 * so a revoke can keep a team another purchase still entitles (a purchase and its renewal, an item and
 * a bundle containing it, two price points for one repository). A transaction guard cannot answer that:
 * it knows one transaction and nothing about the buyer's others. The ledger needs exactly what this
 * class already is - a strongly consistent, single-threaded object whose every method is atomic - and
 * living in the class that already exists means the upgrade is a deploy: no new binding, no new class,
 * no migration for anyone who runs this worker.
 *
 * The two roles never share state. A ledger object carries `role: 'buyer_ledger'` and keeps its entries
 * under `ledger:{adapter}:{transaction_id}`; a transaction object carries no role key (every object
 * written before the ledger existed is a transaction object) and never has a `ledger:` key. Every method
 * checks the role it is called under and throws on the wrong one, `alarm()` dispatches on it, and the
 * ledger's methods refuse an object that already holds transaction state.
 *
 * An entry is REGISTERED by the grant after its entry check and before its first GitHub write, and it
 * counts from that moment, committed or not: a grant still in flight will write the team, so a refund
 * running beside it must not remove that team first. A revoke removes its own entry and, in the same
 * call, learns which teams the remaining entries entitle. Because an in-flight entry may never commit,
 * a team the revoke keeps on another entry's account, and that the revoked grant itself wrote, is
 * recorded on that entry as a DEBT, and so is a team the revoke re-issues an invitation for; a grant that
 * ends without committing removes its entry and withdraws the debts no remaining entry backs. Nothing is withdrawn merely because the ledger does not back it.
 * A transaction the ledger has never heard of (a grant made before the ledger existed) is UNKNOWN to it,
 * never "not entitled": removing it changes nothing and records no debt, and nothing in the ledger speaks
 * for it, so a refund of it removes its teams exactly as before unless a registered purchase still
 * entitles them. Each entry expires `GRANT_TTL_SEC` after registration, with the grant record it stands
 * beside.
 */

export type AcquireResult =
  | { ok: true }
  | { ok: false; code: 'in_progress' | 'already_claimed' | 'revoked' }

export type GuardStatus =
  'idle' | 'processing' | 'granted' | 'closed' | 'revoked'

/** What a refund or dispute event said, with no judgement about what it should do. */
export interface RefundFacts {
  event_type: 'refund' | 'chargeback'
  is_full_refund: boolean | null
}

/** The guard's copy of a committed grant: the same facts the KV grant record carries. */
export interface GrantCopy {
  github_username: string
  org: string
  teams: string[]
  product_id: string
  granted_at: string
  origin?: GrantOrigin
}

/**
 * The guard's whole state, as one read. `refunds` is empty when no refund has been recorded;
 * `sequence` is the number minted by the transition into the current status, 0 before any; `grant`
 * is the committed copy, null when there is none (never committed, or cleared by a revoke).
 */
export interface GuardSnapshot {
  status: GuardStatus
  refunds: RefundFacts[]
  sequence: number
  grant: GrantCopy | null
}

export type CommitResult =
  | { committed: true; sequence: number }
  | { committed: false; snapshot: GuardSnapshot }

/**
 * One transaction in a buyer's ledger: the teams it entitles and when the entry lapses; which of them
 * its grant wrote (absent until the grant has written them); and the teams a revoke kept on its account
 * and that its end must withdraw if it never commits.
 */
export interface LedgerEntry {
  teams: string[]
  expires_at: number
  written?: string[]
  owed?: string[]
}

function unionOfTeams(entries: Iterable<LedgerEntry>): string[] {
  const teams = new Set<string>()
  for (const entry of entries) for (const slug of entry.teams) teams.add(slug)
  return [...teams]
}

const LEDGER_ROLE = 'buyer_ledger'
const LEDGER_PREFIX = 'ledger:'
// Every key a transaction object can hold. A ledger method finding any of them refuses to run.
const TRANSACTION_KEYS = [
  'status',
  'refunds',
  'sequence',
  'grant',
  'last_write_at',
]

export class ClaimGuard extends DurableObject {
  async acquire(): Promise<AcquireResult> {
    await this.asTransaction()
    const status = (await this.ctx.storage.get<GuardStatus>('status')) ?? 'idle'
    if (status === 'revoked') return { ok: false, code: 'revoked' }
    if (status === 'granted' || status === 'closed')
      return { ok: false, code: 'already_claimed' }
    if (status === 'processing') return { ok: false, code: 'in_progress' }
    await this.ctx.storage.put('status', 'processing')
    return { ok: true }
  }

  /** Current state; `idle` when nothing has ever been stored. */
  async status(): Promise<GuardStatus> {
    await this.asTransaction()
    return this.currentStatus()
  }

  /** Allow a sequential retry: only steps back from `processing` (never resurrects a settled state). */
  async release(): Promise<void> {
    await this.asTransaction()
    if ((await this.currentStatus()) === 'processing') {
      await this.ctx.storage.put('status', 'idle')
      await this.armUncommittedExpiry()
    }
  }

  /** Lock a claim that failed for good, with no grant behind it: no further attempt may acquire.
   * Never overwrites a settled outcome - `granted` or `revoked`. */
  async finalize(): Promise<void> {
    await this.asTransaction()
    const status = await this.currentStatus()
    if (status === 'revoked' || status === 'granted') return
    await this.ctx.storage.put('status', 'closed')
    await this.armUncommittedExpiry()
  }

  /**
   * Commit a finished grant, atomically. If the transaction is already `revoked`, or a recorded refund
   * revokes it under `policy` (the granted product's own), nothing is committed: the status becomes
   * `revoked` and the snapshot is returned so the grant can withdraw itself. Otherwise the status
   * becomes `granted`, the copy is stored, and the sequence minted for that transition is returned. A
   * repeat commit of an already `granted` transaction refreshes the copy and mints nothing.
   */
  async commitGrant(
    grant: GrantCopy,
    policy: RevokePolicy,
  ): Promise<CommitResult> {
    await this.asTransaction()
    const status = await this.currentStatus()
    const refunds = await this.recordedRefunds()
    if (
      status === 'revoked' ||
      refunds.some((facts) => revokeGate(policy, facts) === 'revoke')
    ) {
      if (status !== 'revoked') await this.transition('revoked')
      return { committed: false, snapshot: await this.snapshot() }
    }
    if (status === 'granted') {
      await this.ctx.storage.put('grant', grant)
      await this.scheduleCopyExpiry(grant)
      return { committed: true, sequence: await this.currentSequence() }
    }
    const sequence = await this.transition('granted', { grant })
    await this.scheduleCopyExpiry(grant)
    return { committed: true, sequence }
  }

  /**
   * Terminal: this transaction was refunded or disputed, so its claim may never be redeemed. Wins
   * from EVERY state, `processing` included - an in-flight submit must not outlive the refund. The
   * facts of the refund that decided it are kept alongside when the caller has them. Returns the
   * sequence of the transition into `revoked`; revoking an already revoked transaction mints nothing.
   */
  async revoke(facts?: RefundFacts): Promise<number> {
    await this.asTransaction()
    if (facts) await this.appendRefund(facts)
    const sequence =
      (await this.currentStatus()) === 'revoked'
        ? await this.currentSequence()
        : await this.transition('revoked')
    await this.armUncommittedExpiry()
    return sequence
  }

  /**
   * Record that a refund or dispute arrived, WITHOUT deciding anything, and return the state that
   * results, in one call. The status is untouched, so the claim route and every non-revoking policy
   * behave exactly as if nothing were stored. Every distinct refund is kept, so a partial refund
   * recorded after a full one cannot hide the full one.
   *
   * This is the refund's first write, and it checks as it writes. A grant that commits after it finds
   * these facts and judges them with its own product's policy; a grant that committed before it is in
   * the returned snapshot, `granted` with its copy, for the refund to withdraw. No grant can commit in
   * a gap between the two, because there is none.
   */
  async recordRefund(facts: RefundFacts): Promise<GuardSnapshot> {
    await this.asTransaction()
    await this.appendRefund(facts)
    await this.armUncommittedExpiry()
    return this.snapshot()
  }

  /**
   * The refund's verdict, for when its own event names a product whose policy revokes and nothing else
   * says what was sold: record the facts and move to `revoked`, UNLESS a grant has been committed, in
   * which case the status is left alone and the snapshot, with the grant's copy, is returned so the
   * caller judges the refund by the product that grant actually sold. Minting follows `revoke()`.
   */
  async revokeUnlessGranted(facts: RefundFacts): Promise<GuardSnapshot> {
    await this.asTransaction()
    await this.appendRefund(facts)
    const status = await this.currentStatus()
    if (status !== 'granted' && status !== 'revoked')
      await this.transition('revoked')
    await this.armUncommittedExpiry()
    return this.snapshot()
  }

  /** Drop the committed copy once a revoke has withdrawn it, with its expiry. The status stays. */
  async clearGrant(): Promise<void> {
    await this.asTransaction()
    await this.ctx.storage.delete('grant')
    await this.ctx.storage.deleteAlarm()
  }

  /**
   * The object's expiry, both kinds (see the rule at the top of this file). An alarm can run late or be
   * retried, so it re-reads the state and acts only once due, rescheduling otherwise.
   *   - Committed: delete only the copy, at `granted_at + GRANT_TTL_SEC` (a repeat commit may have moved
   *     `granted_at`). It holds the buyer's GitHub handle and must not outlive the record it mirrors.
   *     `status` and `sequence` stay.
   *   - Never committed: delete ALL storage once `GRANT_TTL_SEC` has passed since the last write. An
   *     object with no storage is an object that no longer exists. One written before this rule has no
   *     last-write time and is left alone.
   * A buyer's ledger has an expiry of its own, per entry (see `expireLedger`).
   */
  async alarm(): Promise<void> {
    if (await this.isLedger()) return this.expireLedger()
    if (await this.hasCommitted()) {
      const grant = await this.ctx.storage.get<GrantCopy>('grant')
      if (!grant) return
      const expiresAt = copyExpiresAt(grant)
      if (expiresAt <= Date.now()) await this.ctx.storage.delete('grant')
      else await this.ctx.storage.setAlarm(expiresAt)
      return
    }
    const lastWriteAt = await this.ctx.storage.get<number>('last_write_at')
    if (lastWriteAt === undefined) return
    const expiresAt = lastWriteAt + GRANT_TTL_SEC * 1000
    if (expiresAt <= Date.now()) {
      await this.ctx.storage.deleteAlarm()
      await this.ctx.storage.deleteAll()
    } else await this.ctx.storage.setAlarm(expiresAt)
  }

  // --- the buyer's ledger (role `buyer_ledger`, see the top of this file) ---

  /**
   * Record that transaction `key` (`{adapter}:{transaction_id}`) entitles `teams`. Called by a grant
   * after its entry check and before its first GitHub write. Registering a key that is already present
   * changes nothing, so a replayed step cannot move an entry's expiry.
   */
  async registerGrant(key: string, teams: string[]): Promise<void> {
    await this.asLedger()
    const entryKey = LEDGER_PREFIX + key
    if ((await this.ctx.storage.get<LedgerEntry>(entryKey)) !== undefined)
      return
    const entry: LedgerEntry = {
      teams: [...teams],
      expires_at: Date.now() + GRANT_TTL_SEC * 1000,
    }
    await this.ctx.storage.put({ role: LEDGER_ROLE, [entryKey]: entry })
    const alarm = await this.ctx.storage.getAlarm()
    if (alarm === null || alarm > entry.expires_at)
      await this.ctx.storage.setAlarm(entry.expires_at)
  }

  /**
   * Record which of its teams transaction `key`'s grant WROTE - found absent and added - as opposed to
   * found already present. Called with the grant record, after the last GitHub write. Only a team a
   * grant wrote can become a debt when that grant is revoked (see `withdrawGrant`). An absent entry is
   * left alone, and a repeat call writes the same value.
   */
  async recordWritten(key: string, written: string[]): Promise<void> {
    await this.asLedger()
    const entryKey = LEDGER_PREFIX + key
    const entry = await this.ctx.storage.get<LedgerEntry>(entryKey)
    if (entry === undefined) return
    await this.ctx.storage.put(entryKey, { ...entry, written: [...written] })
  }

  /**
   * A revoke's one ledger call. Remove transaction `key`'s entry and return, atomically:
   *   - `entitled`: every team the buyer's remaining entries (committed or in flight) entitle;
   *   - `kept`: those of `teams` (the revoked grant's) among them, which the revoke must leave in place.
   * A kept team that the revoked grant WROTE is a DEBT: it is recorded as `owed` on every remaining entry
   * that backs it, so that if the one backing it turns out never to commit, its end withdraws the team
   * (see `releaseGrant`). A kept team the revoked grant only found present is not a debt: something the
   * ledger may not know about (a purchase granted before it existed) put it there.
   *
   * Removing a key that is absent - a transaction removed before, or never registered - adds no debt and
   * returns the same answer, so a replay changes nothing. An object never registered into is not written.
   */
  async withdrawGrant(
    key: string,
    teams: string[],
  ): Promise<{ entitled: string[]; kept: string[] }> {
    await this.asLedger()
    const entryKey = LEDGER_PREFIX + key
    const removed = await this.ctx.storage.get<LedgerEntry>(entryKey)
    if (removed !== undefined) await this.ctx.storage.delete(entryKey)
    const remaining = await this.liveEntries()
    if (remaining.size === 0) {
      if (await this.isLedger()) {
        await this.ctx.storage.deleteAlarm()
        await this.ctx.storage.deleteAll()
      }
      return { entitled: [], kept: [] }
    }
    const entitled = unionOfTeams(remaining.values())
    const kept = teams.filter((slug) => entitled.includes(slug))
    const debts = kept.filter((slug) => removed?.written?.includes(slug))
    for (const [otherKey, entry] of remaining) {
      const owed = debts.filter((slug) => entry.teams.includes(slug))
      if (owed.length === 0) continue
      const merged = [...new Set([...(entry.owed ?? []), ...owed])]
      await this.ctx.storage.put(otherKey, { ...entry, owed: merged })
    }
    return { entitled, kept }
  }

  /**
   * Record `teams` as debts on every live entry that entitles them: a revoke has just put those teams in
   * place again on the entries' account (it re-issued a cancelled invitation for them), so a grant among
   * those entries that never commits must withdraw them. Recording a debt already recorded changes nothing.
   */
  async recordDebts(teams: string[]): Promise<void> {
    await this.asLedger()
    for (const [entryKey, entry] of await this.liveEntries()) {
      const owed = teams.filter((slug) => entry.teams.includes(slug))
      const merged = [...new Set([...(entry.owed ?? []), ...owed])]
      if (merged.length === (entry.owed ?? []).length) continue
      await this.ctx.storage.put(entryKey, { ...entry, owed: merged })
    }
  }

  /**
   * A grant's end WITHOUT a commit. Remove transaction `key`'s entry and return, atomically:
   *   - `owed`: the debts recorded on it that no remaining entry backs, which the grant must withdraw;
   *   - `entitled`: every team the remaining entries entitle.
   * A second call finds no entry and owes nothing. An object never registered into is not written.
   */
  async releaseGrant(
    key: string,
  ): Promise<{ owed: string[]; entitled: string[] }> {
    await this.asLedger()
    const entryKey = LEDGER_PREFIX + key
    const released = await this.ctx.storage.get<LedgerEntry>(entryKey)
    if (released !== undefined) await this.ctx.storage.delete(entryKey)
    const remaining = await this.liveEntries()
    if (remaining.size === 0 && (await this.isLedger())) {
      await this.ctx.storage.deleteAlarm()
      await this.ctx.storage.deleteAll()
    }
    const entitled = unionOfTeams(remaining.values())
    const owed = (released?.owed ?? []).filter(
      (slug) => !entitled.includes(slug),
    )
    return { owed, entitled }
  }

  /** Drop every lapsed entry; an object left with none no longer exists. Reschedules for the next. */
  private async expireLedger(): Promise<void> {
    const now = Date.now()
    const entries = await this.ctx.storage.list<LedgerEntry>({
      prefix: LEDGER_PREFIX,
    })
    const lapsed = [...entries]
      .filter(([, entry]) => entry.expires_at <= now)
      .map(([entryKey]) => entryKey)
    if (lapsed.length === entries.size) {
      await this.ctx.storage.deleteAlarm()
      await this.ctx.storage.deleteAll()
      return
    }
    if (lapsed.length > 0) await this.ctx.storage.delete(lapsed)
    const next = Math.min(
      ...[...entries]
        .filter(([entryKey]) => !lapsed.includes(entryKey))
        .map(([, entry]) => entry.expires_at),
    )
    await this.ctx.storage.setAlarm(next)
  }

  /** The entries that have not lapsed. A lapsed entry awaiting its alarm entitles nothing. */
  private async liveEntries(): Promise<Map<string, LedgerEntry>> {
    const now = Date.now()
    const entries = await this.ctx.storage.list<LedgerEntry>({
      prefix: LEDGER_PREFIX,
    })
    return new Map([...entries].filter(([, entry]) => entry.expires_at > now))
  }

  private async isLedger(): Promise<boolean> {
    return (await this.ctx.storage.get<string>('role')) === LEDGER_ROLE
  }

  /** Refuse to run a ledger method on an object that holds transaction state. */
  private async asLedger(): Promise<void> {
    if (await this.isLedger()) return
    const held = await this.ctx.storage.get(TRANSACTION_KEYS)
    if (held.size > 0)
      throw new Error(
        'ClaimGuard: a buyer-ledger method was called on a transaction guard',
      )
  }

  /** Refuse to run a transaction method on a buyer's ledger. */
  private async asTransaction(): Promise<void> {
    if (await this.isLedger())
      throw new Error(
        'ClaimGuard: a transaction method was called on a buyer ledger',
      )
  }

  private async scheduleCopyExpiry(grant: GrantCopy): Promise<void> {
    await this.ctx.storage.setAlarm(copyExpiresAt(grant))
  }

  /**
   * Record this write's time and arm the whole-object expiry, for an object that has never committed a
   * grant. A committed object's alarm belongs to its copy and is left exactly as it is.
   */
  private async armUncommittedExpiry(): Promise<void> {
    if (await this.hasCommitted()) return
    const now = Date.now()
    await this.ctx.storage.put('last_write_at', now)
    await this.ctx.storage.setAlarm(now + GRANT_TTL_SEC * 1000)
  }

  /** Has this object ever committed a grant? `granted`, or `revoked` after `granted` (sequence 2+). */
  private async hasCommitted(): Promise<boolean> {
    const status = await this.currentStatus()
    if (status === 'granted') return true
    return status === 'revoked' && (await this.currentSequence()) >= 2
  }

  /** Status, recorded refunds, sequence and committed copy in one read. */
  async snapshot(): Promise<GuardSnapshot> {
    await this.asTransaction()
    return {
      status: await this.currentStatus(),
      refunds: await this.recordedRefunds(),
      sequence: await this.currentSequence(),
      grant: (await this.ctx.storage.get<GrantCopy>('grant')) ?? null,
    }
  }

  private async currentStatus(): Promise<GuardStatus> {
    return (await this.ctx.storage.get<GuardStatus>('status')) ?? 'idle'
  }

  private async currentSequence(): Promise<number> {
    return (await this.ctx.storage.get<number>('sequence')) ?? 0
  }

  private async recordedRefunds(): Promise<RefundFacts[]> {
    return (await this.ctx.storage.get<RefundFacts[]>('refunds')) ?? []
  }

  /** Move into a settled state and mint its sequence, in one storage write. */
  private async transition(
    status: 'granted' | 'revoked',
    extra: Record<string, unknown> = {},
  ): Promise<number> {
    const sequence = (await this.currentSequence()) + 1
    await this.ctx.storage.put({ ...extra, status, sequence })
    return sequence
  }

  private async appendRefund(facts: RefundFacts): Promise<void> {
    const refunds = await this.recordedRefunds()
    const known = refunds.some(
      (r) =>
        r.event_type === facts.event_type &&
        r.is_full_refund === facts.is_full_refund,
    )
    if (known) return
    refunds.push({
      event_type: facts.event_type,
      is_full_refund: facts.is_full_refund,
    })
    await this.ctx.storage.put('refunds', refunds)
  }
}

/**
 * When a committed copy stops mirroring a live grant record: `granted_at + GRANT_TTL_SEC`. An
 * unparseable `granted_at` (never written by this worker) counts as already due, so the copy cannot
 * outlive a record whose age nobody can tell.
 */
export function copyExpiresAt(grant: Pick<GrantCopy, 'granted_at'>): number {
  const grantedAt = Date.parse(grant.granted_at)
  return Number.isFinite(grantedAt) ? grantedAt + GRANT_TTL_SEC * 1000 : 0
}

/** Resolve the guard stub for a transaction, keyed by adapter + transaction_id (route + workflow both have these). */
export function claimGuard(
  env: CloudflareBindings,
  adapter: string,
  txn: string,
) {
  const ns = env.CLAIM_GUARD
  return ns.get(ns.idFromName(`${adapter}:${txn}`))
}

/**
 * Resolve the buyer's ledger stub, in the same namespace. GitHub logins are case-insensitive, so the
 * login is lowercased: `Octocat` and `octocat` are one buyer with one ledger.
 */
export function buyerLedger(env: CloudflareBindings, username: string) {
  const ns = env.CLAIM_GUARD
  return ns.get(ns.idFromName(`buyer:${username.toLowerCase()}`))
}

/** A transaction's key inside a buyer's ledger. */
export function ledgerKey(adapter: string, txn: string): string {
  return `${adapter}:${txn}`
}
