// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Gary Stupak

import type { GrantOrigin, NormalizedEvent, RepoAccessConfig } from './types'
import { validateWebhookUrl } from './security/ssrf'

// Outbound event envelopes. The envelope shape + a structured-log sink shipped first; the signed-HTTP
// delivery sink was added behind the SAME EventSink interface (so callers don't change).
// Delivery runs in a Workflow step AFTER the GitHub side effect and must never block or fail the
// grant: transient failures throw (the durable engine retries), and the emit step swallows the
// final exhaustion (see workflow emitEvent()).

export type OutboundEventType =
  | 'access.granted'
  | 'access.failed'
  | 'access.revoked'
  | 'claim.pending'
  | 'claim.completed'

export interface EventEnvelope {
  event_id: string
  event_type: OutboundEventType
  timestamp: string
  product_id: string
  transaction_id: string
  buyer_email: string | null
  org: string
  /**
   * How the INSTANCE that emitted this was authorized - a verified provider webhook, or a direct
   * call by a worker bound on the same account. On a grant it is the provenance of the grant; on a
   * revoke it is the provenance of the revoke, which is the same question asked of the event that
   * withdrew access. The authoritative copy is the one on the grant RECORD: delivery can exhaust and
   * be dropped, so a value that lived only here would be lost exactly when an incident needs it.
   *
   * OPTIONAL, because the answer is not always known and a guess is worse than a gap - see
   * `buildEnvelope`. The key is omitted entirely rather than sent as null, so a consumer's
   * "did the worker say?" is a presence check and never a value comparison.
   */
  origin?: GrantOrigin
  // Per-event fields: github_username (string|null), teams (string[]), status/reason/claim_url/
  // trigger (string). A flat scalar/array union - not a recursive JSON type - keeps the envelope
  // Serializable cheaply across the `step.do` boundary that emits it (avoids TS2589).
  //
  // The `| undefined` is what lets the OPTIONAL `origin` above sit under this signature at all; it
  // is deliberately not folded into `EnvelopeField`, so an `extra` a caller passes stays strict.
  [extra: string]: EnvelopeField | undefined
}

/** Value type for an envelope's per-event extra fields (see the index signature above). */
export type EnvelopeField = string | string[] | null

/**
 * Build the base envelope + per-type fields. event_id is THIS delivery's id (not the txn).
 *
 * `origin` is a declared PARAMETER rather than something a caller may pass in `extra`, so an emit
 * site cannot skip the question: every envelope this function produces either states how its
 * instance was authorized or leaves the key out. It sits next to `org` and is typed as the narrow
 * union for the same reason - two adjacent strings would be swappable at a call site, and these two
 * are not. `undefined` is a legal ANSWER to that parameter, not a way to avoid passing it.
 *
 * An unknown origin omits the KEY rather than sending a null or a fallback value. A fallback would
 * be a claim the worker cannot support, and a null still has to be told apart from a real value by
 * every consumer; an absent key is the only shape that says "no answer was recorded" without
 * asserting anything.
 */
export function buildEnvelope(
  org: string,
  origin: GrantOrigin | undefined,
  type: OutboundEventType,
  event: NormalizedEvent,
  extra: Record<string, EnvelopeField> = {},
): EventEnvelope {
  return {
    event_id: crypto.randomUUID(),
    event_type: type,
    timestamp: new Date().toISOString(),
    product_id: event.product_id,
    transaction_id: event.transaction_id,
    buyer_email: event.buyer_email,
    org,
    ...(origin ? { origin } : {}),
    ...extra,
  }
}

/** A delivery sink. The default logs; a signed-HTTP + SSRF-guarded sink is also provided. */
export type EventSink = (envelope: EventEnvelope) => void | Promise<void>

// The envelope legitimately carries buyer_email (PII) and, on claim.pending, claim_url (a single-use
// bearer token) for delivery to the seller - but the LOG fallback must contain neither.
// buyer_email is redacted; claim_url is dropped entirely (the full URL still reaches the
// outbound HTTP sink via deliver(); only this log line omits it).
export const logSink: EventSink = (envelope) => {
  const { buyer_email, claim_url: _claim_url, ...rest } = envelope
  console.log(
    JSON.stringify({
      level: 'info',
      msg: 'event',
      ...rest,
      buyer_email: buyer_email ? '[redacted]' : null,
    }),
  )
}

// --- signed HTTP delivery ------------------------------------

const DELIVERY_TIMEOUT_MS = 10_000

const encoder = new TextEncoder()

/**
 * HMAC-SHA256 over the canonical `${ts}.${body}` string, hex. Deliberately mirrors our inbound
 * Stripe-style scheme (verify.ts) so a seller verifies our deliveries with the same signature scheme
 * they already use for inbound webhooks.
 */
async function signDelivery(
  secret: string,
  ts: string,
  body: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const mac = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(`${ts}.${body}`),
  )
  return [...new Uint8Array(mac)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * Read the OPTIONAL outbound-signing secret without declaring it on the deployer's env type.
 *
 * `EVENT_WEBHOOK_SECRET` signs outbound deliveries and is opt-in: it matters only when the deployer
 * sets `eventWebhook.url` in their config. wrangler's `secrets` has no `optional` list, so core's
 * shipped `wrangler.jsonc.example` deliberately leaves the name out of `secrets.required` - listing
 * it there would force it set before EVERY deploy, including the deploys of everyone who never turns
 * outbound delivery on. A deployer who DOES use the feature may well list it anyway, precisely so a
 * deploy refuses without it, and that is a legitimate choice core must not punish.
 *
 * THOSE TWO CHOICES GENERATE DIFFERENT ENV TYPES, and no single declaration by core fits both.
 * `wrangler types` writes the declared secrets into the interface `CloudflareBindings` extends, so
 * listing the name makes the member REQUIRED there:
 *   - core declaring it OPTIONAL breaks the deployer who listed it. `string | undefined` is not
 *     assignable to `string`, the merged interface no longer extends its own base, and their tree
 *     stops type-checking on a file inside core, through no error of theirs.
 *   - core declaring it REQUIRED compiles in both worlds and LIES in one. The deployer who did not
 *     list it gets a type promising a string that is not there - on a security-relevant value this
 *     module has to fail closed on, and whose absence is the ordinary case.
 *
 * So core declares nothing globally and widens LOCALLY, here, at its one reader. The intersection
 * resolves to `string` where the deployer declared the secret and to `string | undefined` where they
 * did not - true in both worlds - and the return type narrows both to the only thing this module may
 * assume. A deployer who wants to read the name in their OWN code declares it in
 * `secrets.required`, which is what makes it exist for them.
 */
function outboundSigningSecret(env: CloudflareBindings): string | undefined {
  return (env as CloudflareBindings & { EVENT_WEBHOOK_SECRET?: string })
    .EVENT_WEBHOOK_SECRET
}

function safeHost(raw: string): string {
  try {
    return new URL(raw).host
  } catch {
    return '(unparseable)'
  }
}

/**
 * POST the signed envelope to the configured delivery URL. Returns (no-op) for config conditions
 * that a retry can't fix - destination unset, secret missing (fail-closed: never send unsigned), or
 * the SSRF guard rejecting the URL. THROWS on a transient delivery failure (non-2xx, timeout,
 * network) so the durable Workflow engine retries the emit step. The destination +
 * allowlist come from `config.eventWebhook`; the signing secret stays in env.
 */
async function deliver(
  env: CloudflareBindings,
  config: RepoAccessConfig,
  envelope: EventEnvelope,
): Promise<void> {
  const url = config.eventWebhook?.url
  if (!url) return // optional destination unset → nothing to deliver

  const secret = outboundSigningSecret(env) // optional secret → string | undefined
  if (!secret) {
    // Fail-closed, consistent with inbound: a configured URL with no secret must NOT send unsigned.
    console.log(
      JSON.stringify({
        level: 'error',
        msg: 'event delivery misconfigured: eventWebhook.url set but EVENT_WEBHOOK_SECRET missing',
      }),
    )
    return
  }

  const check = validateWebhookUrl(url, {
    allowlist: config.eventWebhook?.allowlist,
  })
  if (!check.ok) {
    console.log(
      JSON.stringify({
        level: 'error',
        msg: 'event delivery blocked by SSRF guard',
        reason: check.reason,
        host: safeHost(url),
      }),
    )
    return
  }

  const body = JSON.stringify(envelope)
  const ts = String(Math.floor(Date.now() / 1000))
  const signature = await signDelivery(secret, ts, body)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS)
  try {
    const res = await fetch(check.url.toString(), {
      method: 'POST',
      body,
      headers: {
        'content-type': 'application/json',
        'x-repoaccess-signature': `sha256=${signature}`,
        'x-repoaccess-timestamp': ts,
      },
      redirect: 'manual', // never follow a redirect to an internal target
      signal: controller.signal,
    })
    // redirect:'manual' surfaces a 3xx as-is; any non-2xx (incl. a redirect) is a delivery failure.
    if (!res.ok) throw new Error(`event delivery: HTTP ${res.status}`)
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Production sink: structured log (always, redacted) + signed HTTP delivery. Swapped in by
 * `AccessWorkflow.run`; `executeAccessWorkflow` still defaults to `logSink` for tests/local.
 */
export function createEventSink(
  env: CloudflareBindings,
  config: RepoAccessConfig,
): EventSink {
  return async (envelope) => {
    logSink(envelope)
    await deliver(env, config, envelope)
  }
}
