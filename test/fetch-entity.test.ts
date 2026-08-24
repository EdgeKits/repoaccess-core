// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Gary Stupak

import { describe, it, expect, vi, afterEach } from 'vitest'
import { fetchVerifiedEntity } from '../src/fetch-entity'

// The core guardrail for api_callback entity fetches (closes the api_callback security gate): https-only +
// SSRF + redirect:'manual' + timeout, with the retry contract 2xx→json / 404→null / else→throw.

const env = {} as CloudflareBindings

function mockFetch(
  impl: (url: string, init: RequestInit) => Response | Promise<Response>,
) {
  return vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : (input as Request).url
      return impl(url, (init ?? {}) as RequestInit)
    })
}

afterEach(() => vi.restoreAllMocks())

describe('fetchVerifiedEntity', () => {
  it('2xx → parsed JSON entity; passes headers + redirect:manual + GET', async () => {
    let seen: RequestInit | undefined
    mockFetch((_url, init) => {
      seen = init
      return new Response(
        JSON.stringify({ success: true, sale: { id: 's1' } }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      )
    })
    const out = await fetchVerifiedEntity(
      'https://api.example.com/v2/sales/s1',
      { headers: { Authorization: 'Bearer tok' } },
      env,
    )
    expect(out).toEqual({ success: true, sale: { id: 's1' } })
    expect(seen?.method).toBe('GET')
    expect(seen?.redirect).toBe('manual') // never follow a redirect
    expect((seen?.headers as Record<string, string>).Authorization).toBe(
      'Bearer tok',
    )
  })

  it('404 → null (definitive not-found / forged id), body never read', async () => {
    mockFetch(() => new Response('should-not-be-read', { status: 404 }))
    expect(
      await fetchVerifiedEntity(
        'https://api.example.com/v2/sales/nope',
        {},
        env,
      ),
    ).toBeNull()
  })

  it('5xx → throw (transient → durable step retries)', async () => {
    mockFetch(() => new Response(null, { status: 503 }))
    await expect(
      fetchVerifiedEntity('https://api.example.com/v2/sales/s1', {}, env),
    ).rejects.toThrow(/HTTP 503/)
  })

  it('401/403 (auth) → throw, not null', async () => {
    mockFetch(() => new Response(null, { status: 401 }))
    await expect(
      fetchVerifiedEntity('https://api.example.com/v2/sales/s1', {}, env),
    ).rejects.toThrow(/HTTP 401/)
  })

  it('a 3xx surfaced by redirect:manual → throw (never follow)', async () => {
    mockFetch(() => new Response(null, { status: 302 }))
    await expect(
      fetchVerifiedEntity('https://api.example.com/v2/sales/s1', {}, env),
    ).rejects.toThrow(/HTTP 302/)
  })

  it('non-https URL → throw (SSRF guard), fetch never called', async () => {
    const spy = mockFetch(() => new Response('{}', { status: 200 }))
    await expect(
      fetchVerifiedEntity('http://api.example.com/v2/sales/s1', {}, env),
    ).rejects.toThrow(/blocked/)
    expect(spy).not.toHaveBeenCalled()
  })

  it('private/reserved host → throw (SSRF guard), fetch never called', async () => {
    const spy = mockFetch(() => new Response('{}', { status: 200 }))
    await expect(
      fetchVerifiedEntity('https://169.254.169.254/latest/meta-data', {}, env),
    ).rejects.toThrow(/blocked/)
    expect(spy).not.toHaveBeenCalled()
  })

  it('a network error / abort propagates as a throw (→ retry)', async () => {
    mockFetch(() => {
      throw new Error('network down')
    })
    await expect(
      fetchVerifiedEntity('https://api.example.com/v2/sales/s1', {}, env),
    ).rejects.toThrow(/network down/)
  })
})
