// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Gary Stupak

import { createWorker } from './create-worker'
import { createAccessWorkflow } from './workflow/workflow'
import { stripe } from './adapters/stripe'
import { production as config } from './config/repoaccess.config'

/**
 * Core PRODUCTION worker entry - selected by wrangler's per-env `main` override
 * (`[env.production].main`). Identical composition to `src/index.ts`, but bound to the
 * `production` config profile. This file is a deploy entry only (never the npm barrel), so it
 * re-exports just the binding classes wrangler must resolve from `main`.
 */
export { ClaimGuard } from './claim/claim-guard'
// Same adapter list to both factories (ack path + Workflow path) - see src/index.ts.
const adapters = [stripe]
export class AccessWorkflow extends createAccessWorkflow(config, adapters) {}
export default createWorker({ adapters, config })
