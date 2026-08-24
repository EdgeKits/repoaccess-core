// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Gary Stupak

/**
 * SSRF guard for outbound event delivery. **Always on** - there is no flag to
 * disable it. `validateWebhookUrl` runs before every outbound fetch and enforces:
 *   - https only (http only when explicitly opted in);
 *   - reject IP-literal hosts in private / reserved / loopback / link-local ranges, including the
 *     `169.254.169.254` cloud-metadata address;
 *   - an optional exact-or-suffix domain allowlist.
 *
 * ⚠️ workerd LIMITATION: a Worker cannot resolve a hostname to its IP address in-process, so a
 * hostname that *resolves* to a private IP (DNS rebinding) is NOT caught by the IP-literal checks
 * below. The domain **allowlist** is the strong control against that - recommend sellers set it.
 * `redirect: 'manual'` at the fetch call site blocks redirect-to-internal. (Residual documented in
 * the security audit.)
 *
 * Pure + dependency-free so it can be unit-tested directly and read in one sitting (security
 * code readability is a feature).
 */

export interface SsrfOptions {
  /** Host allowlist; when non-empty the host must match one entry (exact or suffix). */
  allowlist?: string[]
  /** Permit `http:` (default false → https only). */
  allowHttp?: boolean
}

export type SsrfResult = { ok: true; url: URL } | { ok: false; reason: string }

export function validateWebhookUrl(
  raw: string,
  opts: SsrfOptions = {},
): SsrfResult {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { ok: false, reason: 'invalid url' }
  }

  if (
    url.protocol !== 'https:' &&
    !(opts.allowHttp && url.protocol === 'http:')
  ) {
    return { ok: false, reason: `scheme ${url.protocol} not allowed` }
  }

  // URL.hostname keeps brackets for IPv6 literals on some runtimes - strip them defensively.
  const host = url.hostname.replace(/^\[/, '').replace(/\]$/, '').toLowerCase()

  const v4 = parseIPv4(host)
  if (v4) {
    if (isPrivateIPv4(v4)) return { ok: false, reason: 'private/reserved IPv4' }
  } else if (host.includes(':')) {
    const v6 = parseIPv6(host)
    if (!v6) return { ok: false, reason: 'unparseable IPv6 literal' }
    if (isBlockedIPv6(v6)) return { ok: false, reason: 'private/reserved IPv6' }
  }
  // else: a DNS hostname - cannot resolve in-worker (see header note); the allowlist is the control.

  const allow = parseAllowlist(opts.allowlist)
  if (allow.length > 0 && !hostMatchesAllowlist(host, allow)) {
    return { ok: false, reason: 'host not in allowlist' }
  }

  return { ok: true, url }
}

// --- IPv4 -------------------------------------------------------------------

function parseIPv4(host: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (!m) return null
  const octets = m.slice(1, 5).map((s) => Number(s))
  return octets.some((o) => o > 255) ? null : octets
}

function isPrivateIPv4([a, b]: number[]): boolean {
  if (a === 10) return true // 10/8 private
  if (a === 172 && b >= 16 && b <= 31) return true // 172.16/12 private
  if (a === 192 && b === 168) return true // 192.168/16 private
  if (a === 127) return true // 127/8 loopback
  if (a === 0) return true // 0.0.0.0/8 "this network"
  if (a === 169 && b === 254) return true // 169.254/16 link-local (incl. 169.254.169.254 metadata)
  if (a === 100 && b >= 64 && b <= 127) return true // 100.64/10 CGNAT (defense-in-depth)
  if (a >= 224) return true // 224/4 multicast + 240/4 reserved + 255.255.255.255 (defense-in-depth)
  return false
}

// --- IPv6 -------------------------------------------------------------------

function parseIPv6(input: string): Uint8Array | null {
  let s = input
  const pct = s.indexOf('%')
  if (pct !== -1) s = s.slice(0, pct) // strip zone id

  // Embedded IPv4 tail (e.g. ::ffff:1.2.3.4) → fold into two hextets.
  if (s.includes('.')) {
    const i = s.lastIndexOf(':')
    if (i === -1) return null
    const v4 = parseIPv4(s.slice(i + 1))
    if (!v4) return null
    const hi = ((v4[0] << 8) | v4[1]).toString(16)
    const lo = ((v4[2] << 8) | v4[3]).toString(16)
    s = `${s.slice(0, i + 1)}${hi}:${lo}`
  }

  const halves = s.split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(':') : []
  const tail =
    halves.length === 2 ? (halves[1] ? halves[1].split(':') : []) : null

  let groups: string[]
  if (tail === null) {
    groups = head
  } else {
    const missing = 8 - head.length - tail.length
    if (missing < 1) return null // '::' must stand in for ≥1 group
    groups = [...head, ...Array(missing).fill('0'), ...tail]
  }
  if (groups.length !== 8) return null

  const bytes = new Uint8Array(16)
  for (let i = 0; i < 8; i++) {
    if (!/^[0-9a-f]{1,4}$/.test(groups[i])) return null
    const v = parseInt(groups[i], 16)
    bytes[i * 2] = v >> 8
    bytes[i * 2 + 1] = v & 0xff
  }
  return bytes
}

function isBlockedIPv6(b: Uint8Array): boolean {
  if (b.every((x) => x === 0)) return true // :: unspecified
  if (b.slice(0, 15).every((x) => x === 0) && b[15] === 1) return true // ::1 loopback
  if ((b[0] & 0xfe) === 0xfc) return true // fc00::/7 unique-local
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true // fe80::/10 link-local
  // IPv4-mapped ::ffff:a.b.c.d → apply the v4 rules to the embedded address.
  const mapped =
    b.slice(0, 10).every((x) => x === 0) && b[10] === 0xff && b[11] === 0xff
  if (mapped && isPrivateIPv4([b[12], b[13], b[14], b[15]])) return true
  return false
}

// --- allowlist --------------------------------------------------------------

function parseAllowlist(raw?: string[]): string[] {
  if (!raw) return []
  return raw.map((s) => s.trim().toLowerCase()).filter(Boolean)
}

function hostMatchesAllowlist(host: string, allow: string[]): boolean {
  return allow.some((entry) => host === entry || host.endsWith(`.${entry}`))
}
