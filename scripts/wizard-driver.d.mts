// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Gary Stupak

// Types for the zero-dep setup-wizard driver (scripts/wizard-driver.mjs). Colocated so `tsc --noEmit`
// (and the driver test) get the contract without shipping types to consumers - scripts/ is excluded
// from the npm `files` allowlist. Keep in sync with wizard-driver.mjs.

export type WizardEnv = 'sandbox' | 'production'
export type WizardGoal = 'full' | 'quick'
export type RevokePolicy = 'auto_revoke' | 'log_only'

export const ENVS: readonly WizardEnv[]
export const GOALS: readonly WizardGoal[]
export const QUICK_PRODUCT_ID: string
export const DONE: string
export const SCREEN_IDS: readonly string[]
export const STATE_FILE: string
/** The one command a human types to begin a run. Records never emit it - there is no record yet. */
export const START_COMMAND: string

/** One selectable option of a closed choice. The set is known, so the user never hand-types a token. */
export interface ChoiceOption {
  value: string
  label: string
  description: string
  /** The literal call that answers with this option - always `answer ` + `value`, never composed. */
  command: string
}

/**
 * The step this screen will drive, and the env it runs under. Phase 1 emits it but does not execute it:
 * an auto-step that reports "OK" without checking is a false green, so the execution and its verify
 * attach here together.
 */
export interface RecordAction {
  step: string
  env: WizardEnv | null
}

/** One known failure mode, rendered as `_(when)_ text`. */
export interface RecoveryMode {
  when: string
  text: string
}

/** The ONE record a driver call emits. The agent renders it verbatim and feeds the answer back. */
export interface WizardRecord {
  id: string
  /** `recovery` is emitted when a verify fails or the human asks a question; it never advances. */
  type: 'say' | 'ask' | 'do' | 'recovery'
  /** Set on `ask` only: a closed choice, or a named free-text field read off a dashboard. */
  kind?: 'choice' | 'text'
  env: WizardEnv | null
  goal: WizardGoal | null
  /** Absent on `recovery`, which carries `modes` instead. */
  text?: string
  /** Present on every closed choice, never on free text. */
  options?: ChoiceOption[]
  /** A trailing aside rendered under the options. */
  note?: string
  /** The answer's name in the driver's state. */
  field?: string
  action?: RecordAction
  /** `recovery` only: the known failure modes for this step. */
  modes?: RecoveryMode[]
  /** `recovery` only: the live reason this verify failed, from the failing check's own fix. */
  detail?: string
  /** `recovery` only: the step the human returns to. Never the next step. */
  retry?: string
  /**
   * The literal next invocation, so the agent COPIES a string instead of COMPOSING a shell command.
   * One of three bare-word forms: `next`, `answer YOUR-ANSWER`, `answer done`. Shell-neutral by
   * construction - no `--` (PowerShell consumes it), no quotes, byte-identical in PowerShell and bash.
   */
  command: string
}

/** The result of a step's verify. `owner` is the screen that owns the wrong input. */
export interface VerifyResult {
  ok: boolean
  owner?: string
  detail?: string
  check?: string
  flags?: Record<string, unknown>
}

/**
 * Everything that touches the network, the filesystem or a child process. Tests pass fakes, so no
 * verify needs a live agent, GitHub, or wrangler - and config-write runs against a temp cwd.
 */
export interface DriverDeps {
  cwd?: string
  run?: (args: string[]) => { ok: boolean; stdout: string; stderr: string }
  preflight?: (opts: unknown) => unknown
  githubVerify?: (opts: unknown) => unknown
  secretsCheck?: (opts: unknown) => unknown
  deploy?: (opts: unknown) => unknown
  /** The deploy's /health half alone: how a retry over an already-published worker re-probes it. */
  deployHealth?: (opts: unknown) => unknown
  e2e?: (opts: unknown) => unknown
  resolveUrl?: (opts: unknown) => unknown
  /** Existence probe over the ANSWERED workers.dev subdomain, before anything is wired to it. */
  subdomainCheck?: (opts: unknown) => unknown
  kvCreate?: (opts: unknown) => unknown
  /** Reads the REMOTE grant records, so a refund screen can name the exact `pi_...` to refund. */
  grantRecord?: (opts: unknown) => unknown
  readToken?: (env: StepEnv) => string | null
  createApi?: (token: string) => { get(path: string): Promise<unknown> }
  /** Repo-relative. `null` when the file does not exist. */
  readFile?: (path: string) => string | null
  writeFile?: (path: string, text: string) => void
  readWranglerConfig?: () => Record<string, unknown> | null
  /** The arrival pause before the synthetic check. Injected so tests never spend its 45 seconds. */
  sleep?: (ms: number) => Promise<void>
  /** The typo handle's randomness. Injected so tests pin a deterministic handle. */
  random?: () => number
}

/**
 * The env as the wizard.mjs STEP FUNCTIONS speak it: `null` is sandbox everywhere downstream, and their
 * CLI collapses the word `sandbox` to null on the way in. The driver carries the human's word
 * ('sandbox') and translates at the seam - see `stepEnv`.
 */
export type StepEnv = 'production' | null

/** 4b2's answer. Both options confirm Base permissions; only the optional repo attach differs. */
export type RepoAttached = 'attached' | 'skipped'
/** E6's answer: whether the optional typo/claim test was taken. */
export type TypoTest = 'test' | 'skip'

export interface WizardAnswers {
  env?: WizardEnv
  goal?: WizardGoal
  org?: string
  team?: string
  testBuyer?: string
  domain?: string
  subdomain?: string
  productId?: string
  revokePolicy?: RevokePolicy
  /** Sandbox only - a production run is told to attach the repo, so it has nothing to record. */
  repoAttached?: RepoAttached
  /** Offered on a full `auto_revoke` run only; arms the closing's claim-path clause. */
  typoTest?: TypoTest
}

export interface WizardState {
  /** The screen the run is on; `null` once the run is complete. */
  cursor: string | null
  answers: WizardAnswers
  /** What the driver RESOLVED by running something, as opposed to what the human answered. */
  flags: {
    /**
     * The workers.dev subdomain the account SUGGESTS, resolved by screen 5's arrival probe and offered as
     * a default for the deployer to confirm. Never wired to anything: the value the run uses is the
     * ANSWER. `null` when the account yields no candidate, which only changes which question is asked.
     */
    subdomainCandidate?: string | null
    /** Resolved by the preflight probe's real `wrangler whoami`. */
    cloudflareSignedIn?: boolean
    account?: string | null
    /** A blocking preflight check other than the login; its fix is what the deployer reads. */
    preflightBlocker?: string | null
    /** resolve-url's outputs. `secretPath` is persisted because the step regenerates it per call. */
    workerUrl?: string
    secretPath?: string
    /**
     * The address the deploy step really published to, set only once its `wrangler deploy` succeeded and
     * a base resolved. Distinct from `workerUrl`, which is what the run PREDICTED. Its presence is what
     * makes a retry over a parked deploy re-probe `/health` instead of deploying a second time.
     */
    deployedUrl?: string
    /**
     * The refundable payments already in the REMOTE store before this run bought anything, snapshotted
     * on arrival at the purchase screen. Empty when the store was empty AND when it could not be read:
     * subtracting an empty baseline is the identity, so either way the refund screens are left with the
     * rule they had before the snapshot existed - name a payment only when the store holds one.
     */
    grantBaseline?: string[]
    /**
     * The `pi_...` of the purchase a refund screen names, resolved by the grant-record probe on arrival
     * as the one id the baseline above does not hold. `null` when the lookup could not single one out -
     * the screen then describes the payment instead of naming it, and never gates on this.
     */
    piId?: string | null
  }
  /** Set when a verify failed or the human asked a question; `currentRecord` then emits recovery. */
  recovery?: { detail?: string | null } | null
  /**
   * The screen whose step an ARRIVAL verify already ran and measured. The four autonomous says report a
   * result, so their step runs on arrival and the say is emitted only on a pass; this records that pass
   * so advancing off the say does not run the step a second time. Scoped to the current cursor.
   */
  verifiedAt?: string | null
}

/** An answer that did not fit the record that asked for it - a contract violation, not a setup fault. */
export class DriverError extends Error {
  /** The form to call again with: a rejected answer moves nothing, so it is the same one that asked. */
  command?: string | null
}

export function initialState(): WizardState
export function isComplete(state: WizardState): boolean
export function currentRecord(state: WizardState): WizardRecord
export function advance(
  state: WizardState,
  answer?: string | null,
  deps?: DriverDeps,
): Promise<WizardState>
export function sequence(state: WizardState): string[]
export function envOf(state: WizardState): WizardEnv | null
export function goalOf(state: WizardState): WizardGoal | null
export function facts(state: WizardState): Record<string, string>
export function productIdFor(state: WizardState): string | null
export function fill(text: string, factsMap: Record<string, string>): string
/** `nouser-` plus 12 random base36 characters. Pass `random` to pin the handle in a test. */
export function makeTypoHandle(random?: () => number): string
export function defaultDeps(cwd?: string): DriverDeps
export function draftConfig(state: WizardState): Record<string, unknown>
export function ownerForCheck(name: string): string
export function stepEnv(state: WizardState): StepEnv

/** The two files config-write generates. Both are gitignored - they are the deployer's, not the repo's. */
export const CONFIG_PATH: string
export const WRANGLER_PATH: string

/** Render a value as TS/JSON source. Every deployer-supplied value goes through this, as DATA. */
export function emitValue(value: unknown, indent?: string): string
/** The config object for ONE profile, exactly as the worker will read it. */
export function profileConfig(state: WizardState): Record<string, unknown>
/** Replace `export const <name>: RepoAccessConfig = <RHS>`. `null` = slot not found/not recognised. */
export function setProfile(
  text: string,
  name: string,
  rhs: string,
): string | null
/** Fill this run's profile, leaving the other profile's bytes exactly where they were. */
export function generateConfig(text: string, state: WizardState): string | null
/** Point this env's ENTITLEMENTS binding at `id`. `null` = the slot was not uniquely locatable. */
export function setKvId(
  text: string,
  env: WizardEnv | null,
  id: string,
): string | null
/** Wire the production custom-domain route (commented template block, or a live one). */
export function setProductionRoute(text: string, domain: string): string | null
export function generateWrangler(
  text: string,
  state: WizardState,
  kvId: string,
): { text?: string; error?: string }
export function resolveKvId(state: WizardState, deps: DriverDeps): string | null
export function teamMembership(
  api: { get(path: string): Promise<unknown> },
  org: string,
  team: string,
  username: string,
): Promise<'pending' | 'active' | 'none' | null>
export function main(
  argv: string[],
  cwd?: string,
  deps?: DriverDeps,
): Promise<WizardRecord | { done: true }>

export function readState(cwd?: string): WizardState | null
export function writeState(state: WizardState, cwd?: string): void
export function clearState(cwd?: string): void
export function parseDriverArgs(rest?: string[]): {
  start?: boolean
  next?: boolean
  answer?: string
}
