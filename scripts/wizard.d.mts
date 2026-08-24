// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Gary Stupak

// Types for the zero-dep wizard build script (scripts/wizard.mjs). Colocated so `tsc --noEmit`
// (and the wizard test) get the contract without shipping types to consumers - scripts/ is
// excluded from the npm `files` allowlist. Keep in sync with wizard.mjs.

export interface WizardCheck {
  name: string
  ok: boolean
  fix?: string
  // Informational note about HOW the check passed, kept OFF the name so the name is a stable identity.
  // Used by ensureSecretsFiles to report a secrets file was just created from its template without the
  // check name changing (a name that flipped on work-done broke a fresh clone's first `npm test`).
  detail?: string
  // 'warn' = advisory: surfaced in the JSON but excluded from the step's ok aggregate. Default 'error'.
  severity?: 'error' | 'warn'
  // Set by resolve-url when a check is blocked on an interactive value the orchestrator must ask for
  // ('subdomain' | 'prod-domain'). The check is ok:false, but the flag tells the orchestrator to ask
  // rather than treat it as a failure.
  needsInput?: string
}

export interface ResolvedWorkerUrl {
  base: string
  webhookUrl: string
  secretPath: string
}

export interface GrantRecordEntry {
  adapter: string
  transactionId: string
}

export interface WizardResult {
  step: string
  ok: boolean
  // Names the aggregate in the step's own words: 'ok' when every non-advisory check passed, 'failed' when
  // one did (its checks say what to fix). Tracks `ok`.
  outcome: 'ok' | 'failed'
  checks: WizardCheck[]
  next: string
  // Attached by resolve-url when a base URL resolves: the predictable base, the full Stripe webhook
  // URL, and the raw secret_path (separately, so the orchestrator can offer it as a memory-aid line).
  resolved?: ResolvedWorkerUrl
  // Attached by grant-record: the grant records parsed from the REMOTE ENTITLEMENTS store, each with
  // its adapter and transaction_id (the `pi_...` for Stripe).
  grants?: GrantRecordEntry[]
  // Attached by deploy once the wrangler half has succeeded and a base resolved: the address the health
  // check probed. Its presence is what tells a caller there is a published worker to RE-PROBE, rather
  // than a deploy to repeat.
  url?: string
}

export interface StepOptions {
  cwd?: string
}

export interface CommandResult {
  ok: boolean
  status: number | null
  stdout: string
  stderr: string
}

export interface GithubResponse {
  status: number
  json: any
  headers?: { get(name: string): string | null }
}

export interface GithubApi {
  get(path: string): Promise<GithubResponse>
}

export interface GithubVerifyOptions extends StepOptions {
  config?: unknown
  api?: GithubApi
  token?: string
  fetch?: typeof fetch
  env?: string | null
}

// doctor is the offline check-env core PLUS an optional test-buyer isolation add-on (the same check
// github-verify runs) when the config declares an e2e.testUsername. The api/token/fetch/config seams
// make that add-on mock-testable; a neutral config is a no-op and doctor stays offline there.
export interface DoctorOptions extends StepOptions {
  env?: string | null
  config?: unknown
  api?: GithubApi
  token?: string
  fetch?: typeof fetch
}

export interface RequiredSecrets {
  base: string[]
  production: string[]
}

export interface SecretListResult {
  ok: boolean
  names?: string[]
}

export interface SecretsCheckOptions extends StepOptions {
  required?: RequiredSecrets
  readNames?: (fileName: string) => string[] | null
  listSecrets?: () => SecretListResult
  // 'production' runs the .dev.vars.production local + deployed-worker checks; anything else (sandbox)
  // checks only .dev.vars (the base names).
  env?: string | null
}

export type WranglerRunner = (args: string[]) => CommandResult

export interface HealthResult {
  ok: boolean
  // 0 is the marker for "the request threw before any HTTP response existed", so nothing left this
  // machine and Cloudflare was never asked. Any other value is a status Cloudflare really returned.
  status: number
  body: any
  // What threw, on the status-0 branch only. Node's fetch reports a bare "fetch failed" and puts the
  // half worth reading in `cause`, so both are carried.
  error?: string
}

export interface KvCreateOptions extends StepOptions {
  config?: any
  run?: WranglerRunner
  // ENV-AWARE (same source as deploy / secrets-check): 'production' reconciles only the production
  // <worker>-production-ENTITLEMENTS namespace; anything else (sandbox) reconciles only the sandbox one.
  env?: string | null
}

export interface GrantRecordOptions extends StepOptions {
  run?: WranglerRunner
  // ENV-AWARE (same source as deploy / kv-create): 'production' forwards `--env production`; anything
  // else (sandbox) reads the top-level binding. `--remote` is always sent (the deployed worker writes
  // the REMOTE store).
  env?: string | null
}

export interface DeployOptions extends StepOptions {
  env?: string | null
  config?: any
  run?: WranglerRunner
  fetchHealth?: (url: string) => HealthResult | Promise<HealthResult>
  // Expected base URL (from resolve-url) for the advisory post-deploy URL-match warning AND the
  // health-check fallback when a custom-domain deploy prints no workers.dev URL.
  expectBase?: string
  // /health retry seams. A production (custom-domain) deploy WAITS (preProbeDelay) before its first probe
  // so an eager lookup does not poison the deployer's DNS cache with a negative answer, then retries slowly
  // and few times; sandbox waits briefly for edge propagation and retries a few times, so the script owns
  // the retry rather than the agent improvising one. All mock-testable with no waiting.
  //
  // TWO budgets, split by what the failure MEANS rather than by whether an HTTP status exists.
  // `propagatingAttempts` governs the not-yet failures - status 0 (the request never left the machine, so
  // the name does not resolve) and 404 (Cloudflare's edge answered about a hostname no worker is bound to
  // yet) - both stages of one deploy still arriving, and both fixed only by waiting. `healthAttempts`
  // governs every other answered status, which is a worker that IS serving and will say the same thing on
  // the next try. Sandbox is the one that differs (3 answered, 6 not-yet); production runs both at 5,
  // because its 30s pause plus few probes IS the negative-cache mitigation.
  healthAttempts?: number
  propagatingAttempts?: number
  preProbeDelay?: number
  sleep?: (ms: number) => Promise<void>
  // Human-facing notice channel (default: stderr) for the pre-probe pause, so the stdout JSON stays clean.
  notify?: (message: string) => void
}

// No `envVars` seam: resolve-url reads no environment variable, so `domain` / `subdomain` - both ASKED
// of the deployer and passed back in - are the only way to supply its inputs.
export interface ResolveUrlOptions extends StepOptions {
  env?: string | null
  config?: any
  domain?: string
  subdomain?: string
  secretPath?: string
  rand?: (size: number) => Buffer
}

// The existence probe over an ANSWERED subdomain. `fetchHealth` is the same seam the deploy check uses,
// so a test drives the ENOTFOUND / HTTP-answer distinction with no network.
export interface SubdomainCheckOptions extends StepOptions {
  config?: any
  subdomain?: string
  fetchHealth?: (url: string) => Promise<HealthResult>
}

export interface E2eProduct {
  productId: string
  teams: string[]
}

/**
 * The four provider-specific facts the synthetic check needs, supplied BY THE CALLER.
 *
 * Core defines this seam and exactly one pack - Stripe's. A downstream composing other adapters
 * passes its own, so no other provider's event shape, secret name, signature scheme or route has to
 * enter core to make that provider testable.
 */
export interface E2ePack {
  /**
   * The ADAPTER SEGMENT, load-bearing in three places: the `/wh/<segment>/<secret_path>` route, the
   * `grant:<segment>:<txn>` KV key the cleanup deletes, and the `productTeamMap` key the target
   * product resolves from.
   */
  webhookPath: string
  /** The secret's NAME (never a value); read from the run's secrets file and used only in a header. */
  secretName: string
  /** Build the event to sign and send. */
  buildEvent(args: {
    productId: string
    username: string
    transactionId: string
  }): unknown
  /** Both halves are provider-specific: the header NAME as much as the signing scheme. */
  signatureHeader(
    body: string,
    secret: string,
    timestamp: number,
  ): { name: string; value: string }
}

export interface E2eOptions extends StepOptions {
  config?: any
  // ENV-AWARE (same source as the other steps): 'production' selects the production config profile and
  // reads the pack's secret + GITHUB_TOKEN from .dev.vars.production; anything else (sandbox) uses the
  // sandbox profile and .dev.vars.
  env?: string | null
  username?: string
  url?: string
  /** Omit for the built-in Stripe pack. A supplied pack is taken WHOLE, never merged over the default. */
  pack?: E2ePack
  /** The signing secret, pack-neutral spelling. Overrides the secrets-file read. */
  secret?: string
  /** The original spelling of `secret`, still honoured - every pre-pack caller passes this one. */
  stripeSecret?: string
  githubToken?: string
  fetch?: typeof fetch
  // The wrangler seam for the post-run KV cleanup (delete the synthetic grant record). Same runner the
  // mutating steps use; tests inject a mock so no real wrangler is spawned.
  run?: WranglerRunner
  transactionId?: string
  timestamp?: number
  pollAttempts?: number
  pollIntervalMs?: number
  sleep?: (ms: number) => Promise<void>
}

export interface SecretsFilesSeams {
  exists?: (path: string) => boolean
  copy?: (src: string, dst: string) => void
  // sandbox (null/undefined) creates only .dev.vars; 'production' creates only .dev.vars.production.
  env?: string | null
}

// Config-as-code + wrangler template copy: not env-aware (one config module carries both profiles, one
// wrangler.jsonc carries both environments), so no `env` seam - just exists/copy.
export interface ConfigFilesSeams {
  exists?: (path: string) => boolean
  copy?: (src: string, dst: string) => void
}

export interface PreflightOptions extends StepOptions, SecretsFilesSeams {
  run?: WranglerRunner
}

// Third arg to readSecretValue / readToken: env selects the secrets VALUE file; processEnv overrides
// the process env source (tests pass an empty object to force the file to be consulted).
export interface SecretReadOptions {
  env?: string | null
  processEnv?: Record<string, string | undefined>
}

export const MIN_NODE_VERSION: string
// The one npm script the setup exposes; the driver imports these step functions and calls them directly.
export const WIZARD_DRIVER_SCRIPT: string
export const BROWSER_UA: string

export function nodeSupportsTsImport(version?: string): boolean
export function runCommand(
  command: string,
  args?: string[],
  options?: Record<string, unknown>,
): CommandResult
export function resolveBin(
  name: string,
  opts?: { cwd?: string; env?: Record<string, string | undefined> },
): string | null
export function createGithubApi(
  token: string,
  fetchImpl?: typeof fetch,
): GithubApi
export function selectConfig(
  mod: Record<string, unknown>,
  env?: string | null,
): unknown
export function collectTeams(config: unknown): string[]
export function parseJsonc(text: string): any
export function readWranglerConfig(cwd?: string): any
export function readRequiredSecrets(cwd?: string): RequiredSecrets | null
export function readEnvNames(path: string): string[] | null
export function secretsFileFor(env: string | null | undefined): string
export function readSecretValue(
  name: string,
  cwd?: string,
  opts?: SecretReadOptions,
): string | null
export function readToken(cwd?: string, opts?: SecretReadOptions): string | null
export function buildE2eEvent(args: {
  productId: string
  username: string
  transactionId: string
}): any
export function stripeSignatureHeader(
  body: string,
  secret: string,
  timestamp: number,
): string
/** The built-in default pack, extracted from the literals `e2e` used to carry inline. */
export const STRIPE_E2E_PACK: E2ePack
/** The pack a run will use: the caller's (validated whole) or Stripe's. `error` names what is missing. */
export function resolveE2ePack(pack?: E2ePack | null): {
  pack?: E2ePack
  error?: string
}
export function resolveE2eProduct(
  config: any,
  adapter?: string,
): E2eProduct | null
export function kvTitle(
  workerName: string,
  env: string | null,
  binding: string,
): string
export function wranglerError(res: Partial<CommandResult> | null): string
export function extractWorkerUrl(text: string): string | null
export function defaultFetchHealth(
  url: string,
  doFetch?: typeof fetch,
): Promise<HealthResult>
export function healthEvidence(health: HealthResult | null, url: string): string
export function sameWorkerHost(a: string, b: string): boolean
export function isValidHostname(host: unknown): boolean
export function generateSecretPath(rand?: (size: number) => Buffer): string
export function customDomainPattern(
  config: any,
  env: string | null,
): string | null
export function slugifySubdomain(name: unknown): string | null
export function parseWhoamiAccount(
  stdout: unknown,
): { name: string; id: string } | null
export function whoamiEmailLocalPart(stdout: unknown): string | null
// A SUGGESTION for the subdomain question, never an answer - see the step for why nothing here can be
// more than that.
export function deriveSubdomain(args: {
  explicit?: string | null
  run?: WranglerRunner
}): { subdomain: string; method: string } | null
export const SUBDOMAIN_DASHBOARD_ROUTE: string
export function subdomainCheck(
  opts?: SubdomainCheckOptions,
): Promise<WizardResult>
export function resolveUrl(opts?: ResolveUrlOptions): WizardResult
export function checkEnv(opts?: StepOptions): WizardResult
export function doctor(opts?: DoctorOptions): Promise<WizardResult>
export function testBuyerCheck(
  api: GithubApi,
  org: string,
  testUsername: string | null | undefined,
): Promise<WizardCheck | null>
export function ensureSecretsFiles(
  cwd?: string,
  seams?: SecretsFilesSeams,
): WizardCheck[]
export function ensureConfigFiles(
  cwd?: string,
  seams?: ConfigFilesSeams,
): WizardCheck[]
export function cloudflareAuthCheck(run: WranglerRunner): WizardCheck
export function preflight(opts?: PreflightOptions): WizardResult
export function githubVerify(opts?: GithubVerifyOptions): Promise<WizardResult>
export function secretsCheck(opts?: SecretsCheckOptions): WizardResult
export function kvCreate(opts?: KvCreateOptions): WizardResult
export function grantRecord(opts?: GrantRecordOptions): WizardResult
export function deploy(opts?: DeployOptions): Promise<WizardResult>
/**
 * The /health half of `deploy`, callable on its own so a retry over an already-published worker
 * re-probes instead of deploying a second version of it. Same check, same name, same budgets.
 * Pass `preProbeDelay: 0` when the caller's own recovery has already spent the deployer's minutes.
 */
export function deployHealth(
  opts?: DeployOptions & { url?: string },
): Promise<WizardResult>
export function e2e(opts?: E2eOptions): Promise<WizardResult>
