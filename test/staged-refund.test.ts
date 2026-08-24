// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Gary Stupak

import { env as testEnv } from 'cloudflare:test'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createWorker } from '../src/create-worker'
import { executeAccessWorkflow } from '../src/workflow/workflow'
import { workflowInstanceId } from '../src/workflow/workflow-id'
import type { EventEnvelope } from '../src/events'
import type {
  AccessWorkflowParams,
  NormalizedEvent,
  PaymentAdapter,
  ProductTeamMap,
  RepoAccessConfig,
} from '../src/types'
import {
  hmacHex,
  makeStep,
  mockConfig,
  mockEnv,
  STUB_SIGNATURE_HEADER,
} from './helpers'

// A REFUND COMPLETED IN STAGES, and why the instance id is the thing that decides it.
//
// The failure this file exists to prevent is silent and costs the seller money. Under
// `full_refund_only` a partial refund is SUPPOSED to run and skip the revoke. If a later event then
// completes the amount, that second delivery carries the same transaction - and while the id was
// `{adapter}-refund-{txn}`, it built the identical id, `createBatch` dedupled it away, and the buyer
// kept access after a full refund. Nothing errored. Nothing logged. The flag's own documentation
// promises exactly the case that did not happen.
//
// The cure is at the id, not at the policy: a refund id carries the scope the event reported, so a
// partial and a full for one transaction are two different instances. The tests below are ordered as
// the defect was found - first that the two deliveries are no longer one instance, then that the
// second really revokes, then that the dedupe this all rests on is still intact for a true retry.

afterEach(async () => {
  vi.restoreAllMocks()
  const { keys } = await testEnv.ENTITLEMENTS.list()
  await Promise.all(keys.map((k) => testEnv.ENTITLEMENTS.delete(k.name)))
})

const STUB_SECRET = 'stub_secret'

/**
 * A stub adapter that reads `event_type` and `is_full_refund` off the body, so one test can post the
 * two stages of a refund. `helpers.stubAdapter` hardcodes a `payment_success` with a null scope,
 * which is the one thing this file cannot use.
 */
function refundAdapter(): PaymentAdapter {
  return {
    name: 'stub',
    verification: {
      kind: 'hmac',
      algo: 'SHA-256',
      secret: () => STUB_SECRET,
      canonical: (raw) => raw.bodyText,
      extract: (headers) => ({
        signature: headers.get(STUB_SIGNATURE_HEADER) ?? '',
      }),
    },
    parse: (raw): NormalizedEvent | null => {
      const body = JSON.parse(raw.bodyText) as Record<string, unknown>
      if (typeof body.transaction_id !== 'string') return null
      return {
        event_type: body.event_type as NormalizedEvent['event_type'],
        product_id: 'prod_x',
        transaction_id: body.transaction_id,
        buyer_email: null,
        github_username: null,
        is_full_refund: (body.is_full_refund ?? null) as boolean | null,
      }
    },
  }
}

async function post(body: Record<string, unknown>): Promise<RequestInit> {
  const text = JSON.stringify(body)
  return {
    method: 'POST',
    body: text,
    headers: {
      [STUB_SIGNATURE_HEADER]: await hmacHex('SHA-256', STUB_SECRET, text),
    },
  }
}

const FULL_REFUND_ONLY: ProductTeamMap = {
  stub: {
    prod_x: {
      teams: ['kit-pro'],
      grant_mode: 'username',
      revoke_policy: { mode: 'auto_revoke', full_refund_only: true },
    },
  },
  defaults: { teams: [], revoke_policy: { mode: 'log_only' } },
}

const GRANT_RECORD = JSON.stringify({
  github_username: 'octocat',
  org: 'testorg',
  teams: ['kit-pro'],
  product_id: 'prod_x',
  granted_at: '2026-01-01T00:00:00Z',
})

/** Drive the route and hand back every (id, params) pair it enqueued. */
async function deliveries(bodies: Record<string, unknown>[]) {
  const env = mockEnv()
  const createBatch = env.ACCESS_WORKFLOW.createBatch as ReturnType<
    typeof vi.fn
  >
  const app = createWorker({
    adapters: [refundAdapter()],
    config: mockConfig({ productTeamMap: FULL_REFUND_ONLY }),
  })
  const statuses: number[] = []
  for (const body of bodies) {
    const res = await app.request('/wh/stub/secret', await post(body), env)
    statuses.push(res.status)
  }
  const batched = createBatch.mock.calls.map(
    (call) =>
      (call[0] as Array<{ id: string; params: AccessWorkflowParams }>)[0],
  )
  return { statuses, batched }
}

describe('a refund completed in stages', () => {
  it('partial then full for ONE transaction are two instances, and the full one revokes', async () => {
    // Stage one: a partial refund. Stage two: the same transaction, now full. Same provider, same
    // txn, one after the other - exactly what a seller does when they refund the rest of an order.
    const { statuses, batched } = await deliveries([
      {
        transaction_id: 'pi_staged',
        event_type: 'refund',
        is_full_refund: false,
      },
      {
        transaction_id: 'pi_staged',
        event_type: 'refund',
        is_full_refund: true,
      },
    ])

    expect(statuses).toEqual([200, 200])
    expect(batched).toHaveLength(2)

    // THE DEFECT, STATED AS THE ASSERTION IT FAILED. Identical ids mean `createBatch` silently drops
    // the second delivery, and the refund that completed the amount never runs at all.
    expect(batched[0].id).not.toBe(batched[1].id)
    expect(batched[0].id).toBe('stub-refund-pi_staged-partial')
    expect(batched[1].id).toBe('stub-refund-pi_staged-full')

    // Distinct ids are only half the claim: the instance the second id starts has to withdraw the
    // access. Run it against a live grant record and watch the team membership go.
    await testEnv.ENTITLEMENTS.put('grant:stub:pi_staged', GRANT_RECORD)
    const calls: string[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : (input as Request).url
      const method = ((init as RequestInit)?.method ?? 'GET').toUpperCase()
      const path = url.replace('https://api.github.com', '')
      calls.push(`${method} ${path}`)
      // Every membership read after the removal reports gone, so the org reconcile can finish.
      return new Response(null, { status: method === 'GET' ? 404 : 204 })
    })
    const events: EventEnvelope[] = []
    const config: RepoAccessConfig = {
      githubOrg: 'testorg',
      productTeamMap: FULL_REFUND_ONLY,
    }
    const { step } = makeStep()

    await executeAccessWorkflow(
      step,
      {
        ...testEnv,
        GITHUB_TOKEN: 'test_token',
      } as unknown as CloudflareBindings,
      config,
      batched[1].params,
      (e: EventEnvelope) => void events.push(e),
    )

    expect(calls).toContain(
      'DELETE /orgs/testorg/teams/kit-pro/memberships/octocat',
    )
    expect(events.map((e) => e.event_type)).toContain('access.revoked')
    expect(await testEnv.ENTITLEMENTS.get('grant:stub:pi_staged')).toBeNull()
  })

  it('the SAME delivery twice still dedups - same scope, same id', async () => {
    // The property the staged fix must not cost us. A provider retrying one delivery reports the same
    // answer both times, so it builds the same id and collides, exactly as before.
    const { batched } = await deliveries([
      {
        transaction_id: 'pi_retry',
        event_type: 'refund',
        is_full_refund: true,
      },
      {
        transaction_id: 'pi_retry',
        event_type: 'refund',
        is_full_refund: true,
      },
    ])
    expect(batched[0].id).toBe(batched[1].id)
    expect(batched[0].id).toBe('stub-refund-pi_retry-full')
  })

  it('a repeat PARTIAL dedups too - the engine would decide the same thing twice', async () => {
    const { batched } = await deliveries([
      {
        transaction_id: 'pi_part',
        event_type: 'refund',
        is_full_refund: false,
      },
      {
        transaction_id: 'pi_part',
        event_type: 'refund',
        is_full_refund: false,
      },
    ])
    expect(batched[0].id).toBe(batched[1].id)
  })

  it('a refund with an UNKNOWN scope gets its own suffix, distinct from both answers', async () => {
    // `is_full_refund: null` on a refund means the provider did not say. It is a third answer, not a
    // missing one, so it must not collide with either of the two the engine can act on.
    const { batched } = await deliveries([
      { transaction_id: 'pi_u', event_type: 'refund', is_full_refund: null },
      { transaction_id: 'pi_u', event_type: 'refund', is_full_refund: true },
    ])
    expect(batched[0].id).toBe('stub-refund-pi_u-unknown')
    expect(batched[1].id).toBe('stub-refund-pi_u-full')
  })

  it('non-refund ids are byte-identical to the shape before the suffix existed', async () => {
    // The suffix is a REFUND concern. A grant and a chargeback keep the id they have always had, so
    // no in-flight instance from a previous deploy is orphaned by this change.
    expect(
      await workflowInstanceId('stripe', 'payment_success', 'pi_1', null),
    ).toBe('stripe-payment_success-pi_1')
    expect(await workflowInstanceId('stripe', 'chargeback', 'pi_1', null)).toBe(
      'stripe-chargeback-pi_1',
    )
    // A chargeback carries `is_full_refund: null` by contract, but even a stray value cannot move it:
    // the suffix is gated on the event type, not on the field.
    expect(await workflowInstanceId('stripe', 'chargeback', 'pi_1', true)).toBe(
      'stripe-chargeback-pi_1',
    )
  })

  it('the hash fallback keeps the scope, and stays inside the length bound', async () => {
    // An out-of-charset transaction id falls back to a hash of that id. Both scopes hash the same
    // transaction, so the suffix is the ONLY thing keeping them apart - losing it there would restore
    // the whole defect for exactly the providers whose ids are awkward.
    const partial = await workflowInstanceId(
      'stripe',
      'refund',
      'txn:weird',
      false,
    )
    const full = await workflowInstanceId('stripe', 'refund', 'txn:weird', true)
    expect(partial).not.toBe(full)
    expect(partial.endsWith('-partial')).toBe(true)
    expect(full.endsWith('-full')).toBe(true)
    for (const id of [partial, full]) {
      expect(id.length).toBeLessThanOrEqual(100)
      expect(/^[a-zA-Z0-9_][a-zA-Z0-9_-]*$/.test(id)).toBe(true)
    }

    // The same, with a transaction id long enough to force the slice. The suffix must survive it.
    const long = await workflowInstanceId(
      'stripe',
      'refund',
      'x'.repeat(400),
      true,
    )
    expect(long.length).toBeLessThanOrEqual(100)
    expect(long.endsWith('-full')).toBe(true)
  })
})
