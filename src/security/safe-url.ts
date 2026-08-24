// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Gary Stupak

/**
 * Allow only an http(s) or relative URL into an href/src. Hono JSX escapes an attribute VALUE but does
 * NOT restrict the URL SCHEME, so a misconfigured seller URL (branding logo/favicon, a refund-policy
 * link) like `javascript:...` would otherwise render live. It is seller-owned config (self-inflicted),
 * but we close the foot-gun: parse against a dummy base (so a relative path resolves and passes) and
 * allow ONLY the `http:` / `https:` protocols - `javascript:` / `data:` / `vbscript:` and any parse
 * throw return ''. The ORIGINAL string is returned when allowed (a relative URL is NOT rewritten to
 * absolute). This is the canonical home; a downstream (RepoAccess Pro's checkout page) can import it.
 */
export function safeUrl(url: string): string {
  try {
    const proto = new URL(url, 'https://x.invalid').protocol
    return proto === 'http:' || proto === 'https:' ? url : ''
  } catch {
    return ''
  }
}
