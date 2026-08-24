// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Gary Stupak

/**
 * Canonical webhook fixture format (the core baseline + the post-v1 Adapter Conformance
 * Lab). Every fixture records its **provider**, **capture date**, and **raw bytes verbatim** so that
 * a payload captured live from a provider sandbox drops into the SAME suites with no reshaping.
 *
 * The one rule that makes this Conformance-Lab-ready: `raw` is the body byte-exact, NEVER a
 * re-serialized object. HMAC verification signs these exact bytes, so a fixture
 * that round-trips through `JSON.stringify` would silently diverge from the live payload it stands
 * in for. Author synthetic bodies as verbatim string literals; a live capture writes its bytes here
 * unchanged.
 *
 * Core ships SYNTHETIC fixtures only - no real provider payloads, no Pro fixtures (Pro-isolation).
 * `synthetic: true` is therefore the rule in this repo; the field exists so the Lab can
 * tag refreshed live captures `synthetic: false` in Pro suites using the identical shape.
 */
export interface WebhookFixture {
  /** Adapter/provider name (matches `PaymentAdapter.name`, e.g. 'stripe'). */
  provider: string
  /** Date the payload was captured/authored, ISO 8601 `YYYY-MM-DD`. */
  capture_date: string
  /** true = hand-authored synthetic payload (always true in core). */
  synthetic: boolean
  /** One-line description of what this payload represents. */
  description: string
  /**
   * The request body, byte-exact as received. Signed and parsed verbatim - do NOT re-serialize.
   */
  raw: string
  /**
   * Captured request headers, verbatim, for live fixtures. Synthetic HMAC fixtures usually omit the
   * signature header here and recompute it in-test from the synthetic secret (the secret is not
   * captured), but the field is here so a live capture can carry its real signature header.
   */
  headers?: Record<string, string>
}
