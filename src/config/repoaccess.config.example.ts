// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Gary Stupak

import type { RepoAccessConfig } from '../types'

/**
 * Deployment config as code - the typed, user-owned replacement for the old non-secret
 * `wrangler vars`. SECRETS are NOT here: `GITHUB_TOKEN`, the adapters' `*_WEBHOOK_SECRET`, and the
 * optional `EVENT_WEBHOOK_SECRET` stay in the runtime env.
 *
 * This is the COMMITTED `.example` TEMPLATE, and every path it names is a path in the CLONED
 * REPOSITORY. Copy it to `src/config/repoaccess.config.ts` and fill in your values
 * (`cp src/config/repoaccess.config.example.ts src/config/repoaccess.config.ts`, or let the setup
 * wizard write it). The real file is gitignored, so a `git pull` update brings you new code and never
 * overwrites your config. The repository's worker deploy entries (`src/index.ts`,
 * `src/index.production.ts`) import the real file, so it is still REQUIRED to build - but you no longer
 * have to create it yourself: `npm test` and `npm run typecheck` each copy this
 * template into place first when the file is absent. **So a green typecheck no longer tells you the
 * config has been filled in** - it may be this neutral template, whose empty `githubOrg` and empty
 * `defaults.teams` grant nobody anything. Fill in your own values before you deploy.
 *
 * Installing from npm instead of cloning? Neither deploy entry nor the real config is in the package -
 * the `files` allowlist excludes all three on purpose, because you write your own entry and hand your
 * own config to `createWorker` / `createAccessWorkflow`. This file itself is in the package, to copy from.
 *
 * This template ships NEUTRAL - never hard-code a real org/product map here (the suite latches it). Two
 * shapes are supported:
 *
 *   • single-env  - export one config and point both `createWorker`/`createAccessWorkflow` at it;
 *   • sandbox/prod split - export two profiles (below) and select per-environment via wrangler's
 *     per-env `main` (`src/index.ts` → sandbox, `src/index.production.ts` → production).
 *
 * `env` is unavailable at module top-level in Workers, so the profile is chosen at build/deploy time
 * by which entry wrangler loads - not from a runtime var.
 */

/**
 * Shared base - neutral defaults. A product that matches no entry falls through to `defaults`, and
 * `defaults.teams` is EMPTY: that is why an unmapped product grants nothing. `revoke_policy` below is a
 * separate axis - it governs what happens on a REFUND, not whether a sale grants.
 */
const base: RepoAccessConfig = {
  githubOrg: '',
  productTeamMap: {
    defaults: {
      teams: [],
      grant_mode: 'claim',
      revoke_policy: { mode: 'log_only' },
    },
  },
  // branding omitted → the claim controller fills neutral defaults (name "RepoAccess").
}

/** Default/sandbox profile (loaded by the repository's `src/index.ts` - see the entry note above). */
export const sandbox: RepoAccessConfig = base

/**
 * Production profile (loaded by the repository's `src/index.production.ts` - see the entry note
 * above). Neutral in core - a deployer overrides.
 */
export const production: RepoAccessConfig = base
