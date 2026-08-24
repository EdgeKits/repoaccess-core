// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Gary Stupak

/**
 * Pinned core contract.
 *
 * This is the public surface every adapter implements. Keep it minimal and provider-agnostic:
 * provider specifics live in adapters, never here.
 */

// CORE DECLARES NO MEMBER ON THE GLOBAL `CloudflareBindings`, and that absence is a decision rather
// than an omission. `wrangler types` generates that interface from the deployer's own
// `wrangler.jsonc`, so its members are theirs; a member core adds by declaration merging has to be
// compatible with whatever they generated, and for an OPTIONAL secret no such member exists. See the
// full argument at `outboundSigningSecret` in `events.ts`, which is the one place core reads a name
// the deployer may or may not have declared.

/**
 * A JSON value - the shape that survives being persisted and replayed by a durable Workflow step.
 * Cloudflare Workflows persists every step result, so `step.do<T>()` constrains `T` to
 * `Serializable`; bare `unknown` fails that constraint. Used for GitHub response bodies
 * (`GithubResult.json`), which ARE JSON at runtime and are carried across the step boundary as a
 * JSON string.
 *
 * Both composite arms are named interfaces (not inline `Json[]` / `{ [k]: Json }`): routing the
 * recursion through `ReadonlyArray` and an interface lets the workers-types `Serializable<T>` mapped
 * type resolve each arm via its dedicated `ReadonlyArray` / object branch and reuse the memoized
 * `Serializable<Json>`, instead of re-expanding to infinite instantiation depth (TS2589).
 */
export type Json = null | boolean | number | string | JsonArray | JsonObject
export interface JsonArray extends ReadonlyArray<Json> {}
export interface JsonObject {
  readonly [key: string]: Json
}

/**
 * How the seller's checkout is meant to supply the buyer's GitHub handle. DECLARATIVE: no code reads
 * this value. The route is decided by the event - a valid handle grants directly, an absent or
 * malformed one falls back to the claim page - so this states the seller's setup rather than steering
 * it. `email` was a member of this union and never had an implementation, so it was removed rather
 * than left as a value a config could set to no effect.
 */
export type GrantMode = 'username' | 'claim'

export interface RevokePolicy {
  mode: 'auto_revoke' | 'log_only'
  /** Gates `refund` events only; chargebacks always revoke under auto_revoke. */
  full_refund_only?: boolean
}

export interface ProductConfig {
  /** Team slugs → resolved to numeric ids at runtime (KV `team:{slug}`). */
  teams: string[]
  grant_mode?: GrantMode
  revoke_policy?: RevokePolicy
}

/**
 * Product→team map - flat shape: adapter keys + a sibling `defaults`. `defaults` is a
 * RESERVED key: `resolveProductConfig` guards it so an adapter literally named "defaults" cannot
 * shadow the fallback. Authored as a typed object in `RepoAccessConfig.productTeamMap`,
 * no longer a JSON-string var.
 */
export interface ProductTeamMap {
  defaults: ProductConfig
  [adapter: string]: ProductConfig | { [product_id: string]: ProductConfig }
}

/**
 * One color scheme's worth of seller-configurable colors for the worker-served pages (claim /
 * delivery, and Pro's `/checkout`). A `Theme` carries one `Palette` per scheme (light + dark). All
 * fields optional strings so a partial palette sets only what it wants; any missing color falls back
 * to core's NEUTRAL default for that scheme (see `themeVars`). Values flow into a raw `<style>`
 * block, so `themeVars` strips CSS/HTML breakout chars from each (they are colors, never markup).
 */
export interface Palette {
  /** Primary action color (buttons, links). */
  brand?: string
  /** Text color ON `brand` (button label / spinner). */
  brandContrast?: string
  /** Page background (behind the card). */
  bg?: string
  /** Card / surface background. */
  surface?: string
  /** Primary text (headings + body copy). */
  text?: string
  /** Secondary text (brand line, status, refund notice, muted rows). */
  textMuted?: string
  /** Hairline border (card edges, inputs, summary/product dividers). */
  border?: string
}

/**
 * Seller-configurable design tokens for the worker-served pages. A theme carries BOTH a light and a
 * dark palette - there is no mode switch: `themeVars()` emits every color var as a
 * `light-dark(<light>, <dark>)` pair under `color-scheme: light dark`, so the buyer's BROWSER
 * preference (prefers-color-scheme) picks the palette with no JS theme logic - the same preference
 * any embedded provider checkout frame follows, so the whole chain matches
 * automatically. `radius` / `font` are scheme-independent. Any missing palette or color falls back
 * to core's NEUTRAL default for that scheme.
 */
export interface Theme {
  /** Colors used when the buyer's browser prefers light (or states no preference). */
  light?: Palette
  /** Colors used when the buyer's browser prefers dark. */
  dark?: Palette
  /** Card corner radius; controls derive a slightly tighter radius from it. */
  radius?: string
  /** Font stack (`font-family`). */
  font?: string
}

/**
 * Seller-configurable claim-page branding. The contract type for both
 * `RepoAccessConfig.branding` (as a `Partial`, defaulted by the controller) and the claim template's
 * view (re-exported from `claim-template.tsx`). `theme` + `customCss` drive the shared look: the
 * template renders `themeVars(theme)` + `baseThemeCss` + `customCss` into one `<style>` block.
 */
export interface Branding {
  name: string
  logoUrl: string
  faviconUrl: string
  /** Design tokens (light + dark palettes) overriding core's neutral defaults; omitted -> the neutral theme. */
  theme?: Theme
  /**
   * Raw CSS appended after `baseThemeCss` for seller tweaks. A `</style>` inside it is ESCAPED before
   * injecting, never deleted, so your CSS is not silently truncated - `sanitizeCustomCss` carries why
   * that distinction is the security property rather than a preference.
   */
  customCss?: string
}

/**
 * Outbound event delivery. Optional/opt-in - omit (or leave `url` empty) for the log-only
 * sink. The signing secret is NOT here: it stays in the env as `EVENT_WEBHOOK_SECRET`.
 */
export interface EventWebhookConfig {
  /** Destination URL; unset/empty → delivery is a no-op (log-only). */
  url?: string
  /** SSRF host allowlist (exact-or-suffix match). Empty/unset → any public host. */
  allowlist?: string[]
}

/**
 * Deployment config supplied as a typed, user-owned object - `repoaccess.config.ts` handed to
 * `createWorker({ config })` (request path) and `createAccessWorkflow(config, adapters)` (Workflow path).
 * SECRETS are NOT here - they
 * stay in the runtime env: `GITHUB_TOKEN`, the adapters' `*_WEBHOOK_SECRET`, and the optional
 * `EVENT_WEBHOOK_SECRET`.
 */
export interface RepoAccessConfig {
  /** GitHub org that grants/revokes target. (was the `GITHUB_ORG` var) */
  githubOrg: string
  /** Product→team map as a typed object. (was the `PRODUCT_TEAM_MAP` JSON-string var) */
  productTeamMap: ProductTeamMap
  /** Claim-page branding; optional - the controller fills neutral defaults. (was `CLAIM_BRAND_*`) */
  branding?: Partial<Branding>
  /** Outbound event delivery; optional/opt-in. (was `EVENT_WEBHOOK_URL` / `EVENT_WEBHOOK_ALLOWLIST`) */
  eventWebhook?: EventWebhookConfig
  /**
   * Optional settings for the synthetic end-to-end check (dev/setup tooling only - never
   * read on the request or Workflow path). `testUsername` MUST be a GitHub account the maintainer
   * OWNS: the test sends it a real org/team invite and then cancels it. `productId` optionally pins
   * which product mapping to grant into (omitted -> the first Stripe product that maps to a team);
   * `url` is the deployed worker URL to hit (the setup supplies it from the resolved URL); `secretPath`
   * is the `/wh/stripe/:path` segment (unvalidated for HMAC, defaults to `webhook`).
   */
  e2e?: {
    testUsername?: string
    productId?: string
    url?: string
    secretPath?: string
  }
}

export interface NormalizedEvent {
  event_type: 'payment_success' | 'refund' | 'chargeback'
  product_id: string
  /** Stable correlation key - identical across an order and its later refund/chargeback. */
  transaction_id: string
  buyer_email: string | null
  github_username: string | null
  /** Refund events only: true=full, false=partial, null=n/a. */
  is_full_refund: boolean | null
  /**
   * An id the merchant's post-checkout redirect will carry when it differs from transaction_id
   * (e.g. Stripe checkout session id cs_..., while transaction_id is the payment_intent pi_...).
   * Used to alias-resolve /claim/by-txn. Unset when the redirect id IS the transaction_id.
   */
  redirect_alias_id?: string
}

export interface RawRequest {
  /** Byte-exact body - HMAC verification breaks on re-serialization. */
  bodyText: string
  /** Parsed form body for form-urlencoded adapters. */
  bodyForm?: URLSearchParams
  headers: Headers
}

/**
 * The adapter's API-fetched entity under `api_callback` - opaque to core; shape is adapter-defined.
 * Under api_callback the inbound payload is never trusted; grant decisions read ONLY this verified entity.
 */
export type VerifiedEntity = Record<string, unknown>

export type VerificationStrategy =
  | {
      kind: 'hmac'
      algo: 'SHA-256' | 'SHA-512'
      /**
       * The signing secret, read from the runtime env. The adapter is self-describing about which
       * var holds it - e.g. `(env) => env.STRIPE_WEBHOOK_SECRET`. Returns `undefined`
       * when unset → the engine rejects. (Contract extension over the original base contract - the pinned shape had
       * no way for the generic engine to obtain the per-adapter key.)
       */
      secret(env: CloudflareBindings): string | undefined
      /** Canonical string to sign: raw body | `ts:body` | manifest template. */
      canonical(raw: RawRequest): string
      /**
       * Pull the signature(s) + optional timestamp from the headers. `signature` may be an array
       * when a provider sends multiple candidates (e.g. Stripe `v1` during secret rotation) - the
       * engine accepts a match against ANY.
       */
      extract(headers: Headers): { signature: string | string[]; ts?: string }
      /** Replay tolerance in seconds, where the provider supplies a timestamp. */
      toleranceSec?: number
    }
  | {
      kind: 'api_callback'
      /**
       * The validated path credential, read from the runtime env - the adapter self-describes its
       * var, e.g. `(env) => env.<NAME>_WEBHOOK_PATH` (mirrors hmac's `secret()`). There is no
       * signature on the ack path for api_callback adapters, so the route timing-safe-compares the
       * `:secret_path` URL segment against this value BEFORE enqueueing - it is the first-line
       * credential that replaces HMAC. Returns `undefined` when unset → the route rejects
       * (fail-closed).
       */
      secretPath(env: CloudflareBindings): string | undefined
      /**
       * Fetch the authoritative entity from the provider's API. Runs as a durable, retriable Workflow
       * step (NOT on the ack path - it is outbound I/O, and a provider's API round-trip on the ack path
       * is what pushes an ack past the provider's own retry window). The inbound
       * ping body is NEVER trusted; the grant is mapped from this returned entity. `null` → terminal
       * reject (a forged/unknown id 404s here).
       */
      fetchEntity(
        raw: RawRequest,
        env: CloudflareBindings,
      ): Promise<VerifiedEntity | null>
    }
  | {
      kind: 'shared_secret_header'
      /**
       * Name of the request header carrying the shared secret the provider echoes on every webhook
       * (a fixed header the provider is configured to set once and then sends on every delivery). The
       * engine reads THIS header and timing-safe compares it against `secret`.
       */
      header: string
      /**
       * The expected secret, read from the runtime env - self-describing about which var holds it,
       * exactly like hmac's `secret()` (e.g. `(env) => env.<NAME>_WEBHOOK_SECRET`). Returns
       * `undefined` when unset → the engine rejects (fail-closed). The secret authenticates the
       * TRANSPORT: once the header matches, the inbound body is authentic and the grant reads it
       * directly - there is no signature to check (nothing is signed) and no entity to re-fetch (the
       * update IS the authoritative record). The third taxonomy kind, additive over `hmac` /
       * `api_callback`.
       */
      secret(env: CloudflareBindings): string | undefined
    }

export interface PaymentAdapter {
  /** Adapter id used in the route `/wh/:adapter/...` and the Workflow instance id. */
  name: string
  verification: VerificationStrategy
  /**
   * Normalize the raw request into an event, or `null` (hmac/shared_secret_header → route 400;
   * api_callback → terminal access.failed "unhandled"). The optional `entity` is the API-fetched,
   * trusted entity, supplied ONLY on the api_callback path (fetched inside the Workflow). hmac and
   * shared_secret_header adapters ignore it and keep working unchanged. Under api_callback, map the
   * grant from `entity` - never from `raw` (the ping is untrusted).
   */
  parse(raw: RawRequest, entity?: VerifiedEntity): NormalizedEvent | null
  /**
   * OPTIONAL interactive-handshake hook. When present, the router delegates a verified request to it
   * BEFORE `parse` (only ever AFTER verification has passed - it can never bypass auth): a returned
   * `Response` IS the ack (the router returns it, no enqueue), `null` falls through to the normal
   * `parse → enqueue` path. It exists for providers whose webhook carries handshake steps as well as
   * terminal events - e.g. an interactive pre-charge query the adapter must answer (its own bounded
   * outbound call) before the terminal payment event arrives and flows through `parse`. Every existing
   * adapter omits it and is unaffected.
   */
  handle?(raw: RawRequest, env: CloudflareBindings): Promise<Response | null>
}

/**
 * The raw, UNVERIFIED ping enqueued for an `api_callback` adapter. The Workflow fetches the
 * authoritative entity (never trusting this body) and parses the event from it. Carried instead of
 * a `NormalizedEvent` because, for api_callback, there is nothing to parse on the ack path - the
 * event isn't known until the entity is fetched in a durable step.
 */
export interface ApiCallbackPing {
  /** The ping body byte-exact (the adapter derives its lookup id from this / `form`). */
  bodyText: string
  /** Parsed form fields (form-urlencoded ping); rebuilt into `URLSearchParams` in the Workflow. */
  form: Record<string, string>
}

/**
 * Params handed to `AccessWorkflow` on enqueue (internal - not part of the adapter contract).
 * Exactly one of `event` / `ping` is set:
 *   - `event` - the hmac path: `parse()` already ran on the (fast, local) ack path.
 *   - `ping`  - the api_callback path: the Workflow fetches the entity + parses (outbound I/O kept
 *     off the ack path). Grant vs revoke is then derived from the resolved `event.event_type`.
 */
export interface AccessWorkflowParams {
  adapter: string
  event?: NormalizedEvent
  ping?: ApiCallbackPing
  /**
   * Set by claim completion. Forces `username` grant mode - the product's configured mode is
   * `claim`, which would otherwise loop back into another claim - and makes the grant emit
   * `claim.completed` on success. The handle is validated at the claim POST before enqueue.
   */
  from_claim?: boolean
  /**
   * How this instance was authorized (see `GrantOrigin`). Set by whoever enqueues; the worker's own
   * webhook route sets `webhook` at both of its enqueue sites, and a claim completion carries forward
   * whatever authorized the payment that minted the claim.
   *
   * Leaving it unset is not the same thing everywhere, so set it if you know it. On a DIRECT enqueue
   * an absent value is itself an answer and the Workflow records `rpc`; on a claim completion
   * (`from_claim`) it is not, and the Workflow records nothing rather than inventing one.
   */
  origin?: GrantOrigin
}

/**
 * How a grant was authorized. It reaches the grant RECORD and every event the instance emits, so a
 * seller can reconcile by channel, tell which channel produced a grant when their funnel misbehaves,
 * and see the direct-call path in an incident. Two values, and the distinction is the trust boundary
 * each one crossed:
 *
 *   - `webhook` - a provider webhook that PASSED verification. Signature, shared-secret header, or a
 *     validated secret path plus the authoritative entity fetch: an `api_callback` still arrives over
 *     HTTP from the provider, so it is this one.
 *   - `rpc` - a direct programmatic enqueue by a caller on the same Cloudflare account. There is no
 *     provider event and no signature; the binding IS the authorization.
 */
export type GrantOrigin = 'webhook' | 'rpc'
