// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Gary Stupak

// --- public library surface (the npm barrel; `exports['.']`) -----------------
// Re-exports ONLY. No config import, no default export, no worker instantiation. A downstream that
// installs repoaccess-core and writes `import { createWorker } from 'repoaccess-core'` imports THIS
// file, so it must resolve in a package where the deployer's `repoaccess.config.ts` does not exist at
// all (that file is gitignored, copied from the shipped `.example` template, and never enters the
// published tarball). The worker DEPLOY entries - `src/index.ts` (sandbox) and `src/index.production.ts`
// (production), what wrangler's `main` loads - are the ones that import the config and instantiate the
// worker; keep that side effect out of here so the library import stays config-free.
export { createWorker } from './create-worker'
export type { CreateWorkerOptions } from './create-worker'
// Config-as-code: the factory that binds the Workflow class to a typed config, plus the
// config contract types a deployer authors in their own `repoaccess.config.ts`.
export { createAccessWorkflow } from './workflow/workflow'
// The claim-page template contract - the open extension point a downstream worker implements to
// restyle the claim flow; core ships the default template.
export { defaultClaimTemplate } from './claim/claim-template'
export type { Branding, ClaimView, ClaimTemplate } from './claim/claim-template'
// The shared design-token look (theme primitives) - so Pro's /checkout composes the EXACT same look
// from one source: `themeVars(theme)` (light + dark seller palettes over neutral defaults, emitted
// as browser-resolved `light-dark()` vars) + the unified `baseThemeCss` component stylesheet +
// `sanitizeCustomCss` for the seller `customCss`, rendered into one <style> block.
export { themeVars, baseThemeCss, sanitizeCustomCss } from './themes/theme'
export type { Theme, Palette } from './types'
// Guarded outbound fetch for api_callback adapters' `fetchEntity` (https-only + SSRF + redirect:manual
// + timeout). Use it instead of bare `fetch` so every entity verification gets the same protections.
export { fetchVerifiedEntity } from './fetch-entity'
export type { FetchEntityOptions } from './fetch-entity'
// The adapter contract - the authoritative TypeScript shapes an adapter implements. These exported
// types ARE the contract: compose them to build or type-check an adapter against core.
export type {
  PaymentAdapter,
  VerificationStrategy,
  NormalizedEvent,
  RawRequest,
  VerifiedEntity,
  GrantMode,
  RevokePolicy,
  ProductConfig,
  ProductTeamMap,
  RepoAccessConfig,
  EventWebhookConfig,
} from './types'
// The claim single-flight Durable Object - exported so the CLAIM_GUARD binding resolves.
export { ClaimGuard } from './claim/claim-guard'
// Shared URL scheme-allowlist (http/https/relative only, else '') - applied to seller-config URLs
// rendered into href/src (claim-page branding). Exported so a downstream (RepoAccess Pro's checkout
// page) can reuse the canonical implementation instead of duplicating it.
export { safeUrl } from './security/safe-url'
// Baseline HTML hardening (nosniff + deny framing, absent-only). The app `createWorker` returns
// already applies it to every text/html response it serves; this export is for a downstream serving
// HTML from a route OUTSIDE that app, so the same baseline is one import away, never a hand copy.
export { hardenHtmlHeaders } from './security/harden-html'
// --- engine primitives (0.3.0) - so a same-account composition (Pro's RPC WorkerEntrypoint)
// reuses the SAME deterministic Workflow ids, KV keys, and by-txn resolution instead of
// duplicating them (drift). Additive; core runtime behavior is unchanged.
// Deterministic Workflow instance id = idempotency key. An RPC-initiated grant and a later provider
// webhook for the same transaction collide on one instance only if they build the id identically.
export {
  workflowInstanceId,
  apiCallbackInstanceId,
} from './workflow/workflow-id'
// ENTITLEMENTS key builders + TTLs - the single wire format for grant/claim/alias/fail records.
export {
  grantKey,
  claimKey,
  claimIndexKey,
  sessionTxnKey,
  failKey,
  GRANT_TTL_SEC,
  CLAIM_TTL_SEC,
  FAIL_TTL_SEC,
} from './kv-keys'
// By-txn grant-delivery resolver (grant -> completing -> claim -> fail -> pending) - the single source
// of truth the HTTP `/claim/by-txn` surface and Pro's `resolveDelivery` RPC both call. Token only in
// the `claim` state.
export { resolveByTxn } from './claim/claim'
export type { ByTxnState, ByTxnResolution } from './claim/claim'
// Claim-completion engine (validate handle, single-flight, enqueue) - exposed so a downstream (Pro's
// submitClaim RPC) can complete a claim with a corrected handle without the HTTP claim page.
export { completeClaim } from './claim/claim'
export type { CompleteClaimResult } from './claim/claim'
// Internal enqueue params (grant/revoke) - exported so an RPC composer can build the Workflow input.
// `GrantOrigin` travels with them: it is the vocabulary of the provenance a composer SETS on the
// params, and the same value a consumer reads back off the grant record and off every emitted event.
export type { AccessWorkflowParams, GrantOrigin } from './types'
