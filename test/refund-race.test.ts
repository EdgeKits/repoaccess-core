// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Gary Stupak

import {
  env as testEnv,
  listDurableObjectIds,
  runInDurableObject,
} from 'cloudflare:test'
import { describe, it, expect, vi, afterEach } from 'vitest'
import type { WorkflowStep } from 'cloudflare:workers'
import { makeMemoStep, makeStep } from './helpers'
import { executeAccessWorkflow } from '../src/workflow/workflow'
import { claimGuard } from '../src/claim/claim-guard'
import type { EventEnvelope } from '../src/events'
import type {
  AccessWorkflowParams,
  NormalizedEvent,
  ProductTeamMap,
  RepoAccessConfig,
} from '../src/types'

// A REFUND THAT LANDS WHILE A GRANT IS IN FLIGHT MUST WIN.
//
// A grant reads the transaction's guard at entry, and a durable step is memoized: after a pause or a
// GitHub backoff sleep the engine replays the stored answer, so a refund that arrives after that read
// is invisible to the grant. The refund, meanwhile, finds no grant record yet and has nothing to
// withdraw. The grant then resumes, puts the buyer in the team, writes its record and announces
// `access.granted` - and nothing ever takes that membership away. The window is about a second on a
// normal run, hours under GitHub backoff, and unbounded under a pause.
//
// The cure is that the LAST WRITER CHECKS. The grant commits to the guard in a fresh step after its own
// last write, and withdraws what it just did when the commit finds the transaction revoked. A refund that
// finds nothing to revoke leaves the FACTS of the refund on the guard, and the grant applies its own
// product's policy to them, so a log_only product is never refused by a refund it was told to ignore.

afterEach(async () => {
  vi.restoreAllMocks()
  const { keys } = await testEnv.ENTITLEMENTS.list()
  await Promise.all(keys.map((k) => testEnv.ENTITLEMENTS.delete(k.name)))
  for (const id of await listDurableObjectIds(testEnv.CLAIM_GUARD)) {
    await runInDurableObject(testEnv.CLAIM_GUARD.get(id), (_i, state) =>
      state.storage.deleteAll(),
    )
  }
})

const ORG = 'testorg'
const TXN = 'pi_race'

const PTM: ProductTeamMap = {
  stripe: {
    prod_auto: {
      teams: ['kit-pro'],
      grant_mode: 'username',
      revoke_policy: { mode: 'auto_revoke' },
    },
    prod_log: {
      teams: ['kit-pro'],
      grant_mode: 'username',
      revoke_policy: { mode: 'log_only' },
    },
    prod_partial: {
      teams: ['kit-pro'],
      grant_mode: 'username',
      revoke_policy: { mode: 'auto_revoke', full_refund_only: true },
    },
  },
  // The sold product is auto_revoke, the defaults are log_only: a refund event whose own product id
  // is empty resolves to the defaults, which is the ordering that used to skip the tombstone.
  defaults: {
    teams: [],
    grant_mode: 'claim',
    revoke_policy: { mode: 'log_only' },
  },
}

const config: RepoAccessConfig = { githubOrg: ORG, productTeamMap: PTM }

function makeEnv(): CloudflareBindings {
  return {
    ...testEnv,
    GITHUB_TOKEN: 'test_token',
  } as unknown as CloudflareBindings
}

function evt(over: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return {
    event_type: 'payment_success',
    product_id: 'prod_auto',
    transaction_id: TXN,
    buyer_email: null,
    github_username: 'octocat',
    is_full_refund: null,
    ...over,
  }
}

const refund = (over: Partial<NormalizedEvent> = {}) =>
  evt({
    event_type: 'refund',
    is_full_refund: true,
    github_username: null,
    ...over,
  })

/**
 * A GitHub that remembers membership. `onPut` runs BEFORE the PUT is answered, which is where a test
 * lands the refund: after the grant's entry check, before its write.
 */
function fakeGithub(onPut?: () => Promise<unknown>) {
  const members = new Set<string>()
  const calls: string[] = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : (input as Request).url
    const path = url.replace('https://api.github.com', '')
    const method = ((init as RequestInit)?.method ?? 'GET').toUpperCase()
    calls.push(`${method} ${path}`)
    const team = /^\/orgs\/[^/]+\/teams\/([^/]+)\/memberships\/([^/]+)$/.exec(
      path,
    )
    const json = (status: number, body?: unknown) =>
      new Response(body === undefined ? null : JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      })
    if (team) {
      const key = `${team[1]}:${team[2]}`
      if (method === 'GET')
        return json(members.has(key) ? 200 : 404, { state: 'pending' })
      if (method === 'PUT') {
        if (onPut) await onPut()
        members.add(key)
        return json(200, { state: 'pending' })
      }
      if (method === 'DELETE') {
        members.delete(key)
        return json(204)
      }
    }
    if (method === 'GET' && path.startsWith(`/orgs/${ORG}/invitations`))
      return json(200, [])
    if (method === 'DELETE' && path.startsWith(`/orgs/${ORG}/memberships/`))
      return json(204)
    return json(500)
  })
  return { members, calls }
}

const recorder = () => {
  const events: EventEnvelope[] = []
  return { events, sink: (e: EventEnvelope) => void events.push(e) }
}
const typesOf = (events: EventEnvelope[]) => events.map((e) => e.event_type)

function run(
  step: WorkflowStep,
  env: CloudflareBindings,
  params: AccessWorkflowParams,
  sink: (e: EventEnvelope) => void,
) {
  return executeAccessWorkflow(step, env, config, params, sink)
}

describe('a refund that lands while a grant is in flight', () => {
  it('case 1: direct grant, refund lands mid-grant -> no membership, no record, access.revoked, no access.granted', async () => {
    const env = makeEnv()
    const { members, calls } = fakeGithub(() =>
      claimGuard(env, 'stripe', TXN).revoke(),
    )
    const { step } = makeStep()
    const { events, sink } = recorder()

    await run(step, env, { adapter: 'stripe', event: evt() }, sink)

    expect(calls).toContain(
      `PUT /orgs/${ORG}/teams/kit-pro/memberships/octocat`,
    )
    expect([...members]).toEqual([])
    expect(await env.ENTITLEMENTS.get(`grant:stripe:${TXN}`)).toBeNull()
    expect(typesOf(events)).not.toContain('access.granted')
    expect(typesOf(events)).toContain('access.revoked')
    expect(typesOf(events).at(-1)).toBe('access.revoked')
  })

  it('case 2: claim-completion grant, refund lands mid-grant -> the same outcome', async () => {
    const env = makeEnv()
    // The route acquired the single-flight lock before this completion was enqueued.
    await claimGuard(env, 'stripe', TXN).acquire()
    const { members, calls } = fakeGithub(() =>
      claimGuard(env, 'stripe', TXN).revoke(),
    )
    const { step } = makeStep()
    const { events, sink } = recorder()

    await run(
      step,
      env,
      { adapter: 'stripe', event: evt(), from_claim: true, origin: 'webhook' },
      sink,
    )

    expect(calls).toContain(
      `PUT /orgs/${ORG}/teams/kit-pro/memberships/octocat`,
    )
    expect([...members]).toEqual([])
    expect(await env.ENTITLEMENTS.get(`grant:stripe:${TXN}`)).toBeNull()
    expect(typesOf(events)).not.toContain('access.granted')
    expect(typesOf(events)).not.toContain('claim.completed')
    expect(typesOf(events)).toContain('access.revoked')
    expect(await claimGuard(env, 'stripe', TXN).status()).toBe('revoked')
  })

  for (const username of ['octocat', null]) {
    it(`case 3: refund with an empty product id BEFORE the grant of an auto_revoke product -> refused (${username ? 'direct' : 'claim'} mode)`, async () => {
      const env = makeEnv()
      const { members, calls } = fakeGithub()
      const { events, sink } = recorder()

      await run(
        makeStep().step,
        env,
        { adapter: 'stripe', event: refund({ product_id: '' }) },
        sink,
      )
      await run(
        makeStep().step,
        env,
        { adapter: 'stripe', event: evt({ github_username: username }) },
        sink,
      )

      expect(calls.filter((c) => c.startsWith('PUT'))).toEqual([])
      expect([...members]).toEqual([])
      expect(await env.ENTITLEMENTS.get(`grant:stripe:${TXN}`)).toBeNull()
      expect(await env.ENTITLEMENTS.get(`claim_txn:stripe:${TXN}`)).toBeNull()
      expect(typesOf(events)).not.toContain('access.granted')
      expect(typesOf(events)).not.toContain('claim.pending')
      const refused = events.find((e) => e.event_type === 'access.failed')
      expect(refused).toMatchObject({
        reason: 'transaction_revoked',
        trigger: 'refund',
      })
    })
  }

  it('case 4: refund BEFORE the grant of a log_only product -> granted normally', async () => {
    const env = makeEnv()
    const { members } = fakeGithub()
    const { events, sink } = recorder()

    await run(
      makeStep().step,
      env,
      { adapter: 'stripe', event: refund({ product_id: '' }) },
      sink,
    )
    await run(
      makeStep().step,
      env,
      { adapter: 'stripe', event: evt({ product_id: 'prod_log' }) },
      sink,
    )

    expect([...members]).toEqual(['kit-pro:octocat'])
    expect(await env.ENTITLEMENTS.get(`grant:stripe:${TXN}`)).not.toBeNull()
    expect(typesOf(events)).toEqual(['access.granted'])
  })

  it('case 4b: a log_only product whose refund lands mid-grant is still granted', async () => {
    const env = makeEnv()
    const { members } = fakeGithub(async () => {
      // A real refund instance, not a direct guard write: it must leave facts, never a verdict.
      await run(
        makeStep().step,
        env,
        { adapter: 'stripe', event: refund({ product_id: '' }) },
        () => {},
      )
    })
    const { events, sink } = recorder()

    await run(
      makeStep().step,
      env,
      { adapter: 'stripe', event: evt({ product_id: 'prod_log' }) },
      sink,
    )

    expect([...members]).toEqual(['kit-pro:octocat'])
    expect(typesOf(events)).toEqual(['access.granted'])
  })

  it('case 1b: a real refund INSTANCE with an empty product id lands mid-grant of an auto_revoke product -> withdrawn', async () => {
    // Case 1 lands a verdict directly on the guard. This is the reported ordering end to end: the
    // refund runs as its own instance, finds no record, and can only leave facts.
    const env = makeEnv()
    const { members } = fakeGithub(async () => {
      await run(
        makeStep().step,
        env,
        { adapter: 'stripe', event: refund({ product_id: '' }) },
        () => {},
      )
    })
    const { events, sink } = recorder()

    await run(makeStep().step, env, { adapter: 'stripe', event: evt() }, sink)

    expect([...members]).toEqual([])
    expect(await env.ENTITLEMENTS.get(`grant:stripe:${TXN}`)).toBeNull()
    expect(typesOf(events)).toEqual(['access.revoked'])
    expect(events[0]).toMatchObject({
      github_username: 'octocat',
      trigger: 'refund',
    })
    expect(await claimGuard(env, 'stripe', TXN).status()).toBe('revoked')
  })

  for (const when of ['before', 'mid-grant'] as const) {
    it(`partial refund ${when} the grant of a full_refund_only product -> granted normally`, async () => {
      const env = makeEnv()
      const partial = () =>
        run(
          makeStep().step,
          env,
          {
            adapter: 'stripe',
            event: refund({ product_id: '', is_full_refund: false }),
          },
          () => {},
        )
      const { members } = fakeGithub(when === 'mid-grant' ? partial : undefined)
      if (when === 'before') await partial()
      const { events, sink } = recorder()

      await run(
        makeStep().step,
        env,
        { adapter: 'stripe', event: evt({ product_id: 'prod_partial' }) },
        sink,
      )

      expect([...members]).toEqual(['kit-pro:octocat'])
      expect(typesOf(events)).toEqual(['access.granted'])
      // A partial refund left facts, never a verdict: the grant committed.
      expect(await claimGuard(env, 'stripe', TXN).status()).toBe('granted')
    })
  }

  it('replay: the post-write commit is a NEW step, not a replay of the entry check', async () => {
    // Production memoizes steps. A post-write guard step that reuses the entry check's label replays
    // the entry's `idle` after a suspension and grants into a refunded transaction; only a fresh label
    // sees the refund. Run the grant with the guard idle, suspend it right after its record write,
    // revoke, and resume the SAME instance.
    const env = makeEnv()
    const { members } = fakeGithub()
    const memo = makeMemoStep(`grant-record:stripe:${TXN}`)
    const first = recorder()

    await run(
      memo.step,
      env,
      { adapter: 'stripe', event: evt() },
      first.sink,
    ).catch(() => {})
    expect([...members]).toEqual(['kit-pro:octocat'])

    await claimGuard(env, 'stripe', TXN).revoke()
    memo.resume()
    const second = recorder()
    await run(memo.step, env, { adapter: 'stripe', event: evt() }, second.sink)

    expect([...members]).toEqual([])
    expect(await env.ENTITLEMENTS.get(`grant:stripe:${TXN}`)).toBeNull()
    expect(typesOf([...first.events, ...second.events])).not.toContain(
      'access.granted',
    )
    expect(typesOf(second.events)).toContain('access.revoked')
    // Every guard read in the instance carries its own label.
    const guardReads = memo.names.filter((n) => n.startsWith('claim-guard-'))
    expect(new Set(guardReads).size).toBe(guardReads.length)
  })
})
