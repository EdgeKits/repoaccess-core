// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Gary Stupak

import {
  env as testEnv,
  listDurableObjectIds,
  runInDurableObject,
} from 'cloudflare:test'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { e2e, stripeSignatureHeader } from '../scripts/wizard.mjs'
import { createWorker } from '../src/create-worker'
import { executeAccessWorkflow } from '../src/workflow/workflow'
import { stripe } from '../src/adapters/stripe'
import { makeStep } from './helpers'
import type {
  AccessWorkflowParams,
  ProductTeamMap,
  RepoAccessConfig,
} from '../src/types'

// THE SETUP CHECK CLEANS UP THROUGH THE WORKER, NOT AROUND IT.
//
// The synthetic check sends a signed payment to the deployed worker, which grants the test buyer a real
// team invitation. Its cleanup used to cancel that invitation straight against GitHub and delete the
// grant record with a raw KV delete - neither of which is the worker, so the transaction guard stayed
// `granted` and the buyer's ledger kept an entry saying that transaction still entitles the team. Every
// deployer who ran the check left a phantom entitlement on their test buyer, and the first real refund
// they tested kept the team the phantom still entitled.
//
// The engine here is the deployed one: the check's `fetch` seam is routed into the worker's own router,
// over the real KV namespace and the real guard Durable Object, with only GitHub mocked.

const ORG = 'testorg'
const TEAM = 'kit'
const BUYER = 'testbuyer'
const PRODUCT = 'prod_kit'
const SIGNING_SECRET = 'whsec_wizard_guard'
const WORKER_URL = 'https://worker.example'
const SECRET_PATH = 'wh-path'
const E2E_TXN = 'pi_e2e_guard'
const REAL_TXN = 'pi_real_guard'

const PRODUCT_TEAM_MAP: ProductTeamMap = {
  stripe: {
    [PRODUCT]: {
      teams: [TEAM],
      grant_mode: 'username',
      revoke_policy: { mode: 'auto_revoke' },
    },
  },
  defaults: {
    teams: [],
    grant_mode: 'claim',
    revoke_policy: { mode: 'log_only' },
  },
}

// Exactly what the wizard writes: one product, one team, username mode, auto_revoke - plus the `e2e`
// block the check reads its own inputs from.
const CONFIG: RepoAccessConfig = {
  githubOrg: ORG,
  productTeamMap: PRODUCT_TEAM_MAP,
  e2e: { testUsername: BUYER, url: WORKER_URL, secretPath: SECRET_PATH },
}

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

/** A GitHub that remembers team + org membership and records every call, as the real one behaves. */
function fakeGithub() {
  const members = new Set<string>()
  const orgMembers = new Set<string>()
  const calls: string[] = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : (input as Request).url
    const path = url.replace('https://api.github.com', '')
    const method = ((init as RequestInit)?.method ?? 'GET').toUpperCase()
    calls.push(`${method} ${path}`)
    const json = (status: number, body?: unknown) =>
      new Response(body === undefined ? null : JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      })
    const team = /^\/orgs\/[^/]+\/teams\/([^/]+)\/memberships\/([^/]+)$/.exec(
      path,
    )
    if (team) {
      const key = `${team[1]}:${team[2]}`
      if (method === 'GET')
        return members.has(key)
          ? json(200, { state: 'pending' })
          : json(404, {})
      if (method === 'PUT') {
        members.add(key)
        orgMembers.add(team[2])
        return json(200, { state: 'pending' })
      }
      if (method === 'DELETE') {
        members.delete(key)
        return json(204)
      }
    }
    if (method === 'GET' && path.startsWith(`/orgs/${ORG}/invitations`))
      return json(200, [])
    const org = /^\/orgs\/[^/]+\/memberships\/([^/]+)$/.exec(path)
    if (org && method === 'DELETE') {
      orgMembers.delete(org[1])
      return json(204)
    }
    return json(500, {})
  })
  return { members, orgMembers, calls }
}

/**
 * The deployed worker, wired to the real bindings.
 *
 * `ACCESS_WORKFLOW.createBatch` runs the Workflow INLINE rather than enqueueing it. That is the one
 * deviation from production and it is a scheduling one: the engine, the guard and the ledger are the
 * real ones, and running them before the ack returns is what makes the check's poll deterministic
 * instead of racing a background instance.
 */
function makeWorker() {
  const app = createWorker({ adapters: [stripe], config: CONFIG })
  const env = {
    ...testEnv,
    GITHUB_TOKEN: 'test_token',
    STRIPE_WEBHOOK_SECRET: SIGNING_SECRET,
    ACCESS_WORKFLOW: {
      create: vi.fn(),
      createBatch: async (batch: Array<{ params: AccessWorkflowParams }>) => {
        for (const { params } of batch) {
          await executeAccessWorkflow(makeStep().step, env, CONFIG, params)
        }
        return []
      },
    },
  } as unknown as CloudflareBindings
  return { app, env }
}

type Worker = ReturnType<typeof makeWorker>

/** Sign a body the way the provider does and POST it at the worker's webhook route. */
async function postWebhook(
  { app, env }: Worker,
  body: string,
): Promise<Response> {
  const timestamp = Math.floor(Date.now() / 1000)
  return app.request(
    `${WORKER_URL}/wh/stripe/${SECRET_PATH}`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'stripe-signature': stripeSignatureHeader(
          body,
          SIGNING_SECRET,
          timestamp,
        ),
      },
      body,
    },
    env,
  )
}

/** The paid Checkout Session a purchase sends. */
const payment = (transactionId: string) =>
  JSON.stringify({
    id: `evt_${transactionId}`,
    type: 'checkout.session.completed',
    data: {
      object: {
        id: `cs_${transactionId}`,
        object: 'checkout.session',
        payment_status: 'paid',
        payment_intent: transactionId,
        metadata: { github_username: BUYER, product_id: PRODUCT },
        customer_details: { email: 'buyer@example.test' },
      },
    },
  })

/** The full refund the provider sends when the seller refunds that purchase. */
const fullRefund = (transactionId: string) =>
  JSON.stringify({
    id: `evt_refund_${transactionId}`,
    type: 'charge.refunded',
    data: {
      object: {
        id: `ch_${transactionId}`,
        object: 'charge',
        payment_intent: transactionId,
        amount: 2900,
        amount_refunded: 2900,
        metadata: { product_id: PRODUCT },
        billing_details: { email: 'buyer@example.test' },
      },
    },
  })

/** The check's `fetch`: the worker's own router for the worker URL, mocked GitHub for the rest. */
function wizardFetch(worker: Worker) {
  return (async (url: string, init: RequestInit) => {
    if (url.startsWith(WORKER_URL))
      return worker.app.request(url, init, worker.env)
    return globalThis.fetch(url, init)
  }) as unknown as typeof fetch
}

/**
 * The check's wrangler seam. `wrangler kv key delete` is synchronous to the caller, so the delete is
 * started here and awaited by the test through `pending` - the same ordering a child process gives.
 */
function kvRunner(pending: Promise<unknown>[]) {
  const calls: string[][] = []
  const run = (args: string[]) => {
    calls.push(args)
    if (args[0] === 'kv' && args[2] === 'delete') {
      pending.push(testEnv.ENTITLEMENTS.delete(args[3]))
    }
    return { ok: true, status: 0, stdout: '', stderr: '' }
  }
  return { run, calls }
}

const teamDeletes = (calls: string[], slug: string) =>
  calls.filter((c) =>
    c.startsWith(`DELETE /orgs/${ORG}/teams/${slug}/memberships/`),
  )

/** Every ledger key the buyer's object holds for a transaction, read straight off storage. */
const ledgerEntry = (env: CloudflareBindings, txn: string) =>
  runInDurableObject(
    env.CLAIM_GUARD.get(env.CLAIM_GUARD.idFromName(`buyer:${BUYER}`)),
    async (_i, s) => [
      ...(await s.storage.list({ prefix: `ledger:stripe:${txn}` })).keys(),
    ],
  )

/** The transaction guard's own status. */
const guardStatus = (env: CloudflareBindings, txn: string) =>
  runInDurableObject(
    env.CLAIM_GUARD.get(env.CLAIM_GUARD.idFromName(`stripe:${txn}`)),
    (_i, s) => s.storage.get<string>('status'),
  )

/** Run the synthetic check exactly as the wizard runs it, against the worker above. */
async function runSyntheticCheck(worker: Worker) {
  const pending: Promise<unknown>[] = []
  const { run, calls } = kvRunner(pending)
  const result = await e2e({
    config: CONFIG,
    secret: SIGNING_SECRET,
    githubToken: 'test_token',
    fetch: wizardFetch(worker),
    run,
    transactionId: E2E_TXN,
    pollAttempts: 3,
    pollIntervalMs: 0,
    sleep: () => Promise.resolve(),
  })
  await Promise.all(pending)
  return { result, wranglerCalls: calls }
}

describe('the synthetic check leaves the worker owning its own state', () => {
  it('a: the check grants and then withdraws through the worker, so nothing survives it', async () => {
    const worker = makeWorker()
    const gh = fakeGithub()

    const { result } = await runSyntheticCheck(worker)

    expect(result.ok).toBe(true)
    expect(await ledgerEntry(worker.env, E2E_TXN)).toEqual([])
    expect(await guardStatus(worker.env, E2E_TXN)).not.toBe('granted')
    expect(
      await worker.env.ENTITLEMENTS.get(`grant:stripe:${E2E_TXN}`),
    ).toBeNull()
    expect([...gh.members]).toEqual([])
  })

  it("b: a real purchase's refund still removes the team after the check has run", async () => {
    const worker = makeWorker()
    const gh = fakeGithub()

    await runSyntheticCheck(worker)

    // The deployer's own test purchase - same buyer, same team, the guide's next step.
    expect((await postWebhook(worker, payment(REAL_TXN))).status).toBe(200)
    expect([...gh.members]).toEqual([`${TEAM}:${BUYER}`])

    gh.calls.length = 0
    expect((await postWebhook(worker, fullRefund(REAL_TXN))).status).toBe(200)

    expect(teamDeletes(gh.calls, TEAM)).toHaveLength(1)
    expect([...gh.members]).toEqual([])
    expect([...gh.orgMembers]).toEqual([])
  })
})
