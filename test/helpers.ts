// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Gary Stupak

import { afterEach, vi } from 'vitest'
import type { WorkflowStep } from 'cloudflare:workers'
import type {
  NormalizedEvent,
  PaymentAdapter,
  RepoAccessConfig,
} from '../src/types'

// Shared synthetic test fixtures. NO real provider payloads (Pro-isolation / core stays clean).

const encoder = new TextEncoder()

/** HMAC-hex, mirroring the engine - used by tests to forge a valid signature for the stub adapter. */
export async function hmacHex(
  algo: 'SHA-256' | 'SHA-512',
  secret: string,
  message: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: algo },
    false,
    ['sign'],
  )
  const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(message))
  return [...new Uint8Array(mac)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

const STUB_SECRET = 'stub-signing-secret'
export const STUB_SIGNATURE_HEADER = 'x-stub-signature'

/**
 * Synthetic hmac adapter: signs the raw body with STUB_SECRET (SHA-256), reads the signature from
 * `x-stub-signature`. `parse` accepts JSON carrying `transaction_id` and returns a payment_success.
 */
export function stubAdapter(): PaymentAdapter {
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
      try {
        const body = JSON.parse(raw.bodyText) as Record<string, unknown>
        if (typeof body.transaction_id !== 'string') return null
        return {
          event_type: 'payment_success',
          product_id:
            typeof body.product_id === 'string' ? body.product_id : 'prod_x',
          transaction_id: body.transaction_id,
          buyer_email: null,
          github_username: null,
          is_full_refund: null,
        }
      } catch {
        return null
      }
    },
  }
}

/** A POST RequestInit with a valid stub signature over `body`. */
export async function signedPost(body: string): Promise<RequestInit> {
  const signature = await hmacHex('SHA-256', STUB_SECRET, body)
  return {
    method: 'POST',
    body,
    headers: { [STUB_SIGNATURE_HEADER]: signature },
  }
}

/** Mock env: spy the Workflow binding + bindings the route touches. Non-secret config is NOT in env
 * anymore (config-as-code) - use `mockConfig()` and pass it to `createWorker`. */
export function mockEnv(
  overrides: Partial<Record<string, unknown>> = {},
): CloudflareBindings {
  return {
    ACCESS_WORKFLOW: { create: vi.fn(), createBatch: vi.fn(async () => []) },
    ENTITLEMENTS: {},
    ...overrides,
  } as unknown as CloudflareBindings
}

/**
 * Neutral deployment config for `createWorker({ adapters, config })`.
 *
 * `githubOrg` IS SET, and it used to be the empty string. That was harmless while nothing read it and
 * became 32 failures the moment the router started refusing a config that names no org - which is the
 * point of that gate, and makes the fixture the thing that was wrong. Those tests were building workers
 * that could not have granted anybody anything, on routes whose subject is verification and acks. The
 * value is a placeholder login because none of them reads it; a test that cares passes its own.
 *
 * `productTeamMap` KEEPS its empty fallback deliberately. That shape is legitimate - an unmapped product
 * must grant nothing - so it is warned about and never refused, and leaving it here is what keeps the
 * test over that warning honest.
 */
export function mockConfig(
  overrides: Partial<RepoAccessConfig> = {},
): RepoAccessConfig {
  return {
    githubOrg: 'testorg',
    productTeamMap: { defaults: { teams: [] } },
    ...overrides,
  }
}

/**
 * Step results that broke the no-object rule during the current test, drained by the hook below.
 *
 * Throwing from the mock is the fast signal, but it is NOT sufficient on its own, and that is not
 * hypothetical: the `emit:` step is wrapped in a try/catch by design, because an outbound delivery
 * failure must never fail a grant that already happened. A throw there is swallowed by the code under
 * test and the suite stays green. So every violation is ALSO recorded here and re-thrown after the
 * test, where no production catch can reach it.
 */
const stepResultViolations: string[] = []

afterEach(() => {
  const found = stepResultViolations.splice(0)
  if (found.length > 0) throw new Error(found.join('\n'))
})

/**
 * The one `step.do` / `step.sleep` mock, shared by every suite that drives the Workflow directly.
 *
 * It also GUARDS the shape of every step result, which is why it is worth having in one place. A
 * Workflows runtime defect records the whole invocation as an exception, carrying a "code had hung and
 * would never generate a response" message, when a step callback resolves to an OBJECT - even though
 * the step and the instance both complete successfully. A callback resolving to a string, a primitive
 * or nothing is recorded cleanly. So no step callback in this repo may resolve to an object, and that
 * is a rule about code nobody re-reads: the mock asserts it instead, and names the offending step id
 * so a regression points at the site rather than at this file.
 *
 * `null` is allowed through deliberately - it is what a KV read returns for a missing key, and it is
 * not an object result in the sense the runtime chokes on.
 *
 * Sleeps are recorded because the workflow suite asserts the backoff schedule. Callers that do not
 * care can ignore the array.
 */
export function makeStep(): { step: WorkflowStep; sleeps: number[] } {
  const sleeps: number[] = []
  const step = {
    // step.do has two arities: (name, fn) and (name, config, fn) - the emit and fetch-entity steps
    // pass a retry config as the middle arg.
    do: async (name: string, a: unknown, b?: unknown) => {
      const fn = (typeof b === 'function' ? b : a) as () => unknown
      const value = await fn()
      if (value !== null && typeof value === 'object') {
        const message =
          `step.do("${name}") resolved to an object. A step callback must return a string, a ` +
          `primitive, or nothing: an object makes the Workflows runtime record the invocation as ` +
          `an exception. Stringify the value inside the callback and parse it after the await.`
        stepResultViolations.push(message)
        throw new Error(message)
      }
      return value
    },
    sleep: (_name: string, ms: number) => {
      sleeps.push(ms)
      return Promise.resolve()
    },
    sleepUntil: () => Promise.resolve(),
  }
  return { step: step as unknown as WorkflowStep, sleeps }
}
