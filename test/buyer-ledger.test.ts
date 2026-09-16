// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Gary Stupak

import {
  env as testEnv,
  listDurableObjectIds,
  runDurableObjectAlarm,
  runInDurableObject,
} from 'cloudflare:test'
import { describe, it, expect, vi, afterEach } from 'vitest'
import type { WorkflowStep } from 'cloudflare:workers'
import { makeMemoStep, makeStep, mockConfig, stubAdapter } from './helpers'
import { createWorker } from '../src/create-worker'
import { executeAccessWorkflow } from '../src/workflow/workflow'
import type { EventEnvelope } from '../src/events'
import type {
  AccessWorkflowParams,
  NormalizedEvent,
  ProductTeamMap,
  RepoAccessConfig,
} from '../src/types'

// A REVOKE KEEPS A TEAM THAT ANOTHER PURCHASE STILL ENTITLES.
//
// Grant records are keyed by transaction, so a refund used to remove every team named on the refunded
// grant with no way to tell that another purchase by the same buyer entitles the same team: a purchase
// and its renewal, an item and a bundle that contains it, two price points for one repository. The
// buyer's ledger records which teams each of the buyer's transactions entitles, and a revoke asks it
// before it removes anything.

afterEach(async () => {
  vi.restoreAllMocks()
  const { keys } = await testEnv.ENTITLEMENTS.list()
  await Promise.all(keys.map((k) => testEnv.ENTITLEMENTS.delete(k.name)))
  for (const id of await listDurableObjectIds(testEnv.CLAIM_GUARD)) {
    await runInDurableObject(testEnv.CLAIM_GUARD.get(id), async (_i, state) => {
      await state.storage.deleteAlarm()
      await state.storage.deleteAll()
    })
  }
})

const ORG = 'testorg'
const TXN_A = 'pi_a'
const TXN_B = 'pi_b'

const auto = (teams: string[]) => ({
  teams,
  grant_mode: 'username' as const,
  revoke_policy: { mode: 'auto_revoke' as const },
})

const SHARED: ProductTeamMap = {
  stripe: { prod_a: auto(['kit']), prod_b: auto(['kit']) },
  defaults: {
    teams: [],
    grant_mode: 'claim',
    revoke_policy: { mode: 'log_only' },
  },
}

const DISTINCT: ProductTeamMap = {
  stripe: { prod_a: auto(['kit-a']), prod_b: auto(['kit-b']) },
  defaults: {
    teams: [],
    grant_mode: 'claim',
    revoke_policy: { mode: 'log_only' },
  },
}

function makeEnv(): CloudflareBindings {
  return {
    ...testEnv,
    GITHUB_TOKEN: 'test_token',
  } as unknown as CloudflareBindings
}

function sale(
  txn: string,
  productId: string,
  username = 'octocat',
): NormalizedEvent {
  return {
    event_type: 'payment_success',
    product_id: productId,
    transaction_id: txn,
    buyer_email: null,
    github_username: username,
    is_full_refund: null,
  }
}

// A Stripe refund event carries no product id.
function refundOf(txn: string): NormalizedEvent {
  return {
    event_type: 'refund',
    product_id: '',
    transaction_id: txn,
    buyer_email: null,
    github_username: null,
    is_full_refund: true,
  }
}

type Answer = { status: number; body?: unknown }

/** A GitHub that remembers team and org membership and records every call. */
function fakeGithub(
  override?: (method: string, path: string) => Answer | null,
) {
  const members = new Set<string>()
  const orgMembers = new Set<string>()
  const calls: string[] = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : (input as Request).url
    const path = url.replace('https://api.github.com', '')
    const method = ((init as RequestInit)?.method ?? 'GET').toUpperCase()
    calls.push(`${method} ${path}`)
    const json = ({ status, body }: Answer) =>
      new Response(body === undefined ? null : JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      })
    const forced = override?.(method, path)
    if (forced) return json(forced)
    const team = /^\/orgs\/[^/]+\/teams\/([^/]+)\/memberships\/([^/]+)$/.exec(
      path,
    )
    if (team) {
      const key = `${team[1]}:${team[2]}`
      if (method === 'GET')
        return json({ status: members.has(key) ? 200 : 404, body: {} })
      if (method === 'PUT') {
        members.add(key)
        orgMembers.add(team[2])
        return json({ status: 200, body: { state: 'active' } })
      }
      if (method === 'DELETE') {
        members.delete(key)
        return json({ status: 204 })
      }
    }
    if (method === 'GET' && path.startsWith(`/orgs/${ORG}/invitations`))
      return json({ status: 200, body: [] })
    const org = /^\/orgs\/[^/]+\/memberships\/([^/]+)$/.exec(path)
    if (org && method === 'DELETE') {
      orgMembers.delete(org[1])
      return json({ status: 204 })
    }
    return json({ status: 500 })
  })
  return { members, orgMembers, calls }
}

const recorder = () => {
  const events: EventEnvelope[] = []
  return { events, sink: (e: EventEnvelope) => void events.push(e) }
}

function run(
  step: WorkflowStep,
  env: CloudflareBindings,
  map: ProductTeamMap,
  params: AccessWorkflowParams,
  sink: (e: EventEnvelope) => void = () => {},
) {
  const config: RepoAccessConfig = { githubOrg: ORG, productTeamMap: map }
  return executeAccessWorkflow(step, env, config, params, sink)
}

const grant = (
  map: ProductTeamMap,
  env: CloudflareBindings,
  event: NormalizedEvent,
) => run(makeStep().step, env, map, { adapter: 'stripe', event })

/** Every key the buyer's ledger object holds for a transaction, read straight off storage. */
const ledgerEntry = (
  env: CloudflareBindings,
  txn: string,
  username = 'octocat',
) =>
  runInDurableObject(
    env.CLAIM_GUARD.get(env.CLAIM_GUARD.idFromName(`buyer:${username}`)),
    async (_i, s) => [
      ...(await s.storage.list({ prefix: `ledger:stripe:${txn}` })).keys(),
    ],
  )

const teamDeletes = (calls: string[], slug: string) =>
  calls.filter((c) =>
    c.startsWith(`DELETE /orgs/${ORG}/teams/${slug}/memberships/`),
  )
const orgDeletes = (calls: string[]) =>
  calls.filter((c) => c.startsWith(`DELETE /orgs/${ORG}/memberships/`))

describe('a shared team survives a refund while another purchase entitles it', () => {
  it('a: refunding B keeps the team A still entitles, and org membership', async () => {
    const env = makeEnv()
    const { members, orgMembers, calls } = fakeGithub()
    await grant(SHARED, env, sale(TXN_A, 'prod_a'))
    await grant(SHARED, env, sale(TXN_B, 'prod_b'))
    expect(await env.ENTITLEMENTS.get(`grant:stripe:${TXN_A}`)).not.toBeNull()
    expect(await env.ENTITLEMENTS.get(`grant:stripe:${TXN_B}`)).not.toBeNull()

    calls.length = 0
    const { events, sink } = recorder()
    await run(
      makeStep().step,
      env,
      SHARED,
      { adapter: 'stripe', event: refundOf(TXN_B) },
      sink,
    )

    expect(teamDeletes(calls, 'kit')).toEqual([])
    expect(orgDeletes(calls)).toEqual([])
    expect([...members]).toEqual(['kit:octocat'])
    expect([...orgMembers]).toEqual(['octocat'])
    expect(await env.ENTITLEMENTS.get(`grant:stripe:${TXN_A}`)).not.toBeNull()
    expect(await env.ENTITLEMENTS.get(`grant:stripe:${TXN_B}`)).toBeNull()
    const revoked = events.filter((e) => e.event_type === 'access.revoked')
    expect(revoked).toHaveLength(1)
    expect(revoked[0].transaction_id).toBe(TXN_B)
  })

  it('b: then refunding A removes the team and reconciles the org as before', async () => {
    const env = makeEnv()
    const { members, orgMembers, calls } = fakeGithub()
    await grant(SHARED, env, sale(TXN_A, 'prod_a'))
    await grant(SHARED, env, sale(TXN_B, 'prod_b'))
    await run(makeStep().step, env, SHARED, {
      adapter: 'stripe',
      event: refundOf(TXN_B),
    })

    calls.length = 0
    await run(makeStep().step, env, SHARED, {
      adapter: 'stripe',
      event: refundOf(TXN_A),
    })

    expect(teamDeletes(calls, 'kit')).toHaveLength(1)
    expect(orgDeletes(calls)).toHaveLength(1)
    expect([...members]).toEqual([])
    expect([...orgMembers]).toEqual([])
    expect(await ledgerEntry(env, TXN_A)).toEqual([])
  })

  it('c: distinct teams - refunding B removes kit-b and keeps kit-a and the org', async () => {
    const env = makeEnv()
    const { members, orgMembers, calls } = fakeGithub()
    await grant(DISTINCT, env, sale(TXN_A, 'prod_a'))
    await grant(DISTINCT, env, sale(TXN_B, 'prod_b'))

    calls.length = 0
    await run(makeStep().step, env, DISTINCT, {
      adapter: 'stripe',
      event: refundOf(TXN_B),
    })

    expect(teamDeletes(calls, 'kit-b')).toHaveLength(1)
    expect(teamDeletes(calls, 'kit-a')).toEqual([])
    expect(orgDeletes(calls)).toEqual([])
    expect([...members]).toEqual(['kit-a:octocat'])
    expect([...orgMembers]).toEqual(['octocat'])
  })

  it("d: a grant of A in flight (registered, not yet written) keeps the team through B's refund", async () => {
    const env = makeEnv()
    const { calls } = fakeGithub()
    await grant(SHARED, env, sale(TXN_A, 'prod_a'))
    await grant(SHARED, env, sale(TXN_B, 'prod_b'))
    // A second grant of A's product for a new transaction, suspended after its entry check (and its
    // registration) and before its first GitHub call.
    const inFlight = sale('pi_a2', 'prod_a')
    // Once suspended, no later step runs, the terminal catch's included.
    const { step: inner } = makeStep()
    let suspended = false
    const halting = {
      ...inner,
      do: async (name: string, a: unknown, b?: unknown) => {
        if (name.startsWith('team-get:')) suspended = true
        if (suspended)
          throw new Error(`instance suspended before step "${name}"`)
        return (inner.do as (...x: unknown[]) => Promise<unknown>)(name, a, b)
      },
    } as unknown as WorkflowStep
    await run(halting, env, SHARED, {
      adapter: 'stripe',
      event: inFlight,
    }).catch(() => {})

    // Refund both committed purchases; only the in-flight grant still entitles `kit`.
    await run(makeStep().step, env, SHARED, {
      adapter: 'stripe',
      event: refundOf(TXN_A),
    })
    calls.length = 0
    await run(makeStep().step, env, SHARED, {
      adapter: 'stripe',
      event: refundOf(TXN_B),
    })
    expect(teamDeletes(calls, 'kit')).toEqual([])
  })
})

describe('a grant that ends without committing leaves nothing registered', () => {
  it('e: a claim fallback on a handle GitHub does not know', async () => {
    const env = makeEnv()
    fakeGithub((m) => (m === 'PUT' ? { status: 404 } : null))
    await grant(SHARED, env, sale(TXN_A, 'prod_a'))
    expect(
      await env.ENTITLEMENTS.get(`claim_txn:stripe:${TXN_A}`),
    ).not.toBeNull()
    expect(await ledgerEntry(env, TXN_A)).toEqual([])
  })

  it('e: a terminal GitHub failure', async () => {
    const env = makeEnv()
    fakeGithub((m) => (m === 'GET' ? { status: 403 } : null))
    await grant(SHARED, env, sale(TXN_A, 'prod_a'))
    expect(await ledgerEntry(env, TXN_A)).toEqual([])
  })

  it('e: a terminal failure of a claim completion', async () => {
    const env = makeEnv()
    fakeGithub((m) => (m === 'PUT' ? { status: 422 } : null))
    await run(makeStep().step, env, SHARED, {
      adapter: 'stripe',
      event: sale(TXN_A, 'prod_a'),
      from_claim: true,
      origin: 'webhook',
    })
    expect(await ledgerEntry(env, TXN_A)).toEqual([])
  })

  it('e: a grant that throws (GitHub unavailable through every retry)', async () => {
    const env = makeEnv()
    fakeGithub((m) => (m === 'PUT' ? { status: 502 } : null))
    await grant(SHARED, env, sale(TXN_A, 'prod_a')).catch(() => {})
    expect(await ledgerEntry(env, TXN_A)).toEqual([])
  })

  it('e: a refusal at entry because the transaction was already revoked', async () => {
    const env = makeEnv()
    fakeGithub()
    await run(makeStep().step, env, SHARED, {
      adapter: 'stripe',
      event: refundOf(TXN_A),
    })
    // The refund's own product did not resolve, so record a revoking refund the grant will judge.
    await grant(SHARED, env, sale(TXN_A, 'prod_a'))
    expect(await ledgerEntry(env, TXN_A)).toEqual([])
  })

  it('e: a refusal at commit because the transaction was revoked in flight', async () => {
    const env = makeEnv()
    const { members } = fakeGithub()
    const memo = makeMemoStep(`grant-record:stripe:${TXN_A}`)
    const params = { adapter: 'stripe', event: sale(TXN_A, 'prod_a') }
    await run(memo.step, env, SHARED, params).catch(() => {})
    await run(makeStep().step, env, SHARED, {
      adapter: 'stripe',
      event: refundOf(TXN_A),
    })
    memo.resume()
    await run(memo.step, env, SHARED, params)
    expect([...members]).toEqual([])
    expect(await ledgerEntry(env, TXN_A)).toEqual([])
  })
})

describe('grants made before the ledger existed', () => {
  it('f: a refund of an unregistered grant behaves exactly as before', async () => {
    const env = makeEnv()
    const { members, orgMembers, calls } = fakeGithub()
    members.add('kit:octocat')
    orgMembers.add('octocat')
    await env.ENTITLEMENTS.put(
      `grant:stripe:${TXN_A}`,
      JSON.stringify({
        github_username: 'octocat',
        org: ORG,
        teams: ['kit'],
        product_id: 'prod_a',
        granted_at: new Date().toISOString(),
      }),
    )
    const { events, sink } = recorder()
    await run(
      makeStep().step,
      env,
      SHARED,
      { adapter: 'stripe', event: refundOf(TXN_A) },
      sink,
    )

    expect(teamDeletes(calls, 'kit')).toHaveLength(1)
    expect(orgDeletes(calls)).toHaveLength(1)
    expect([...members]).toEqual([])
    expect(events.map((e) => e.event_type)).toEqual(['access.revoked'])
    expect(await env.ENTITLEMENTS.get(`grant:stripe:${TXN_A}`)).toBeNull()
  })
})

describe('the ledger itself', () => {
  const ledger = (username = 'octocat') =>
    testEnv.CLAIM_GUARD.get(testEnv.CLAIM_GUARD.idFromName(`buyer:${username}`))
  const storageOf = (username = 'octocat') =>
    runInDurableObject(ledger(username), async (_i, s) =>
      Object.fromEntries(await s.storage.list()),
    )

  it('registering the same transaction twice changes nothing the second time', async () => {
    await ledger().registerGrant('stripe:pi_a', ['kit'])
    const first = await storageOf()
    await ledger().registerGrant('stripe:pi_a', ['kit', 'other'])
    expect(await storageOf()).toEqual(first)
  })

  it('withdrawing the same transaction twice changes nothing the second time, debts included', async () => {
    await ledger().registerGrant('stripe:pi_a', ['kit'])
    await ledger().registerGrant('stripe:pi_b', ['kit', 'extra'])
    await ledger().recordWritten('stripe:pi_b', ['kit', 'extra'])
    const answer = { entitled: ['kit'], kept: ['kit'] }
    expect(
      await ledger().withdrawGrant('stripe:pi_b', ['kit', 'extra']),
    ).toEqual(answer)
    const first = await storageOf()
    expect(first['ledger:stripe:pi_a']).toMatchObject({ owed: ['kit'] })
    expect(
      await ledger().withdrawGrant('stripe:pi_b', ['kit', 'extra']),
    ).toEqual(answer)
    expect(await storageOf()).toEqual(first)
  })

  it('a kept team the revoked grant only found present is not a debt', async () => {
    await ledger().registerGrant('stripe:pi_a', ['kit'])
    await ledger().registerGrant('stripe:pi_b', ['kit'])
    await ledger().recordWritten('stripe:pi_b', [])
    await ledger().withdrawGrant('stripe:pi_b', ['kit'])
    expect((await storageOf())['ledger:stripe:pi_a']).not.toHaveProperty('owed')
  })

  it('releasing owes only the debts no remaining entry backs, and owes nothing a second time', async () => {
    await ledger().registerGrant('stripe:pi_a', ['kit'])
    await ledger().registerGrant('stripe:pi_b', ['kit'])
    await ledger().recordWritten('stripe:pi_b', ['kit'])
    await ledger().withdrawGrant('stripe:pi_b', ['kit'])
    await ledger().registerGrant('stripe:pi_c', ['kit'])
    expect(await ledger().releaseGrant('stripe:pi_a')).toEqual({
      owed: [],
      entitled: ['kit'],
    })
    await runInDurableObject(ledger(), (_i, s) =>
      s.storage.put('ledger:stripe:pi_c', {
        teams: ['kit'],
        expires_at: Date.now() + 60_000,
        owed: ['kit'],
      }),
    )
    expect(await ledger().releaseGrant('stripe:pi_c')).toEqual({
      owed: ['kit'],
      entitled: [],
    })
    expect(await ledger().releaseGrant('stripe:pi_c')).toEqual({
      owed: [],
      entitled: [],
    })
  })

  it('a ledger never registered into is never written', async () => {
    expect(await ledger().withdrawGrant('stripe:pi_x', ['kit'])).toEqual({
      entitled: [],
      kept: [],
    })
    expect(await ledger().releaseGrant('stripe:pi_x')).toEqual({
      owed: [],
      entitled: [],
    })
    expect(await storageOf()).toEqual({})
  })

  it('a ledger method refuses a transaction guard, and a transaction method refuses a ledger', async () => {
    const txn = testEnv.CLAIM_GUARD.get(
      testEnv.CLAIM_GUARD.idFromName('stripe:pi_role'),
    )
    await txn.acquire()
    // Called on the instance, so the refusal is a plain rejection rather than one thrown across RPC.
    await runInDurableObject(txn, async (guard) => {
      await expect(guard.registerGrant('stripe:pi_a', ['kit'])).rejects.toThrow(
        /transaction guard/,
      )
    })
    await ledger().registerGrant('stripe:pi_a', ['kit'])
    await runInDurableObject(ledger(), async (guard) => {
      await expect(guard.acquire()).rejects.toThrow(/buyer ledger/)
      await expect(guard.snapshot()).rejects.toThrow(/buyer ledger/)
    })
  })

  it('a lapsed entry entitles nothing', async () => {
    await ledger().registerGrant('stripe:pi_a', ['kit'])
    await runInDurableObject(ledger(), (_i, s) =>
      s.storage.put('ledger:stripe:pi_a', { teams: ['kit'], expires_at: 1 }),
    )
    expect(await ledger().withdrawGrant('stripe:pi_b', ['kit'])).toEqual({
      entitled: [],
      kept: [],
    })
    expect(await storageOf()).toEqual({})
  })

  it('the alarm drops lapsed entries, keeps live ones, and empties a ledger left with none', async () => {
    await ledger().registerGrant('stripe:pi_a', ['kit'])
    await ledger().registerGrant('stripe:pi_b', ['kit'])
    await runInDurableObject(ledger(), (_i, s) =>
      s.storage.put('ledger:stripe:pi_a', { teams: ['kit'], expires_at: 1 }),
    )
    expect(await runDurableObjectAlarm(ledger())).toBe(true)
    expect(Object.keys(await storageOf()).sort()).toEqual([
      'ledger:stripe:pi_b',
      'role',
    ])
    await runInDurableObject(ledger(), async (_i, s) => {
      await s.storage.put('ledger:stripe:pi_b', {
        teams: ['kit'],
        expires_at: 1,
      })
      await s.storage.setAlarm(Date.now() + 60_000)
    })
    expect(await runDurableObjectAlarm(ledger())).toBe(true)
    expect(await storageOf()).toEqual({})
  })

  it('one buyer whatever the case of the login', async () => {
    const env = makeEnv()
    const { calls } = fakeGithub()
    await grant(SHARED, env, sale(TXN_A, 'prod_a', 'Octocat'))
    await grant(SHARED, env, sale(TXN_B, 'prod_b', 'octocat'))
    calls.length = 0
    await run(makeStep().step, env, SHARED, {
      adapter: 'stripe',
      event: refundOf(TXN_B),
    })
    expect(teamDeletes(calls, 'kit')).toEqual([])
  })

  it('a kept team keeps the pending invitation that carries it', async () => {
    const env = makeEnv()
    const { calls } = fakeGithub((m, path) =>
      m === 'GET' && path.startsWith(`/orgs/${ORG}/invitations`)
        ? { status: 200, body: [{ id: 7, login: 'octocat' }] }
        : null,
    )
    await grant(SHARED, env, sale(TXN_A, 'prod_a'))
    await grant(SHARED, env, sale(TXN_B, 'prod_b'))
    calls.length = 0
    await run(makeStep().step, env, SHARED, {
      adapter: 'stripe',
      event: refundOf(TXN_B),
    })
    expect(calls.filter((c) => c.includes('/invitations'))).toEqual([])
  })

  it('distinct teams still cancel the pending invitation, as before', async () => {
    const env = makeEnv()
    const { calls } = fakeGithub((m, path) =>
      m === 'GET' && path.startsWith(`/orgs/${ORG}/invitations`)
        ? { status: 200, body: [{ id: 7, login: 'octocat' }] }
        : m === 'DELETE' && path === `/orgs/${ORG}/invitations/7`
          ? { status: 204 }
          : null,
    )
    await grant(DISTINCT, env, sale(TXN_A, 'prod_a'))
    await grant(DISTINCT, env, sale(TXN_B, 'prod_b'))
    calls.length = 0
    await run(makeStep().step, env, DISTINCT, {
      adapter: 'stripe',
      event: refundOf(TXN_B),
    })
    expect(calls).toContain(`DELETE /orgs/${ORG}/invitations/7`)
  })
})

describe("the ledger's debts: a team kept for a grant that then never commits", () => {
  /** Run a grant up to (not including) its first GitHub call, as a suspended instance would stop. */
  async function suspendBeforeGithub(
    env: CloudflareBindings,
    map: ProductTeamMap,
    event: NormalizedEvent,
  ) {
    const { step: inner } = makeStep()
    let suspended = false
    const halting = {
      ...inner,
      do: async (name: string, a: unknown, b?: unknown) => {
        if (name.startsWith('team-get:')) suspended = true
        if (suspended)
          throw new Error(`instance suspended before step "${name}"`)
        return (inner.do as (...x: unknown[]) => Promise<unknown>)(name, a, b)
      },
    } as unknown as WorkflowStep
    await run(halting, env, map, { adapter: 'stripe', event }).catch(() => {})
  }

  /** A GitHub whose next team-membership GET answers 403, once. */
  function failNextTeamGet() {
    let armed = false
    const github = fakeGithub((m, path) => {
      if (armed && m === 'GET' && path.includes('/teams/')) {
        armed = false
        return { status: 403 }
      }
      return null
    })
    return { ...github, arm: () => (armed = true) }
  }

  it('a: the in-flight grant fails, and the team it kept is withdrawn', async () => {
    const env = makeEnv()
    const gh = failNextTeamGet()
    await grant(SHARED, env, sale(TXN_B, 'prod_b'))
    await suspendBeforeGithub(env, SHARED, sale(TXN_A, 'prod_a'))
    await run(makeStep().step, env, SHARED, {
      adapter: 'stripe',
      event: refundOf(TXN_B),
    })
    expect([...gh.members]).toEqual(['kit:octocat'])

    gh.calls.length = 0
    gh.arm()
    const { events, sink } = recorder()
    await run(
      makeStep().step,
      env,
      SHARED,
      { adapter: 'stripe', event: sale(TXN_A, 'prod_a') },
      sink,
    )

    expect(teamDeletes(gh.calls, 'kit')).toHaveLength(1)
    expect(orgDeletes(gh.calls)).toHaveLength(1)
    expect([...gh.members]).toEqual([])
    const revoked = events.filter((e) => e.event_type === 'access.revoked')
    expect(revoked).toHaveLength(1)
    expect(revoked[0]).toMatchObject({
      transaction_id: TXN_A,
      github_username: 'octocat',
      teams: ['kit'],
    })
  })

  it('b: a team an older, unregistered purchase also holds is not withdrawn', async () => {
    const env = makeEnv()
    const gh = failNextTeamGet()
    gh.members.add('kit:octocat')
    gh.orgMembers.add('octocat')
    await env.ENTITLEMENTS.put(
      'grant:stripe:pi_old',
      JSON.stringify({
        github_username: 'octocat',
        org: ORG,
        teams: ['kit'],
        product_id: 'prod_a',
        granted_at: new Date().toISOString(),
      }),
    )
    await grant(SHARED, env, sale(TXN_B, 'prod_b'))
    await suspendBeforeGithub(env, SHARED, sale(TXN_A, 'prod_a'))
    await run(makeStep().step, env, SHARED, {
      adapter: 'stripe',
      event: refundOf(TXN_B),
    })

    gh.calls.length = 0
    gh.arm()
    await run(makeStep().step, env, SHARED, {
      adapter: 'stripe',
      event: sale(TXN_A, 'prod_a'),
    })

    expect(teamDeletes(gh.calls, 'kit')).toEqual([])
    expect(orgDeletes(gh.calls)).toEqual([])
    expect([...gh.members]).toEqual(['kit:octocat'])
  })

  it('c: a third purchase registered before the failure keeps the team', async () => {
    const env = makeEnv()
    const gh = failNextTeamGet()
    await grant(SHARED, env, sale(TXN_B, 'prod_b'))
    await suspendBeforeGithub(env, SHARED, sale(TXN_A, 'prod_a'))
    await run(makeStep().step, env, SHARED, {
      adapter: 'stripe',
      event: refundOf(TXN_B),
    })
    await suspendBeforeGithub(env, SHARED, sale('pi_c', 'prod_b'))

    gh.calls.length = 0
    gh.arm()
    await run(makeStep().step, env, SHARED, {
      adapter: 'stripe',
      event: sale(TXN_A, 'prod_a'),
    })

    expect(teamDeletes(gh.calls, 'kit')).toEqual([])
    expect([...gh.members]).toEqual(['kit:octocat'])
  })
})

describe('the invitation follows the kept teams', () => {
  it('d: distinct teams, unaccepted invitation - cancelled, then re-issued for the team the buyer keeps', async () => {
    const env = makeEnv()
    const { calls } = fakeGithub((m, path) =>
      m === 'GET' && path.startsWith(`/orgs/${ORG}/invitations`)
        ? { status: 200, body: [{ id: 7, login: 'octocat' }] }
        : m === 'DELETE' && path === `/orgs/${ORG}/invitations/7`
          ? { status: 204 }
          : null,
    )
    await grant(DISTINCT, env, sale(TXN_A, 'prod_a'))
    await grant(DISTINCT, env, sale(TXN_B, 'prod_b'))
    calls.length = 0
    await run(makeStep().step, env, DISTINCT, {
      adapter: 'stripe',
      event: refundOf(TXN_B),
    })

    const cancel = calls.indexOf(`DELETE /orgs/${ORG}/invitations/7`)
    const reissue = calls.indexOf(
      `PUT /orgs/${ORG}/teams/kit-a/memberships/octocat`,
    )
    expect(cancel).toBeGreaterThanOrEqual(0)
    expect(reissue).toBeGreaterThan(cancel)
    expect(
      calls.filter((c) =>
        c.startsWith(`PUT /orgs/${ORG}/teams/kit-b/memberships/`),
      ),
    ).toEqual([])
  })
})

describe('a re-issued invitation is a debt too', () => {
  it('a team re-issued for an in-flight grant that then fails is withdrawn', async () => {
    const env = makeEnv()
    let armed = false
    const gh = fakeGithub((m, path) => {
      if (armed && m === 'GET' && path.includes('/teams/')) {
        armed = false
        return { status: 403 }
      }
      if (m === 'GET' && path.startsWith(`/orgs/${ORG}/invitations`))
        return { status: 200, body: [{ id: 7, login: 'octocat' }] }
      if (m === 'DELETE' && path === `/orgs/${ORG}/invitations/7`)
        return { status: 204 }
      return null
    })
    await grant(DISTINCT, env, sale(TXN_B, 'prod_b'))
    const { step: inner } = makeStep()
    let suspended = false
    const halting = {
      ...inner,
      do: async (name: string, a: unknown, b?: unknown) => {
        if (name.startsWith('team-get:')) suspended = true
        if (suspended) throw new Error('suspended')
        return (inner.do as (...x: unknown[]) => Promise<unknown>)(name, a, b)
      },
    } as unknown as WorkflowStep
    await run(halting, env, DISTINCT, {
      adapter: 'stripe',
      event: sale(TXN_A, 'prod_a'),
    }).catch(() => {})
    await run(makeStep().step, env, DISTINCT, {
      adapter: 'stripe',
      event: refundOf(TXN_B),
    })
    expect([...gh.members]).toEqual(['kit-a:octocat'])

    armed = true
    await run(makeStep().step, env, DISTINCT, {
      adapter: 'stripe',
      event: sale(TXN_A, 'prod_a'),
    })
    expect([...gh.members]).toEqual([])
  })
})

describe('access.revoked says what it kept', () => {
  it('e: kept_teams names a kept team, and is absent when nothing is kept', async () => {
    const env = makeEnv()
    fakeGithub()
    const { events, sink } = recorder()
    await grant(SHARED, env, sale(TXN_A, 'prod_a'))
    await grant(SHARED, env, sale(TXN_B, 'prod_b'))
    await run(
      makeStep().step,
      env,
      SHARED,
      { adapter: 'stripe', event: refundOf(TXN_B) },
      sink,
    )
    await run(
      makeStep().step,
      env,
      SHARED,
      { adapter: 'stripe', event: refundOf(TXN_A) },
      sink,
    )
    const [first, second] = events.filter(
      (e) => e.event_type === 'access.revoked',
    )
    expect(first).toMatchObject({ transaction_id: TXN_B, teams: ['kit'] })
    expect(first.kept_teams).toEqual(['kit'])
    expect(second.transaction_id).toBe(TXN_A)
    expect('kept_teams' in second).toBe(false)
  })
})

describe('the buyer ledger reserves an adapter name', () => {
  it('f: createWorker refuses an adapter named buyer', () => {
    const adapter = { ...stubAdapter(), name: 'buyer' }
    expect(() =>
      createWorker({ adapters: [adapter], config: mockConfig() }),
    ).toThrow(/buyer ledger/)
  })
})
