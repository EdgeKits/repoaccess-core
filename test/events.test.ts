// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Gary Stupak

import { describe, it, expect, vi, afterEach } from 'vitest'
import { buildEnvelope, createEventSink, logSink } from '../src/events'
import type { NormalizedEvent, RepoAccessConfig } from '../src/types'
import { hmacHex } from './helpers'

const event: NormalizedEvent = {
  event_type: 'payment_success',
  product_id: 'prod_x',
  transaction_id: 'pi_1',
  buyer_email: 'buyer@example.com',
  github_username: 'octocat',
  is_full_refund: null,
}

afterEach(() => vi.restoreAllMocks())

describe('events', () => {
  it('buildEnvelope carries the base envelope + per-type extras', () => {
    const envelope = buildEnvelope('acme', 'webhook', 'access.granted', event, {
      teams: ['kit-pro'],
      status: 'success',
    })
    expect(envelope).toMatchObject({
      event_type: 'access.granted',
      org: 'acme',
      product_id: 'prod_x',
      transaction_id: 'pi_1',
      teams: ['kit-pro'],
      status: 'success',
    })
    expect(typeof envelope.event_id).toBe('string')
    expect(envelope.event_id.length).toBeGreaterThan(0)
  })

  it('logSink redacts buyer_email - no raw PII in logs', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    logSink(buildEnvelope('acme', 'webhook', 'access.granted', event, {}))
    const logged = String(spy.mock.calls[0]?.[0])
    expect(logged).not.toContain('buyer@example.com')
    expect(logged).toContain('[redacted]')
  })
})

// --- signed HTTP delivery sink ----------------------------------------
// Config-as-code: the destination URL + allowlist come from config.eventWebhook; only the
// signing secret stays in env (EVENT_WEBHOOK_SECRET).

function evEnv(
  over: Partial<Record<string, unknown>> = {},
): CloudflareBindings {
  return {
    EVENT_WEBHOOK_SECRET: 'evt-secret',
    ...over,
  } as unknown as CloudflareBindings
}

function evConfig(over: Partial<RepoAccessConfig> = {}): RepoAccessConfig {
  return {
    githubOrg: 'testorg',
    productTeamMap: { defaults: { teams: [] } },
    eventWebhook: {
      url: 'https://hooks.example.com/repoaccess',
      allowlist: [],
    },
    ...over,
  }
}

const envelopeFor = (c: RepoAccessConfig) =>
  buildEnvelope(c.githubOrg, 'webhook', 'access.granted', event, {
    github_username: 'octocat',
    teams: ['kit-pro'],
    status: 'success',
  })

function spyFetch(impl?: () => unknown) {
  return vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(
      (impl ?? (() => ({ ok: true, status: 200 }))) as typeof fetch,
    )
}

describe('createEventSink - signed HTTP delivery', () => {
  it('signs `${ts}.${body}` with HMAC-SHA256, posts to the URL, no-redirect + abortable', async () => {
    const e = evEnv()
    const c = evConfig()
    const fetchSpy = spyFetch()

    await createEventSink(e, c)(envelopeFor(c))

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://hooks.example.com/repoaccess')
    expect(init.method).toBe('POST')
    expect(init.redirect).toBe('manual')
    expect(init.signal).toBeInstanceOf(AbortSignal)

    const headers = new Headers(init.headers)
    const ts = headers.get('x-repoaccess-timestamp') as string
    const body = init.body as string
    const expected = `sha256=${await hmacHex('SHA-256', 'evt-secret', `${ts}.${body}`)}`
    expect(headers.get('x-repoaccess-signature')).toBe(expected)
    expect(JSON.parse(body)).toMatchObject({
      event_type: 'access.granted',
      transaction_id: 'pi_1',
    })
  })

  it('URL unset → no-op (no fetch)', async () => {
    const fetchSpy = spyFetch()
    const c = evConfig({ eventWebhook: { url: '', allowlist: [] } })
    await createEventSink(evEnv(), c)(envelopeFor(c))
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('URL set but secret missing → fail-closed (no fetch, logs misconfig)', async () => {
    const fetchSpy = spyFetch()
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const c = evConfig()
    await createEventSink(
      evEnv({ EVENT_WEBHOOK_SECRET: '' }),
      c,
    )(envelopeFor(c))
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(
      logSpy.mock.calls.flat().some((a) => String(a).includes('misconfigured')),
    ).toBe(true)
  })

  it('SSRF-blocked URL (metadata IP) → no fetch', async () => {
    const fetchSpy = spyFetch()
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const c = evConfig({
      eventWebhook: { url: 'https://169.254.169.254/latest', allowlist: [] },
    })
    await createEventSink(evEnv(), c)(envelopeFor(c))
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(
      logSpy.mock.calls.flat().some((a) => String(a).includes('SSRF')),
    ).toBe(true)
  })

  it('host not in allowlist → no fetch', async () => {
    const fetchSpy = spyFetch()
    const c = evConfig({
      eventWebhook: {
        url: 'https://hooks.example.com/repoaccess',
        allowlist: ['only.example.net'],
      },
    })
    await createEventSink(evEnv(), c)(envelopeFor(c))
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('non-2xx → throws (durable engine retries the emit step)', async () => {
    spyFetch(() => ({ ok: false, status: 500 }))
    const c = evConfig()
    // Naming the status is the point: a bare `.rejects.toThrow()` accepts ANY error, so it would pass on
    // an SSRF rejection, or a TypeError from a bug in this test's own setup, and we would never know the
    // delivery path was reached at all.
    await expect(createEventSink(evEnv(), c)(envelopeFor(c))).rejects.toThrow(
      'event delivery: HTTP 500',
    )
  })

  it('redirect surfaced as 3xx → throws (redirect not followed)', async () => {
    spyFetch(() => ({ ok: false, status: 302 }))
    const c = evConfig()
    // The 302 in the message is what proves the redirect was NOT followed: it surfaced as the status.
    await expect(createEventSink(evEnv(), c)(envelopeFor(c))).rejects.toThrow(
      'event delivery: HTTP 302',
    )
  })
})
