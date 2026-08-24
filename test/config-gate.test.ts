// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Gary Stupak

import { describe, it, expect, vi } from 'vitest'
import { createWorker } from '../src/create-worker'
import {
  assertGithubOrg,
  makeConfigGate,
  warnUngrantableConfig,
} from '../src/config/config'
import type { ProductTeamMap, RepoAccessConfig } from '../src/types'
import { mockConfig, mockEnv, stubAdapter } from './helpers'

// A worker whose config names no usable GitHub org can never grant anybody anything, and until this
// gate existed nothing anywhere said so: the real config file is gitignored and materialised from a
// neutral template, so `clone -> npm test green -> deploy` reached exactly that worker and the first
// sign of it was a paying buyer getting nothing.
//
// THE CHECK RUNS AT FIRST REQUEST, NOT AT CONSTRUCTION, and that is a recorded deviation from the
// obligation's original wording rather than a preference. Three deliberate things make a
// construction-time throw impossible here: the shipped template is neutral by decision (asserted by the
// neutrality latch in config-as-code.test.ts AND by the release gate), the dev bootstrap materialises
// that template so the gate returns identical numbers in a fresh clone, and the worker test pool boots
// the real deploy entry against it. A throw in the factory fires before any test runs, in every tree.

const app = (config: Partial<RepoAccessConfig>) =>
  createWorker({
    adapters: [stubAdapter()],
    config: mockConfig(config),
  })

describe('assertGithubOrg', () => {
  it('refuses the three ways this value is wrong, and they fail identically at grant time', () => {
    // Empty, whitespace-only, and a pasted URL where the login was meant. Without the format half, the
    // third one is accepted here and 404s against GitHub on every grant instead.
    for (const bad of ['', '   ', 'https://github.com/acme', 'Acme Kits']) {
      expect(() => assertGithubOrg(bad), JSON.stringify(bad)).toThrow(
        /githubOrg/,
      )
    }
  })

  it('names the field and the file to fix in the message a deployer reads', () => {
    expect(() => assertGithubOrg('')).toThrow(
      /src\/config\/repoaccess\.config\.ts/,
    )
  })

  it('accepts an ordinary org login, hyphens included', () => {
    for (const good of ['acme', 'acme-kits', 'a', 'Acme123']) {
      expect(assertGithubOrg(good), good).toBe(good)
    }
  })
})

describe('warnUngrantableConfig', () => {
  const warnFor = (map: ProductTeamMap) => {
    const warn = vi.fn()
    warnUngrantableConfig(map, warn)
    return warn
  }

  it('warns only on the COMBINATION - no fallback teams AND no product mapped anywhere', () => {
    expect(warnFor({ defaults: { teams: [] } })).toHaveBeenCalledTimes(1)
  })

  it('does NOT warn when the fallback grants something', () => {
    expect(warnFor({ defaults: { teams: ['pro'] } })).not.toHaveBeenCalled()
  })

  it('does NOT warn when a product is mapped, even with an empty fallback', () => {
    // An empty `defaults.teams` is CORRECT on its own: an unmapped product must grant nothing. Refusing
    // it would break the safe configuration, which is why this is a warning and why it needs both
    // halves.
    expect(
      warnFor({
        defaults: { teams: [] },
        stub: { prod_x: { teams: ['pro'], grant_mode: 'username' } },
      } as unknown as ProductTeamMap),
    ).not.toHaveBeenCalled()
  })
})

describe('the config gate refuses every request, and keeps refusing', () => {
  it('answers 500 on EVERY route, /health included - no partial service', async () => {
    const worker = app({ githubOrg: '' })
    // `/health` is in the list deliberately: it reports whether this worker can do its job, and a green
    // liveness probe in front of a worker that will refuse every buyer is a false signal - the one the
    // setup wizard's deploy step would read as success.
    for (const path of ['/health', '/claim/anything', '/claim/by-txn/stub/t']) {
      const res = await worker.request(path, {}, mockEnv())
      expect(res.status, path).toBe(500)
      expect(await res.text(), path).toMatch(/githubOrg/)
    }
  })

  it('a valid config serves normally, so the assertion above cannot green on nothing', async () => {
    const res = await app({}).request('/health', {}, mockEnv())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ok' })
  })

  it('validates ONCE and reuses the verdict on every later request', () => {
    // The config object cannot change between requests in a Worker isolate, so recomputing it would
    // burn the same answer on every webhook. Counted through the warn sink, which the pass path calls
    // exactly once per validation.
    const warn = vi.fn()
    const gate = makeConfigGate({
      githubOrg: 'acme',
      productTeamMap: { defaults: { teams: [] } },
    })
    // The gate takes its own warn sink from `assertRepoAccessConfig`'s default, so drive the count
    // through a config that warns and read the console instead.
    const spy = vi.spyOn(console, 'warn').mockImplementation(warn)
    try {
      expect(gate()).toBeNull()
      expect(gate()).toBeNull()
      expect(gate()).toBeNull()
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      spy.mockRestore()
    }
  })

  it('a failure is STICKY - only a redeploy clears it', () => {
    const gate = makeConfigGate({
      githubOrg: '',
      productTeamMap: { defaults: { teams: [] } },
    })
    const first = gate()
    expect(first).toMatch(/githubOrg/)
    // Same verdict, not a fresh evaluation: nothing a request can do fixes a config file.
    expect(gate()).toBe(first)
  })
})
