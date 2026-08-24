// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Gary Stupak

import { describe, it, expect } from 'vitest'
import { validateWebhookUrl } from '../src/security/ssrf'

const ok = (u: string, opts = {}) => validateWebhookUrl(u, opts).ok

describe('validateWebhookUrl - scheme', () => {
  it('allows https', () => {
    expect(ok('https://hooks.example.com/x')).toBe(true)
  })
  it('rejects http by default, allows it when opted in', () => {
    expect(ok('http://hooks.example.com/x')).toBe(false)
    expect(ok('http://hooks.example.com/x', { allowHttp: true })).toBe(true)
  })
  it('rejects non-http(s) schemes', () => {
    expect(ok('ftp://hooks.example.com/x')).toBe(false)
    expect(ok('file:///etc/passwd')).toBe(false)
  })
  it('rejects an unparseable url', () => {
    expect(ok('not a url')).toBe(false)
  })
})

describe('validateWebhookUrl - IPv4 literals', () => {
  it('rejects private / reserved / loopback / link-local', () => {
    for (const ip of [
      '10.0.0.1',
      '172.16.5.4',
      '172.31.255.255',
      '192.168.1.1',
      '127.0.0.1',
      '0.0.0.0',
      '169.254.1.1',
      '169.254.169.254', // cloud metadata
      '100.64.0.1', // CGNAT
      '224.0.0.1', // multicast
      '255.255.255.255', // broadcast
    ]) {
      expect(ok(`https://${ip}/x`), ip).toBe(false)
    }
  })
  it('allows public IPv4', () => {
    expect(ok('https://8.8.8.8/x')).toBe(true)
    expect(ok('https://172.15.0.1/x')).toBe(true) // just below 172.16/12
    expect(ok('https://172.32.0.1/x')).toBe(true) // just above 172.16/12
  })
})

describe('validateWebhookUrl - IPv6 literals', () => {
  it('rejects loopback / unspecified / ULA / link-local / mapped-private', () => {
    for (const ip of [
      '[::1]',
      '[::]',
      '[fc00::1]',
      '[fd12:3456::1]',
      '[fe80::1]',
      '[::ffff:10.0.0.1]', // IPv4-mapped private
      '[::ffff:169.254.169.254]',
    ]) {
      expect(ok(`https://${ip}/x`), ip).toBe(false)
    }
  })
  it('allows public IPv6', () => {
    expect(ok('https://[2606:4700:4700::1111]/x')).toBe(true)
  })
})

describe('validateWebhookUrl - allowlist', () => {
  it('enforces exact or suffix match when set', () => {
    const opts = { allowlist: ['hooks.example.com', 'events.acme.io'] }
    expect(ok('https://hooks.example.com/x', opts)).toBe(true)
    expect(ok('https://eu.events.acme.io/x', opts)).toBe(true) // suffix
    expect(ok('https://evil.com/x', opts)).toBe(false)
    expect(ok('https://acme.io/x', opts)).toBe(false) // parent of suffix entry, not a match
  })
  it('any public host allowed when allowlist empty', () => {
    expect(ok('https://anything.example.org/x', { allowlist: [] })).toBe(true)
  })
  it('allowlist does not rescue a private IP', () => {
    expect(ok('https://10.0.0.1/x', { allowlist: ['10.0.0.1'] })).toBe(false)
  })
})
