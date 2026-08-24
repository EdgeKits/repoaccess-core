// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Gary Stupak

import type {
  PaymentAdapter,
  RawRequest,
  VerificationStrategy,
  VerifiedEntity,
} from '../types'

/**
 * Verification engine. Core declares the strategy on each adapter and
 * executes it here - adapters never do their own crypto. Runs on the fast-ack request path, so it
 * does no work beyond the signature check (hmac) or the single entity fetch (api_callback, which is
 * itself the verification). On failure the route rejects BEFORE enqueueing.
 */
export type VerifyResult =
  { ok: true; entity?: VerifiedEntity } | { ok: false; reason: string }

type HmacStrategy = Extract<VerificationStrategy, { kind: 'hmac' }>
type ApiCallbackStrategy = Extract<
  VerificationStrategy,
  { kind: 'api_callback' }
>
type SharedSecretHeaderStrategy = Extract<
  VerificationStrategy,
  { kind: 'shared_secret_header' }
>

const encoder = new TextEncoder()

async function hmacHex(
  algo: 'SHA-256' | 'SHA-512',
  secret: string,
  message: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: algo },
    false,
    ['sign'],
  )
  const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(message))
  const bytes = new Uint8Array(mac)
  let hex = ''
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0')
  return hex
}

/**
 * Constant-time hex compare. The length check is acceptable: a digest's length is fixed by its
 * algorithm, so a length mismatch only ever means an invalid signature, not a secret-dependent
 * branch. The XOR loop over equal-length strings does not short-circuit. (invariant: timing-safe)
 */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/**
 * Constant-time UTF-8 string compare with NO early length-leak. Used for the api_callback
 * `:secret_path` credential check - unlike `timingSafeEqualHex` (which returns early on a length
 * mismatch, acceptable for fixed-length digests but a length oracle for a variable-length secret),
 * this folds the length difference into the accumulator and always iterates over the EXPECTED
 * secret's byte length. So neither the candidate's content nor its length short-circuits: a wrong
 * length still fails (via the length XOR) without a distinguishable early return, and the loop count
 * depends only on the deployment-fixed `expected`, never on attacker input.
 */
export function timingSafeEqualString(
  candidate: string,
  expected: string,
): boolean {
  const a = encoder.encode(candidate)
  const b = encoder.encode(expected)
  let diff = a.length ^ b.length
  for (let i = 0; i < b.length; i++) {
    diff |= b[i] ^ (i < a.length ? a[i] : 0)
  }
  return diff === 0
}

export async function verifyHmac(
  strategy: HmacStrategy,
  raw: RawRequest,
  env: CloudflareBindings,
  nowMs: number = Date.now(),
): Promise<VerifyResult> {
  const secret = strategy.secret(env)
  if (!secret) return { ok: false, reason: 'missing signing secret' }

  const { signature, ts } = strategy.extract(raw.headers)
  const candidates = (
    Array.isArray(signature) ? signature : [signature]
  ).filter(Boolean)
  if (candidates.length === 0) return { ok: false, reason: 'missing signature' }

  // Replay window, only where the provider supplies a timestamp.
  if (strategy.toleranceSec !== undefined) {
    if (!ts) return { ok: false, reason: 'missing timestamp' }
    const tsSec = Number(ts)
    if (!Number.isFinite(tsSec))
      return { ok: false, reason: 'invalid timestamp' }
    if (Math.abs(nowMs / 1000 - tsSec) > strategy.toleranceSec) {
      return { ok: false, reason: 'timestamp outside tolerance' }
    }
  }

  const expected = await hmacHex(strategy.algo, secret, strategy.canonical(raw))
  // Match against ANY candidate (e.g. Stripe sends one v1 per active secret during rotation).
  const matched = candidates.some((candidate) =>
    timingSafeEqualHex(expected, candidate.toLowerCase()),
  )
  if (!matched) return { ok: false, reason: 'signature mismatch' }
  return { ok: true }
}

export async function verifyApiCallback(
  strategy: ApiCallbackStrategy,
  raw: RawRequest,
  env: CloudflareBindings,
): Promise<VerifyResult> {
  // The inbound payload is never trusted: the grant decision reads only this fetched entity.
  // (The route's :secret_path segment is the first-line filter: it is timing-safe-compared against the
  // adapter's secretPath(env) and 401s before any fetch, parse or enqueue - see create-worker.ts. This
  // function's job is the authoritative entity fetch that stands in for a signature.)
  const entity = await strategy.fetchEntity(raw, env)
  if (!entity) return { ok: false, reason: 'entity fetch returned null' }
  return { ok: true, entity }
}

/**
 * Verify a `shared_secret_header` request: the provider echoes a shared secret in a fixed header.
 * Constant-time compare that header against the
 * configured secret - fail-closed when the secret is unset OR the header is missing/mismatched (401),
 * the same posture as the other two kinds. The secret authenticates the TRANSPORT: no body is signed
 * and no entity is re-fetched, so this does NO body parse and NO outbound I/O - once the header
 * matches, the inbound body is authentic and the grant reads it directly (like hmac, unlike
 * api_callback). Synchronous, but returns a `VerifyResult` for a uniform `verifyRequest` surface.
 */
export function verifySharedSecretHeader(
  strategy: SharedSecretHeaderStrategy,
  raw: RawRequest,
  env: CloudflareBindings,
): VerifyResult {
  const expected = strategy.secret(env)
  if (!expected) return { ok: false, reason: 'missing shared secret' }
  const provided = raw.headers.get(strategy.header)
  // No header → fail-closed. (Compare anyway would also fail, but skip the work and be explicit.)
  if (provided === null) return { ok: false, reason: 'missing secret header' }
  // Constant-time, no early length-leak - same compare used for the api_callback secret path.
  if (!timingSafeEqualString(provided, expected))
    return { ok: false, reason: 'secret header mismatch' }
  return { ok: true }
}

/** Execute an adapter's declared verification strategy. */
export function verifyRequest(
  adapter: PaymentAdapter,
  raw: RawRequest,
  env: CloudflareBindings,
): Promise<VerifyResult> {
  const strategy = adapter.verification
  switch (strategy.kind) {
    case 'hmac':
      return verifyHmac(strategy, raw, env)
    case 'api_callback':
      return verifyApiCallback(strategy, raw, env)
    case 'shared_secret_header':
      return Promise.resolve(verifySharedSecretHeader(strategy, raw, env))
  }
}
