// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Gary Stupak

import { validateWebhookUrl, type SsrfOptions } from './security/ssrf'
import type { VerifiedEntity } from './types'

/**
 * Guarded outbound fetch for `api_callback` entity verification - the core guardrail that closes the
 * api_callback security gate. An adapter's `fetchEntity` builds the provider URL (with the
 * untrusted lookup id `encodeURIComponent`'d - that part the adapter must still do) and calls this
 * helper instead of bare `fetch`, so every entity fetch gets the same protections the outbound event
 * sink already has (`src/events.ts`): https-only, SSRF guard (`src/ssrf.ts` - reject private/reserved
 * IP-literal hosts), `redirect: 'manual'` (never follow a 3xx to an internal target), and a
 * per-attempt `AbortController` timeout.
 *
 * Return/throw semantics match `resolveApiCallbackEvent`'s retry model (`src/workflow.ts`):
 *   - **2xx** → parsed JSON entity.
 *   - **404** → `null` (a *definitive* not-found - a forged/unknown id → the adapter returns `null` →
 *     terminal `access.failed`, with no retry storm).
 *   - **everything else** → THROW: other non-2xx (incl. a 3xx surfaced by `redirect: 'manual'`, and
 *     auth errors like 401/403), network errors, the timeout abort, and SSRF/non-https rejects. The
 *     durable fetch-entity step retries a throw; on exhaustion it becomes `access.failed`. Throwing
 *     (not returning `null`) on these keeps an ambiguous/transient failure from masquerading as a
 *     clean "forged id".
 *
 * Never follows redirects; never reads a non-2xx body beyond its status. The auth token belongs in
 * `opts.headers` (`Authorization: Bearer …`), keeping it out of the URL and logs.
 */

const DEFAULT_TIMEOUT_MS = 10_000

export interface FetchEntityOptions {
  /** Request headers - put the provider auth token here (e.g. `Authorization: Bearer <token>`). */
  headers?: Record<string, string>
  /** Per-attempt timeout (default 10s). */
  timeoutMs?: number
  /** SSRF options (e.g. a host allowlist); https-only is enforced regardless. */
  ssrf?: SsrfOptions
}

function is2xx(status: number): boolean {
  return status >= 200 && status < 300
}

export async function fetchVerifiedEntity(
  url: string,
  opts: FetchEntityOptions = {},
  // Reserved for future env-derived fetch policy (e.g. an SSRF allowlist / http opt-in from config);
  // kept in the signature so adapters call a stable `fetchVerifiedEntity(url, opts, env)` shape.
  _env?: CloudflareBindings,
): Promise<VerifiedEntity | null> {
  const check = validateWebhookUrl(url, opts.ssrf) // https-only + private/reserved-IP reject
  if (!check.ok) {
    // Security reject → throw (the step retries, then access.failed) rather than a silent null.
    throw new Error(`fetchVerifiedEntity blocked: ${check.reason}`)
  }

  const controller = new AbortController()
  const timer = setTimeout(
    () => controller.abort(),
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  )
  try {
    const res = await fetch(check.url.toString(), {
      method: 'GET',
      headers: opts.headers,
      redirect: 'manual', // never follow a redirect to an internal target
      signal: controller.signal,
    })
    if (res.status === 404) return null // definitive not-found / forged id → terminal
    if (!is2xx(res.status)) {
      // Other non-2xx (incl. a manual-redirect 3xx and 401/403/5xx) → transient/ambiguous → retry.
      throw new Error(`fetchVerifiedEntity: HTTP ${res.status}`)
    }
    return (await res.json()) as VerifiedEntity
  } finally {
    clearTimeout(timer)
  }
}
