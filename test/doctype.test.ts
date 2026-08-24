// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Gary Stupak

import { env as testEnv } from 'cloudflare:test'
import { describe, it, expect, vi } from 'vitest'
import { createWorker } from '../src/create-worker'
import { mockConfig, stubAdapter } from './helpers'

// Every HTML document this worker serves must OPEN with a doctype. Without one the browser parses the
// page in quirks mode, where the layout is not the one the stylesheet describes: a flex-centred card's
// height pins to the viewport while its content overflows, and the body's bottom padding is swallowed.
// It is a property of the DOCUMENT, not of any one page, so it is asserted over every route this worker
// answers rather than page by page.
//
// The route list is read off the app itself, so a route added later is covered without this file being
// edited: it needs a sample request below, and if it serves HTML without a doctype it fails under its
// own path. That is the same shape the downstream repo's guard uses over its own routes - both halves of
// the same defect, one per repository that owns a shell.

// One request per GET route, keyed by the route pattern `createWorker` registers. Checked against the
// app's own route table, so a new GET route with no entry here fails by name.
const SAMPLE_REQUEST: Record<string, string> = {
  '/health': '/health',
  // An unknown token renders the `invalid` view - a real HTML document, and the one claim state that
  // needs no KV fixture to reach.
  '/claim/:token': '/claim/nope',
  // No `claim_txn` for this transaction, so this renders the neutral `pending` view, which is HTML.
  // The adapter segment must be one the app composes, or the route 404s before it renders a document.
  '/claim/by-txn/:adapter/:txn': '/claim/by-txn/stub/txn_missing',
}

const app = createWorker({ adapters: [stubAdapter()], config: mockConfig() })

const own = [
  ...new Set(app.routes.filter((r) => r.method === 'GET').map((r) => r.path)),
]

// The REAL KV and Durable Object from the pool, plus a mocked Workflow binding - the same env shape the
// claim tests use. A stubbed `ENTITLEMENTS: {}` is not enough here: the claim routes read KV before they
// render anything, so the route would throw and every page would come back as a non-HTML error, which
// the last test in this file exists to notice.
const sampleEnv = () =>
  ({
    ...testEnv,
    ACCESS_WORKFLOW: { create: vi.fn(), createBatch: vi.fn(async () => []) },
  }) as unknown as CloudflareBindings

/** The response body of one sample request, with its content-type, both lower-cased where compared. */
async function fetchSample(path: string) {
  const res = await app.request(SAMPLE_REQUEST[path], {}, sampleEnv())
  const type = (res.headers.get('content-type') ?? '').toLowerCase()
  return { isHtml: type.includes('text/html'), body: await res.text() }
}

describe('every HTML document this worker serves opens with a doctype', () => {
  it('every GET route has a sample request in this file', () => {
    expect(own.filter((path) => !(path in SAMPLE_REQUEST))).toEqual([])
  })

  it.each(own)('%s', async (path) => {
    const { isHtml, body } = await fetchSample(path)
    // A route that answers something other than HTML (`/health` answers JSON) has no document to
    // declare anything about.
    if (!isHtml) return
    expect(body.slice(0, 15).toLowerCase()).toBe('<!doctype html>')
  })

  it('the HTML routes really do answer HTML, so the assertion above cannot green on nothing', async () => {
    const served: string[] = []
    for (const path of own) {
      if ((await fetchSample(path)).isHtml) served.push(path)
    }
    expect(served).toContain('/claim/:token')
    expect(served).toContain('/claim/by-txn/:adapter/:txn')
  })
})
