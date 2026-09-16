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
import { makeMemoStep, makeStep } from './helpers'
import { executeAccessWorkflow } from '../src/workflow/workflow'
import { claimGuard } from '../src/claim/claim-guard'
import { GRANT_TTL_SEC } from '../src/kv-keys'
import type { EventEnvelope } from '../src/events'
import type {
  AccessWorkflowParams,
  NormalizedEvent,
  ProductTeamMap,
  RepoAccessConfig,
} from '../src/types'

// THE GUARD IS THE LEDGER OF A TRANSACTION'S OUTCOME.
//
// A refund used to decide "there is nothing to withdraw" from a KV read. KV is eventually consistent:
// a grant record written seconds ago in one location can read as absent from another, so a refund
// that runs there recorded the refund's facts, withdrew nothing, and the buyer kept access. The guard
// is a Durable Object and strongly consistent, so a successful grant COMMITS to it - status `granted`
// plus a copy of what was granted - and a revoke asks the guard before it asks KV.
//
// The same ledger numbers its transitions. Arrival order of outbound events was never reliable (the
// emit step retries), and `timestamp` is stamped when an event is sent, so a seller could receive
// `access.granted` after the `access.revoked` that superseded it and have no way to tell. `sequence`
// is minted by the transition that decided each event: for one transaction, the higher one is current.

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
const TXN = 'pi_ledger'
const GRANT_KEY = `grant:stripe:${TXN}`

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
  },
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

/** The same env, but the grant record reads as ABSENT - a KV location that has not seen the write. */
function staleEnv(env: CloudflareBindings): CloudflareBindings {
  const kv = env.ENTITLEMENTS
  const stale = {
    get: (key: string, ...rest: unknown[]) =>
      key === GRANT_KEY
        ? Promise.resolve(null)
        : (kv.get as (...a: unknown[]) => Promise<unknown>)(key, ...rest),
    put: kv.put.bind(kv),
    delete: kv.delete.bind(kv),
    list: kv.list.bind(kv),
  }
  return { ...env, ENTITLEMENTS: stale } as unknown as CloudflareBindings
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

// A Stripe refund event carries no product id.
const refund = () =>
  evt({
    event_type: 'refund',
    product_id: '',
    is_full_refund: true,
    github_username: null,
  })

type Answer = { status: number; body?: unknown }

/** A GitHub that remembers team membership; `override` answers first when it returns something. */
function fakeGithub(
  override?: (method: string, path: string) => Answer | null,
) {
  const members = new Set<string>()
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : (input as Request).url
    const path = url.replace('https://api.github.com', '')
    const method = ((init as RequestInit)?.method ?? 'GET').toUpperCase()
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
        return json({ status: 200, body: { state: 'pending' } })
      }
      if (method === 'DELETE') {
        members.delete(key)
        return json({ status: 204 })
      }
    }
    if (method === 'GET' && path.startsWith(`/orgs/${ORG}/invitations`))
      return json({ status: 200, body: [] })
    if (method === 'DELETE' && path.startsWith(`/orgs/${ORG}/memberships/`))
      return json({ status: 204 })
    return json({ status: 500 })
  })
  return { members }
}

const recorder = () => {
  const events: EventEnvelope[] = []
  return { events, sink: (e: EventEnvelope) => void events.push(e) }
}

function run(
  step: WorkflowStep,
  env: CloudflareBindings,
  params: AccessWorkflowParams,
  sink: (e: EventEnvelope) => void = () => {},
) {
  return executeAccessWorkflow(step, env, config, params, sink)
}

const guardState = (env: CloudflareBindings) =>
  runInDurableObject(
    env.CLAIM_GUARD.get(env.CLAIM_GUARD.idFromName(`stripe:${TXN}`)),
    async (_i, s) => ({
      status: await s.storage.get<string>('status'),
      grant: await s.storage.get<Record<string, unknown>>('grant'),
    }),
  )

describe('the guard is the ledger of a transaction', () => {
  it('a: a refund whose KV read is stale still withdraws a committed grant', async () => {
    const env = makeEnv()
    const { members } = fakeGithub()
    await run(makeStep().step, env, { adapter: 'stripe', event: evt() })
    expect([...members]).toEqual(['kit-pro:octocat'])

    const logs = vi.spyOn(console, 'log')
    const { events, sink } = recorder()
    await run(
      makeStep().step,
      staleEnv(env),
      { adapter: 'stripe', event: refund() },
      sink,
    )

    expect([...members]).toEqual([])
    expect(events.map((e) => e.event_type)).toContain('access.revoked')
    const absent = logs.mock.calls.filter((c) =>
      String(c[0]).includes('grant record absent'),
    )
    expect(absent).toEqual([])
    expect(await env.ENTITLEMENTS.get(GRANT_KEY)).toBeNull()
    expect(await guardState(env)).toMatchObject({ status: 'revoked' })
    expect((await guardState(env)).grant).toBeUndefined()
  })

  it('b: a successful direct grant commits `granted` and a copy of the grant to the guard', async () => {
    const env = makeEnv()
    fakeGithub()
    await run(makeStep().step, env, {
      adapter: 'stripe',
      event: evt(),
      origin: 'webhook',
    })

    const state = await guardState(env)
    expect(state.status).toBe('granted')
    expect(state.grant).toMatchObject({
      github_username: 'octocat',
      org: ORG,
      teams: ['kit-pro'],
      product_id: 'prod_auto',
      origin: 'webhook',
    })
    expect(typeof state.grant?.granted_at).toBe('string')
  })

  it('c: access.revoked outranks access.granted by sequence, whatever order they were emitted in', async () => {
    const env = makeEnv()
    fakeGithub()
    const { events, sink } = recorder()
    // The refund runs to completion after the grant commits and before the grant's emit step.
    const { step: inner } = makeStep()
    const step = {
      ...inner,
      do: async (name: string, a: unknown, b?: unknown) => {
        if (name.startsWith('emit:access.granted:'))
          await run(
            makeStep().step,
            env,
            { adapter: 'stripe', event: refund() },
            sink,
          )
        return (inner.do as (...x: unknown[]) => Promise<unknown>)(name, a, b)
      },
    } as unknown as WorkflowStep

    await run(step, env, { adapter: 'stripe', event: evt() }, sink)

    const granted = events.find((e) => e.event_type === 'access.granted')
    const revoked = events.find((e) => e.event_type === 'access.revoked')
    expect(events.map((e) => e.event_type)).toEqual([
      'access.revoked',
      'access.granted',
    ])
    expect(typeof granted?.sequence).toBe('number')
    expect(typeof revoked?.sequence).toBe('number')
    expect(Number(revoked?.sequence)).toBeGreaterThan(Number(granted?.sequence))
  })

  it('c2: a refusal for an already-revoked transaction carries the revoking transition sequence', async () => {
    const env = makeEnv()
    fakeGithub()
    const { events, sink } = recorder()
    await run(makeStep().step, env, { adapter: 'stripe', event: evt() }, sink)
    await run(
      makeStep().step,
      env,
      { adapter: 'stripe', event: refund() },
      sink,
    )
    // A duplicate payment_success delivered under a different id, e.g. a claim completion enqueue.
    await run(
      makeStep().step,
      env,
      { adapter: 'stripe', event: evt(), from_claim: true, origin: 'webhook' },
      sink,
    )
    const revoked = events.find((e) => e.event_type === 'access.revoked')
    const refused = events.find(
      (e) =>
        e.event_type === 'access.failed' && e.reason === 'transaction_revoked',
    )
    expect(refused?.sequence).toBeDefined()
    expect(refused?.sequence).toBe(revoked?.sequence)
  })

  it('d: a pre-change grant (KV record, idle guard) is revoked exactly as before', async () => {
    const env = makeEnv()
    const { members } = fakeGithub()
    members.add('kit-pro:octocat')
    await env.ENTITLEMENTS.put(
      GRANT_KEY,
      JSON.stringify({
        github_username: 'octocat',
        org: ORG,
        teams: ['kit-pro'],
        product_id: 'prod_auto',
        granted_at: new Date().toISOString(),
      }),
    )
    const { events, sink } = recorder()
    await run(
      makeStep().step,
      env,
      { adapter: 'stripe', event: refund() },
      sink,
    )

    expect([...members]).toEqual([])
    expect(events.map((e) => e.event_type)).toEqual(['access.revoked'])
    expect(events[0]).toMatchObject({
      github_username: 'octocat',
      trigger: 'refund',
    })
    expect(await env.ENTITLEMENTS.get(GRANT_KEY)).toBeNull()
  })

  it('e: a direct grant that falls back to a claim does not commit', async () => {
    const env = makeEnv()
    fakeGithub((m) => (m === 'PUT' ? { status: 404 } : null))
    await run(makeStep().step, env, { adapter: 'stripe', event: evt() })
    expect(await env.ENTITLEMENTS.get(`claim_txn:stripe:${TXN}`)).not.toBeNull()
    expect((await guardState(env)).status).not.toBe('granted')
  })

  it('e: a direct grant that fails terminally does not commit', async () => {
    const env = makeEnv()
    fakeGithub((m) => (m === 'GET' ? { status: 403 } : null))
    await run(makeStep().step, env, { adapter: 'stripe', event: evt() })
    expect((await guardState(env)).status).not.toBe('granted')
  })

  it('e2: a claim completion that fails terminally locks the claim without committing a grant', async () => {
    const env = makeEnv()
    fakeGithub((m) => (m === 'PUT' ? { status: 422 } : null))
    await claimGuard(env, 'stripe', TXN).acquire()
    await run(makeStep().step, env, {
      adapter: 'stripe',
      event: evt(),
      from_claim: true,
      origin: 'webhook',
    })
    expect((await guardState(env)).status).not.toBe('granted')
    // The claim route still refuses a further submit exactly as before.
    expect(await claimGuard(env, 'stripe', TXN).acquire()).toEqual({
      ok: false,
      code: 'already_claimed',
    })
  })
})

describe('the refund side of the ledger checks as it writes', () => {
  // The grant commits between the refund's guard step and the refund's later guard write. Three
  // suspensions express it exactly, each instance resuming through its own memoizing step as the engine
  // would replay it:
  //   1. the grant runs up to its record write and is suspended BEFORE its commit;
  //   2. the refund runs through its guard step and its KV read (from a location that cannot see the
  //      record yet) and is suspended;
  //   3. the grant resumes and commits; then the refund resumes and performs its remaining writes.
  async function interleave(refundProductId: string) {
    const env = makeEnv()
    const { members } = fakeGithub()
    const { events, sink } = recorder()
    const refundEvent = evt({
      event_type: 'refund',
      product_id: refundProductId,
      is_full_refund: true,
      github_username: null,
    })
    const grant = makeMemoStep(`grant-record:stripe:${TXN}`)
    const refund = makeMemoStep(`grant-read:stripe:${TXN}`)
    const grantParams = { adapter: 'stripe', event: evt() }
    const refundParams = { adapter: 'stripe', event: refundEvent }

    await run(grant.step, env, grantParams, sink).catch(() => {})
    expect([...members]).toEqual(['kit-pro:octocat'])
    await run(refund.step, staleEnv(env), refundParams, sink).catch(() => {})
    grant.resume()
    await run(grant.step, env, grantParams, sink)
    refund.resume()
    await run(refund.step, staleEnv(env), refundParams, sink)

    return { env, members, events }
  }

  async function expectWithdrawn(
    result: Awaited<ReturnType<typeof interleave>>,
  ) {
    const { env, members, events } = result
    expect([...members]).toEqual([])
    const revoked = events.find((e) => e.event_type === 'access.revoked')
    expect(typeof revoked?.sequence).toBe('number')
    const granted = events.find((e) => e.event_type === 'access.granted')
    if (granted)
      expect(Number(revoked?.sequence)).toBeGreaterThan(
        Number(granted.sequence),
      )
    expect(await env.ENTITLEMENTS.get(GRANT_KEY)).toBeNull()
    const state = await guardState(env)
    expect(state.status).toBe('revoked')
    expect(state.grant).toBeUndefined()
  }

  it('M-1 a: facts branch - a grant committing between the refund read and its write is still withdrawn', async () => {
    await expectWithdrawn(await interleave(''))
  })

  it('M-1 b: verdict branch (the refund product revokes) - the same outcome', async () => {
    await expectWithdrawn(await interleave('prod_auto'))
  })

  it('a log_only pending claim survives a refund whose own product id maps to a revoking product', async () => {
    // The claim record, not the refund event, says what was sold. A verdict written from the event's
    // product before the claim is consulted would refuse a claim the seller told a refund to leave alone.
    const env = makeEnv()
    fakeGithub()
    await run(makeStep().step, env, {
      adapter: 'stripe',
      event: evt({ product_id: 'prod_log', github_username: null }),
    })
    expect(await env.ENTITLEMENTS.get(`claim_txn:stripe:${TXN}`)).not.toBeNull()

    await run(makeStep().step, env, {
      adapter: 'stripe',
      event: evt({
        event_type: 'refund',
        product_id: 'prod_auto',
        is_full_refund: true,
        github_username: null,
      }),
    })

    expect(await env.ENTITLEMENTS.get(`claim_txn:stripe:${TXN}`)).not.toBeNull()
    expect(await claimGuard(env, 'stripe', TXN).acquire()).toEqual({ ok: true })
  })
})

describe('the guard copy lives exactly as long as the grant record', () => {
  const copy = (grantedAt: string) => ({
    github_username: 'octocat',
    org: ORG,
    teams: ['kit-pro'],
    product_id: 'prod_auto',
    granted_at: grantedAt,
  })
  const stub = () =>
    testEnv.CLAIM_GUARD.get(testEnv.CLAIM_GUARD.idFromName(`stripe:${TXN}`))

  it('L-5 c: a copy older than GRANT_TTL_SEC is deleted by the expiry; status and sequence stay', async () => {
    const committed = await stub().commitGrant(copy(new Date().toISOString()), {
      mode: 'auto_revoke',
    })
    expect(committed).toEqual({ committed: true, sequence: 1 })
    // Age the stored copy past the record's lifetime, then let the scheduled expiry run. (Committing an
    // already-old copy would schedule an alarm in the past, which fires on its own before a test can
    // drive it.)
    const old = new Date(Date.now() - (GRANT_TTL_SEC + 60) * 1000).toISOString()
    await runInDurableObject(stub(), (_i, s) =>
      s.storage.put('grant', copy(old)),
    )

    expect(await runDurableObjectAlarm(stub())).toBe(true)

    const snapshot = await stub().snapshot()
    expect(snapshot.grant).toBeNull()
    expect(snapshot.status).toBe('granted')
    expect(snapshot.sequence).toBe(1)
  })

  it('L-5 c2: a fresh commit schedules the expiry at granted_at + GRANT_TTL_SEC and keeps the copy', async () => {
    const grantedAt = new Date().toISOString()
    await stub().commitGrant(copy(grantedAt), { mode: 'auto_revoke' })
    const alarm = await runInDurableObject(stub(), (_i, s) =>
      s.storage.getAlarm(),
    )
    expect(alarm).toBe(Date.parse(grantedAt) + GRANT_TTL_SEC * 1000)
    expect((await stub().snapshot()).grant).not.toBeNull()
  })
})

describe('an object that never grants expires with its facts', () => {
  // Every verified refund leaves facts on the guard for its transaction, including refunds of charges this
  // worker never sold. An object that never commits a grant expires entirely once the grant record's own
  // retention has passed since its last write; one that has committed keeps `status` and `sequence`.
  const DUE_MS = (GRANT_TTL_SEC + 60) * 1000
  const stubFor = (env: CloudflareBindings) =>
    env.CLAIM_GUARD.get(env.CLAIM_GUARD.idFromName(`stripe:${TXN}`))
  const storageSize = (env: CloudflareBindings) =>
    runInDurableObject(
      stubFor(env),
      async (_i, s) => (await s.storage.list()).size,
    )
  const alarmAt = (env: CloudflareBindings) =>
    runInDurableObject(stubFor(env), (_i, s) => s.storage.getAlarm())
  const refundEvent = (productId: string) =>
    evt({
      event_type: 'refund',
      product_id: productId,
      is_full_refund: true,
      github_username: null,
    })

  /** Run the object's alarm as if the clock had moved past the due time. */
  async function fireWhenDue(env: CloudflareBindings) {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + DUE_MS)
    try {
      return await runDurableObjectAlarm(stubFor(env))
    } finally {
      vi.useRealTimers()
    }
  }

  it('I-5 a: a facts-only object (no grant, no claim) schedules an expiry and is emptied once due', async () => {
    const env = makeEnv()
    fakeGithub()
    await run(makeStep().step, env, {
      adapter: 'stripe',
      event: refundEvent(''),
    })
    expect(await storageSize(env)).toBeGreaterThan(0)
    expect(await alarmAt(env)).not.toBeNull()

    expect(await fireWhenDue(env)).toBe(true)
    expect(await storageSize(env)).toBe(0)
  })

  it('I-5 b: a revoked tombstone (the refund product revokes, no grant, no claim) is emptied once due', async () => {
    const env = makeEnv()
    fakeGithub()
    await run(makeStep().step, env, {
      adapter: 'stripe',
      event: refundEvent('prod_auto'),
    })
    expect((await guardState(env)).status).toBe('revoked')
    expect(await alarmAt(env)).not.toBeNull()

    expect(await fireWhenDue(env)).toBe(true)
    expect(await storageSize(env)).toBe(0)
  })

  it('an alarm that runs before it is due removes nothing', async () => {
    const env = makeEnv()
    fakeGithub()
    await run(makeStep().step, env, {
      adapter: 'stripe',
      event: refundEvent(''),
    })
    const before = await storageSize(env)
    await runDurableObjectAlarm(stubFor(env))
    expect(await storageSize(env)).toBe(before)
  })

  it('c: a grant committed on an object that already carried facts is never emptied by an alarm', async () => {
    const env = makeEnv()
    fakeGithub()
    await run(makeStep().step, env, {
      adapter: 'stripe',
      event: refundEvent(''),
    })
    await run(makeStep().step, env, {
      adapter: 'stripe',
      event: evt({ product_id: 'prod_log' }),
    })
    expect((await guardState(env)).status).toBe('granted')

    await fireWhenDue(env)
    const state = await stubFor(env).snapshot()
    expect(state.status).toBe('granted')
    expect(state.sequence).toBe(1)
  })

  it('c: a granted-then-revoked object keeps status and sequence, with no alarm left to remove them', async () => {
    const env = makeEnv()
    fakeGithub()
    await run(makeStep().step, env, { adapter: 'stripe', event: evt() })
    await run(makeStep().step, env, {
      adapter: 'stripe',
      event: refundEvent(''),
    })
    const state = await stubFor(env).snapshot()
    expect(state).toMatchObject({ status: 'revoked', sequence: 2, grant: null })

    await fireWhenDue(env)
    expect(await stubFor(env).snapshot()).toMatchObject({
      status: 'revoked',
      sequence: 2,
    })
  })
})
