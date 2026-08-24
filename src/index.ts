// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Gary Stupak

import { createWorker } from './create-worker'
import { createAccessWorkflow } from './workflow/workflow'
import { stripe } from './adapters/stripe'
import { sandbox as config } from './config/repoaccess.config'

/**
 * Core example worker entry (sandbox/default env) - selected by wrangler's top-level `main`.
 * Composes the free-core adapter set (just Stripe) with the neutral `sandbox` config profile. A
 * downstream distribution composes `[stripe, …]` with a longer adapter list from its own entry; the
 * router/engine/Workflow are identical, only the adapter list + config differ.
 *
 * This file is a DEPLOY entry only, NOT the npm barrel - that is `src/lib.ts` (`exports['.']`), which
 * imports no config so a library consumer resolves it without the deployer's gitignored
 * `repoaccess.config.ts`. Here we DO import the config (the `sandbox` profile) and instantiate the
 * worker, and re-export just the binding classes wrangler must resolve from `main`: `ClaimGuard`
 * (Durable Object) and `AccessWorkflow` (Workflows), the latter built via the config-bound factory so
 * `extends createAccessWorkflow(config, adapters)` yields a named class wrangler can resolve
 * `class_name` against. The adapter list goes to BOTH `createWorker` (ack path) and
 * `createAccessWorkflow` (Workflow path) so an api_callback adapter can run its entity fetch + parse
 * in-step; keep the two identical.
 */
export { ClaimGuard } from './claim/claim-guard'
const adapters = [stripe]
export class AccessWorkflow extends createAccessWorkflow(config, adapters) {}
export default createWorker({ adapters, config })
