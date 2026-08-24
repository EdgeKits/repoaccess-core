// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Gary Stupak

import { describe, it, expect } from 'vitest'
import { safeUrl } from '../src/security/safe-url'

// 0.5.0: scheme allowlist for seller-config URLs rendered into href/src (claim-page branding). Allows
// http/https/relative only; a misconfigured javascript:/data: URL collapses to '' so it never renders.

describe('safeUrl', () => {
  it('passes http, https, and relative URLs unchanged (relative NOT rewritten to absolute)', () => {
    expect(safeUrl('https://cdn.example.com/logo.png')).toBe(
      'https://cdn.example.com/logo.png',
    )
    expect(safeUrl('http://example.com/x')).toBe('http://example.com/x')
    expect(safeUrl('/assets/logo.svg')).toBe('/assets/logo.svg')
    expect(safeUrl('logo.png')).toBe('logo.png')
  })

  it('rejects javascript:, data:, vbscript:, and unparseable/empty URLs -> ""', () => {
    expect(safeUrl('javascript:alert(1)')).toBe('')
    expect(safeUrl('data:image/svg+xml,<svg onload=alert(1)>')).toBe('')
    expect(safeUrl('vbscript:msgbox(1)')).toBe('')
    expect(safeUrl('')).toBe('')
  })
})
