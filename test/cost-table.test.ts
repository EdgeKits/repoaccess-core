// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Gary Stupak

import {
  env as testEnv,
  listDurableObjectIds,
  runInDurableObject,
} from 'cloudflare:test'
import { describe, it, expect, vi, afterEach } from 'vitest'
import type { WorkflowStep } from 'cloudflare:workers'
import GUIDE from '../docs/setup-guide.md?raw'
import { executeAccessWorkflow } from '../src/workflow/workflow'
import { completeClaim } from '../src/claim/claim'
import { claimIndexKey } from '../src/kv-keys'
import type {
  AccessWorkflowParams,
  NormalizedEvent,
  ProductTeamMap,
  RepoAccessConfig,
} from '../src/types'

// THE COST TABLE IN `docs/setup-guide.md` IS A MEASUREMENT, NOT A TRANSCRIBED COUNT.
//
// That table is the only thing a deployer plans capacity against: it says how many sales a day the
// Cloudflare free plan carries, and it is read by someone deciding whether this worker fits inside a
// free account. It was maintained by counting `step.do` calls and `ENTITLEMENTS.put` calls out of the
// source by hand, and on 2026-09-16 the `claim` row was found to be one step and one KV write too high
// - `writeSessionAlias` had been counted on BOTH instances of a claim sale, when it runs once, because
// the claim completion builds its event from the claim record and that event carries no
// `redirect_alias_id`. The figure had been published, and nothing could have caught it: a count from
// source is a second reading of the same code by the same reader, so it fails exactly where the reading
// fails.
//
// So the table is now asserted against a RUN. This file drives the real engine over the four journeys
// the table's three rows describe, counting the steps the Workflow takes and the KV writes and deletes
// it makes, and compares the totals with the numbers PARSED OUT OF THE GUIDE. Neither side is a literal
// here, which is the whole point: the test reddens when either one moves alone. An engine change that
// adds a step fails until the row is updated; a doc edit that mistypes a figure fails against the run.
//
// WHAT IT DOES NOT DO: it does not check the arithmetic BELOW the table (the "about N sales a day"
// figures, which divide the limits by these rows). Those are prose and they are the curator's; this
// file's failure message names them so whoever fixes a row knows they are downstream of it.

// --- the published table ---------------------------------------------------------------------------
//
// The parse is deliberately NARROW AND LITERAL: three exact row labels, and the cells positionally. It
// is not a markdown parser and must not become one. The guide is a document the curator rewrites, so a
// test that understood its structure would break on ordinary prose edits and teach everyone to ignore
// it; a test that can only find three labelled rows either finds them or says plainly that it could
// not. Column padding is prettier's and varies with the widest cell, so every cell is trimmed.

const ROW_LABELS = {
  username: 'Sale in `username` mode (the handle arrived with the payment)',
  claim: 'Sale in `claim` mode (the buyer enters their handle)',
  revoke: 'Refund or chargeback, access revoked',
} as const

interface PublishedRow {
  steps: string
  writes: number
  deletes: number
}

/** The three cells of the row whose first column is exactly `label`. */
function publishedRow(label: string): PublishedRow {
  const row = GUIDE.split('\n').find(
    (line) => line.startsWith('|') && line.split('|')[1]?.trim() === label,
  )
  if (!row) {
    throw new Error(
      `docs/setup-guide.md has no cost-table row labelled "${label}". Either the row was renamed - ` +
        `update ROW_LABELS here in the same edit - or the table is gone, in which case this whole ` +
        `file should go with it rather than be made to pass.`,
    )
  }
  const cells = row.split('|').map((c) => c.trim())
  const [, , steps, writes, deletes] = cells
  return { steps, writes: Number(writes), deletes: Number(deletes) }
}

/** The revoke row publishes its steps as a range: "11 to 12", accepted first. */
function revokeSteps(): { accepted: number; pending: number } {
  const { steps } = publishedRow(ROW_LABELS.revoke)
  const m = /^(\d+) to (\d+)$/.exec(steps)
  if (!m) {
    throw new Error(
      `the revoke row's step cell reads "${steps}"; this file expects the published range "<accepted> ` +
        `to <pending>" (a revoke costs one step more while the invitation is still pending). If the ` +
        `row became a single number, the two revoke cases below collapsed into one and this parse ` +
        `should be simplified rather than loosened.`,
    )
  }
  return { accepted: Number(m[1]), pending: Number(m[2]) }
}

/**
 * The failure every assertion below reports through.
 *
 * It names the row, the column, both numbers and WHICH WAY to fix it, because the two directions are
 * different jobs: a run that grew is an engine change and the row follows it (and the CHANGELOG owes a
 * line, since the published figure is what a deployer planned against); a run that did not move is a
 * doc edit that mistyped a cell.
 */
const mismatch = (row: string, column: string, published: number) =>
  `${row} row, ${column}: the guide publishes ${published}, the run does not agree (measured value ` +
  `below). If the ENGINE changed, update that cell in docs/setup-guide.md, re-derive the "about N ` +
  `sales a day" figures under the table from the new row, and note it for the CHANGELOG - the ` +
  `published cost is something deployers planned capacity against. If the GUIDE was edited, the cell ` +
  `is wrong and the run is right.`

// --- the measured run ------------------------------------------------------------------------------

const ORG = 'testorg'
const PRODUCT = 'prod_x'

const MAP: ProductTeamMap = {
  stripe: {
    [PRODUCT]: {
      teams: ['kit'],
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

const CONFIG: RepoAccessConfig = { githubOrg: ORG, productTeamMap: MAP }

/** One journey's tally. `steps` keeps the ids so a failure can show what ran. */
interface Meter {
  steps: string[]
  writes: string[]
  deletes: string[]
}

const meter = (): Meter => ({ steps: [], writes: [], deletes: [] })

/** `ENTITLEMENTS`, counted. Every other method passes through to the real binding. */
const countingKv = (m: Meter) =>
  new Proxy(testEnv.ENTITLEMENTS as unknown as Record<string, unknown>, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver)
      if (prop === 'put')
        return (...args: unknown[]) => {
          m.writes.push(String(args[0]))
          return (value as (...a: unknown[]) => unknown).apply(target, args)
        }
      if (prop === 'delete')
        return (...args: unknown[]) => {
          m.deletes.push(String(args[0]))
          return (value as (...a: unknown[]) => unknown).apply(target, args)
        }
      return typeof value === 'function' ? value.bind(target) : value
    },
  })

/**
 * The real bindings with the counted KV, plus the two a deploy supplies.
 *
 * `ACCESS_WORKFLOW` is a stub because the claim route enqueues through it and this file drives the
 * instances itself: a real enqueue here would run the grant twice and count it twice.
 */
const wfEnv = (m: Meter) =>
  ({
    ...testEnv,
    ENTITLEMENTS: countingKv(m),
    ACCESS_WORKFLOW: { create: vi.fn(), createBatch: vi.fn(async () => []) },
    GITHUB_TOKEN: 'test_token',
  }) as unknown as CloudflareBindings

/** A `step.do` that records every step id and runs its callback, both arities. */
const countingStep = (m: Meter): WorkflowStep =>
  ({
    do: async (name: string, a: unknown, b?: unknown) => {
      m.steps.push(name)
      const fn = (typeof b === 'function' ? b : a) as () => unknown
      return await fn()
    },
    sleep: async () => {},
    sleepUntil: async () => {},
  }) as unknown as WorkflowStep

/**
 * A GitHub that remembers team membership, shaped like `buyer-ledger.test.ts`'s.
 *
 * `invitationPending` is the one lever, and it is what separates the two revoke cases: it decides both
 * what a fresh `PUT` reports and whether the organization's invitation page has anything on it, so the
 * revoke either finds an invitation to cancel (one extra step) or does not.
 */
function fakeGithub(invitationPending: boolean, login: string) {
  const members = new Set<string>()
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : (input as Request).url
    const path = url.replace('https://api.github.com', '')
    const method = ((init as RequestInit)?.method ?? 'GET').toUpperCase()
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
      if (method === 'GET') return json(members.has(key) ? 200 : 404, {})
      if (method === 'PUT') {
        members.add(key)
        return json(200, { state: invitationPending ? 'pending' : 'active' })
      }
      if (method === 'DELETE') {
        members.delete(key)
        return json(204)
      }
    }
    if (method === 'GET' && path.startsWith(`/orgs/${ORG}/invitations`))
      return json(200, invitationPending ? [{ id: 7, login }] : [])
    if (method === 'DELETE' && /^\/orgs\/[^/]+\/invitations\//.test(path))
      return json(204)
    const org = /^\/orgs\/[^/]+\/memberships\/([^/]+)$/.exec(path)
    if (org && method === 'DELETE') return json(204)
    return json(500)
  })
}

const run = (m: Meter, params: AccessWorkflowParams) =>
  executeAccessWorkflow(countingStep(m), wfEnv(m), CONFIG, params, () => {})

const sale = (
  txn: string,
  username: string | null,
  aliasId?: string,
): NormalizedEvent =>
  ({
    event_type: 'payment_success',
    product_id: PRODUCT,
    transaction_id: txn,
    buyer_email: 'buyer@example.test',
    github_username: username,
    is_full_refund: null,
    // The Stripe adapter carries the checkout-session id so /claim/by-txn resolves from the redirect;
    // the alias step and its write are the one cost the table attributes to that.
    ...(aliasId ? { redirect_alias_id: aliasId } : {}),
  }) as NormalizedEvent

/** A Stripe refund carries no product id - the revoke resolves it from the grant record. */
const refund = (txn: string): NormalizedEvent => ({
  event_type: 'refund',
  product_id: '',
  transaction_id: txn,
  buyer_email: null,
  github_username: null,
  is_full_refund: true,
})

/**
 * EVERY JOURNEY GETS ITS OWN BUYER, AND THAT IS NOT TIDINESS.
 *
 * The buyer's ledger is a Durable Object keyed by login, and a `CLAIM_GUARD` object outlives a single
 * test within one isolate. Two journeys sharing a login means the second one's revoke asks a ledger
 * that still holds the first one's purchase, is told the team is still entitled, KEEPS it, and skips
 * the removal - so the run measures a revoke that did not revoke. That is not hypothetical: it is what
 * the first draft of this measurement did, and the numbers looked plausible.
 */
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

describe('the published cost table matches a measured run', () => {
  it('sale in `username` mode', async () => {
    const published = publishedRow(ROW_LABELS.username)
    const m = meter()
    fakeGithub(false, 'buyer-username')

    // The alias id rides on both sale journeys, because the published figures are "for the Stripe
    // adapter" and the guide attributes one step and one write of EACH SALE to it. Leaving it off here
    // measures an adapter whose redirect already carries the transaction id, which is a different row
    // than the one this asserts - and is exactly what the first run of this test did.
    await run(m, {
      adapter: 'stripe',
      event: sale('pi_u', 'buyer-username', 'cs_u'),
    })

    expect(
      m.steps.length,
      `${mismatch('username', 'Workflow steps', Number(published.steps))}\nsteps: ${m.steps.join(', ')}`,
    ).toBe(Number(published.steps))
    expect(
      m.writes.length,
      `${mismatch('username', 'KV writes', published.writes)}\nwrites: ${m.writes.join(', ')}`,
    ).toBe(published.writes)
    expect(
      m.deletes.length,
      `${mismatch('username', 'KV deletes', published.deletes)}\ndeletes: ${m.deletes.join(', ')}`,
    ).toBe(published.deletes)
  })

  it('sale in `claim` mode, all three legs of it', async () => {
    // A claim sale is not one run. The payment arrives with no handle and mints a claim (instance one),
    // the buyer submits on the claim page - which makes a KV write of its own, and the guide says so -
    // and the completion is a SECOND Workflow instance. The table's row is the whole journey, so the
    // measurement has to be too; counting only the instances is how the claim page's write goes missing.
    const published = publishedRow(ROW_LABELS.claim)
    const m = meter()
    fakeGithub(false, 'buyer-claim')

    await run(m, { adapter: 'stripe', event: sale('pi_c', null, 'cs_c') })

    // The token is read back from the claim index the first instance wrote, so the submit below is the
    // real one for this claim rather than a token invented here.
    const token = await testEnv.ENTITLEMENTS.get(
      claimIndexKey('stripe', 'pi_c'),
    )
    expect(token, 'the payment instance minted no claim to submit').toBeTruthy()
    const submitted = await completeClaim(
      wfEnv(m),
      CONFIG,
      token!,
      'buyer-claim',
    )
    expect(submitted.status).toBe('submitted')

    await run(m, {
      adapter: 'stripe',
      event: sale('pi_c', 'buyer-claim'),
      from_claim: true,
    })

    expect(
      m.steps.length,
      `${mismatch('claim', 'Workflow steps', Number(published.steps))}\nsteps: ${m.steps.join(', ')}`,
    ).toBe(Number(published.steps))
    expect(
      m.writes.length,
      `${mismatch('claim', 'KV writes', published.writes)}\nwrites: ${m.writes.join(', ')}`,
    ).toBe(published.writes)
    expect(
      m.deletes.length,
      `${mismatch('claim', 'KV deletes', published.deletes)}\ndeletes: ${m.deletes.join(', ')}`,
    ).toBe(published.deletes)
  })

  it('revoke while the invitation is still pending - the higher of the published range', async () => {
    // The grant is not measured here: only the refund instance is, which is what the row describes.
    const published = publishedRow(ROW_LABELS.revoke)
    const { pending } = revokeSteps()
    fakeGithub(true, 'buyer-pending')
    await run(meter(), {
      adapter: 'stripe',
      event: sale('pi_p', 'buyer-pending'),
    })

    const m = meter()
    await run(m, { adapter: 'stripe', event: refund('pi_p') })

    expect(
      m.steps.length,
      `${mismatch('revoke', 'Workflow steps (invitation pending, the upper figure)', pending)}\nsteps: ${m.steps.join(', ')}`,
    ).toBe(pending)
    expect(
      m.writes.length,
      `${mismatch('revoke', 'KV writes', published.writes)}\nwrites: ${m.writes.join(', ')}`,
    ).toBe(published.writes)
    expect(
      m.deletes.length,
      `${mismatch('revoke', 'KV deletes', published.deletes)}\ndeletes: ${m.deletes.join(', ')}`,
    ).toBe(published.deletes)
  })

  it('revoke once the invitation has been accepted - the lower of the published range', async () => {
    const published = publishedRow(ROW_LABELS.revoke)
    const { accepted } = revokeSteps()
    fakeGithub(false, 'buyer-accepted')
    await run(meter(), {
      adapter: 'stripe',
      event: sale('pi_a', 'buyer-accepted'),
    })

    const m = meter()
    await run(m, { adapter: 'stripe', event: refund('pi_a') })

    expect(
      m.steps.length,
      `${mismatch('revoke', 'Workflow steps (invitation accepted, the lower figure)', accepted)}\nsteps: ${m.steps.join(', ')}`,
    ).toBe(accepted)
    expect(
      m.writes.length,
      `${mismatch('revoke', 'KV writes', published.writes)}\nwrites: ${m.writes.join(', ')}`,
    ).toBe(published.writes)
    expect(
      m.deletes.length,
      `${mismatch('revoke', 'KV deletes', published.deletes)}\ndeletes: ${m.deletes.join(', ')}`,
    ).toBe(published.deletes)
  })
})
