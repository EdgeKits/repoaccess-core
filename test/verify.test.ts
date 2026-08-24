// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Gary Stupak

import { describe, it, expect } from 'vitest'
import {
  verifyHmac,
  verifyApiCallback,
  verifySharedSecretHeader,
  timingSafeEqualHex,
} from '../src/security/verify'
import type {
  RawRequest,
  VerificationStrategy,
  VerifiedEntity,
} from '../src/types'
import { hmacHex } from './helpers'

const SECRET = 'engine-test-secret'
const env = {} as CloudflareBindings

function raw(body: string, headers: Record<string, string> = {}): RawRequest {
  return { bodyText: body, headers: new Headers(headers) }
}

type Hmac = Extract<VerificationStrategy, { kind: 'hmac' }>

// Raw-body hmac (signature over the raw body, in a header), signature in `x-sig`.
function rawBodyStrategy(algo: 'SHA-256' | 'SHA-512' = 'SHA-256'): Hmac {
  return {
    kind: 'hmac',
    algo,
    secret: () => SECRET,
    canonical: (r) => r.bodyText,
    extract: (h) => ({ signature: h.get('x-sig') ?? '' }),
  }
}

// `ts:body` hmac with a replay tolerance (timestamped signature shape), `x-ts` + `x-sig`.
function tsBodyStrategy(toleranceSec: number): Hmac {
  return {
    kind: 'hmac',
    algo: 'SHA-256',
    secret: () => SECRET,
    canonical: (r) => `${r.headers.get('x-ts') ?? ''}:${r.bodyText}`,
    extract: (h) => ({
      signature: h.get('x-sig') ?? '',
      ts: h.get('x-ts') ?? undefined,
    }),
    toleranceSec,
  }
}

describe('verifyHmac - raw body', () => {
  const body = '{"hello":"world"}'

  it('valid SHA-256 signature passes', async () => {
    const sig = await hmacHex('SHA-256', SECRET, body)
    const result = await verifyHmac(
      rawBodyStrategy('SHA-256'),
      raw(body, { 'x-sig': sig }),
      env,
    )
    expect(result.ok).toBe(true)
  })

  it('valid SHA-512 signature passes (algo is parametrized)', async () => {
    const sig = await hmacHex('SHA-512', SECRET, body)
    const result = await verifyHmac(
      rawBodyStrategy('SHA-512'),
      raw(body, { 'x-sig': sig }),
      env,
    )
    expect(result.ok).toBe(true)
  })

  it('tampered body fails', async () => {
    const sig = await hmacHex('SHA-256', SECRET, body)
    const result = await verifyHmac(
      rawBodyStrategy(),
      raw('{"hello":"tampered"}', { 'x-sig': sig }),
      env,
    )
    // The reason, not just the rejection: a bare ok:false also passes when this fails for a reason that
    // has nothing to do with tampering (an unset secret, a missing header), which would be a test of
    // nothing. The sibling tests below already pin theirs; these three had drifted.
    expect(result).toMatchObject({ ok: false, reason: 'signature mismatch' })
  })

  it('wrong algo fails (SHA-512 signature, SHA-256 strategy)', async () => {
    const sig = await hmacHex('SHA-512', SECRET, body)
    const result = await verifyHmac(
      rawBodyStrategy('SHA-256'),
      raw(body, { 'x-sig': sig }),
      env,
    )
    expect(result).toMatchObject({ ok: false, reason: 'signature mismatch' })
  })

  it('wrong secret fails', async () => {
    const sig = await hmacHex('SHA-256', 'not-the-secret', body)
    const result = await verifyHmac(
      rawBodyStrategy(),
      raw(body, { 'x-sig': sig }),
      env,
    )
    expect(result).toMatchObject({ ok: false, reason: 'signature mismatch' })
  })

  it('missing signature fails', async () => {
    const result = await verifyHmac(rawBodyStrategy(), raw(body), env)
    expect(result).toMatchObject({ ok: false, reason: 'missing signature' })
  })

  it('missing signing secret fails', async () => {
    const strategy = { ...rawBodyStrategy(), secret: () => undefined }
    const sig = await hmacHex('SHA-256', SECRET, body)
    const result = await verifyHmac(strategy, raw(body, { 'x-sig': sig }), env)
    expect(result).toMatchObject({
      ok: false,
      reason: 'missing signing secret',
    })
  })
})

describe('verifyHmac - timestamp tolerance', () => {
  const body = '{"evt":"x"}'
  const nowMs = 1_700_000_000_000
  const nowSec = Math.floor(nowMs / 1000)

  it('valid signature within tolerance passes', async () => {
    const ts = String(nowSec - 2)
    const sig = await hmacHex('SHA-256', SECRET, `${ts}:${body}`)
    const result = await verifyHmac(
      tsBodyStrategy(5),
      raw(body, { 'x-sig': sig, 'x-ts': ts }),
      env,
      nowMs,
    )
    expect(result.ok).toBe(true)
  })

  it('expired timestamp fails even with a valid signature', async () => {
    const ts = String(nowSec - 3600)
    const sig = await hmacHex('SHA-256', SECRET, `${ts}:${body}`)
    const result = await verifyHmac(
      tsBodyStrategy(5),
      raw(body, { 'x-sig': sig, 'x-ts': ts }),
      env,
      nowMs,
    )
    expect(result).toMatchObject({
      ok: false,
      reason: 'timestamp outside tolerance',
    })
  })

  it('missing timestamp fails when tolerance is required', async () => {
    const sig = await hmacHex('SHA-256', SECRET, `:${body}`)
    const result = await verifyHmac(
      tsBodyStrategy(5),
      raw(body, { 'x-sig': sig }),
      env,
      nowMs,
    )
    expect(result).toMatchObject({ ok: false, reason: 'missing timestamp' })
  })
})

describe('verifyApiCallback', () => {
  it('non-null entity passes and is returned', async () => {
    const entity: VerifiedEntity = { status: 'paid' }
    const result = await verifyApiCallback(
      {
        kind: 'api_callback',
        secretPath: () => 'p',
        fetchEntity: async () => entity,
      },
      raw('{}'),
      env,
    )
    expect(result).toEqual({ ok: true, entity })
  })

  it('null entity is rejected (never trust the payload)', async () => {
    const result = await verifyApiCallback(
      {
        kind: 'api_callback',
        secretPath: () => 'p',
        fetchEntity: async () => null,
      },
      raw('{}'),
      env,
    )
    expect(result).toMatchObject({
      ok: false,
      reason: 'entity fetch returned null',
    })
  })
})

describe('verifySharedSecretHeader', () => {
  type Ssh = Extract<VerificationStrategy, { kind: 'shared_secret_header' }>
  const HEADER = 'x-secret-token'
  const strategy: Ssh = {
    kind: 'shared_secret_header',
    header: HEADER,
    secret: () => SECRET,
  }

  it('valid header matching the secret passes (no body parse, no fetch)', () => {
    const result = verifySharedSecretHeader(
      strategy,
      raw('{"any":"body"}', { [HEADER]: SECRET }),
      env,
    )
    expect(result.ok).toBe(true)
  })

  it('missing header fails closed', () => {
    const result = verifySharedSecretHeader(strategy, raw('{}'), env)
    expect(result).toMatchObject({ ok: false, reason: 'missing secret header' })
  })

  it('mismatched header fails closed', () => {
    const result = verifySharedSecretHeader(
      strategy,
      raw('{}', { [HEADER]: 'wrong-token' }),
      env,
    )
    expect(result).toMatchObject({
      ok: false,
      reason: 'secret header mismatch',
    })
  })

  it('unset secret fails closed even when a header is present', () => {
    const unset: Ssh = { ...strategy, secret: () => undefined }
    const result = verifySharedSecretHeader(
      unset,
      raw('{}', { [HEADER]: SECRET }),
      env,
    )
    expect(result).toMatchObject({ ok: false, reason: 'missing shared secret' })
  })
})

describe('timingSafeEqualString (api_callback secret-path)', () => {
  it('true only for an exact match; length mismatch fails without a length oracle', async () => {
    const { timingSafeEqualString } = await import('../src/security/verify')
    expect(timingSafeEqualString('sekret', 'sekret')).toBe(true)
    expect(timingSafeEqualString('sekret', 'secret')).toBe(false)
    expect(timingSafeEqualString('sek', 'sekret')).toBe(false) // shorter candidate
    expect(timingSafeEqualString('sekretxx', 'sekret')).toBe(false) // longer candidate
    expect(timingSafeEqualString('', '')).toBe(true)
  })
})

describe('timingSafeEqualHex', () => {
  it('true for equal strings, false otherwise', () => {
    expect(timingSafeEqualHex('abcd', 'abcd')).toBe(true)
    expect(timingSafeEqualHex('abcd', 'abce')).toBe(false)
    expect(timingSafeEqualHex('abcd', 'abc')).toBe(false)
  })
})
