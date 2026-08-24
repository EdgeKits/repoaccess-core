// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Gary Stupak

import type { RawRequest } from '../types'

const FORM_CONTENT_TYPE = 'application/x-www-form-urlencoded'

/**
 * Capture the request body byte-exact BEFORE any JSON parse. HMAC verification breaks if the body
 * is parsed and re-serialized, so adapters must receive the raw text.
 * The body is read exactly once.
 *
 * For form-urlencoded providers, a parsed `URLSearchParams` view is attached
 * alongside the raw text - the raw text remains the source of truth for signatures.
 */
export async function captureRawRequest(request: Request): Promise<RawRequest> {
  // Read the raw bytes and decode as UTF-8 ourselves, rather than `request.text()`. workerd warns that
  // the result "will probably be corrupted" whenever `.text()` is called on a non-text Content-Type
  // (form-urlencoded webhooks trip it), even though those bytes are ASCII and decode identically. The
  // decoded string is byte-for-byte what `.text()` returns, so the byte-exact body the HMAC path signs
  // over is unchanged - this only silences a benign, alarming warning at the source.
  const bodyText = new TextDecoder().decode(await request.arrayBuffer())
  const { headers } = request
  const contentType = headers.get('content-type') ?? ''
  const bodyForm = contentType.includes(FORM_CONTENT_TYPE)
    ? new URLSearchParams(bodyText)
    : undefined
  return { bodyText, bodyForm, headers }
}
