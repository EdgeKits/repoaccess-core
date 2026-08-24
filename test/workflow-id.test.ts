// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Gary Stupak

import { describe, it, expect } from 'vitest'
import {
  workflowInstanceId,
  WORKFLOW_INSTANCE_ID_PATTERN,
  MAX_WORKFLOW_INSTANCE_ID_LENGTH,
} from '../src/workflow/workflow-id'

describe('workflowInstanceId', () => {
  it('returns the readable form for charset-safe components', async () => {
    expect(
      await workflowInstanceId('stripe', 'payment_success', 'pi_123', null),
    ).toBe('stripe-payment_success-pi_123')
  })

  it('hashes an out-of-charset transaction_id instead of throwing, staying valid + bounded', async () => {
    const id = await workflowInstanceId(
      'stripe',
      'refund',
      'txn:weird/id with spaces',
      true,
    )
    expect(id.startsWith('stripe-refund-')).toBe(true)
    expect(WORKFLOW_INSTANCE_ID_PATTERN.test(id)).toBe(true)
    expect(id.length).toBeLessThanOrEqual(MAX_WORKFLOW_INSTANCE_ID_LENGTH)
  })

  it('is deterministic (same inputs → same id, so idempotency holds)', async () => {
    const a = await workflowInstanceId('stripe', 'refund', 'txn:weird', true)
    const b = await workflowInstanceId('stripe', 'refund', 'txn:weird', true)
    expect(a).toBe(b)
  })

  it('distinct out-of-charset txns → distinct ids (collision-resistant, not lossy)', async () => {
    const a = await workflowInstanceId('stripe', 'refund', 'bad id A', true)
    const b = await workflowInstanceId('stripe', 'refund', 'bad id B', true)
    expect(a).not.toBe(b)
  })

  it('over-long transaction_id → hashed, ≤100 chars, valid', async () => {
    const id = await workflowInstanceId(
      'stripe',
      'payment_success',
      'x'.repeat(200),
      null,
    )
    expect(id.length).toBeLessThanOrEqual(MAX_WORKFLOW_INSTANCE_ID_LENGTH)
    expect(WORKFLOW_INSTANCE_ID_PATTERN.test(id)).toBe(true)
  })
})
