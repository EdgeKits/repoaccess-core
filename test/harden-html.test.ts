// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Gary Stupak

// Baseline HTML hardening - the safe-by-default property of the app `createWorker` returns: every
// text/html response carries `X-Content-Type-Options: nosniff` and `X-Frame-Options: DENY`, whether
// the route is core's own (claim / delivery) or one a downstream mounts on the same app. A security
// header with no test is a security header that quietly disappears.

import { describe, expect, it } from 'vitest'
import { createWorker } from '../src/create-worker'
import { hardenHtmlHeaders } from '../src/security/harden-html'
import { mockConfig, mockEnv, stubAdapter } from './helpers'

function makeApp() {
  return createWorker({ adapters: [stubAdapter()], config: mockConfig() })
}

describe('baseline HTML hardening (createWorker middleware)', () => {
  it('stamps nosniff + DENY on a core HTML page (invalid-claim render)', async () => {
    const app = makeApp()
    const res = await app.request(
      'https://worker.test/claim/not-a-real-token',
      { headers: { accept: 'text/html' } },
      mockEnv({ ENTITLEMENTS: { get: async () => null } }),
    )
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(res.headers.get('X-Frame-Options')).toBe('DENY')
    // The claim pages keep their token-specific headers too - exactly the live-proven set, no fewer.
    expect(res.headers.get('Referrer-Policy')).toBe('no-referrer')
    expect(res.headers.get('Cache-Control')).toBe('no-store')
  })

  it('stamps nosniff + DENY on the by-txn delivery page', async () => {
    const app = makeApp()
    const res = await app.request(
      'https://worker.test/claim/by-txn/stub/txn_123',
      { headers: { accept: 'text/html' } },
      mockEnv({ ENTITLEMENTS: { get: async () => null } }),
    )
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(res.headers.get('X-Frame-Options')).toBe('DENY')
  })

  it('stamps a downstream-mounted HTML route (the composition property)', async () => {
    const app = makeApp()
    app.get('/storefront', (c) => c.html('<h1>catalog</h1>'))
    const res = await app.request(
      'https://worker.test/storefront',
      {},
      mockEnv(),
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(res.headers.get('X-Frame-Options')).toBe('DENY')
  })

  it('never clobbers a route that deliberately chose its own value (absent-only)', async () => {
    const app = makeApp()
    app.get('/embeddable', (c) => {
      c.header('X-Frame-Options', 'SAMEORIGIN')
      return c.html('<p>widget</p>')
    })
    const res = await app.request(
      'https://worker.test/embeddable',
      {},
      mockEnv(),
    )
    expect(res.headers.get('X-Frame-Options')).toBe('SAMEORIGIN')
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff') // the unset one still lands
  })

  it('leaves non-HTML responses untouched (/health JSON, ack path semantics)', async () => {
    const app = makeApp()
    const res = await app.request('https://worker.test/health', {}, mockEnv())
    expect(res.status).toBe(200)
    expect(res.headers.get('X-Content-Type-Options')).toBeNull()
    expect(res.headers.get('X-Frame-Options')).toBeNull()
  })
})

describe('hardenHtmlHeaders (the exported primitive)', () => {
  it('sets both headers when absent', () => {
    const headers = new Headers()
    hardenHtmlHeaders(headers)
    expect(headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(headers.get('X-Frame-Options')).toBe('DENY')
  })

  it('is idempotent and preserves an existing value', () => {
    const headers = new Headers({ 'X-Frame-Options': 'SAMEORIGIN' })
    hardenHtmlHeaders(headers)
    hardenHtmlHeaders(headers)
    expect(headers.get('X-Frame-Options')).toBe('SAMEORIGIN')
    expect(headers.get('X-Content-Type-Options')).toBe('nosniff')
  })
})
