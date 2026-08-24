// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Gary Stupak

import { Hono } from 'hono'
import type {
  AccessWorkflowParams,
  ApiCallbackPing,
  PaymentAdapter,
  RepoAccessConfig,
} from './types'
import { captureRawRequest } from './security/raw-request'
import { hardenHtmlHeaders } from './security/harden-html'
import {
  apiCallbackInstanceId,
  workflowInstanceId,
} from './workflow/workflow-id'
import { timingSafeEqualString, verifyRequest } from './security/verify'
import { makeClaimGet, makeClaimPost, makeClaimByTxn } from './claim/claim'
import {
  defaultClaimTemplate,
  type ClaimTemplate,
} from './claim/claim-template'
import { makeConfigGate } from './config/config'

export interface CreateWorkerOptions {
  adapters: PaymentAdapter[]
  /**
   * Deployment config as a typed object - `githubOrg`, `productTeamMap`, branding,
   * outbound `eventWebhook`. Non-secret config no longer comes from `wrangler vars`; secrets stay in
   * the env. The Workflow path receives the SAME object via `createAccessWorkflow(config, adapters)`.
   */
  config: RepoAccessConfig
  /**
   * Claim-page HTML template. The open extension point: a downstream worker supplies its
   * own `ClaimTemplate` to restyle every claim state without forking the controller. Defaults to
   * core's `defaultClaimTemplate`.
   */
  claimTemplate?: ClaimTemplate
}

/**
 * Composition root. Core exports this; the example entry composes `[stripe]`, a downstream
 * distribution composes `[stripe, …]` with a longer adapter list. The router code is identical - only
 * the adapter list differs. No provider-specific branches live here.
 */
export function createWorker({
  adapters,
  config,
  claimTemplate = defaultClaimTemplate,
}: CreateWorkerOptions) {
  const adaptersByName = new Map(
    adapters.map((adapter) => [adapter.name, adapter]),
  )
  const app = new Hono<{ Bindings: CloudflareBindings }>()

  // The config gate, and it is registered FIRST so nothing is served past it.
  //
  // TOTAL, not selective: a worker whose config names no GitHub org cannot grant access on any route,
  // so answering some of them would be worse than answering none - it looks like a working deployment.
  // `/health` is included deliberately. It reports whether this worker can do its job, and the answer
  // here is no; a green liveness probe in front of a worker that will refuse every buyer is the exact
  // false signal the wizard's deploy step must not get.
  //
  // The verdict is computed on the FIRST request and cached (see `makeConfigGate` for why it cannot be
  // computed at construction). The message is the deployer's, naming the field and the file to fix, and
  // it carries nothing about the request - there is no attacker-useful detail in "this deployment was
  // never configured", and a deployer staring at a 500 needs to be told which line to edit.
  const configGate = makeConfigGate(config)
  app.use('*', async (c, next) => {
    const rejected = configGate()
    if (rejected !== null) {
      return c.text(
        `This RepoAccess worker is misconfigured and is refusing every request.\n\n${rejected}\n`,
        500,
      )
    }
    await next()
  })

  // Safe-by-default HTML: every text/html response served by this app - core's own claim/delivery
  // pages AND any route a downstream mounts on the returned app (a storefront, a policy page) - gets
  // the baseline hardening headers (nosniff + deny framing) without the route author having to
  // remember them. Absent-only: a route that set its own value keeps it, and the claim pages, which
  // already set these plus their token-specific headers, are byte-identical with or without this.
  // Non-HTML responses (webhook acks, /health JSON) are not touched - the ack path stays as-is.
  app.use('*', async (c, next) => {
    await next()
    const contentType = c.res.headers.get('content-type')
    if (contentType && contentType.toLowerCase().includes('text/html')) {
      hardenHtmlHeaders(c.res.headers)
    }
  })

  // Liveness only - never leak config/secrets. (route map: hono skill)
  app.get('/health', (c) => c.json({ status: 'ok' }))

  // Claim flow. GET renders the JSON projection or the injected HTML template
  // (defaultClaimTemplate unless overridden) after KV token validation; POST validates the
  // handle inline → single-flights via ClaimGuard → enqueues a grant in `username` mode under
  // the id `{adapter}-claim_completed-{transaction_id}-{handle}`. The route does NOT delete the token -
  // the workflow terminal step consumes it on success / retains it on user-not-found. See
  // `claim.tsx` (controller) + `claim-template.tsx` (view contract).
  app.get('/claim/:token', makeClaimGet(claimTemplate, config))
  app.post('/claim/:token', makeClaimPost(claimTemplate, config))

  // Resolve-by-transaction (claim-link delivery). A re-queryable lookup the deployer
  // wires their post-checkout redirect to: claim_txn:{adapter}:{txn} -> token -> 302 /claim/{token},
  // or a neutral `pending` view while the (async) grant workflow has not yet written claim_txn. No
  // route collision: this is 4 path segments vs the 2 of /claim/:token. Read-only (KV read + redirect).
  app.get(
    '/claim/by-txn/:adapter/:txn',
    makeClaimByTxn(claimTemplate, config, new Set(adaptersByName.keys())),
  )

  /**
   * Inbound payment webhooks. The request path does ONLY: resolve adapter → capture raw body →
   * [verify | secret-path check] → enqueue the Workflow (deterministic id) → ack. No GitHub calls,
   * no outbound events, all side effects run inside the Workflow - so the ack returns without waiting
   * for any of the grant work, which is what keeps it inside a provider's retry window. The constraint
   * is WHAT runs here, not a millisecond budget: this comment used to name one, and a live deployment
   * does not meet it.
   *
   * Three verification kinds, branched here:
   *   - hmac: timing-safe signature check → `parse(raw)` → enqueue the parsed `event`.
   *   - shared_secret_header: timing-safe compare a fixed header against the adapter's configured
   *     secret (fail-closed). Like hmac, the body is then authentic and parsed on the ack path - no
   *     fetch. Shares the hmac code path below (verifyRequest dispatches by kind).
   *   - api_callback: there is no signature. The `:secret_path` segment IS the credential
   *     (timing-safe compared against the adapter's configured path, fail-closed). The authoritative
   *     entity fetch is outbound I/O, so it is deferred to a durable Workflow step - the ack path
   *     enqueues only the RAW ping (no fetch, no parse here).
   */
  app.post('/wh/:adapter/:secret_path', async (c) => {
    const adapter = adaptersByName.get(c.req.param('adapter'))
    if (!adapter) return c.notFound() // unknown adapter → 404

    // Read the raw body byte-exact BEFORE any parse (HMAC depends on it).
    const raw = await captureRawRequest(c.req.raw)

    if (adapter.verification.kind === 'api_callback') {
      // First-line credential (replaces HMAC for api_callback): timing-safe compare the path segment
      // against the adapter's configured secret path. Unset secret OR mismatch → 401, fail-closed,
      // BEFORE any fetch/parse/enqueue. No outbound I/O on the ack path.
      const expected = adapter.verification.secretPath(c.env)
      const provided = c.req.param('secret_path')
      if (!expected || !timingSafeEqualString(provided, expected)) {
        console.log(
          JSON.stringify({
            level: 'warn',
            msg: 'webhook secret-path rejected',
            adapter: adapter.name,
          }),
        )
        return c.text('unauthorized', 401)
      }

      // The event isn't known until the entity is fetched (in the Workflow), so the id hashes the raw
      // ping body: identical retried pings dedupe; distinct events (different bodies) get distinct ids.
      const id = await apiCallbackInstanceId(adapter.name, raw.bodyText)
      const ping: ApiCallbackPing = {
        bodyText: raw.bodyText,
        form: Object.fromEntries(raw.bodyForm ?? []),
      }
      // `webhook`: the secret-path credential was checked above, and the Workflow's own entity fetch
      // is the rest of the verification. It arrives over HTTP from the provider either way.
      const params: AccessWorkflowParams = {
        adapter: adapter.name,
        ping,
        origin: 'webhook',
      }
      await c.env.ACCESS_WORKFLOW.createBatch([{ id, params }])
      return c.text('ok', 200)
    }

    // hmac | shared_secret_header - execute the adapter's declared check (timing-safe compare +
    // optional tolerance, or a timing-safe header-secret compare). Reject BEFORE enqueue on failure.
    const verification = await verifyRequest(adapter, raw, c.env)
    if (!verification.ok) {
      // Structured warn on verification failure - never log signatures/secrets/body.
      // Visibility into rejected webhooks without leaking anything sensitive.
      console.log(
        JSON.stringify({
          level: 'warn',
          msg: 'webhook verification failed',
          adapter: adapter.name,
        }),
      )
      return c.text('invalid signature', 401)
    }

    // Optional interactive-handshake hook. Runs ONLY after verify passed (so it can never bypass
    // auth), BEFORE parse → enqueue. A returned Response IS the ack (e.g. answering an interactive
    // pre-charge query); `null` falls through to the normal parse path. No-op for adapters that
    // omit it - the hmac/api_callback paths stay byte-identical. The hook's own outbound (the ack
    // call back to the provider) is the adapter's bounded concern.
    if (adapter.handle) {
      const handled = await adapter.handle(raw, c.env)
      if (handled) return handled
    }

    const event = adapter.parse(raw)
    if (!event) return c.text('unprocessable entity', 400) // malformed/unrecognized → 400

    // Deterministic Workflow id = the idempotency key (`-`-joined, see workflow-id.ts -
    // the runtime rejects the `:` separator). This IS the dedupe mechanism - no KV bookkeeping.
    // `createBatch` is idempotent: a duplicate id (within the instance retention window) is silently
    // skipped (NOT thrown), so we still ack 200. (Workflows API, verified against docs + runtime)
    // The event's own answer goes into the id: on a refund it becomes the scope suffix, so a refund
    // paid in stages is two instances instead of one silently-dedupled one (see workflow-id.ts).
    const id = await workflowInstanceId(
      adapter.name,
      event.event_type,
      event.transaction_id,
      event.is_full_refund,
    )
    // `webhook`: verification passed above, so this grant descends from a signed (or shared-secret)
    // provider delivery. Stated explicitly rather than left to the default - a reader of the record
    // should not have to know which way an absent value falls.
    const params: AccessWorkflowParams = {
      adapter: adapter.name,
      event,
      origin: 'webhook',
    }
    await c.env.ACCESS_WORKFLOW.createBatch([{ id, params }])

    return c.text('ok', 200)
  })

  return app
}
