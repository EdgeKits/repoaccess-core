// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Gary Stupak

import { describe, it, expect } from 'vitest'
import {
  assertProductTeamMap,
  resolveProductConfig,
} from '../src/config/config'
import type { ProductTeamMap } from '../src/types'

describe('assertProductTeamMap', () => {
  it('returns a valid map unchanged', () => {
    const map: ProductTeamMap = { defaults: { teams: [] } }
    expect(assertProductTeamMap(map)).toBe(map)
  })

  it('throws when `defaults` is missing (config-as-code guard)', () => {
    // A loosened/cast config that dropped `defaults` must fail loudly, not grant nothing silently.
    expect(() =>
      assertProductTeamMap({ stripe: {} } as unknown as ProductTeamMap),
    ).toThrow(/defaults/)
  })

  it('throws when handed a non-object', () => {
    expect(() =>
      assertProductTeamMap(null as unknown as ProductTeamMap),
    ).toThrow(/defaults/)
  })
})

describe('resolveProductConfig', () => {
  const map: ProductTeamMap = {
    stripe: {
      prod_ABC: { teams: ['kit-pro'], grant_mode: 'username' },
    },
    defaults: {
      teams: [],
      grant_mode: 'claim',
      revoke_policy: { mode: 'log_only' },
    },
  }

  it('returns the per-product config when mapped', () => {
    expect(resolveProductConfig(map, 'stripe', 'prod_ABC').teams).toEqual([
      'kit-pro',
    ])
  })

  it('falls through to defaults for an unmapped product', () => {
    expect(resolveProductConfig(map, 'stripe', 'prod_UNKNOWN')).toBe(
      map.defaults,
    )
  })

  it('falls through to defaults for an unmapped adapter', () => {
    expect(resolveProductConfig(map, 'unmapped', 'anything')).toBe(map.defaults)
  })

  it("an adapter literally named 'defaults' cannot shadow the fallback", () => {
    const m: ProductTeamMap = { defaults: { teams: ['d'] } }
    expect(resolveProductConfig(m, 'defaults', 'whatever')).toBe(m.defaults)
  })
})
