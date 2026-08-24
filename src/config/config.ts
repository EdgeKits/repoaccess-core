// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Gary Stupak

import type { ProductConfig, ProductTeamMap, RepoAccessConfig } from '../types'
import { isValidGithubUsername } from '../username'

/**
 * Light runtime guard that a config-authored `productTeamMap` carries the reserved `defaults` key.
 * The typed `RepoAccessConfig` already enforces this at compile time; this catches a
 * hand-authored config that was cast/loosened, failing loudly at startup rather than silently
 * granting nothing. (Replaces the old JSON-string `parseProductTeamMap`.)
 */
export function assertProductTeamMap(map: ProductTeamMap): ProductTeamMap {
  if (
    typeof map !== 'object' ||
    map === null ||
    typeof map.defaults !== 'object' ||
    map.defaults === null
  ) {
    throw new Error('productTeamMap must be an object with a `defaults` key')
  }
  return map
}

/**
 * Refuse a config that names no usable GitHub org.
 *
 * WHY THIS EXISTS. The deploy entries import a config file that is gitignored and copied from a neutral
 * template whose `githubOrg` is the empty string. For one release that copy did not exist in a fresh
 * clone, so the build failed and the failure WAS the guard; then a dev bootstrap started materialising
 * the template, because a gate that cannot be reproduced in a clone is not a gate. That trade was right
 * and it left nothing checking this value anywhere, so `clone -> npm test green -> deploy` reached a
 * worker that can never grant anyone access, and the first sign of it was a paying buyer getting
 * nothing.
 *
 * FORMAT AS WELL AS PRESENCE, because the three ways to get this wrong fail identically at grant time:
 * an empty string, a whitespace-only string, and a pasted `https://github.com/acme` where the login was
 * meant. The grammar is the GitHub login grammar, so it is READ FROM `isValidGithubUsername` rather than
 * restated here - orgs and users share that namespace, and a second copy of the rule is a second thing
 * to keep in step.
 *
 * IT REFUSES RATHER THAN WARNS. A worker with no org is not degraded, it is inoperable: every grant it
 * ever attempts fails, and a warning in a log nobody reads at deploy time is how that reaches a buyer.
 */
export function assertGithubOrg(githubOrg: string): string {
  if (typeof githubOrg !== 'string' || githubOrg.trim() === '') {
    throw new Error(
      'RepoAccessConfig.githubOrg is empty. Set it to your GitHub organization login in src/config/repoaccess.config.ts (the profile this environment deploys) and deploy again - a worker without one cannot grant access to anybody.',
    )
  }
  if (!isValidGithubUsername(githubOrg)) {
    throw new Error(
      `RepoAccessConfig.githubOrg is not a GitHub organization login: ${JSON.stringify(githubOrg)}. Use the login on its own - the last segment of your organization URL - not the full URL and not the display name. It lives in src/config/repoaccess.config.ts.`,
    )
  }
  return githubOrg
}

/**
 * Warn about a config that CAN never grant anything, without refusing it.
 *
 * THE COMBINATION IS THE SIGNAL, not either half. An empty `defaults.teams` is correct and deliberate on
 * its own - an unmapped product must grant nothing, which is exactly what an empty fallback expresses -
 * so refusing it would break the safe configuration. Per-adapter entries beside a non-empty `defaults`
 * are ordinary too. What is worth surfacing is BOTH at once: no fallback teams and no product mapped
 * anywhere, which is the neutral template's exact shape and a worker whose every grant resolves to
 * nothing.
 *
 * A WARNING, NEVER A REFUSAL, because this shape is legitimately reachable. A deployer standing the
 * worker up before wiring their first product has it, and so does the setup wizard, which deploys before
 * it writes the product map. Refusing here would break that order of operations to catch a mistake the
 * next screen fixes.
 */
export function warnUngrantableConfig(
  map: ProductTeamMap,
  warn: (message: string) => void = console.warn,
): void {
  const fallbackGrantsNothing = (map.defaults?.teams?.length ?? 0) === 0
  const mapped = Object.entries(map).some(
    ([adapter, entry]) =>
      adapter !== 'defaults' &&
      typeof entry === 'object' &&
      entry !== null &&
      Object.keys(entry).length > 0,
  )
  if (fallbackGrantsNothing && !mapped) {
    warn(
      'RepoAccessConfig.productTeamMap grants nothing: `defaults.teams` is empty and no adapter has a product entry. Every purchase will resolve to a grant of no teams until you map a product.',
    )
  }
}

/**
 * Validate a whole config. Refuses what is inoperable, warns about what is merely empty.
 *
 * The other three config keys need nothing on this axis, and that is a decision rather than an
 * omission: `eventWebhook` already fail-closes when its signing secret is unset, `branding` is optional
 * and neutral-defaulted and its URLs already pass the scheme allowlist, and `e2e` is setup tooling that
 * is never read on the request or Workflow path.
 */
export function assertRepoAccessConfig(
  config: RepoAccessConfig,
  warn: (message: string) => void = console.warn,
): RepoAccessConfig {
  assertGithubOrg(config.githubOrg)
  assertProductTeamMap(config.productTeamMap)
  warnUngrantableConfig(config.productTeamMap, warn)
  return config
}

/**
 * The memoized verdict for one composed worker: `null` once the config has passed, the deployer-facing
 * message once it has failed, `undefined` until the first request asks.
 *
 * IT IS CHECKED AT FIRST USE RATHER THAN AT CONSTRUCTION, and that is a recorded deviation rather than
 * a preference. Three deliberate things make a construction-time refusal impossible here: the shipped
 * config template is neutral by decision (and that is asserted by a committed test and by the release
 * gate), the dev bootstrap materialises that template so the gate returns the same numbers in a fresh
 * clone, and the worker test pool boots the real deploy entry against it. A throw in the factory
 * therefore fires before any test runs, in every tree, and reports a broken build rather than a
 * misconfigured deployment.
 *
 * VALIDATED ONCE, and the cached verdict is what every later request reads: a config object cannot
 * change between requests in a Worker isolate, so recomputing it would burn the same answer on every
 * webhook. A failure is sticky for the life of the isolate and only a redeploy with a corrected config
 * clears it, which is exactly the shape of the mistake being caught.
 */
export function makeConfigGate(config: RepoAccessConfig): () => string | null {
  let verdict: string | null | undefined
  return () => {
    if (verdict === undefined) {
      try {
        assertRepoAccessConfig(config)
        verdict = null
      } catch (err) {
        verdict = err instanceof Error ? err.message : String(err)
        console.log(
          JSON.stringify({
            level: 'error',
            msg: 'config rejected - refusing every request until redeploy',
            detail: verdict,
          }),
        )
      }
    }
    return verdict
  }
}

/**
 * Resolve a product's config: `map[adapter]?.[product_id] ?? map.defaults` (whole-object
 * fallback). `defaults` is a reserved key - an adapter literally named "defaults" cannot shadow
 * the fallback.
 */
export function resolveProductConfig(
  map: ProductTeamMap,
  adapter: string,
  productId: string,
): ProductConfig {
  const perAdapter =
    adapter === 'defaults'
      ? undefined
      : (map[adapter] as Record<string, ProductConfig> | undefined)
  return perAdapter?.[productId] ?? map.defaults
}
