// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Gary Stupak

/**
 * Baseline hardening for every HTML page this worker serves: `X-Content-Type-Options: nosniff` (no
 * content-type sniffing) and `X-Frame-Options: DENY` (no page of this worker is ever legitimately
 * iframed by another site - the claim form, the delivery page, and any storefront a downstream adds
 * are all top-level pages, so denying framing closes clickjacking by default).
 *
 * Sets each header ONLY when absent, so a route that deliberately chose a different value keeps it
 * and a route that already set these exact headers is untouched. The worker's router applies this to
 * every `text/html` response automatically (see `createWorker`); it is also exported so a downstream
 * serving HTML from its own separate app can apply the same baseline without duplicating it.
 *
 * Deliberately NOT here: `Referrer-Policy` / `Cache-Control` (the claim pages set those themselves -
 * their URLs carry a bearer token, which is a claim-specific concern, not a property of every HTML
 * page) and a `Content-Security-Policy` (the shipped pages carry inline scripts that would need
 * per-response nonces; that is separate, deliberate work - do not bolt a CSP on here).
 */
export function hardenHtmlHeaders(headers: Headers): void {
  if (!headers.has('X-Content-Type-Options')) {
    headers.set('X-Content-Type-Options', 'nosniff')
  }
  if (!headers.has('X-Frame-Options')) {
    headers.set('X-Frame-Options', 'DENY')
  }
}
