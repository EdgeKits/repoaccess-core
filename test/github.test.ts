// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Gary Stupak

import { describe, it, expect, vi, afterEach } from 'vitest'
import { github, isRateLimited, type GithubResult } from '../src/github'

const env = { GITHUB_TOKEN: 'test_token' } as unknown as CloudflareBindings

afterEach(() => vi.restoreAllMocks())

describe('github client - request shaping', () => {
  it('sends the required headers (Bearer auth, Accept, API version, User-Agent)', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }))

    await github.getTeamMembership(env, 'acme', 'kit-pro', 'octocat')

    const [url, init] = spy.mock.calls[0]
    expect(String(url)).toBe(
      'https://api.github.com/orgs/acme/teams/kit-pro/memberships/octocat',
    )
    const headers = new Headers((init as RequestInit).headers)
    expect(headers.get('authorization')).toBe('Bearer test_token')
    expect(headers.get('accept')).toBe('application/vnd.github+json')
    expect(headers.get('x-github-api-version')).toBe('2022-11-28')
    expect(headers.get('user-agent')).toBe('repoaccess-worker')
  })

  it('surfaces rate-limit headers in the result', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{}', {
        status: 403,
        headers: { 'retry-after': '60', 'x-ratelimit-remaining': '0' },
      }),
    )
    const result = await github.addTeamMembership(
      env,
      'acme',
      'kit-pro',
      'octocat',
    )
    expect(result.status).toBe(403)
    expect(result.retryAfterSec).toBe(60)
    expect(result.rateLimitRemaining).toBe(0)
  })
})

describe('isRateLimited', () => {
  const base: GithubResult = {
    status: 200,
    json: null,
    retryAfterSec: null,
    rateLimitRemaining: null,
    rateLimitResetSec: null,
  }
  it('true for 429', () =>
    expect(isRateLimited({ ...base, status: 429 })).toBe(true))
  it('true for 403 + remaining 0', () =>
    expect(isRateLimited({ ...base, status: 403, rateLimitRemaining: 0 })).toBe(
      true,
    ))
  it('true for 403 + retry-after', () =>
    expect(isRateLimited({ ...base, status: 403, retryAfterSec: 30 })).toBe(
      true,
    ))
  it('false for plain 403 (e.g. bad token)', () =>
    expect(isRateLimited({ ...base, status: 403 })).toBe(false))
  it('false for 200/404', () => {
    expect(isRateLimited({ ...base, status: 200 })).toBe(false)
    expect(isRateLimited({ ...base, status: 404 })).toBe(false)
  })
})
