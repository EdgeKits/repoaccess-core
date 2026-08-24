// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Gary Stupak

import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from 'cloudflare:workers'
import { NonRetryableError } from 'cloudflare:workflows'
import type {
  AccessWorkflowParams,
  ApiCallbackPing,
  GrantOrigin,
  NormalizedEvent,
  PaymentAdapter,
  ProductConfig,
  ProductTeamMap,
  RawRequest,
  RepoAccessConfig,
  RevokePolicy,
} from '../types'
import {
  assertProductTeamMap,
  makeConfigGate,
  resolveProductConfig,
} from '../config/config'
import { sha256Hex } from './workflow-id'
import { verifyApiCallback } from '../security/verify'
import { isValidGithubUsername } from '../username'
import {
  github,
  isRateLimited,
  INVITE_PAGE_SIZE,
  type GithubResult,
} from '../github'
import {
  buildEnvelope,
  createEventSink,
  logSink,
  type EnvelopeField,
  type EventSink,
  type OutboundEventType,
} from '../events'
import {
  CLAIM_TTL_SEC,
  GRANT_TTL_SEC,
  FAIL_TTL_SEC,
  grantKey,
  claimKey,
  claimIndexKey,
  sessionTxnKey,
  failKey,
  claimSubmittedKey,
} from '../kv-keys'
import { claimGuard } from '../claim/claim-guard'

const KV_MIN_TTL_SEC = 60 // Cloudflare KV floor for expirationTtl

const MAX_GH_ATTEMPTS = 8 // rate-limit / 5xx backoff cap; durable sleeps span >1 day before giving up

// Safety cap on the revoke invitation-listing pagination: 20 pages * 100/page = 2000 pending
// invitations scanned before we stop. A refund must revoke access at volume (an org with >100 pending
// invites could otherwise leave a refunded buyer's invite un-cancelled on a later page), but an
// unbounded loop against a pathological org is its own hazard - so we page to this cap and, if we hit
// it without finding the invite, surface a non-fatal warn (the team removal already happened).
const INVITE_PAGE_CAP = 20

// Outbound delivery retry policy. The emit step lets the durable engine retry transient
// delivery failures; after exhaustion the emit step swallows the error (the grant already happened -
// delivery must NEVER fail the grant).
const EMIT_RETRY = {
  retries: { limit: 5, delay: '10 seconds', backoff: 'exponential' },
} as const

// api_callback entity-fetch retry policy. A THROWN fetch error (network/5xx - a provider API can
// be slow/down) is retried durably by the engine; after exhaustion the step throws and the workflow
// surfaces access.failed. A returned null (not-found/forged id) is NOT retried - it is terminal.
const FETCH_ENTITY_RETRY = {
  retries: { limit: 5, delay: '10 seconds', backoff: 'exponential' },
} as const

/**
 * The stable, coarse vocabulary for the `reason` field on a delivered `access.failed` envelope. The
 * wire value is ALWAYS one of these fixed codes - never raw error text, an HTTP status, a team slug, or
 * `String(err)` (those leak internal/inconsistent detail to the seller's endpoint). The full,
 * descriptive detail is preserved in the structured `log()` calls (the `detail` field) so debugging
 * loses nothing. Pre-0.2.0 hardening (Info-1): the event SHAPE is unchanged (`reason` stays a string),
 * only its VALUE space is fixed.
 *
 *   - invalid_username     handle absent/malformed/nonexistent where a valid one was required
 *   - github_error         a GitHub API call failed un-correctably (auth/permission/validation/status)
 *   - fetch_failed         an api_callback entity fetch threw, or returned not-found/unverifiable
 *   - parse_failed         an api_callback adapter's parse() threw on the fetched entity
 *   - unhandled_event      the fetched entity parsed to null (an event kind we don't act on)
 *   - unverifiable_adapter the enqueued api_callback adapter wasn't passed to createAccessWorkflow
 *   - grant_error          a grant died on an exhausted-retry / unexpected throw (terminal catch)
 *   - github_token_degraded  a revoke hit 401/403 - the worker's token can no longer manage members,
 *                            so access was NOT withdrawn and the seller must act (see runRevoke)
 */
export type AccessFailedReason =
  | 'invalid_username'
  | 'github_error'
  | 'fetch_failed'
  | 'parse_failed'
  | 'unhandled_event'
  | 'unverifiable_adapter'
  | 'grant_error'
  | 'github_token_degraded'
  // A payment_success (or claim completion) arrived for a transaction already refunded/disputed.
  // Nothing was granted and no claim was minted - emitted so the seller sees the refusal rather
  // than silence, which is what let a refunded claim stay redeemable in the first place.
  | 'transaction_revoked'

/**
 * Where a DIRECT enqueue lands when its caller said nothing about how it was authorized.
 *
 * IT IS NOT A FALLBACK FOR "UNKNOWN" - it is the answer to a specific question, and that is why it is
 * safe. A caller that reached the Workflow without going through the webhook route enqueued this
 * instance itself, from code, on this account: `rpc` restates what that caller just did rather than
 * guessing at something it did not say. The opposite direction would not be safe - `webhook` asserts
 * a provider delivery passed verification, which core cannot know about an enqueue it never saw.
 *
 * The webhook route never reaches this: it states `webhook` at both of its enqueue sites, and a test
 * pins that. Neither does a claim completion, whose authorization descends from an earlier instance
 * and is therefore not something this line can restate - see `executeAccessWorkflow`, which is what
 * decides which of the two an origin-less instance is.
 */
const DEFAULT_GRANT_ORIGIN: GrantOrigin = 'rpc'

interface GrantRecord {
  github_username: string
  org: string
  teams: string[]
  product_id: string
  granted_at: string
  /**
   * How the grant was authorized. Optional in both directions and for two different reasons: a record
   * written before this field existed does not carry one, and a grant whose origin this worker could
   * not establish does not write one. Either way an absent key means "no answer was recorded" - read
   * it as unknown, never as a default.
   */
  origin?: GrantOrigin
}

function log(
  level: string,
  msg: string,
  extra: Record<string, unknown> = {},
): void {
  console.log(JSON.stringify({ level, msg, ...extra }))
}

function backoffMs(result: GithubResult, attempt: number): number {
  if (result.retryAfterSec !== null)
    return Math.max(1, result.retryAfterSec) * 1000
  return Math.min(60 * 2 ** attempt, 3600) * 1000 // 1 min → cap 1 h (hours-scale, durable)
}

/**
 * Run one GitHub op inside a durable step. 5xx and rate-limit (429 / 403+signal) → `step.sleep`
 * backoff and retry (NEVER fail the grant on a transient/limit) up to a generous cap.
 * Returns the result for the caller to classify (e.g. 404 vs 200).
 *
 * The step resolves to a JSON STRING and the caller parses it back, which is why this is not simply
 * `() => op(env)`. It works around a defect in the Workflows runtime: a step callback that resolves
 * to an OBJECT makes the runtime record the whole invocation as an exception, carrying a "code had
 * hung and would never generate a response" message, even though the step and the instance both
 * complete successfully. A callback resolving to a string (or to nothing) is recorded cleanly. The
 * value is still persisted and replayed on a retry, so nothing about durability changes.
 */
async function ghStep(
  step: WorkflowStep,
  env: CloudflareBindings,
  label: string,
  op: (env: CloudflareBindings) => Promise<GithubResult>,
): Promise<GithubResult> {
  for (let attempt = 0; attempt <= MAX_GH_ATTEMPTS; attempt++) {
    const result = JSON.parse(
      await step.do(`${label}#${attempt}`, async () =>
        JSON.stringify(await op(env)),
      ),
    ) as GithubResult
    if (result.status < 500 && !isRateLimited(result)) return result
    if (attempt === MAX_GH_ATTEMPTS) {
      throw new NonRetryableError(
        `${label}: GitHub unavailable after ${attempt} retries (last status ${result.status})`,
      )
    }
    log('warn', 'github backoff', { label, attempt, status: result.status })
    await step.sleep(`${label} backoff#${attempt}`, backoffMs(result, attempt))
  }
  throw new NonRetryableError(`${label}: exhausted`)
}

/**
 * A GitHub result that says the worker's token cannot do its job: expired PAT, revoked authorization,
 * or permissions narrowed below `Members: write`.
 *
 * Safe to read as an auth wall precisely BECAUSE it is only ever applied to a value `ghStep` returned:
 * a rate-limited 403 never gets that far (`ghStep` catches it via `isRateLimited` and backs off, then
 * throws once retries are exhausted), so any 403 surviving to a caller is a permissions 403, not a
 * throttle. Applying this to a raw `github.*` result instead would conflate the two.
 */
function isDegradedToken(result: GithubResult): boolean {
  return result.status === 401 || result.status === 403
}

async function emitEvent(
  step: WorkflowStep,
  org: string,
  origin: GrantOrigin | undefined,
  sink: EventSink,
  type: OutboundEventType,
  event: NormalizedEvent,
  extra: Record<string, EnvelopeField>,
): Promise<void> {
  try {
    // The sink throws on a transient delivery failure → the durable engine retries this step per
    // EMIT_RETRY. Side-effect-free retry: re-running only re-sends the event.
    //
    // The callback deliberately returns NOTHING. It used to return the envelope, which nothing reads,
    // and a step callback resolving to an object makes the Workflows runtime record the whole
    // invocation as an exception ("code had hung and would never generate a response") even though the
    // step and the instance both succeed. There is no value to preserve here, so it is simply dropped.
    await step.do(
      `emit:${type}:${event.transaction_id}`,
      EMIT_RETRY,
      async () => {
        await sink(buildEnvelope(org, origin, type, event, extra))
      },
    )
  } catch (err) {
    // Retries exhausted (or a non-retryable error). Log and continue - the grant already happened;
    // outbound delivery must never fail it.
    log('warn', 'event delivery exhausted', {
      type,
      transaction_id: event.transaction_id,
      error: String(err),
    })
  }
}

function generateToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32)) // 256-bit, ≥128-bit requirement
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function collectAllTeams(map: ProductTeamMap): string[] {
  const teams = new Set<string>()
  const add = (cfg: ProductConfig | undefined) => {
    for (const slug of cfg?.teams ?? []) teams.add(slug)
  }
  for (const [key, value] of Object.entries(map)) {
    if (key === 'defaults') add(value as ProductConfig)
    else
      for (const cfg of Object.values(value as Record<string, ProductConfig>))
        add(cfg)
  }
  return [...teams]
}

// --- grant ------------------------------------------------------------------

/**
 * Write the redirect-alias index when the adapter set `redirect_alias_id` - the merchant's
 * post-checkout redirect will carry an id that differs from transaction_id (Stripe: the checkout
 * session id cs_... vs the payment_intent pi_... that keys the claim/grant). Maps the redirect id ->
 * transaction_id so /claim/by-txn alias-resolves it transparently. No-op when unset (an adapter
 * whose redirect id IS the transaction_id). GRANT_TTL_SEC so the alias outlives BOTH the claim window
 * and the grant window. NOT deleted on revoke: the refund/dispute event carries no redirect_alias_id,
 * and the alias is a harmless indirection - once the underlying claim/grant are gone, by-txn falls
 * through to the pending view; the alias then expires by TTL.
 */
async function writeSessionAlias(
  step: WorkflowStep,
  env: CloudflareBindings,
  adapter: string,
  event: NormalizedEvent,
): Promise<void> {
  const aliasId = event.redirect_alias_id
  if (!aliasId) return
  await step.do(`claim-alias:${adapter}:${event.transaction_id}`, async () => {
    await env.ENTITLEMENTS.put(
      sessionTxnKey(adapter, aliasId),
      event.transaction_id,
      { expirationTtl: GRANT_TTL_SEC },
    )
    return true
  })
}

async function runGrant(
  step: WorkflowStep,
  env: CloudflareBindings,
  org: string,
  origin: GrantOrigin | undefined,
  adapter: string,
  event: NormalizedEvent,
  config: ProductConfig,
  sink: EventSink,
  fromClaim: boolean,
): Promise<void> {
  const teams = config.teams ?? []
  const username = event.github_username

  // A refund or dispute may already have revoked this transaction, and the two orderings that get
  // here are both real: the refund arrived BEFORE the payment_success behind it (provider events carry
  // no ordering guarantee), or it landed while this claim completion was already enqueued and the
  // grant record did not exist yet. Either way the purchase is dead - so grant nothing AND mint no
  // claim, because a fresh token here would be a 30-day bearer credential for a refunded transaction.
  // Checked before every write, the redirect alias included, so a revoked txn leaves no new artifact.
  if (await guardRevoked(step, env, adapter, event.transaction_id)) {
    log('info', 'grant refused: transaction already revoked', {
      adapter,
      transaction_id: event.transaction_id,
      from_claim: fromClaim,
      origin,
    })
    await fail(
      step,
      org,
      origin,
      event,
      sink,
      teams,
      username,
      'transaction_revoked',
      'refund/dispute preceded this grant',
    )
    await clearSubmittedMarker(step, env, adapter, event.transaction_id)
    return
  }

  // Alias the merchant redirect id (if any) -> transaction_id BEFORE the grant-vs-claim branch, so
  // /claim/by-txn resolves for BOTH outcomes (direct grant AND claim fallback).
  await writeSessionAlias(step, env, adapter, event)

  // Grant-mode Option 1: a present + well-formed `github_username` drives a DIRECT grant in
  // ANY grant_mode - grant_mode governs ONLY the no-valid-handle case. So a `claim`-mode product whose
  // event ALREADY carries a good handle (e.g. a worker-hosted checkout that collected it, or any adapter
  // that maps a buyer-supplied handle) grants directly instead of bouncing the buyer to the claim page.
  // A claim-completed grant (`fromClaim`) always carries a handle validated at the claim POST. An
  // absent/malformed handle never reaches the API (it can't burn the org's 50/24h invitation quota) and
  // falls back to `claim` (so real claim-mode providers, which carry no handle, keep claiming unchanged).
  if (!isValidGithubUsername(username)) {
    if (fromClaim) {
      // Unreachable in practice (the claim POST validates first); fail loudly rather than spawn
      // another claim and loop. Not a user-not-found → consume the token.
      await terminalFailure(
        step,
        env,
        org,
        origin,
        adapter,
        event,
        sink,
        teams,
        username,
        'invalid_username',
        'claim completion with invalid username',
        false,
        true,
      )
      return
    }
    const reason = username
      ? 'malformed username, falling back to claim'
      : 'no username, falling back to claim'
    // A MALFORMED handle means the buyer TYPED something (e.g. an email) - stamp last_error so the
    // claim form explains the re-ask (parity with the nonexistent-handle fallback below). A plain
    // no-handle claim-mode event stays unexplained (nothing typed to correct).
    const lastError = username
      ? 'That was not a valid GitHub username - letters, digits and single hyphens, up to 39 characters.'
      : undefined
    await runClaimFallback(
      step,
      env,
      org,
      origin,
      adapter,
      event,
      teams,
      sink,
      reason,
      lastError,
    )
    return
  }

  const grantedTeams: string[] = []
  for (const slug of teams) {
    // Reconcile: 200 = already active OR pending → converged, skip. 404 = not a member → invite.
    const current = await ghStep(
      step,
      env,
      `team-get:${slug}:${username}`,
      (e) => github.getTeamMembership(e, org, slug, username),
    )
    if (current.status === 200) {
      grantedTeams.push(slug)
      continue
    }
    if (current.status !== 404) {
      // Not user-correctable (auth/permission/unexpected) → consume any claim token.
      await terminalFailure(
        step,
        env,
        org,
        origin,
        adapter,
        event,
        sink,
        teams,
        username,
        'github_error',
        `team-get ${slug} → ${current.status}`,
        false,
        fromClaim,
      )
      return
    }
    // PUT auto-invites non-members; an existing org member is added directly.
    const put = await ghStep(step, env, `team-put:${slug}:${username}`, (e) =>
      github.addTeamMembership(e, org, slug, username),
    )
    if (put.status !== 200 && put.status !== 201) {
      const userNotFound = put.status === 404
      // 404 = the GitHub login does not exist (user not found). For a NON-claim grant the buyer's
      // up-front handle was simply wrong; this 404 lands on the FIRST team-add (a nonexistent login
      // fails immediately, so no teams are granted yet), so fall the whole grant back to a claim -
      // mint a token + emit claim.pending so the buyer can self-correct, rather than terminal
      // access.failed. A claim-originated 404 instead retains the existing token for a fixed resubmit.
      if (userNotFound && !fromClaim) {
        // The buyer's up-front handle is well-formed but has no GitHub account (PUT 404). Fall the whole
        // grant back to a claim AND stamp last_error on the new claim record so the claim form EXPLAINS
        // the re-ask ("we could not find <handle>") instead of silently re-prompting. The by-txn resolver
        // 302s to this claim, so the buyer lands on the form with the reason shown.
        await runClaimFallback(
          step,
          env,
          org,
          origin,
          adapter,
          event,
          teams,
          sink,
          'username not found, falling back to claim',
          `We could not find the GitHub user "${username}". Check it and re-enter.`,
        )
        return
      }
      // Otherwise terminal: a claim-originated 404 RETAINS the token for a corrected resubmit
      // (userNotFound); 422 etc. are not correctable here. A 404 means the GitHub login doesn't exist
      // (invalid_username); any other status is an un-correctable GitHub error.
      await terminalFailure(
        step,
        env,
        org,
        origin,
        adapter,
        event,
        sink,
        teams,
        username,
        userNotFound ? 'invalid_username' : 'github_error',
        `team-put ${slug} → ${put.status}`,
        userNotFound,
        fromClaim,
      )
      return
    }
    grantedTeams.push(slug)
  }

  const record: GrantRecord = {
    github_username: username,
    org,
    teams: grantedTeams,
    product_id: event.product_id,
    granted_at: new Date().toISOString(),
    // The LEDGER copy, and the reason this is written before the event rather than only carried on
    // it: core logs "event delivery exhausted" and carries on, so provenance that lived only in the
    // envelope would be gone precisely when a seller goes looking for it. Omitted entirely when the
    // answer is unknown - see the resolution in `executeAccessWorkflow`.
    ...(origin ? { origin } : {}),
  }
  await step.do(`grant-record:${adapter}:${event.transaction_id}`, async () => {
    // 180d TTL - covers the refund + ~120d card-chargeback window so a late chargeback can
    // still resolve; also deleted on revoke.
    await env.ENTITLEMENTS.put(
      grantKey(adapter, event.transaction_id),
      JSON.stringify(record),
      { expirationTtl: GRANT_TTL_SEC },
    )
    return true
  })

  await emitEvent(step, org, origin, sink, 'access.granted', event, {
    github_username: username,
    teams: grantedTeams,
    status: 'success',
  })

  // A grant that originated from a completed claim also closes the claim: emit claim.completed and
  // consume the single-use token (+ reverse index) here in the workflow's terminal step - NOT at the
  // route, so a failed attempt can retain the token for a corrected retry.
  if (fromClaim) {
    await emitEvent(step, org, origin, sink, 'claim.completed', event, {
      github_username: username,
      teams: grantedTeams,
      status: 'success',
    })
    await consumeClaim(step, env, adapter, event.transaction_id)
    await guardFinalize(step, env, adapter, event.transaction_id)
  }
}

async function runClaimFallback(
  step: WorkflowStep,
  env: CloudflareBindings,
  org: string,
  origin: GrantOrigin | undefined,
  adapter: string,
  event: NormalizedEvent,
  teams: string[],
  sink: EventSink,
  reason: string,
  // Set whenever the buyer TYPED a handle that can't grant (MALFORMED format, or valid-format but
  // NONEXISTENT on GitHub): recorded on the fresh claim record so the claim form explains WHY the
  // buyer is being asked again. Omitted only for the no-handle fallback (nothing typed to
  // correct-explain).
  lastError?: string,
): Promise<void> {
  log('info', 'grant → claim fallback', {
    adapter,
    transaction_id: event.transaction_id,
    reason,
    origin,
  })
  const token = await step.do(
    `claim-token:${adapter}:${event.transaction_id}`,
    async () => {
      const t = generateToken()
      // Anchor expiry at creation (epoch seconds) so re-puts (last_error) preserve it, never
      // resetting a fresh 30 days.
      const expiresAt = Math.floor(Date.now() / 1000) + CLAIM_TTL_SEC
      const pending = JSON.stringify({
        adapter,
        product_id: event.product_id,
        teams,
        buyer_email: event.buyer_email,
        transaction_id: event.transaction_id,
        expires_at: expiresAt,
        // Carried so the later completion can say how the PAYMENT was authorized rather than how the
        // claim submission arrived. A claim completion enqueues its own instance and its authority
        // descends from the purchase, so the value has to survive the gap - and this record is the
        // only thing that spans it (a claim fallback writes no grant record, by definition). Written
        // only when known, so a completion reading it back can tell "no answer" from an answer.
        ...(origin ? { origin } : {}),
        ...(lastError ? { last_error: lastError } : {}),
      })
      await env.ENTITLEMENTS.put(claimKey(t), pending, {
        expirationTtl: CLAIM_TTL_SEC,
      })
      await env.ENTITLEMENTS.put(
        claimIndexKey(adapter, event.transaction_id),
        t,
        {
          expirationTtl: CLAIM_TTL_SEC,
        },
      )
      return t
    },
  )

  // claim_url is relative until the claim page lands / the seller prepends their domain.
  await emitEvent(step, org, origin, sink, 'claim.pending', event, {
    claim_url: `/claim/${token}`,
    teams,
  })
}

async function fail(
  step: WorkflowStep,
  org: string,
  origin: GrantOrigin | undefined,
  event: NormalizedEvent,
  sink: EventSink,
  teams: string[],
  username: string | null,
  reason: AccessFailedReason,
  detail?: string,
): Promise<void> {
  // The wire envelope carries ONLY the coarse code; the raw detail stays in the log.
  log('error', 'grant failed', {
    transaction_id: event.transaction_id,
    username,
    reason,
    detail,
    origin,
  })
  await emitEvent(step, org, origin, sink, 'access.failed', event, {
    github_username: username,
    teams,
    status: 'failure',
    reason,
  })
}

/**
 * A terminal grant failure. Always emits `access.failed` (seller-facing). For a claim-originated
 * grant it then manages the claim-token lifecycle:
 *   - `userNotFound` (GitHub login doesn't exist) is buyer-correctable → RETAIN the token and stamp
 *     `last_error` so `GET /claim/:token` re-shows the form with the error;
 *   - any other terminal failure is not correctable on the claim page → consume the token.
 */
async function terminalFailure(
  step: WorkflowStep,
  env: CloudflareBindings,
  org: string,
  origin: GrantOrigin | undefined,
  adapter: string,
  event: NormalizedEvent,
  sink: EventSink,
  teams: string[],
  username: string | null,
  reason: AccessFailedReason,
  detail: string | undefined,
  userNotFound: boolean,
  fromClaim: boolean,
): Promise<void> {
  await fail(step, org, origin, event, sink, teams, username, reason, detail)
  if (!fromClaim) {
    // Non-claim grant, terminally failed (e.g. a bad up-front handle that 404s mid-grant, or a 403/
    // auth error): no claim and no grant record will be written, so mark it failed → /claim/by-txn
    // shows `failed` rather than perpetual `pending`.
    await writeFailMarker(step, env, adapter, event.transaction_id, reason)
    return
  }
  // fromClaim: a "claim completing" marker may be set from the claim POST. Clear it BEFORE writing the
  // outcome so /claim/by-txn stops polling and reflects the real state - the retained claim form (with
  // the new last_error) on a correctable re-fallback, or `failed` below - instead of sticking on the
  // "setting up" page (the marker is checked before both the claim key and the fail marker).
  await clearSubmittedMarker(step, env, adapter, event.transaction_id)
  if (userNotFound) {
    // Buyer-correctable → retain the token AND release the single-flight lock so a later sequential
    // resubmit with a corrected handle can acquire. NOT terminal: write NO fail marker (and
    // /claim/by-txn 302s to the still-present claim regardless).
    await recordClaimError(
      step,
      env,
      adapter,
      event.transaction_id,
      `GitHub user "${username}" was not found - check the spelling and try again.`,
    )
    await guardRelease(step, env, adapter, event.transaction_id)
  } else {
    // Not correctable here → consume the token, lock the claim for good, and mark it failed so
    // /claim/by-txn (the claim is now consumed) shows `failed` instead of `pending`.
    await consumeClaim(step, env, adapter, event.transaction_id)
    await guardFinalize(step, env, adapter, event.transaction_id)
    await writeFailMarker(step, env, adapter, event.transaction_id, reason)
  }
}

/** Release the single-flight lock (back to idle) so a corrected sequential resubmit can acquire. */
async function guardRelease(
  step: WorkflowStep,
  env: CloudflareBindings,
  adapter: string,
  txn: string,
): Promise<void> {
  await step.do(`claim-guard-release:${adapter}:${txn}`, async () => {
    await claimGuard(env, adapter, txn).release()
    return true
  })
}

/** Lock the claim terminally (granted/closed) so no further attempt can acquire. */
async function guardFinalize(
  step: WorkflowStep,
  env: CloudflareBindings,
  adapter: string,
  txn: string,
): Promise<void> {
  await step.do(`claim-guard-finalize:${adapter}:${txn}`, async () => {
    await claimGuard(env, adapter, txn).finalize()
    return true
  })
}

/**
 * Mark the transaction revoked so its claim token can never be redeemed. Strongly consistent and
 * keyed by `{adapter}:{transaction_id}`, so it beats both races the KV delete alone cannot: a submit
 * already in flight, and the propagation window on the deleted `claim:{token}`.
 */
async function guardRevoke(
  step: WorkflowStep,
  env: CloudflareBindings,
  adapter: string,
  txn: string,
): Promise<void> {
  await step.do(`claim-guard-revoke:${adapter}:${txn}`, async () => {
    await claimGuard(env, adapter, txn).revoke()
    return true
  })
}

/** Has a refund/dispute already revoked this transaction? Read before any grant work. */
async function guardRevoked(
  step: WorkflowStep,
  env: CloudflareBindings,
  adapter: string,
  txn: string,
): Promise<boolean> {
  return (
    (await step.do(`claim-guard-status:${adapter}:${txn}`, () =>
      claimGuard(env, adapter, txn).status(),
    )) === 'revoked'
  )
}

/** Delete the single-use claim token (+ reverse index) for this transaction, if one exists. */
async function consumeClaim(
  step: WorkflowStep,
  env: CloudflareBindings,
  adapter: string,
  txn: string,
): Promise<void> {
  await step.do(`claim-consume:${adapter}:${txn}`, async () => {
    const token = await env.ENTITLEMENTS.get(claimIndexKey(adapter, txn))
    if (token) {
      await env.ENTITLEMENTS.delete(claimKey(token))
      await env.ENTITLEMENTS.delete(claimIndexKey(adapter, txn))
    }
    return true
  })
}

/**
 * Write a terminal grant-failure marker so /claim/by-txn shows a definite `failed` state for a doomed
 * transaction instead of looping on `pending`. Stores ONLY the coarse, non-sensitive
 * `AccessFailedReason` code (the same value already carried on the access.failed wire envelope) - never
 * raw detail, secrets, the handle, or team slugs. FAIL_TTL_SEC is the backstop; a later revoke cleanup
 * for the same txn may remove it sooner, and the TTL guarantees it never lingers. Deterministic step
 * id → idempotent across durable retries.
 */
async function writeFailMarker(
  step: WorkflowStep,
  env: CloudflareBindings,
  adapter: string,
  txn: string,
  reason: AccessFailedReason,
): Promise<void> {
  await step.do(`fail-marker:${adapter}:${txn}`, async () => {
    await env.ENTITLEMENTS.put(failKey(adapter, txn), reason, {
      expirationTtl: FAIL_TTL_SEC,
    })
    return true
  })
}

/**
 * Clear the short-TTL "claim completing" marker (`claim_submitted:{adapter}:{txn}`, written by the
 * claim POST) so /claim/by-txn stops showing the polling `pending` view and reflects the real outcome:
 * the retained claim form (with last_error) on a correctable re-fallback, or the `failed` view on a
 * terminal failure. Deterministic step id → idempotent across durable retries; a delete of an
 * absent/expired marker is a harmless no-op.
 */
async function clearSubmittedMarker(
  step: WorkflowStep,
  env: CloudflareBindings,
  adapter: string,
  txn: string,
): Promise<void> {
  await step.do(`claim-submitted-clear:${adapter}:${txn}`, async () => {
    await env.ENTITLEMENTS.delete(claimSubmittedKey(adapter, txn))
    return true
  })
}

/** Stamp `last_error` on the retained claim record so the buyer sees it on GET and can retry. */
async function recordClaimError(
  step: WorkflowStep,
  env: CloudflareBindings,
  adapter: string,
  txn: string,
  message: string,
): Promise<void> {
  await step.do(`claim-error:${adapter}:${txn}`, async () => {
    const token = await env.ENTITLEMENTS.get(claimIndexKey(adapter, txn))
    if (!token) return false
    const claim = (await env.ENTITLEMENTS.get(
      claimKey(token),
      'json',
    )) as Record<string, unknown> | null
    if (!claim) return false
    claim.last_error = message
    // KV has no in-place update; re-put must restate the TTL. Preserve the ORIGINAL expiry anchored at
    // creation - never reset to a fresh 30 days, or repeated failures would extend the
    // token indefinitely. Floor at the KV minimum; fall back to a full window for legacy records.
    const expiresAt =
      typeof claim.expires_at === 'number' ? claim.expires_at : null
    const ttl = expiresAt
      ? Math.max(KV_MIN_TTL_SEC, expiresAt - Math.floor(Date.now() / 1000))
      : CLAIM_TTL_SEC
    await env.ENTITLEMENTS.put(claimKey(token), JSON.stringify(claim), {
      expirationTtl: ttl,
    })
    return true
  })
}

// --- revoke -----------------------------------------------------------------

/**
 * What the seller's policy says this refund/dispute event should do. Shared by BOTH revoke paths - a
 * granted purchase and a still-pending claim - so the two can never drift on what a refund means. The
 * caller logs its own reason; this decides.
 */
type RevokeGate = 'revoke' | 'log_only' | 'partial_refund'

function revokeGate(policy: RevokePolicy, event: NormalizedEvent): RevokeGate {
  if (policy.mode !== 'auto_revoke') return 'log_only'
  // A partial refund skips ONLY under `full_refund_only` - plain `auto_revoke` revokes it like any
  // other refund. A chargeback carries `is_full_refund: null` and always revokes, whatever the flag
  // says. And a refund that is partial NOW may be completed later: that arrives as its own instance
  // (the id carries the scope, see workflow-id.ts), so this gate is asked again with the new answer.
  if (
    event.event_type === 'refund' &&
    policy.full_refund_only &&
    event.is_full_refund !== true
  )
    return 'partial_refund'
  return 'revoke'
}

/**
 * Revoke a purchase that has a pending CLAIM but no grant record - a claim fallback writes the token
 * and no grant record, so this is what a refunded-but-never-claimed purchase looks like.
 *
 * The claim token is a bearer credential valid for CLAIM_TTL_SEC (30 days). Left alone it stays
 * redeemable long after the refund, and redeeming it puts the refunded buyer in the team. So an
 * `auto_revoke` product destroys it: mark the guard (strongly consistent, beats the in-flight submit
 * and the KV propagation window) and delete both keys.
 *
 * The policy is resolved from the CLAIM record's `product_id` for the same reason the granted path
 * resolves it from the grant record's: a refund event's own `product_id` is frequently absent or a
 * line-item id, which would fall through to `defaults` (log_only) and wrongly spare an auto_revoke
 * product. With no grant record, the claim record is the authoritative statement of what was sold.
 *
 * `log_only` destroys NOTHING - see the branch below.
 */
async function revokePendingClaim(
  step: WorkflowStep,
  env: CloudflareBindings,
  org: string,
  origin: GrantOrigin | undefined,
  adapter: string,
  event: NormalizedEvent,
  map: ProductTeamMap,
  sink: EventSink,
): Promise<void> {
  const txn = event.transaction_id
  const token = (await step.do(`claim-index-read:${adapter}:${txn}`, () =>
    env.ENTITLEMENTS.get(claimIndexKey(adapter, txn)),
  )) as string | null

  if (!token) {
    // Neither a grant nor a claim. Two different situations look identical here, and only one of them
    // is "nothing to do":
    //   (a) this worker never sold that transaction (a stray or replayed refund) - nothing to do;
    //   (b) the refund is running AHEAD of the payment_success it belongs to. Provider events carry no
    //       ordering guarantee, so the grant may be seconds behind, and it would mint a fresh 30-day
    //       claim token for an already-refunded purchase - the very credential this function exists to
    //       destroy, recreated after the fact.
    // They are indistinguishable at this instant, so leave a tombstone on the guard and let the grant
    // path refuse itself. Policy comes from the EVENT's product_id here because it is the only source
    // that exists - there is no grant or claim record to read. That is safe in this ONE branch, and
    // deliberately conservative: an absent or unmapped product_id falls through to `defaults`
    // (log_only), which tombstones nothing. So the tombstone is bounded to refunds of products this
    // deployment actually maps to auto_revoke, not to every refund the worker ever sees.
    const policy = resolveProductConfig(map, adapter, event.product_id)
      .revoke_policy ?? { mode: 'log_only' }
    if (revokeGate(policy, event) === 'revoke') {
      log('warn', 'revoke: grant record absent, tombstoning transaction', {
        transaction_id: txn,
        has_buyer_email: Boolean(event.buyer_email), // never log raw PII
      })
      await guardRevoke(step, env, adapter, txn)
      return
    }
    log('warn', 'revoke: grant record absent', {
      transaction_id: txn,
      has_buyer_email: Boolean(event.buyer_email), // never log raw PII
    })
    return
  }

  // Read the record as TEXT and parse it here rather than asking KV for 'json'. A step callback that
  // resolves to an object makes the Workflows runtime record the invocation as an exception (see
  // ghStep), and KV hands back the stored text anyway, so the parse just moves outside the step - no
  // stringify-then-reparse round trip. A missing key is null in both forms, and a malformed stored
  // record still throws rather than yielding a half-usable object.
  const claimJson = await step.do(`claim-read:${adapter}:${txn}`, () =>
    env.ENTITLEMENTS.get(claimKey(token)),
  )
  const claim = (claimJson === null ? null : JSON.parse(claimJson)) as {
    product_id?: string
    teams?: string[]
  } | null

  if (!claim) {
    // The index outlived the claim it points at (the token was consumed, or expired first). Nothing
    // is redeemable - `completeClaim` reads `claim:{token}` and would already return not_found - so
    // just drop the dangling index.
    log('warn', 'revoke: claim index without a claim record', {
      transaction_id: txn,
    })
    await step.do(`claim-index-clean:${adapter}:${txn}`, async () => {
      await env.ENTITLEMENTS.delete(claimIndexKey(adapter, txn))
      return true
    })
    return
  }

  const policy = resolveProductConfig(map, adapter, claim.product_id ?? '')
    .revoke_policy ?? { mode: 'log_only' }
  const gate = revokeGate(policy, event)

  if (gate === 'log_only') {
    // `log_only` means log only, and a pending claim is no exception. The seller asked for a refund
    // NOT to withdraw access; the claim IS the access they bought, so destroying it would withdraw
    // access behind their back. Under log_only a COMPLETED claim keeps its team membership, so an
    // uncompleted one keeps its token - same policy, same outcome, whether or not the buyer has got
    // round to clicking the link yet.
    log('info', 'revoke skipped: log_only (pending claim retained)', {
      transaction_id: txn,
    })
    return
  }
  if (gate === 'partial_refund') {
    log('info', 'revoke skipped: partial refund (pending claim retained)', {
      transaction_id: txn,
    })
    return
  }

  log('info', 'revoke: destroying pending claim', { transaction_id: txn })
  // Guard FIRST: it is the strongly-consistent gate, so once it is set the token is refused even
  // while the KV deletes below are still propagating.
  await guardRevoke(step, env, adapter, txn)
  await consumeClaim(step, env, adapter, txn)
  await clearSubmittedMarker(step, env, adapter, txn)

  // The seller subscribed to access.revoked to learn a refund was actioned, and it was: the pending
  // entitlement is gone. `github_username` is null because nobody ever claimed it - which is exactly
  // how a consumer tells this apart from revoking a live membership. Silence here is what made the
  // original defect invisible.
  await emitEvent(step, org, origin, sink, 'access.revoked', event, {
    github_username: null,
    teams: claim.teams ?? [],
    trigger: event.event_type,
  })
}

async function runRevoke(
  step: WorkflowStep,
  env: CloudflareBindings,
  org: string,
  origin: GrantOrigin | undefined,
  adapter: string,
  event: NormalizedEvent,
  map: ProductTeamMap,
  sink: EventSink,
): Promise<void> {
  // Read the grant record FIRST - it, not the event, is the authoritative source of which product was
  // sold. Refund/adjustment events frequently lack a usable product_id (an adjustment/refund event may
  // reference a line-item id rather than the product, so product_id is ''), so resolving the revoke
  // policy from the EVENT would fall
  // through to `defaults` (log_only) and wrongly SKIP an auto_revoke product. Resolve the policy from
  // the GRANT RECORD's product_id instead.
  // Read as TEXT and parse outside the step, for the same reason as the claim read above: a step
  // callback resolving to an object is what the Workflows runtime mis-records (see ghStep).
  const recordJson = await step.do(
    `grant-read:${adapter}:${event.transaction_id}`,
    () => env.ENTITLEMENTS.get(grantKey(adapter, event.transaction_id)),
  )
  const record = (
    recordJson === null ? null : JSON.parse(recordJson)
  ) as GrantRecord | null

  if (!record) {
    // No grant record does NOT mean there is nothing here. A claim fallback writes a claim token and
    // NO grant record, so this is exactly the shape a refunded-but-unclaimed purchase takes - and the
    // token is a live bearer credential that must not outlive the refund.
    await revokePendingClaim(step, env, org, origin, adapter, event, map, sink)
    return
  }

  const config = resolveProductConfig(map, adapter, record.product_id)
  const policy = config.revoke_policy ?? { mode: 'log_only' }
  const gate = revokeGate(policy, event)

  if (gate === 'log_only') {
    log('info', 'revoke skipped: log_only', {
      transaction_id: event.transaction_id,
    })
    return
  }
  if (gate === 'partial_refund') {
    log('info', 'revoke skipped: partial refund', {
      transaction_id: event.transaction_id,
    })
    return
  }

  const username = record.github_username
  const teams = record.teams ?? []

  /**
   * Stop the revoke on a degraded token.
   *
   * A revoke that cannot reach GitHub must NOT look like one that succeeded. Withdrawing access is the
   * whole promise of a refund, so when the token can no longer do it we fail loudly and leave every
   * artifact in place:
   *   - emit `access.failed` carrying the handle + teams, so the seller can finish by hand. BEST-EFFORT:
   *     `emitEvent` swallows exhausted delivery, so a seller endpoint that is down for the retry window
   *     yields no delivered event. The Errored instance below is the guarantee; the event is not.
   *   - skip the KV cleanup, which leaves TWO different kinds of key behind, and the difference matters:
   *     `grant:` is the DIAGNOSTIC and what a retry needs, but `claim:`/`claim_txn:` (when present) are a
   *     live BEARER CREDENTIAL for a transaction that was just refunded. Reaching here means a grant
   *     record EXISTS, and the paths that produce one leave no live claim beside it: a direct grant mints
   *     no claim, and a completed claim consumes both keys. A refunded purchase whose claim is still
   *     PENDING has no grant record at all, so it never reaches this function - it is handled by
   *     `revokePendingClaim`, which destroys the token via the guard before any GitHub call can degrade.
   *     Do not read that as a general guarantee: an adapter or downstream that CAN put a live claim
   *     beside a grant record must consume it here rather than inherit this comment.
   *   - emit NO `access.revoked` - the seller must never be told access went away when it did not;
   *   - throw, so the instance ends Errored. Errored is the reliable half of the signature.
   */
  const abortOnDegradedToken = async (
    phase: string,
    status: number,
  ): Promise<never> => {
    // The wire envelope carries only the coarse code; the phase/status detail stays in the log.
    log('error', 'revoke aborted: github token degraded', {
      transaction_id: event.transaction_id,
      username,
      phase,
      status,
    })
    await emitEvent(step, org, origin, sink, 'access.failed', event, {
      github_username: username,
      teams,
      status: 'failure',
      reason: 'github_token_degraded',
      trigger: event.event_type,
    })
    throw new NonRetryableError(
      `revoke aborted: GitHub answered ${status} on ${phase} - the worker's token can no longer manage org members, so access was NOT withdrawn`,
    )
  }

  for (const slug of teams) {
    // DELETE is idempotent: 204 (removed) or 404 (already gone) both converge.
    const del = await ghStep(step, env, `team-del:${slug}:${username}`, (e) =>
      github.removeTeamMembership(e, org, slug, username),
    )
    if (isDegradedToken(del))
      await abortOnDegradedToken(`team-del:${slug}`, del.status)
  }

  // Cancel the pending org invitation for this user. Paginate past the 100/page cap: with >100 pending
  // invites the buyer's could sit on a later page, and "a refund revokes access" must hold at volume.
  // GitHub allows at most one pending invitation per user per org, so stop as soon as we cancel it;
  // otherwise page until a short (last) page or the safety cap. The listing + each cancel run through
  // ghStep (durable + rate-limit backoff) with per-page step ids, so a Workflow retry is idempotent.
  let inviteCancelled = false
  let pagesExhausted = false
  for (let page = 1; page <= INVITE_PAGE_CAP; page++) {
    const invites = await ghStep(step, env, `invites-list#${page}`, (e) =>
      github.listInvitations(e, org, page),
    )
    if (isDegradedToken(invites))
      await abortOnDegradedToken(`invites-list#${page}`, invites.status)
    const list = Array.isArray(invites.json)
      ? (invites.json as Array<{ id?: number; login?: string }>)
      : []
    const match = list.find(
      (invite) => invite.login === username && typeof invite.id === 'number',
    )
    if (match) {
      const cancel = await ghStep(step, env, `invite-cancel:${match.id}`, (e) =>
        github.cancelInvitation(e, org, match.id as number),
      )
      if (isDegradedToken(cancel))
        await abortOnDegradedToken(`invite-cancel:${match.id}`, cancel.status)
      inviteCancelled = true
      break
    }
    if (list.length < INVITE_PAGE_SIZE) {
      // A short page is the last page: every pending invite has been seen, this user has none.
      pagesExhausted = true
      break
    }
  }
  if (!inviteCancelled && !pagesExhausted) {
    // Hit the page cap with full pages throughout and never found the invite - a pathological invite
    // volume. The team removal already ran; surface a non-fatal warn (like the other revoke edge cases)
    // rather than failing the revoke or looping unbounded.
    log(
      'warn',
      'revoke: invitation pagination cap reached without finding invite',
      {
        transaction_id: event.transaction_id,
        pages: INVITE_PAGE_CAP,
      },
    )
  }

  // Reconcile org membership against LIVE state: drop org membership only if the user is in no
  // product team anymore (they may hold other entitlements). Never a KV scan.
  let stillInATeam = false
  for (const slug of collectAllTeams(map)) {
    const m = await ghStep(step, env, `team-check:${slug}:${username}`, (e) =>
      github.getTeamMembership(e, org, slug, username),
    )
    // 401/403 answer NOTHING and must never be read as "not in a team" - doing so would drop org
    // membership from a buyer who still holds other entitlements, on the strength of a read that never
    // happened. Those two are excluded here; every other non-200 status still falls through as "not in
    // this team", which is right for the 404 that GitHub actually returns and is the deliberate limit of
    // this check - it is auth-complete, not status-complete.
    if (isDegradedToken(m))
      await abortOnDegradedToken(`team-check:${slug}`, m.status)
    if (m.status === 200) {
      stillInATeam = true
      break
    }
  }
  if (!stillInATeam) {
    const orgDel = await ghStep(step, env, `org-del:${username}`, (e) =>
      github.removeOrgMembership(e, org, username),
    )
    if (isDegradedToken(orgDel))
      await abortOnDegradedToken(`org-del`, orgDel.status)
  }

  // Clean up KV: pending claim (if any) + the grant record.
  await step.do(`cleanup:${adapter}:${event.transaction_id}`, async () => {
    const token = await env.ENTITLEMENTS.get(
      claimIndexKey(adapter, event.transaction_id),
    )
    if (token) {
      await env.ENTITLEMENTS.delete(claimKey(token))
      await env.ENTITLEMENTS.delete(
        claimIndexKey(adapter, event.transaction_id),
      )
    }
    await env.ENTITLEMENTS.delete(grantKey(adapter, event.transaction_id))
    return true
  })

  await emitEvent(step, org, origin, sink, 'access.revoked', event, {
    github_username: username,
    teams,
    trigger: event.event_type,
  })
}

// --- api_callback (fetch-in-workflow) ---------------------------------------

type ApiCallbackResolution =
  | { ok: true; event: NormalizedEvent }
  | { ok: false; reason: AccessFailedReason; detail?: string }

/**
 * Resolve a `NormalizedEvent` for an api_callback ping by fetching the authoritative entity and
 * parsing it - the never-trust-the-payload anchor. The fetch + parse run in ONE durable step so the
 * opaque `VerifiedEntity` never has to cross the step boundary (it may not be JSON-serializable) and
 * `parse` (pure) stays beside the fetch. A THROWN fetch error retries per FETCH_ENTITY_RETRY; a null
 * entity (forged/unknown id) and a null/throwing parse (unhandled) are terminal.
 *
 * The step resolves to a JSON STRING of the resolution, parsed back at the return, because a step
 * callback resolving to an object is mis-recorded by the Workflows runtime (see ghStep). The
 * resolution is still persisted, so a retry or a suspend/resume replays it instead of refetching -
 * which is the whole point of doing the outbound verification in a durable step.
 */
async function resolveApiCallbackEvent(
  step: WorkflowStep,
  env: CloudflareBindings,
  adapterName: string,
  adapters: PaymentAdapter[],
  ping: ApiCallbackPing,
): Promise<ApiCallbackResolution> {
  const adapter = adapters.find((a) => a.name === adapterName)
  if (!adapter || adapter.verification.kind !== 'api_callback') {
    // Fail-closed: the deploy enqueued an api_callback ping but didn't pass this adapter to
    // createAccessWorkflow(config, adapters). Terminal - never grant from an unverifiable ping.
    return {
      ok: false,
      reason: 'unverifiable_adapter',
      detail: `no api_callback adapter "${adapterName}" in the workflow's adapter set`,
    }
  }
  const strategy = adapter.verification
  // Minimal RawRequest from the enqueued ping. Headers are intentionally empty - the entity is
  // fetched from the provider API, never derived from (untrusted) inbound headers.
  const raw: RawRequest = {
    bodyText: ping.bodyText,
    bodyForm: new URLSearchParams(ping.form),
    headers: new Headers(),
  }
  // Serialize through a DECLARED parameter type so the compiler still checks every arm. `JSON.stringify`
  // accepts anything and the string is cast back at the return, so without this the object literals below
  // would be unchecked and a typo in a `reason` code would compile and reach the wire.
  const encodeResolution = (resolution: ApiCallbackResolution): string =>
    JSON.stringify(resolution)

  const resolved = await step.do(
    `fetch-entity:${adapterName}`,
    FETCH_ENTITY_RETRY,
    async () => {
      // Reuse the engine's fetch + null-reject (the single audited "never trust the payload" point); it
      // just runs here, inside a durable retriable step, instead of on the ack path. The opaque entity
      // is consumed by parse() in THIS step, so it never crosses the step boundary (where it might not be
      // JSON-serializable).
      const verified = await verifyApiCallback(strategy, raw, env)
      if (!verified.ok) {
        return encodeResolution({
          ok: false,
          reason: 'fetch_failed',
          detail: 'entity fetch failed or not found',
        })
      }
      let parsed: NormalizedEvent | null
      try {
        parsed = adapter.parse(raw, verified.entity)
      } catch (err) {
        return encodeResolution({
          ok: false,
          reason: 'parse_failed',
          detail: `parse error: ${String(err)}`,
        })
      }
      if (!parsed)
        return encodeResolution({ ok: false, reason: 'unhandled_event' })
      return encodeResolution({ ok: true, event: parsed })
    },
  )
  return JSON.parse(resolved) as ApiCallbackResolution
}

/**
 * Emit access.failed for an api_callback ping that never resolved to a real event (entity fetch
 * failed/not found, or parse returned null). No NormalizedEvent exists, so synthesize a minimal one
 * whose transaction_id is derived (deterministically) from the ping body for correlation.
 */
async function emitApiCallbackFailure(
  step: WorkflowStep,
  org: string,
  origin: GrantOrigin | undefined,
  sink: EventSink,
  ping: ApiCallbackPing,
  reason: AccessFailedReason,
  detail?: string,
): Promise<void> {
  const digest = await sha256Hex(ping.bodyText)
  const synthetic: NormalizedEvent = {
    event_type: 'payment_success',
    product_id: '',
    transaction_id: `apicallback-${digest.slice(0, 32)}`,
    buyer_email: null,
    github_username: null,
    is_full_refund: null,
  }
  // The wire envelope carries ONLY the coarse code; the raw detail stays in the log.
  log('error', 'api_callback resolution failed', {
    adapter_event: 'access.failed',
    transaction_id: synthetic.transaction_id,
    reason,
    detail,
    origin,
  })
  await emitEvent(step, org, origin, sink, 'access.failed', synthetic, {
    github_username: null,
    teams: [],
    status: 'failure',
    reason,
  })
}

// --- entrypoint -------------------------------------------------------------

/**
 * Grant vs revoke decided by `event.event_type`. Reconciliation-based: every step reads
 * current GitHub state and converges, so duplicate/retried runs are no-ops. `appConfig` carries the
 * deployment config (org + product map) - no longer read from env vars. `sink` is
 * injectable for tests; production uses the signed-HTTP delivery sink (`createEventSink`).
 *
 * `adapters` is needed ONLY for api_callback pings (to run the in-workflow entity fetch + parse);
 * hmac enqueues carry the already-parsed `event` and ignore it (default `[]`).
 */
export async function executeAccessWorkflow(
  step: WorkflowStep,
  env: CloudflareBindings,
  appConfig: RepoAccessConfig,
  params: AccessWorkflowParams,
  sink: EventSink = logSink,
  adapters: PaymentAdapter[] = [],
): Promise<void> {
  const { adapter } = params
  const org = appConfig.githubOrg
  // Resolved ONCE, here, and passed to everything below: how this instance was authorized is a
  // property of the instance, not of the step that happens to be emitting. It reaches the grant
  // record and every envelope, and stays `undefined` when the answer is not known.
  //
  // TWO DIFFERENT SITUATIONS ARRIVE HERE WITH NO ORIGIN, and `from_claim` is what tells them apart.
  // A caller that enqueued this instance DIRECTLY and said nothing has, by that very act, told us
  // what it was: a direct programmatic enqueue, which is `DEFAULT_GRANT_ORIGIN`. A CLAIM COMPLETION
  // has not. Its authorization descends from a payment that happened earlier, in another instance,
  // and if the claim record carried nothing forward then this worker simply does not know - the
  // ordinary reason being a claim minted before the field existed, from a provider webhook it
  // verified at the time. Defaulting that one is not modest, it is WRONG: it writes a verified sale
  // down as a direct call, and a ledger that invents entries is worse than one with gaps in it.
  const origin: GrantOrigin | undefined =
    params.origin ?? (params.from_claim ? undefined : DEFAULT_GRANT_ORIGIN)
  const map = assertProductTeamMap(appConfig.productTeamMap)

  // Resolve the NormalizedEvent. hmac path: parsed on the (fast) ack path → carried in params.event.
  // api_callback path: fetch the authoritative entity + parse here, in a durable step (outbound I/O
  // kept off the ack path; the ping body is never trusted).
  let event: NormalizedEvent
  if (params.ping) {
    let resolution: ApiCallbackResolution
    try {
      resolution = await resolveApiCallbackEvent(
        step,
        env,
        adapter,
        adapters,
        params.ping,
      )
    } catch (err) {
      // Transient fetch retries exhausted (or unexpected throw). Emit access.failed, then re-throw to
      // mark the instance failed for observability (mirrors the grant exhausted-retry path).
      await emitApiCallbackFailure(
        step,
        org,
        origin,
        sink,
        params.ping,
        'fetch_failed',
        `entity fetch error: ${String(err)}`,
      )
      throw err
    }
    if (!resolution.ok) {
      // Clean terminal (forged/unknown id, or unhandled event) → access.failed, no retry storm.
      await emitApiCallbackFailure(
        step,
        org,
        origin,
        sink,
        params.ping,
        resolution.reason,
        resolution.detail,
      )
      return
    }
    event = resolution.event
  } else if (params.event) {
    event = params.event
  } else {
    log('error', 'workflow params missing both event and ping', { adapter })
    return
  }

  const config = resolveProductConfig(map, adapter, event.product_id)

  try {
    if (event.event_type === 'payment_success') {
      await runGrant(
        step,
        env,
        org,
        origin,
        adapter,
        event,
        config,
        sink,
        Boolean(params.from_claim),
      )
    } else {
      // runRevoke resolves its own product config from the grant record's product_id - the event's
      // product_id is unreliable on refund/adjustment events (see runRevoke).
      await runRevoke(step, env, org, origin, adapter, event, map, sink)
    }
  } catch (err) {
    log('error', 'workflow terminal failure', {
      adapter,
      transaction_id: event.transaction_id,
      event_type: event.event_type,
      error: String(err),
      origin,
    })
    // Surface an access.failed for grants that died on an exhausted-retry / unexpected error. The wire
    // reason is the coarse code; the raw String(err) detail is in the log line above.
    if (event.event_type === 'payment_success') {
      await emitEvent(step, org, origin, sink, 'access.failed', event, {
        github_username: event.github_username,
        teams: config.teams ?? [],
        status: 'failure',
        reason: 'grant_error',
      })
      // A claim-originated grant that died on a transient/unexpected error must release its
      // single-flight lock so the buyer can resubmit (the token was retained) - /claim/by-txn 302s to
      // that retained claim, so no fail marker. Clear the completing marker too, so by-txn drops back to
      // the claim form for the resubmit instead of polling until the marker TTL-expires. A NON-claim
      // grant (rate-limit / 5xx exhausted, or an unexpected throw) leaves no claim and no grant record,
      // so mark it failed → /claim/by-txn shows `failed` rather than perpetual `pending`.
      if (params.from_claim) {
        await clearSubmittedMarker(step, env, adapter, event.transaction_id)
        await guardRelease(step, env, adapter, event.transaction_id)
      } else {
        await writeFailMarker(
          step,
          env,
          adapter,
          event.transaction_id,
          'grant_error',
        )
      }
    }
    throw err // mark the Workflow instance failed for observability (the event already fired)
  }
}

/**
 * Factory for the single static Workflow class, bound to a deployment `config`. The
 * `AccessWorkflow` is instantiated by the Workers runtime - NOT by `createWorker` - so the
 * `createWorker` closure can't reach it; the factory's closure is how config crosses that boundary.
 * The user entry exports the result under the name wrangler's `class_name` expects:
 *
 *   const adapters = [stripe]
 *   export class AccessWorkflow extends createAccessWorkflow(config, adapters) {}
 *
 * `extends <factory()>` (not a bare `const`) so the export is a class - a value AND a type - which
 * `worker-configuration.d.ts` references as `import('./src/index').AccessWorkflow`.
 * `run()` reads SECRETS from `this.env` (GITHUB_TOKEN, EVENT_WEBHOOK_SECRET) and everything else from
 * the closed-over `config`. Grant/revoke are run params.
 *
 * `adapters` (additive 2nd param, default `[]`) is the SAME list passed to `createWorker` - the
 * Workflow needs it ONLY to run an api_callback adapter's `fetchEntity` + `parse` in-step. A deploy
 * with only hmac adapters can omit it; one composing an api_callback adapter MUST pass it, or
 * api_callback pings fail closed (access.failed, no grant). Pre-0.2.0 signature change (intentional).
 */
export function createAccessWorkflow(
  config: RepoAccessConfig,
  adapters: PaymentAdapter[] = [],
) {
  // The SECOND door onto the same config, gated the same way and for the same reason. The router
  // refuses every request when the config names no usable org, so nothing reaches here through a
  // webhook - but a downstream can enqueue this Workflow directly (an RPC entrypoint on the deployer's
  // own account does exactly that), and that path has its own way in.
  //
  // Checked at first RUN rather than at construction, like the router's gate: the factory is called at
  // module scope by the deploy entries, so a throw there fires before any test runs. See
  // `makeConfigGate`.
  const configGate = makeConfigGate(config)

  return class extends WorkflowEntrypoint<
    CloudflareBindings,
    AccessWorkflowParams
  > {
    async run(
      event: WorkflowEvent<AccessWorkflowParams>,
      step: WorkflowStep,
    ): Promise<void> {
      // NON-RETRYABLE, which is the whole difference from a transient failure. A missing org is not
      // going to resolve itself between attempts, so a retrying step would spend a day's backoff
      // budget re-reading the same config; this fails the instance immediately with a message naming
      // the field and the file.
      const rejected = configGate()
      if (rejected !== null) {
        throw new NonRetryableError(rejected)
      }

      // Production sink = structured log + signed HTTP delivery. Tests call executeAccessWorkflow
      // directly with their own sink.
      await executeAccessWorkflow(
        step,
        this.env,
        config,
        event.payload,
        createEventSink(this.env, config),
        adapters,
      )
    }
  }
}
