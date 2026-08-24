/** @jsxRuntime automatic */
/** @jsxImportSource hono/jsx */
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Gary Stupak

import type { Context } from 'hono'
import type {
  AccessWorkflowParams,
  Branding,
  GrantOrigin,
  NormalizedEvent,
  RepoAccessConfig,
} from '../types'
import { workflowInstanceId } from '../workflow/workflow-id'
import { isValidGithubUsername } from '../username'
import {
  claimKey,
  claimIndexKey,
  grantKey,
  sessionTxnKey,
  failKey,
  claimSubmittedKey,
  CLAIM_SUBMITTED_TTL_SEC,
} from '../kv-keys'
import { claimGuard } from './claim-guard'
import { safeUrl } from '../security/safe-url'
import type { ClaimTemplate } from './claim-template'

/**
 * Claim flow CONTROLLER. A claim is created by the
 * grant workflow's `claim`-mode fallback when no valid GitHub username is known. This module owns the
 * LOGIC for the page the buyer lands on; the HTML VIEW is an injected `ClaimTemplate` (the open
 * extension point - see `claim-template.tsx`):
 *
 *   GET  /claim/:token  → JSON (Accept: application/json) or the template's `form` state after KV
 *                         token validation. A prior failed attempt (user-not-found) re-shows `last_error`.
 *   POST /claim/:token  → browser: validate the handle inline, then render the `confirm` state; a
 *                         submission carrying `confirmed` → enqueue a grant in `username` mode under
 *                         the instance id `{adapter}-claim_completed-{transaction_id}-{handle}`.
 *                         An `Accept: application/json` caller skips the confirm step (see below).
 *
 * The handle is folded INTO the instance id: a corrected handle is a new id and re-runs,
 * while resubmitting the SAME handle dedups against the in-flight/failed instance. The claim token
 * lifecycle (consume on success / non-user-not-found, RETAIN on user-not-found) lives in the WORKFLOW
 * terminal step - NOT here - so a failed attempt leaves the token usable for a corrected retry. The
 * route therefore does not delete the token; it tells the buyer to reload to see the result.
 *
 * Handlers are built from a template via `makeClaimGet`/`makeClaimPost` (wired in create-worker.ts).
 * JSON responses are controller-owned; the template renders HTML only.
 */

// Encode the route path so `c.req.param('token')` types as `string` (not `string | undefined`):
// these handlers are only ever mounted at `/claim/:token` (see create-worker.ts), and the `:token`
// segment is non-optional, so the param is always present.
type Ctx = Context<{ Bindings: CloudflareBindings }, '/claim/:token'>

// Same trick for the resolve-by-transaction route: both `:adapter` and `:txn` are non-optional.
type ByTxnCtx = Context<
  { Bindings: CloudflareBindings },
  '/claim/by-txn/:adapter/:txn'
>

interface PendingClaim {
  adapter: string
  product_id: string
  teams: string[]
  buyer_email: string | null
  transaction_id: string
  /** Absolute expiry (epoch seconds) anchored at claim creation - preserved across re-puts. */
  expires_at?: number
  /**
   * How the PAYMENT that minted this claim was authorized, recorded by the grant workflow's claim
   * fallback. Optional because a claim written before the field existed carries none, and that
   * absence has to survive being read: it is what tells the completion it has no answer to forward,
   * rather than one it should replace with a default.
   */
  origin?: GrantOrigin
  /** Set by the workflow on a user-not-found failure so GET re-shows the form with the error. */
  last_error?: string
}

// Seller-configurable branding from `config.branding`. Neutral per-field defaults -
// never hard-code EdgeKits; a partial config sets only the fields it wants. `logoUrl`/`faviconUrl` are
// rendered into an <img src> / <link href> by the template, so they pass through `safeUrl` (scheme
// allowlist: http/https/relative only) - a misconfigured `javascript:`/`data:` URL collapses to '' and
// reuses the template's brand-name-text / omit-favicon fallbacks. The value is escaped by Hono JSX, but
// escaping does not restrict the SCHEME, so this is the needed defense.
function branding(config: RepoAccessConfig): Branding {
  const b = config.branding
  return {
    name: b?.name || 'RepoAccess',
    logoUrl: safeUrl(b?.logoUrl || ''),
    faviconUrl: safeUrl(b?.faviconUrl || ''),
    // theme + customCss drive the shared look (themeVars + baseThemeCss + customCss); pass them through
    // untouched - themeVars sanitizes token values and the template escapes `</style>` in customCss.
    theme: b?.theme,
    customCss: b?.customCss,
  }
}

async function readClaim(
  env: CloudflareBindings,
  token: string,
): Promise<PendingClaim | null> {
  return (await env.ENTITLEMENTS.get(
    claimKey(token),
    'json',
  )) as PendingClaim | null
}

function wantsJson(c: Ctx): boolean {
  return Boolean(c.req.header('accept')?.includes('application/json'))
}

// The by-txn resolver path for a claim's transaction - built ONE way (shared by the post-submit
// redirect and the poll-budget reset in submitJs) so the client-side sessionStorage key, which is
// derived from location.pathname on the by-txn page, always matches. encodeURIComponent each segment:
// the transaction_id is provider-supplied (webhook-verified, but still not a fixed charset), so encode
// it so it can't alter the URL path; Hono decodes the :txn param back to the exact value the by-txn
// resolver keys KV on. adapter is from the fixed set.
function byTxnPath(adapter: string, transactionId: string): string {
  return `/claim/by-txn/${encodeURIComponent(adapter)}/${encodeURIComponent(transactionId)}`
}

// Submit-feedback for the claim form (UX only - ClaimGuard enforces single-flight server-side). On
// submit: disable the button + swap in a spinner so the buyer sees progress and is discouraged from
// double-submitting. `label` names what THIS step is doing - step 1 goes to the confirm screen, only
// the confirmed submit runs the ~1.5s grant - so the spinner never claims work that is not happening.
// Neither step's button carries a `name`, so disabling it drops no field: the confirm decision travels
// in a hidden input for exactly that reason (a disabled submitter's name/value can be left out of the
// entry list), which is also what keeps the step working with JavaScript off.
// Also resets the by-txn POLL BUDGET for this claim's transaction: the poll cap (POLL_JS) is a per-path
// sessionStorage counter, and every submit redirects to the SAME by-txn path as the initial wait - so
// without the reset the counter accumulates across the whole multi-step flow (initial pending + each
// submit/retry) and trips the "taking longer" line on a SUCCESSFUL grant. Each fresh wait episode gets
// a fresh budget. Kept core-owned + central (built per-claim and passed into the `form` view as
// `submitScript`) so the behaviour is uniform across templates; a template embeds it via
// <script>{raw(view.submitScript)}</script> and targets the `claim-form`/`claim-btn` ids. NOTE: served
// inline with no nonce because the claim responses set NO Content-Security-Policy (the page already
// relies on an inline <style>). If a strict script-src CSP is ever added to these responses, nonce this
// <script> (do NOT add 'unsafe-inline'). The embedded path is JSON.stringify-quoted and its segments
// are encodeURIComponent'd, so it cannot break out of the string or the <script> element.
const submitJs = (claimByTxnPath: string, label: string) => `
;(function () {
  var f = document.getElementById('claim-form')
  if (!f) return
  f.addEventListener('submit', function () {
    try { sessionStorage.removeItem('repoaccess_bytxn:' + ${JSON.stringify(claimByTxnPath)}) } catch (e) {}
    var b = document.getElementById('claim-btn')
    if (!b || b.disabled) return
    b.disabled = true
    b.setAttribute('aria-busy', 'true')
    b.innerHTML = '<span class="spinner" aria-hidden="true"></span>${label}'
  })
})()
`

// The two spinner labels, each true of the step it runs on. Plain ASCII-safe words with no quote or
// backslash, so they embed in the single-quoted JS string above without escaping.
const CONTINUE_LABEL = 'Continuing…'
const CLAIMING_LABEL = 'Claiming…'

// Re-prompt text for a handle that fails the format check. One string, because two places produce it:
// the pre-confirm check on the first submission and the engine's `invalid_handle` on a confirmed one.
const INVALID_HANDLE_ERROR =
  'Enter a valid GitHub username - letters, digits and single hyphens, up to 39 characters.'

// Auto-poll for the resolve-by-transaction `pending` view: the grant workflow runs async AFTER the
// webhook ack returns, and a KV key-miss is edge-cached for ~60s (cacheTtl floor, cannot go lower), so
// even a SUCCESSFUL grant can read as `pending` for up to ~60s until the miss-cache expires. This
// reloads the page every ~4s so the buyer lands on the terminal view (302 / granted / failed) without
// manually refreshing. The loop SELF-TERMINATES because only the `pending` view carries this script -
// a terminal view has no script. Capped at ~25 reloads (~100s) via a per-path sessionStorage counter -
// comfortably past the ~60s KV miss-cache window - so a genuinely stuck case stops looping and reveals a
// quiet "taking longer" line (#bytxn-slow) instead of refreshing forever. Core-owned + central (passed
// into the `pending` view as `pollScript`)
// like SUBMIT_JS, so the behaviour is uniform across templates. Served inline with no nonce for the
// same reason as SUBMIT_JS (these responses set no CSP); if a strict script-src CSP is ever added,
// nonce this <script> (do NOT add 'unsafe-inline').
const POLL_JS = `
;(function () {
  try {
    var KEY = 'repoaccess_bytxn:' + location.pathname
    var MAX = 25
    var n = 0
    try { n = parseInt(sessionStorage.getItem(KEY) || '0', 10) || 0 } catch (e) {}
    if (n >= MAX) {
      try { sessionStorage.removeItem(KEY) } catch (e) {}
      var el = document.getElementById('bytxn-slow')
      if (el) el.style.display = ''
      return
    }
    try { sessionStorage.setItem(KEY, String(n + 1)) } catch (e) {}
    setTimeout(function () { location.reload() }, 4000)
  } catch (e) {}
})()
`

// The token lives in the URL path → keep it out of Referer (a seller-set brand image host would
// otherwise receive the full claim URL) and out of shared caches. Also two cheap hardening headers on
// every claim/delivery response: `nosniff` (no content-type sniffing of the HTML/JSON) and `DENY`
// framing (the claim FORM can't be iframed for clickjacking). NOT a strict script-src CSP - these pages
// carry inline scripts (SUBMIT_JS / POLL_JS) that would need nonces; that is deliberately separate work.
function harden(c: Ctx): void {
  c.header('Referrer-Policy', 'no-referrer')
  c.header('Cache-Control', 'no-store')
  c.header('X-Content-Type-Options', 'nosniff')
  c.header('X-Frame-Options', 'DENY')
}

/** Build the GET handler bound to a claim template. Logic is template-agnostic. */
export function makeClaimGet(
  template: ClaimTemplate,
  config: RepoAccessConfig,
) {
  return async function handleClaimGet(c: Ctx): Promise<Response> {
    harden(c)
    const token = c.req.param('token')
    const brand = branding(config)
    const claim = await readClaim(c.env, token)

    if (!claim) {
      return wantsJson(c)
        ? c.json({ error: 'invalid_or_expired' }, 404)
        : c.html(template({ brand, view: { kind: 'invalid' } }), 404)
    }
    if (wantsJson(c)) {
      // Minimal projection - no buyer_email (PII) over the wire here.
      return c.json({
        adapter: claim.adapter,
        product_id: claim.product_id,
        teams: claim.teams,
        last_error: claim.last_error ?? null,
      })
    }
    // A retained claim carries last_error from a failed prior attempt → re-show the form with it.
    return c.html(
      template({
        brand,
        view: {
          kind: 'form',
          token,
          error: claim.last_error,
          submitScript: submitJs(
            byTxnPath(claim.adapter, claim.transaction_id),
            CONTINUE_LABEL,
          ),
        },
      }),
    )
  }
}

/**
 * The four terminal outcomes of completing a claim with a submitted handle. `code` is set ONLY on
 * `busy` and carries the ClaimGuard rejection reason (`in_progress` = another submit is mid-flight,
 * `already_claimed` = the claim was finalized) so a caller can echo it verbatim.
 */
export interface CompleteClaimResult {
  status: 'submitted' | 'busy' | 'invalid_handle' | 'not_found'
  /** Present iff `status === 'busy'`: the single-flight guard's rejection code. */
  code?: 'in_progress' | 'already_claimed'
  /**
   * The resolved claim's `adapter` + `transaction_id` - present for every status EXCEPT `not_found`
   * (i.e. whenever the claim record was found). The `POST /claim/:token` route uses them to redirect a
   * submitted buyer to `/claim/by-txn/<adapter>/<txn>` (which polls to the granted/failed terminal view)
   * instead of the static token page - which would show the `invalid` view once the token is consumed.
   */
  adapter?: string
  transactionId?: string
}

/**
 * The claim-completion ENGINE, shared by the HTTP `POST /claim/:token` route (`makeClaimPost`) and
 * Pro's `submitClaim` RPC so both complete a claim - including with a CORRECTED handle -
 * through the identical id/single-flight/enqueue path, with no duplicated logic and no id drift.
 *
 * Given a claim token and a candidate GitHub handle it: loads the claim (`claim:{token}`) - absent →
 * `not_found`; validates the handle format - bad → `invalid_handle` (never enqueues a malformed
 * handle); acquires the per-claim ClaimGuard single-flight lock - already held → `busy` (+ `code`);
 * on acquire, enqueues the grant under the deterministic id
 * `{adapter}-claim_completed-{transaction_id}-{handle}` (the handle folded in, via
 * `workflowInstanceId`) and returns `submitted`. It NEVER deletes the token (the workflow consumes it
 * on success / non-user-not-found and RETAINS it on user-not-found so a corrected handle can retry),
 * and releases the guard if the enqueue itself throws so the claim isn't left stuck.
 *
 * `config` is part of the stable engine signature (a caller passes its `RepoAccessConfig`); the
 * completion path is config-independent today - branding/views are the caller's concern.
 */
export async function completeClaim(
  env: CloudflareBindings,
  config: RepoAccessConfig,
  token: string,
  githubUsername: string,
): Promise<CompleteClaimResult> {
  const claim = await readClaim(env, token)
  if (!claim) return { status: 'not_found' }

  // The claim's txn reference - returned on every found-claim outcome so the route can redirect to
  // /claim/by-txn/<adapter>/<txn> after a successful submit (see CompleteClaimResult).
  const ref = { adapter: claim.adapter, transactionId: claim.transaction_id }

  const username = githubUsername.trim()

  // Username validation → reject on failure (never enqueue a malformed handle).
  if (!isValidGithubUsername(username))
    return { status: 'invalid_handle', ...ref }

  // Build the grant event. event_type is `payment_success` so the workflow runs a GRANT; the instance
  // id below uses the distinct `claim_completed` event_type so it can't collide with the original
  // claim-mode `payment_success` instance for this transaction.
  const event: NormalizedEvent = {
    event_type: 'payment_success',
    product_id: claim.product_id,
    transaction_id: claim.transaction_id,
    buyer_email: claim.buyer_email,
    github_username: username,
    is_full_refund: null,
  }
  // Fold the submitted handle into the id: a corrected handle → new id → re-runs the grant
  // even while a failed attempt is still in its retention window; the SAME handle → same id → dedups.
  // `username` is charset-safe; workflowInstanceId hash-falls-back if the combined value is
  // out-of-charset/over-long (the hash includes the handle, so it stays distinct per handle).
  // `null` scope: a claim completion is not a refund, so the id carries no scope suffix.
  const id = await workflowInstanceId(
    claim.adapter,
    'claim_completed',
    `${claim.transaction_id}-${username}`,
    null,
  )
  const params: AccessWorkflowParams = {
    adapter: claim.adapter,
    event,
    from_claim: true,
    // A completion's authorization DESCENDS from the payment, not from this submission: the buyer
    // typing a handle into a form is not a second authorization of the purchase, it is the same
    // purchase finishing. So carry the value the claim record kept rather than restating one here.
    // A record written before that field existed carries nothing, and that `undefined` is meant to
    // travel: paired with `from_claim` it is what tells the Workflow it has no answer to record.
    origin: claim.origin,
  }

  // Single-flight: serialize through the per-claim Durable Object so two concurrent submits
  // (esp. of DISTINCT handles) can't both enqueue → at most one grant per claim. A second concurrent
  // submit while one is in flight is rejected; the workflow releases the lock on user-not-found so a
  // later sequential corrected resubmit can acquire.
  const guard = claimGuard(env, claim.adapter, claim.transaction_id)
  const acq = await guard.acquire()
  // A REVOKED transaction (refund/dispute) is not "busy" - the claim is gone for good, so it reports
  // exactly like a consumed or expired token and renders the existing `invalid` 404 view. The revoke
  // path also deletes `claim:{token}`, so this branch is normally unreachable; it is what closes the
  // window where that delete has not propagated yet (KV is eventually consistent) or where the submit
  // was already in flight when the refund landed. The guard is strongly consistent, so it decides.
  if (!acq.ok) {
    if (acq.code === 'revoked') return { status: 'not_found' }
    return { status: 'busy', code: acq.code, ...ref }
  }

  try {
    await env.ACCESS_WORKFLOW.createBatch([{ id, params }])
  } catch (err) {
    // Enqueue failed → release the lock so the buyer can retry (otherwise the claim is stuck).
    await guard.release()
    throw err
  }

  // Mark the claim as completing (see claimSubmittedKey) so /claim/by-txn shows the polling "setting
  // up" page rather than 302-ing back to the still-present claim form while the grant is in flight -
  // the bug this fixes: a buyer who submitted a corrected handle bounced back to an empty form. The
  // workflow clears this on any terminal/fallback outcome; the TTL is the backstop. Best-effort: a put
  // failure must NOT fail the submit (the grant is already enqueued) - by-txn would then just briefly
  // bounce to the form until the grant record lands, the pre-fix behaviour.
  try {
    await env.ENTITLEMENTS.put(
      claimSubmittedKey(claim.adapter, claim.transaction_id),
      '1',
      { expirationTtl: CLAIM_SUBMITTED_TTL_SEC },
    )
  } catch {
    // Non-fatal: the marker is a UX optimization, not a correctness gate.
  }

  // Do NOT delete the token here - the workflow consumes it on success (or a non-user-not-found
  // failure) and RETAINS it on user-not-found so the buyer can correct the handle.
  return { status: 'submitted', ...ref }
}

/**
 * Build the POST handler bound to a claim template. Logic is template-agnostic.
 *
 * The BROWSER path is two submissions, not one. The first renders the `confirm` state - the handle
 * read back, with what happens if it is wrong, and a one-click way back that re-renders the form with
 * the value still in it - and only a submission carrying `confirmed` reaches `completeClaim`. The
 * way back matters as much as the warning: a confirmation that shows a buyer their mistake and offers
 * only "proceed" is worse than none. It costs nothing to take - every pre-confirm branch only reads -
 * so the buyer can go round as many times as they like and the token is untouched until they confirm.
 * The reason for the step is the failure ladder of this field, and only the third rung matters
 * here: a malformed handle falls back to the claim page, a well-formed handle for an account that
 * does not exist fails at GitHub and RETAINS the claim for a retry, but a well-formed handle for a
 * real account that is not the buyer's SUCCEEDS - the stranger is invited, the token is consumed, and
 * the buyer has neither access nor a way back. Nothing downstream can tell that case from a correct
 * one (the system cannot know which account belongs to the buyer), so the only place to catch it is
 * in front of the buyer, before the irreversible step.
 *
 * It is a step in the PAGE, not a rule in the engine: no new validation, no account lookup, and
 * `completeClaim` is untouched, so Pro's `submitClaim` RPC behaves exactly as before. Both decisions
 * ride in hidden form fields rather than on a submit button, and the way back is a real POST rather
 * than `history.back()` - the whole step therefore works with JavaScript disabled, which it must,
 * since the page's script is progressive enhancement.
 *
 * An `Accept: application/json` caller skips the step entirely: it is a program supplying a handle
 * deliberately, there is no reader to confirm anything, and the JSON contract predates this.
 */
export function makeClaimPost(
  template: ClaimTemplate,
  config: RepoAccessConfig,
) {
  return async function handleClaimPost(c: Ctx): Promise<Response> {
    harden(c)
    const token = c.req.param('token')
    const brand = branding(config)

    const body = await c.req.parseBody()
    // `typed` is the handle EXACTLY as the buyer entered it - what the confirm screen reads back and
    // what a re-rendered form puts back in the field. `username` is the trimmed value everything
    // downstream uses. Keeping the two apart is the point: the buyer is checking for a typo, so the
    // page must not quietly hand back a cleaned-up version of what they wrote.
    const typed =
      typeof body.github_username === 'string' ? body.github_username : ''
    const username = typed.trim()

    // The browser's two-submission path. `edit` (back from the confirm screen) and an unconfirmed
    // submission both land here; only `confirmed` falls through to the engine below.
    const editing = body.edit === '1'
    if (!wantsJson(c) && (editing || body.confirmed !== '1')) {
      const claim = await readClaim(c.env, token)
      // Same order the engine uses: an absent claim is the token's problem, and a malformed handle is
      // re-prompted rather than confirmed - the confirm screen must never read back a handle the
      // engine would refuse. Every branch here READS and renders; none writes KV, touches the guard,
      // or enqueues, so a buyer can walk to the confirm screen and back as often as they need and the
      // token is exactly as usable afterwards. The engine stays the authority and re-runs the same
      // format check on the confirmed submission.
      if (!claim)
        return c.html(template({ brand, view: { kind: 'invalid' } }), 404)

      const path = byTxnPath(claim.adapter, claim.transaction_id)
      const reprompt = (error?: string) =>
        template({
          brand,
          view: {
            kind: 'form',
            token,
            error,
            value: typed,
            submitScript: submitJs(path, CONTINUE_LABEL),
          },
        })

      // Back from the confirm screen: the same form, with what they typed still in it, so they
      // correct a character instead of retyping the handle they are trying to proof-read.
      if (editing) return c.html(reprompt())

      if (!isValidGithubUsername(username))
        return c.html(reprompt(INVALID_HANDLE_ERROR), 400)

      return c.html(
        template({
          brand,
          view: {
            kind: 'confirm',
            token,
            username: typed,
            // The validated value, for anything that must name the ACCOUNT rather than echo the
            // input - the profile link. `typed` answers "what did I write?" and stays raw; `handle`
            // answers "which account gets access?" and must be what the engine will act on, which is
            // the trimmed value passed to `completeClaim` below.
            handle: username,
            submitScript: submitJs(path, CLAIMING_LABEL),
          },
        }),
      )
    }

    // Run the shared completion engine; map its status to this route's existing HTML/JSON views.
    const result = await completeClaim(c.env, config, token, username)

    if (result.status === 'not_found') {
      return wantsJson(c)
        ? c.json({ error: 'invalid_or_expired' }, 404)
        : c.html(template({ brand, view: { kind: 'invalid' } }), 404)
    }

    if (result.status === 'invalid_handle') {
      // adapter/transactionId are always present on invalid_handle (the claim record was found);
      // the '' fallback only satisfies the optional type and yields a harmless no-op key removal.
      const path =
        result.adapter && result.transactionId
          ? byTxnPath(result.adapter, result.transactionId)
          : ''
      return wantsJson(c)
        ? c.json({ error: 'invalid_username' }, 400)
        : c.html(
            template({
              brand,
              view: {
                kind: 'form',
                token,
                error: INVALID_HANDLE_ERROR,
                value: typed,
                submitScript: submitJs(path, CONTINUE_LABEL),
              },
            }),
            400,
          )
    }

    if (result.status === 'busy') {
      return wantsJson(c)
        ? c.json({ error: result.code }, 409)
        : c.html(template({ brand, view: { kind: 'busy', token } }), 409)
    }

    // submitted: the grant workflow is enqueued (it consumes the token on success, or RETAINS it +
    // stamps last_error on a user-not-found so the form re-asks with a reason). Route the BROWSER buyer
    // to the by-txn resolver `/claim/by-txn/<adapter>/<txn>` rather than the static token page: by-txn
    // polls to the terminal granted/failed view (or 302s back to the retained claim, now carrying
    // last_error), whereas the old token page would 404 to `invalid` the moment the token is consumed -
    // a successful claim would look like a broken link. The API caller still gets the JSON `processing`.
    if (wantsJson(c)) {
      return c.json({ status: 'processing', github_username: username })
    }
    if (result.adapter && result.transactionId) {
      // byTxnPath encodes each segment (see its comment) - the same builder submitJs embeds, so the
      // poll-budget key reset on submit matches the pathname this redirect lands on.
      return c.redirect(byTxnPath(result.adapter, result.transactionId), 303)
    }
    // Defensive fallback (adapter/txn are always present on a submitted result): the static page.
    return c.html(
      template({ brand, view: { kind: 'submitted', token, username } }),
    )
  }
}

/**
 * The four grant-aware states a transaction can resolve to. `token` is set ONLY in the `claim` state
 * (the single-use `/claim/:token` credential); the `granted`/`failed`/`pending` states carry no token
 * and never echo grant/failure detail - existence is all the caller learns.
 */
export type ByTxnState = 'granted' | 'claim' | 'pending' | 'failed'

export interface ByTxnResolution {
  state: ByTxnState
  /** The single-use claim token - present iff `state === 'claim'`. */
  token?: string
}

/**
 * Resolve a transaction (or a merchant redirect alias for it) to its grant-delivery state. The single
 * source of truth for by-txn resolution: the HTTP surface (`makeClaimByTxn`) maps the returned state to
 * 302/granted/failed/pending, and Pro's RPC `RepoAccessService.resolveDelivery` composes the same call
 * so both paths see identical KV keys + resolution order.
 *
 * Alias-resolves `:txn` first (see `sessionTxnKey`): a merchant redirect id that differs from the
 * transaction_id (Stripe's `cs_...` session id vs the `pi_...` claim key) is mapped through
 * `session_txn:{adapter}:{id}` before the lookups; a direct transaction_id (no alias entry) resolves
 * unchanged. Read-only: KV existence checks only, no grant, no workflow enqueue, no side effects.
 *
 * Resolution order is grant -> completing -> claim -> fail -> pending. `grant` wins first so a
 * just-completed claim (grant written, claim consumed) resolves to `granted` even before the completing
 * marker TTL-expires. The `completing` marker (written by `completeClaim` on a fresh submit) is checked
 * BEFORE the claim key so a buyer who just submitted a handle sees the polling `pending` view instead of
 * being bounced back to the still-present claim form mid-grant (the claim-completion -> delivery bounce
 * this fixes) - the workflow clears the marker on any terminal/fallback outcome, so a doomed submit
 * still surfaces `claim` (retry-with-last_error) or `failed` rather than sticking on polling. The
 * `granted`/`failed` branches check ONLY existence - they never read/parse the record, so no handle,
 * teams, org, or failure detail leaks through the txn-as-bearer-credential.
 */
export async function resolveByTxn(
  env: CloudflareBindings,
  adapter: string,
  txn: string,
): Promise<ByTxnResolution> {
  const mapped = await env.ENTITLEMENTS.get(sessionTxnKey(adapter, txn))
  const realTxn = mapped ?? txn

  // (a) A grant record exists → access was granted directly (username happy path OR a completed claim).
  //     Checked first so a just-completed claim resolves to `granted` in the brief window where both a
  //     grant record and the completing marker are still present.
  const granted = await env.ENTITLEMENTS.get(grantKey(adapter, realTxn))
  if (granted !== null) return { state: 'granted' }

  // (b) A "claim completing" marker exists → a handle was just submitted and the grant is in flight.
  //     Show the polling `pending` view rather than 302-ing back to the still-present claim form. The
  //     workflow clears this marker on any terminal/fallback outcome (a corrected-handle re-fallback or
  //     a terminal failure), so a doomed submit falls through to (c)/(d), never sticks on polling.
  const completing = await env.ENTITLEMENTS.get(
    claimSubmittedKey(adapter, realTxn),
  )
  if (completing !== null) return { state: 'pending' }

  // (c) A pending claim exists (and no fresh submit is in flight) → hand back its single-use token.
  const token = await env.ENTITLEMENTS.get(claimIndexKey(adapter, realTxn))
  if (token) return { state: 'claim', token }

  // (d) No claim/grant, but a terminal-failure marker exists → the grant failed for good.
  const failed = await env.ENTITLEMENTS.get(failKey(adapter, realTxn))
  if (failed !== null) return { state: 'failed' }

  // (e) No key (yet) present → eventual-consistency pending.
  return { state: 'pending' }
}

/**
 * Build the resolve-by-transaction handler (claim-link delivery) bound to a claim
 * template.
 *
 *   GET /claim/by-txn/:adapter/:txn → four grant-aware landing states, so ONE redirect URL serves
 *     BOTH grant modes and reflects a terminal failure (resolution order grant -> completing -> claim
 *     -> fail -> pending, see resolveByTxn):
 *       a. `grant:{adapter}:{txn}` present → a neutral `granted` view (200) - access was granted
 *          directly (grant_mode `username` happy path) or a claim was just completed.
 *       b. else `claim_submitted:{adapter}:{txn}` present → the `pending` view (200): a handle was just
 *          submitted and the grant is in flight, so poll rather than bounce back to the claim form.
 *       c. else `claim_txn:{adapter}:{txn}` present → 302 to the single-use `/claim/:token` flow
 *          (grant_mode `claim`, OR a username typo-fallback that produced a claim).
 *       d. else `fail:{adapter}:{txn}` present → a neutral `failed` view (200) - the grant failed
 *          terminally (the workflow wrote the marker), so the buyer gets a definite signal.
 *       e. else → a neutral `pending` view (200) that auto-polls across the KV consistency window.
 *
 * This is the re-queryable delivery channel: it survives a dropped or closed post-checkout redirect
 * (the deployer can resolve the same txn again). The grant workflow runs async AFTER the webhook ack
 * returns, so no key may exist yet at the instant of the redirect - the (d) case renders a neutral
 * "preparing" page rather than 404, leaking no distinction between not-yet-written and never-existed and
 * exposing no token; its client poll (POLL_JS) reloads every ~4s (capped ~25x) so a successful grant
 * surfaces without a manual refresh once KV's ~60s key-miss cache expires. Read-only: KV existence
 * checks + a redirect, no grant, no workflow enqueue, no side effects. The `granted` and `failed`
 * branches check ONLY for the record's existence - they never parse or echo the grant detail (handle /
 * teams / org) or the failure detail, so no purchase data is exposed by the txn-as-bearer-credential.
 *
 * The `:txn` segment is alias-resolved first (see `sessionTxnKey`): a merchant redirect that carries
 * an id differing from the transaction_id (Stripe `cs_...` session id vs the `pi_...` claim key) is
 * mapped through `session_txn:{adapter}:{id}` before the lookups; a direct transaction_id resolves
 * unchanged. The mechanism is generic - adapters whose redirect id IS the transaction_id
 * write no alias and need no change.
 *
 * `adapterNames` gates the `:adapter` segment (unknown adapter → 404), mirroring the `/wh` lookup.
 */
export function makeClaimByTxn(
  template: ClaimTemplate,
  config: RepoAccessConfig,
  adapterNames: ReadonlySet<string>,
) {
  return async function handleClaimByTxn(c: ByTxnCtx): Promise<Response> {
    harden(c)
    const adapter = c.req.param('adapter')
    if (!adapterNames.has(adapter)) return c.notFound() // unknown adapter → 404

    const txn = c.req.param('txn')
    const brand = branding(config)

    // Single source of truth for by-txn resolution (also composed by Pro's RPC service):
    // alias-resolves the redirect id, then checks claim -> grant -> fail -> pending. Map each state to
    // its landing response.
    const { state, token } = await resolveByTxn(c.env, adapter, txn)

    // (a) A pending claim exists → hand off to the single-use claim flow via a same-origin redirect.
    if (state === 'claim') {
      return c.redirect(`/claim/${token}`, 302)
    }

    // (b) A grant record exists → access was granted directly (username happy path). Neutral view;
    // resolveByTxn checked existence only, so no handle/teams/org detail is available to leak here.
    if (state === 'granted') {
      return c.html(template({ brand, view: { kind: 'granted' } }))
    }

    // (c) A terminal-failure marker exists → the grant failed for good (bad handle on a username grant
    // / un-correctable GitHub error / exhausted retries). Show a terminal `failed` view so the buyer
    // gets a definite signal instead of looping on `pending`; the coarse marker value is never echoed.
    if (state === 'failed') {
      return c.html(template({ brand, view: { kind: 'failed' } }))
    }

    // (d) Eventual consistency: no key (yet) present → neutral preparing view (no token exposed) that
    // auto-polls (POLL_JS) across the ~60s KV miss-cache window until a terminal view replaces it.
    return c.html(
      template({ brand, view: { kind: 'pending', pollScript: POLL_JS } }),
    )
  }
}
