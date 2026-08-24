// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Gary Stupak

import { env as testEnv } from 'cloudflare:test'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { makeStep } from './helpers'
import { createAccessWorkflow } from '../src/workflow/workflow'
import { sandbox, production } from '../src/config/repoaccess.config.example'
import type { NormalizedEvent, RepoAccessConfig } from '../src/types'

// Config-as-code: the AccessWorkflow is built by createAccessWorkflow(config) and reads
// non-secret config from the closed-over object (NOT env vars). The first suite proves the factory
// binds config (the org + product map both drive behavior). The second is a NEUTRALITY LATCH: the
// deployer's real `repoaccess.config.ts` is gitignored (it survives updates), so the COMMITTED
// artifact is the `.example` TEMPLATE - the latch targets that and locks its neutrality, so a real
// org/product map can never be committed back into the repo by accident. It imports the `.example`
// (not the gitignored real file) so a FRESH clone's first `npm test` is GREEN - core shipped a red
// first run once; do not repeat it.

afterEach(async () => {
  vi.restoreAllMocks()
  const { keys } = await testEnv.ENTITLEMENTS.list()
  await Promise.all(keys.map((k) => testEnv.ENTITLEMENTS.delete(k.name)))
})

function mockFetch(handler: (method: string, path: string) => number) {
  return vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : (input as Request).url
      const path = url.replace('https://api.github.com', '')
      const method = ((init as RequestInit)?.method ?? 'GET').toUpperCase()
      return new Response(JSON.stringify({ state: 'pending' }), {
        status: handler(method, path),
        headers: { 'content-type': 'application/json' },
      })
    })
}

const grantEvent: NormalizedEvent = {
  event_type: 'payment_success',
  product_id: 'prod_x',
  transaction_id: 'pi_factory',
  buyer_email: null,
  github_username: 'octocat',
  is_full_refund: null,
}

describe('createAccessWorkflow factory', () => {
  it('binds config: the org + product map come from the closed-over config, not env', async () => {
    const config: RepoAccessConfig = {
      githubOrg: 'factoryorg',
      productTeamMap: {
        stripe: { prod_x: { teams: ['kit-pro'], grant_mode: 'username' } },
        defaults: { teams: [] },
      },
    }
    const calls: string[] = []
    mockFetch((m, p) => {
      calls.push(`${m} ${p}`)
      if (m === 'GET' && p.includes('/memberships/')) return 404
      if (m === 'PUT' && p.includes('/memberships/')) return 200
      return 500
    })

    // The runtime constructs the WorkflowEntrypoint (it rejects a synthetic ctx outside workerd), so
    // we invoke run() through the prototype with a synthetic `this` - run() only reads `this.env` and
    // the closed-over config, which is exactly what we're asserting.
    const Workflow = createAccessWorkflow(config)
    const env = {
      ...testEnv,
      GITHUB_TOKEN: 'test_token',
    } as unknown as CloudflareBindings
    await Workflow.prototype.run.call(
      { env } as never,
      { payload: { adapter: 'stripe', event: grantEvent } } as never,
      makeStep().step,
    )

    // The PUT path proves BOTH githubOrg ('factoryorg') and the productTeamMap (team 'kit-pro',
    // grant_mode 'username') came from the bound config.
    expect(calls).toContain(
      'PUT /orgs/factoryorg/teams/kit-pro/memberships/octocat',
    )
    expect(
      await env.ENTITLEMENTS.get('grant:stripe:pi_factory', 'json'),
    ).toMatchObject({ org: 'factoryorg', teams: ['kit-pro'] })
  })

  it('the result is a class with a run() method, inherited by `extends` (the entry pattern)', () => {
    // `export class AccessWorkflow extends createAccessWorkflow(config) {}` - the subclass inherits
    // run(), giving wrangler a named class to resolve `class_name` against.
    const Workflow = createAccessWorkflow({
      githubOrg: 'x',
      productTeamMap: { defaults: { teams: [] } },
    })
    class AccessWorkflow extends Workflow {}
    expect(typeof Workflow.prototype.run).toBe('function')
    expect(AccessWorkflow.prototype.run).toBe(Workflow.prototype.run)
  })
})

describe('repoaccess.config.example template - neutral', () => {
  it('exports `sandbox` and `production`, each a valid config with a `defaults` map', () => {
    for (const profile of [sandbox, production]) {
      expect(typeof profile.githubOrg).toBe('string')
      expect(profile.productTeamMap.defaults).toBeDefined()
      expect(Array.isArray(profile.productTeamMap.defaults.teams)).toBe(true)
    }
  })

  it('ships no real org: both profiles have an empty githubOrg', () => {
    expect(sandbox.githubOrg).toBe('')
    expect(production.githubOrg).toBe('')
  })

  it('ships no product mappings: only the empty/log_only defaults, no adapter keys', () => {
    for (const profile of [sandbox, production]) {
      expect(Object.keys(profile.productTeamMap)).toEqual(['defaults'])
      expect(profile.productTeamMap.defaults).toMatchObject({
        teams: [],
        grant_mode: 'claim',
        revoke_policy: { mode: 'log_only' },
      })
    }
  })
})
