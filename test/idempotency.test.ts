// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Gary Stupak

import { env } from 'cloudflare:test'
import { describe, it, expect, vi } from 'vitest'
import { createWorker } from '../src/create-worker'
import { workflowInstanceId } from '../src/workflow/workflow-id'
import type { AccessWorkflowParams, NormalizedEvent } from '../src/types'
import { mockConfig, mockEnv, signedPost, stubAdapter } from './helpers'

// BASELINE - idempotency (duplicate webhook → single workflow).
// Locks down the deterministic Workflow-id dedupe the whole idempotency model rests on.
//
// Local-runtime fidelity note: production has two behaviors the miniflare local engine does NOT
// reproduce (its dedupe is lenient) - both verified instead against the live docs AND the bundled
// workflows-shared source:
//   1. create() THROWS on an already-existing id (miniflare silently dedupes, no throw).
//   2. createBatch() EXCLUDES an already-existing id from its returned array (miniflare includes it).
// So the real-binding test below asserts only what IS locally faithful: enqueuing the same id twice
// via createBatch does not throw, the id resolves to a single instance, and that instance runs to a
// terminal status. The worker's own contribution - a STABLE deterministic id + ack-200-on-duplicate -
// is asserted with a mock binding.

const eventFor = (transactionId: string): NormalizedEvent => ({
  event_type: 'payment_success',
  product_id: 'prod_x',
  transaction_id: transactionId,
  buyer_email: null,
  github_username: null,
  is_full_refund: null,
})

/**
 * Poll an instance until it stops running, and hand back the terminal status.
 *
 * A test that starts a REAL instance must also watch it end. Not for tidiness: an instance still
 * executing when its test returns keeps the pool's runtime busy past teardown, and the whole `npm
 * test` process then never exits - the tests all pass, the summary prints, and the prompt never comes
 * back. Observing to terminal removes that race at its source rather than papering over it with a
 * sleep. Locally the instance settles in well under 100ms (two polls), so the budget below is roughly
 * ten times what it needs; exhausting it is a real failure and says so.
 */
async function settle(instance: WorkflowInstance): Promise<InstanceStatus> {
  let last: InstanceStatus | null = null
  for (let i = 0; i < 100; i++) {
    last = await instance.status()
    if (
      last.status === 'errored' ||
      last.status === 'terminated' ||
      last.status === 'complete'
    ) {
      return last
    }
    await scheduler.wait(10)
  }
  throw new Error(
    `instance ${instance.id} never reached a terminal status; last was ${last?.status}`,
  )
}

// THE INSTANCE THIS TEST STARTS IS EXPECTED TO FAIL, and its failure is asserted below rather than
// merely tolerated. The real binding runs the real `AccessWorkflow` from the deploy entry, which
// composes the bootstrapped NEUTRAL config - no `githubOrg` - so the config gate refuses that instance
// terminally the moment the local engine starts it. That refusal is the correct behaviour: a worker
// that cannot grant anybody anything must not try. Asserting it here means the day the gate stops
// refusing, this test goes red instead of passing quietly.
//
// The runtime ALSO prints the rejection to its own stderr ("uncaught exception ... NonRetryableError"),
// and that line stays whatever this test does - it comes from the engine, not from the test runner, so
// no assertion here can consume it. Read it as the expected log of an expected failure.
describe('idempotency - Workflows dedupe (real binding)', () => {
  it('enqueuing the same id twice via createBatch does not throw and yields one addressable instance', async () => {
    const id = await workflowInstanceId(
      'stub',
      'payment_success',
      'dedupe_a',
      null,
    )
    const params: AccessWorkflowParams = {
      adapter: 'stub',
      event: eventFor('dedupe_a'),
    }

    // The duplicate second createBatch must NOT throw (idempotent enqueue).
    let threw = false
    try {
      await env.ACCESS_WORKFLOW.createBatch([{ id, params }])
      await env.ACCESS_WORKFLOW.createBatch([{ id, params }])
    } catch {
      threw = true
    }
    expect(threw).toBe(false)

    // get() throws if the id doesn't exist → resolving proves a single instance is addressable.
    let instance: WorkflowInstance | null = null
    try {
      instance = await env.ACCESS_WORKFLOW.get(id)
    } catch {
      instance = null
    }
    expect(instance).not.toBeNull()

    // Addressable is half the claim; the other half is what became of it. The config gate throws a
    // NonRetryableError, so the instance must end ERRORED - never `complete`, and never still running.
    const terminal = await settle(instance!)
    expect(terminal.status).toBe('errored')
    // The engine wraps our throw in its own fatal error, and which field carries the cause has moved
    // between versions - so match the token across both rather than pinning a vendor sentence.
    expect(`${terminal.error?.name} ${terminal.error?.message}`).toContain(
      'NonRetryableError',
    )
  })
})

describe('idempotency - worker contract', () => {
  it('duplicate webhook (same transaction_id) → both ack 200 with the SAME deterministic id', async () => {
    const env = mockEnv() // mock binding so the assertion is deterministic, free of RPC-stub quirks
    const createBatch = env.ACCESS_WORKFLOW.createBatch as ReturnType<
      typeof vi.fn
    >

    const app = createWorker({
      adapters: [stubAdapter()],
      config: mockConfig(),
    })
    const init = await signedPost(JSON.stringify({ transaction_id: 'dup_txn' }))

    const first = await app.request('/wh/stub/secret', init, env)
    const second = await app.request('/wh/stub/secret', init, env)

    expect(first.status).toBe(200)
    expect(second.status).toBe(200) // duplicate still acks 200 (dedupe, not failure)

    // Both deliveries enqueue under the identical deterministic id → the runtime dedupes to one.
    expect(createBatch).toHaveBeenCalledTimes(2)
    const ids = createBatch.mock.calls.map(
      (call) => (call[0] as Array<{ id: string }>)[0].id,
    )
    expect(ids).toEqual([
      'stub-payment_success-dup_txn',
      'stub-payment_success-dup_txn',
    ])
  })
})
