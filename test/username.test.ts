// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Gary Stupak

import { describe, it, expect } from 'vitest'
import { isValidGithubUsername } from '../src/username'

describe('isValidGithubUsername', () => {
  it('accepts valid handles', () => {
    for (const ok of [
      'octocat',
      'a',
      'user-name',
      'GitHub',
      'a1b2c3',
      'x'.repeat(39),
    ]) {
      expect(isValidGithubUsername(ok)).toBe(true)
    }
  })

  it('rejects malformed handles', () => {
    for (const bad of [
      '',
      '-leading',
      'trailing-',
      'double--hyphen',
      'has space',
      'under_score',
      'dot.dot',
      'x'.repeat(40), // 40 chars > 39
      null,
      undefined,
    ]) {
      expect(isValidGithubUsername(bad as string)).toBe(false)
    }
  })
})
