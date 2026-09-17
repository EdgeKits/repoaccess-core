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
import { completeClaim } from '../src/claim/claim'
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
    // Two teams, so a refund can land BETWEEN the writes of one grant.
    prod_two: {
      teams: ['kit-pro', 'kit-extra'],
      grant_mode: 'username',
      revoke_policy: { mode: 'auto_revoke' },
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
 * A GitHub that remembers membership AND pending invitations. `onPut` runs BEFORE the PUT is answered,
 * which is where a test lands the refund: after the grant's entry check, before its write.
 *
 * `putStatuses` scripts the answer to each PUT in order (anything other than 200/201 leaves membership
 * untouched), so a test can make a write back off and land its refund inside the sleep that follows.
 * A PUT that succeeds creates the pending invitation the real API creates, and the withdrawal's
 * list/cancel pair is answered from the same ledger - which is what lets a test assert that the
 * invitation of an abandoned grant is gone rather than assuming it.
 */
function fakeGithub(
  onPut?: () => Promise<unknown>,
  putStatuses: number[] = [],
) {
  const members = new Set<string>()
  const invitations = new Map<number, string>()
  const calls: string[] = []
  let nextInvitationId = 1
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
        const scripted = putStatuses.shift()
        if (scripted !== undefined && scripted !== 200 && scripted !== 201)
          return json(scripted)
        members.add(key)
        if (![...invitations.values()].includes(team[2]))
          invitations.set(nextInvitationId++, team[2])
        return json(200, { state: 'pending' })
      }
      if (method === 'DELETE') {
        members.delete(key)
        return json(204)
      }
    }
    if (method === 'GET' && path.startsWith(`/orgs/${ORG}/invitations`))
      return json(
        200,
        [...invitations].map(([id, login]) => ({ id, login })),
      )
    if (method === 'DELETE' && path.startsWith(`/orgs/${ORG}/invitations/`)) {
      invitations.delete(Number(path.slice(path.lastIndexOf('/') + 1)))
      return json(204)
    }
    if (method === 'DELETE' && path.startsWith(`/orgs/${ORG}/memberships/`))
      return json(204)
    return json(500)
  })
  return { members, invitations, calls }
}

const putsIn = (calls: string[]) => calls.filter((c) => c.startsWith('PUT'))

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

// AND THE WRITE ITSELF RE-READS IT.
//
// Entry and commit BRACKET the GitHub writes; they do not cover the ground between them, and that
// ground is what a membership is actually made of. Two windows sit inside it: the backoff sleep after
// a 5xx, which runs for hours, and a suspension - a deploy, an eviction, a pause from the dashboard -
// which has no bound at all. A refund landing in either used to be seen only at the commit, AFTER the
// PUT had already put the buyer in the team, so access existed for the whole PUT-to-DELETE interval.
// So every grant-side write re-reads the guard INSIDE its own attempt, and an attempt that finds the
// transaction revoked asks GitHub for nothing. Only the PUT's own in-flight latency is irreducible.
describe('a refund that lands between the attempts of a grant-side write', () => {
  it('during the GitHub backoff sleep: the next attempt makes no PUT at all', async () => {
    const env = makeEnv()
    // The first attempt answers 503, so the grant sleeps - and the refund runs as its own instance
    // inside that sleep, which is the ordering that reaches production.
    let landed = false
    const gh = fakeGithub(undefined, [503])
    const { step } = makeStep(async () => {
      if (landed) return
      landed = true
      await run(
        makeStep().step,
        env,
        { adapter: 'stripe', event: refund({ product_id: '' }) },
        () => {},
      )
    })
    const { events, sink } = recorder()

    await run(step, env, { adapter: 'stripe', event: evt() }, sink)

    // One PUT: the one that backed off. The second attempt read the guard and stopped.
    expect(putsIn(gh.calls)).toHaveLength(1)
    expect([...gh.members]).toEqual([])
    expect([...gh.invitations]).toEqual([])
    expect(await env.ENTITLEMENTS.get(`grant:stripe:${TXN}`)).toBeNull()
    expect(await claimGuard(env, 'stripe', TXN).status()).toBe('revoked')
    expect(typesOf(events)).not.toContain('access.granted')
    const failed = events.find((e) => e.event_type === 'access.failed')
    expect(failed).toMatchObject({
      reason: 'transaction_revoked',
      trigger: 'refund',
    })
    // The verdict was promoted inside the attempt, so the refusal carries the guard's own number.
    expect(typeof failed?.sequence).toBe('number')
  })

  it('while the instance is suspended before the PUT: the replay makes no PUT either', async () => {
    const env = makeEnv()
    const gh = fakeGithub()
    // Halt the instance after the team read, so the PUT attempt's step never runs and records
    // nothing. That is what a pause is, and it is why the read has to live inside the closure: the
    // replay re-runs it, and a check that had completed earlier would only replay its stale answer.
    const memo = makeMemoStep('team-get:kit-pro:octocat')
    const first = recorder()

    await run(
      memo.step,
      env,
      { adapter: 'stripe', event: evt() },
      first.sink,
    ).catch(() => {})
    expect(putsIn(gh.calls)).toEqual([])

    // The refund lands while the instance is not running at all.
    await run(
      makeStep().step,
      env,
      { adapter: 'stripe', event: refund({ product_id: '' }) },
      () => {},
    )

    memo.resume()
    const second = recorder()
    await run(memo.step, env, { adapter: 'stripe', event: evt() }, second.sink)

    expect(putsIn(gh.calls)).toEqual([])
    expect([...gh.members]).toEqual([])
    expect([...gh.invitations]).toEqual([])
    expect(await env.ENTITLEMENTS.get(`grant:stripe:${TXN}`)).toBeNull()
    expect(await claimGuard(env, 'stripe', TXN).status()).toBe('revoked')
    const all = [...first.events, ...second.events]
    expect(typesOf(all)).not.toContain('access.granted')
    expect(all.find((e) => e.event_type === 'access.failed')).toMatchObject({
      reason: 'transaction_revoked',
      trigger: 'refund',
    })
  })

  it('between the two teams of one grant: the second attempt skips and the first team is withdrawn', async () => {
    const env = makeEnv()
    // kit-pro's PUT lands; kit-extra's first attempt backs off, and the refund arrives in that sleep.
    let landed = false
    const gh = fakeGithub(undefined, [200, 503])
    const { step } = makeStep(async () => {
      if (landed) return
      landed = true
      await run(
        makeStep().step,
        env,
        { adapter: 'stripe', event: refund({ product_id: '' }) },
        () => {},
      )
    })
    const { events, sink } = recorder()

    await run(
      step,
      env,
      { adapter: 'stripe', event: evt({ product_id: 'prod_two' }) },
      sink,
    )

    expect(putsIn(gh.calls)).toHaveLength(2) // kit-pro, then kit-extra's 503. No third.
    expect(gh.calls).toContain(
      `DELETE /orgs/${ORG}/teams/kit-pro/memberships/octocat`,
    )
    expect([...gh.members]).toEqual([])
    expect([...gh.invitations]).toEqual([]) // the invitation the first PUT created is cancelled
    expect(await env.ENTITLEMENTS.get(`grant:stripe:${TXN}`)).toBeNull()
    expect(typesOf(events)).not.toContain('access.granted')
    // One refusal and ONE withdrawal: the abandoned grant reuses the revoke's own code rather than
    // writing a second one beside it.
    expect(typesOf(events).filter((t) => t === 'access.failed')).toHaveLength(1)
    expect(typesOf(events).filter((t) => t === 'access.revoked')).toHaveLength(
      1,
    )
  })

  it('the claim path: the refund lands in the completion backoff, and the token is consumed', async () => {
    const env = makeEnv()
    const token = 'tok_race'
    await env.ENTITLEMENTS.put(
      `claim:${token}`,
      JSON.stringify({
        adapter: 'stripe',
        product_id: 'prod_auto',
        teams: ['kit-pro'],
        buyer_email: null,
        transaction_id: TXN,
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        origin: 'webhook',
      }),
      { expirationTtl: 3600 },
    )
    await env.ENTITLEMENTS.put(`claim_txn:stripe:${TXN}`, token, {
      expirationTtl: 3600,
    })
    // Submit through the real engine, so the completion runs on the params IT enqueued, and with the
    // single-flight lock it acquired, rather than on a hand-built approximation of them.
    const enqueued: AccessWorkflowParams[] = []
    const claimEnv = {
      ...env,
      ACCESS_WORKFLOW: {
        createBatch: async (batch: { params: AccessWorkflowParams }[]) => {
          enqueued.push(...batch.map((b) => b.params))
          return []
        },
      },
    } as unknown as CloudflareBindings
    const submit = await completeClaim(claimEnv, config, token, 'octocat')
    expect(submit.status).toBe('submitted')

    let landed = false
    const gh = fakeGithub(undefined, [503])
    const { step } = makeStep(async () => {
      if (landed) return
      landed = true
      await run(
        makeStep().step,
        env,
        { adapter: 'stripe', event: refund({ product_id: '' }) },
        () => {},
      )
    })
    const { events, sink } = recorder()

    await run(step, env, enqueued[0], sink)

    expect(putsIn(gh.calls)).toHaveLength(1)
    expect([...gh.members]).toEqual([])
    expect(await env.ENTITLEMENTS.get(`grant:stripe:${TXN}`)).toBeNull()
    expect(await env.ENTITLEMENTS.get(`claim:${token}`)).toBeNull()
    expect(await env.ENTITLEMENTS.get(`claim_txn:stripe:${TXN}`)).toBeNull()
    expect(
      await env.ENTITLEMENTS.get(`claim_submitted:stripe:${TXN}`),
    ).toBeNull()
    // Consumed, and not redeemable by any later submit.
    expect(
      (await completeClaim(claimEnv, config, token, 'octocat')).status,
    ).toBe('not_found')
    expect(await claimGuard(env, 'stripe', TXN).status()).toBe('revoked')
    expect(typesOf(events)).not.toContain('access.granted')
    expect(typesOf(events)).not.toContain('claim.completed')
    expect(events.find((e) => e.event_type === 'access.failed')).toMatchObject({
      reason: 'transaction_revoked',
      trigger: 'refund',
    })
  })

  it('log_only: the refund lands during the backoff and the PUT still happens', async () => {
    const env = makeEnv()
    let landed = false
    const gh = fakeGithub(undefined, [503])
    const { step } = makeStep(async () => {
      if (landed) return
      landed = true
      await run(
        makeStep().step,
        env,
        { adapter: 'stripe', event: refund({ product_id: '' }) },
        () => {},
      )
    })
    const { events, sink } = recorder()

    await run(
      step,
      env,
      { adapter: 'stripe', event: evt({ product_id: 'prod_log' }) },
      sink,
    )

    // The verdict is read under THIS product's policy, so a refund the seller told the worker to
    // ignore does not stop the write. That is the policy working, not a hole in the check.
    expect(putsIn(gh.calls)).toHaveLength(2)
    expect([...gh.members]).toEqual(['kit-pro:octocat'])
    expect(typesOf(events)).toEqual(['access.granted'])
  })
})
