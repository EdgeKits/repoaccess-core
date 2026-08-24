// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Gary Stupak

import { describe, it, expect } from 'vitest'
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseJsonc, customDomainPattern } from '../scripts/wizard.mjs'
import {
  initialState,
  currentRecord,
  advance,
  isComplete,
  sequence,
  fill,
  facts,
  productIdFor,
  makeTypoHandle,
  parseDriverArgs,
  readState,
  writeState,
  STATE_FILE,
  main,
  DriverError,
  QUICK_PRODUCT_ID,
  SCREEN_IDS,
  stepEnv,
  emitValue,
  setProfile,
  setKvId,
  setProductionRoute,
  CONFIG_PATH,
  WRANGLER_PATH,
} from '../scripts/wizard-driver.mjs'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
import type {
  WizardRecord,
  WizardEnv,
  WizardGoal,
  WizardAnswers,
  WizardState,
  RevokePolicy,
  ChoiceOption,
} from '../scripts/wizard-driver.mjs'

// A complete, valid set of answers for a run. The tests drive the machine with these, so every
// assertion below is about a record the driver really emitted in sequence - never a hand-built one.
const ANSWERS: Required<
  Pick<
    WizardAnswers,
    | 'org'
    | 'team'
    | 'testBuyer'
    | 'domain'
    | 'subdomain'
    | 'productId'
    | 'revokePolicy'
    | 'repoAttached'
    | 'typoTest'
  >
> = {
  org: 'acme',
  team: 'pro',
  testBuyer: 'octocat-test',
  domain: 'access.example.com',
  subdomain: 'acme-dev',
  productId: 'prod_ABC123',
  revokePolicy: 'auto_revoke',
  repoAttached: 'attached',
  // The default run TAKES the optional typo test, so the E6 choreography is walked by every full-run
  // assertion below rather than only by the tests that name it. A `skip` run is driven explicitly.
  typoTest: 'test',
}

function answerFor(
  record: WizardRecord,
  answers: WizardAnswers,
): string | null {
  if (record.type === 'say') return null
  if (record.type === 'do') return 'done'
  const value = answers[record.field as keyof WizardAnswers] as
    string | undefined
  // A closed choice falls back to its first option, so a run the test did not pin still walks.
  if (record.kind === 'choice') return value ?? record.options![0].value
  if (value === undefined) {
    throw new Error(`test has no answer for field '${record.field}'`)
  }
  return value
}

const WHOAMI_OK = `
 ------------------------------------------------------
| Account Name        | Account ID                       |
| acme-co             | 0123456789abcdef0123456789abcdef |
 ------------------------------------------------------
`

// What resolve-url really returns: a base, the webhook URL built from it, and a secret_path it
// regenerates on every call unless one is passed back in. The fake honours that last part, because the
// driver persisting the path is exactly what the tests below check.
const SANDBOX_BASE = 'https://repoaccess-core.acme-dev.workers.dev'
const PROD_BASE = 'https://access.example.com'
const FAKE_SECRET_PATH = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'

const NEEDS_DOMAIN = {
  checks: [
    {
      name: 'production custom domain',
      ok: false,
      needsInput: 'prod-domain',
      fix: 'Core has no custom_domain route - provide the production domain',
    },
  ],
}

const resolveUrlFake =
  (paths: string[] = []) =>
  ({ env, domain, subdomain, secretPath }: Record<string, string | null>) => {
    // A production run learns its domain from the screen's own answer, so on ARRIVAL there is nothing to
    // resolve yet and the real step reports needsInput. The driver resolves again on advance.
    if (env === 'production' && !domain) return NEEDS_DOMAIN
    const base =
      env === 'production'
        ? `https://${domain}`
        : subdomain
          ? `https://repoaccess-core.${subdomain}.workers.dev`
          : SANDBOX_BASE
    // A fresh random path per call unless the caller passed one back - the real step's behaviour, and
    // the reason the driver has to persist it.
    const path = secretPath ?? `${FAKE_SECRET_PATH}${paths.length}`
    paths.push(path)
    return {
      checks: [
        { name: `stripe webhook URL: ${base}/wh/stripe/${path}`, ok: true },
      ],
      resolved: {
        base,
        webhookUrl: `${base}/wh/stripe/${path}`,
        secretPath: path,
      },
    }
  }

/** What the existence probe says about a subdomain Cloudflare really has. */
const SUBDOMAIN_EXISTS = {
  checks: [
    {
      name: 'workers.dev subdomain exists (acme-dev): repoaccess-core.acme-dev.workers.dev answered HTTP 404',
      ok: true,
    },
  ],
}

/** And about one it does not: the DNS lookup found no such name, so nothing may be wired to it. */
const SUBDOMAIN_MISSING = {
  checks: [
    {
      name: 'workers.dev subdomain exists (nope)',
      ok: false,
      fix: 'There is no `nope.workers.dev` - looking up repoaccess-core.nope.workers.dev found no such name',
    },
  ],
}

/**
 * An account `wrangler whoami` says nothing useful about: no `*.workers.dev` host, no login email, no
 * account row. The subdomain question is asked either way - this is the run with no default to offer.
 */
const noSubdomainCandidate = {
  run: (args: string[]) => ({
    ok: true,
    stdout: args.join(' ') === 'kv namespace list' ? kvListStdout : 'nothing',
    stderr: '',
  }),
}

const KV_ID = 'abcdef0123456789abcdef0123456789'
const PROD_KV_ID = '99999999999999999999999999999999'

/** The deployer's own test payment, as grant-record reports it back. */
const REAL_PI = 'pi_3ABC123DEF456'

/** The synthetic check's own grant, which its advisory cleanup may leave behind. Never refundable. */
const E2E_PI = 'pi_e2e_0f1e2d3c4b5a6978'

/** The second purchase, the one the typo test buys and the claim page grants. */
const TYPO_PI = 'pi_7QRSTUV890TYPO'

/**
 * The grants the REMOTE store holds while the run is on `screenId` - the fake store the default world
 * reads. Written as a function of how far the run has got, because a refund screen resolves this run's
 * payment by subtracting a pre-purchase snapshot and a constant store would leave nothing to subtract.
 *
 * The probe for a screen runs while the cursor is still on the screen BEFORE it, which is why this asks
 * "has the run reached X" rather than "is the run on X".
 */
function grantStoreAt(
  screenId: string | null,
  seed: string[] = [],
): { adapter: string; transactionId: string }[] {
  const reached = (id: string) =>
    FULL_SEQUENCE.indexOf(screenId ?? '') >= FULL_SEQUENCE.indexOf(id)
  const ids = [
    ...seed,
    E2E_PI,
    // The purchase's grant, deleted again by the refund E5 walks the deployer through.
    ...(reached('purchase') && !reached('refund') ? [REAL_PI] : []),
    // The claim page's grant, minted by the typo test's second purchase.
    ...(reached('typo-claim') ? [TYPO_PI] : []),
  ]
  return ids.map((transactionId) => ({ adapter: 'stripe', transactionId }))
}

/** A wrangler whose `kv namespace list` reports the convention-titled namespaces. */
const kvListStdout = JSON.stringify([
  { title: 'repoaccess-core-ENTITLEMENTS', id: KV_ID },
  { title: 'repoaccess-core-production-ENTITLEMENTS', id: PROD_KV_ID },
])

// The REAL committed templates - the same bytes `wizard:preflight` copies into place on a fresh clone.
// Seeding the fake disk from them (rather than from a stub that flatters the generator) is what makes
// these tests able to fail: if a template edit removes the KV placeholder or the commented route block,
// the slot is gone and config-write's own re-read check says so here rather than on a deployer's machine.
const CONFIG_TEMPLATE = readFileSync(
  join(REPO_ROOT, 'src/config/repoaccess.config.example.ts'),
  'utf8',
)
const WRANGLER_TEMPLATE = readFileSync(
  join(REPO_ROOT, 'wrangler.jsonc.example'),
  'utf8',
)

/** A fake disk seeded with what preflight leaves behind, so a write is visible to the next read. */
function makeFs(seed: Record<string, string> = {}) {
  const files: Record<string, string> = {
    'src/config/repoaccess.config.ts': CONFIG_TEMPLATE,
    'wrangler.jsonc': WRANGLER_TEMPLATE,
    ...seed,
  }
  return {
    files,
    readFile: (path: string) => files[path] ?? null,
    writeFile: (path: string, text: string) => {
      files[path] = text
    },
  }
}

/**
 * A world where every check passes: GitHub is healthy, the deploy is live, and the buyer moves through
 * invite -> accept -> (revoked | kept) exactly as the policy says. Tests that want a FAILURE override
 * one dep, so the failing check is the only difference from a passing run.
 */
function okDeps(
  cursor: { id: string | null },
  policy: string,
  overrides: Record<string, unknown> = {},
  // What the refund left behind. The default is what a CORRECT run produces for the policy: gone under
  // auto_revoke, still there under log_only. A test that wants E5 to fail flips it.
  refundMembership?: 'active' | 'none',
  // Grants ALREADY in the store when the run starts - what earlier runs on the same namespace left
  // behind. Empty by default; a production store is where it is never empty.
  storeSeed: string[] = [],
): Record<string, unknown> {
  const afterRefund =
    refundMembership ?? (policy === 'log_only' ? 'active' : 'none')
  return {
    run: (args: string[]) => ({
      ok: true,
      stdout: args.join(' ') === 'kv namespace list' ? kvListStdout : WHOAMI_OK,
      stderr: '',
    }),
    preflight: async () => ({
      checks: [
        { name: 'Cloudflare authenticated (wrangler whoami)', ok: true },
      ],
    }),
    resolveUrl: resolveUrlFake(),
    // The default world's account really has the subdomain the deployer answers with.
    subdomainCheck: async () => SUBDOMAIN_EXISTS,
    kvCreate: async () => ({
      checks: [{ name: 'ENTITLEMENTS namespace created (sandbox)', ok: true }],
    }),
    // The REMOTE store as it really CHANGES across a run, keyed on how far the run has got. A fake that
    // answered one constant list would make the pre-purchase snapshot equal to the store's final
    // contents, and every difference-based lookup below would resolve nothing.
    //
    // What it models: the synthetic check's own grant is always present (its cleanup delete is advisory
    // and can fail, so a `pi_e2e_` grant may linger, and naming it would send the deployer to a row with
    // no payment behind it); the purchase adds one grant, E5's refund deletes it, and the typo test's
    // claim page adds another. The store starts otherwise EMPTY here - the dirty-store case is its own
    // test, because it is the one this default cannot show.
    grantRecord: () => {
      const grants = grantStoreAt(cursor.id, storeSeed)
      return {
        // The real step names the env in this check; this fake is not told which env it is under and
        // these runs drive both, so it names the count alone rather than a label that would be false
        // half the time. Nothing reads it - the probe reads `grants`.
        checks: [
          {
            name: `grant records present: ${grants.length}`,
            ok: grants.length > 0,
          },
        ],
        grants,
      }
    },
    readWranglerConfig: () => ({ name: 'repoaccess-core' }),
    ...makeFs(),
    githubVerify: async () => ({ checks: [{ name: 'all good', ok: true }] }),
    secretsCheck: async ({ env }: { env: string | null }) => {
      const file = env === 'production' ? '.dev.vars.production' : '.dev.vars'
      return {
        checks: [
          { name: `GITHUB_TOKEN in ${file}`, ok: true },
          { name: `STRIPE_WEBHOOK_SECRET in ${file}`, ok: true },
        ],
      }
    },
    deploy: async () => ({ checks: [{ name: '/health ok', ok: true }] }),
    // The re-probe seam. A green run never reaches it: the arrival deploy passes, so nothing is parked.
    deployHealth: async () => ({ checks: [{ name: '/health ok', ok: true }] }),
    e2e: async () => ({ checks: [{ name: 'worker ack (2xx)', ok: true }] }),
    // The arrival pause, injected: every run below crosses the synthetic check, and none of them spends
    // its 45 real seconds. A deps object without this throws rather than skipping the wait silently.
    sleep: async () => {},
    readToken: () => 'github_pat_fake',
    createApi: () => ({
      get: async (path: string) => {
        // `/users/{handle}` is a different question from team membership, and GitHub answers it
        // separately - the account exists whether or not it is on the team. A fake that collapsed the
        // two would make the 4d existence check untestable.
        if (path.startsWith('/users/'))
          return { status: 200, json: { login: 'octocat-test' } }
        // The membership the buyer really has at each step: on the team through E3/E4 (invited, then
        // accepted), and whatever the refund left behind once we reach a refund screen. E6 re-grants
        // through the claim page, so the buyer is back on the team for its E3/E4 mirrors and gone again
        // once its own refund has run.
        const now =
          cursor.id === 'refund' || cursor.id === 'typo-refund'
            ? afterRefund
            : 'active'
        return now === 'none'
          ? { status: 404, json: null }
          : { status: 200, json: { state: now } }
      },
    }),
    ...overrides,
  }
}

/** Walk a whole run and collect every record the driver emitted, in order. */
async function drive(
  env: WizardEnv,
  goal: WizardGoal,
  overrides: Partial<WizardAnswers> & {
    deps?: Record<string, unknown>
    storeSeed?: string[]
  } = {},
): Promise<WizardRecord[]> {
  const { deps: depOverrides, storeSeed, ...answerOverrides } = overrides
  const answers: WizardAnswers = { ...ANSWERS, env, goal, ...answerOverrides }
  const state0 = initialState()

  const cursor: { id: string | null } = { id: null }
  const deps = okDeps(
    cursor,
    answers.revokePolicy ?? 'auto_revoke',
    { ...depOverrides },
    undefined,
    storeSeed,
  )
  let state = state0

  const records: WizardRecord[] = []
  let guard = 0
  while (!isComplete(state)) {
    if (guard++ > 60) throw new Error('driver did not terminate')
    const record = currentRecord(state)
    cursor.id = record.id
    records.push(record)
    state = await advance(state, answerFor(record, answers), deps)
  }
  return records
}

/** Drive to a named screen and stop on it, so a test can act at exactly that step. */
async function driveTo(
  screenId: string,
  env: WizardEnv,
  goal: WizardGoal,
  overrides: Partial<WizardAnswers> & {
    deps?: Record<string, unknown>
    refundMembership?: 'active' | 'none'
    storeSeed?: string[]
  } = {},
): Promise<{ state: WizardState; deps: Record<string, unknown> }> {
  const {
    deps: depOverrides,
    refundMembership,
    storeSeed,
    ...answerOverrides
  } = overrides
  const answers: WizardAnswers = { ...ANSWERS, env, goal, ...answerOverrides }
  const cursor: { id: string | null } = { id: null }
  const deps = okDeps(
    cursor,
    answers.revokePolicy ?? 'auto_revoke',
    depOverrides,
    refundMembership,
    storeSeed,
  )

  let state = initialState()
  let guard = 0
  while (currentRecord(state).id !== screenId) {
    if (guard++ > 60) throw new Error(`never reached '${screenId}'`)
    const record = currentRecord(state)
    cursor.id = record.id
    state = await advance(state, answerFor(record, answers), deps)
  }
  cursor.id = screenId
  return { state, deps }
}

const byId = (records: WizardRecord[], id: string): WizardRecord => {
  const found = records.find((r) => r.id === id)
  if (!found) throw new Error(`no '${id}' record was emitted`)
  return found
}

// --- the four sequences -------------------------------------------------------------------------
//
// The whole point of the driver: the sequence is code, so it is pinned here rather than living in prose
// nothing executes. Each assertion names the exact screens, in order - not a length, not "not empty".

const COMMON = [
  'welcome',
  'env',
  'goal',
  'road-map',
  'preflight',
  'github-org',
  'github-team',
  'github-team-lock',
  'org-harden',
  'github-pat',
  'test-buyer',
  'worker-url',
  // Sandbox only: the address announcement, which exists as a screen of its own so that it can happen
  // AFTER the subdomain answer. A production run's address is the domain it just typed.
  'worker-url-confirmed',
]

/** The same sequence as a production run walks it. */
const forEnv = (ids: string[], env: WizardEnv) =>
  env === 'production' ? ids.filter((id) => id !== 'worker-url-confirmed') : ids

const FULL_SEQUENCE = [
  ...COMMON,
  'stripe-product',
  'payment-link',
  'webhook-secret',
  'revoke-policy',
  'config-written',
  'secret-name-check',
  'deploy',
  'synthetic-check',
  'purchase',
  'awaiting-grant',
  'accept-invite',
  'refund',
  'typo-test',
  'typo-purchase',
  'typo-claim',
  'typo-accept',
  'typo-refund',
  'closing',
]

/** The same run with E6 declined: the offer is still made, the choreography is simply not in the run. */
const FULL_SEQUENCE_TYPO_SKIPPED = FULL_SEQUENCE.filter(
  (id) => !id.startsWith('typo-') || id === 'typo-test',
)

const QUICK_SEQUENCE = [
  ...COMMON,
  'revoke-policy',
  'config-written',
  'secret-name-check',
  'deploy',
  'synthetic-check',
  'closing',
]

describe('driver sequence (4 env x goal combinations)', () => {
  it('sandbox + full emits the full sequence in order', async () => {
    expect((await drive('sandbox', 'full')).map((r) => r.id)).toEqual(
      forEnv(FULL_SEQUENCE, 'sandbox'),
    )
  })

  it('production + full emits the full sequence in order', async () => {
    expect((await drive('production', 'full')).map((r) => r.id)).toEqual(
      forEnv(FULL_SEQUENCE, 'production'),
    )
  })

  it('sandbox + quick skips every Stripe and purchase screen', async () => {
    expect((await drive('sandbox', 'quick')).map((r) => r.id)).toEqual(
      forEnv(QUICK_SEQUENCE, 'sandbox'),
    )
  })

  it('production + quick skips every Stripe and purchase screen', async () => {
    expect((await drive('production', 'quick')).map((r) => r.id)).toEqual(
      forEnv(QUICK_SEQUENCE, 'production'),
    )
  })

  it('a quick run emits no Stripe dashboard screen at all', async () => {
    const ids = (await drive('sandbox', 'quick')).map((r) => r.id)
    for (const stripeScreen of [
      'stripe-product',
      'payment-link',
      'webhook-secret',
      'purchase',
      'awaiting-grant',
      'accept-invite',
      'refund',
    ]) {
      expect(ids).not.toContain(stripeScreen)
    }
  })

  it('the road map is between the goal answer and preflight, in every combination', async () => {
    // The road map sits AFTER the goal because it describes the path that answer chose, and BEFORE
    // preflight because its whole job is to arrive before the run spends the deployer's time.
    for (const env of ['sandbox', 'production'] as const) {
      for (const goal of ['full', 'quick'] as const) {
        const ids = (await drive(env, goal)).map((r) => r.id)
        expect(ids.indexOf('road-map'), `${env}/${goal}`).toBe(
          ids.indexOf('goal') + 1,
        )
        expect(ids.indexOf('preflight'), `${env}/${goal}`).toBe(
          ids.indexOf('road-map') + 1,
        )
      }
    }
  })

  it('the org hardening walk is between 4b2 and 4c, in every combination', async () => {
    // The position is the load-bearing part: 4b3 decides whether fine-grained PATs are allowed at all,
    // so it has to land BEFORE 4c mints one.
    for (const env of ['sandbox', 'production'] as const) {
      for (const goal of ['full', 'quick'] as const) {
        const ids = (await drive(env, goal)).map((r) => r.id)
        expect(ids.indexOf('org-harden'), `${env}/${goal}`).toBe(
          ids.indexOf('github-team-lock') + 1,
        )
        expect(ids.indexOf('github-pat'), `${env}/${goal}`).toBe(
          ids.indexOf('org-harden') + 1,
        )
      }
    }
  })

  it('the goal answer, not the agent, selects the branch', async () => {
    // Same state, same cursor - only the goal answer differs, and the next screen differs with it.
    const atGoal = { cursor: 'goal', answers: { env: 'sandbox' }, flags: {} }
    const deps = okDeps({ id: 'goal' }, 'auto_revoke')
    expect((await advance(atGoal as never, 'full', deps)).cursor).toBe(
      'road-map',
    )
    expect(
      sequence({
        ...atGoal,
        answers: { env: 'sandbox', goal: 'full' },
      } as never),
    ).toContain('stripe-product')
    expect(
      sequence({
        ...atGoal,
        answers: { env: 'sandbox', goal: 'quick' },
      } as never),
    ).not.toContain('stripe-product')
  })
})

// --- screen wording -----------------------------------------------------------------------------
//
// The approved words are the product here. Each test names the record type AND the key text, so a drift
// from the approved wording fails rather than reaching a deployer.

describe('screen wording', () => {
  it('welcome is a say that promises the wizard never sees secret values', async () => {
    const record = byId(await drive('sandbox', 'full'), 'welcome')
    expect(record.type).toBe('say')
    expect(record.text).toBe(
      'This wizard sets up your RepoAccess worker one verified step at a time. It runs the commands and edits the config files for you; you do the dashboard clicks and paste your own secrets. It never sees your secret values.\n\nTwo quick questions first - they set the whole run.',
    )
  })

  it('the env question carries the note that Production still runs Stripe in test mode', async () => {
    const record = byId(await drive('sandbox', 'full'), 'env')
    expect(record.text).toBe('**Which environment are you setting up?**')
    expect(record.note).toBe(
      '_This choice is about your worker, not your Stripe account. Even Production runs Stripe in test mode - going live with real cards is a separate, final step._',
    )
  })

  it('the goal question budgets an hour for a Full run, not the old 15-20 minutes', async () => {
    // The old estimate was falsified by measured runs, and the org-hardening walk is back in the path -
    // so the number was wrong in the direction that matters: it under-promised the deployer's evening.
    const full = byId(await drive('sandbox', 'full'), 'goal').options!.find(
      (o) => o.value === 'full',
    )!
    expect(full.description).toContain(
      'Budget about an hour the first time - much less if your GitHub org and Stripe account are already set up.',
    )
    expect(full.description).not.toContain('15-20 minutes')
  })

  it('the road map states the second-account prerequisite, on BOTH goals', async () => {
    // State the prerequisite before Step 0. A live run reached 4d - most of an hour in - with the
    // deployer never told they needed a second account, which parks the wizard on account creation.
    for (const goal of ['full', 'quick'] as const) {
      const record = byId(await drive('sandbox', goal), 'road-map')
      expect(record.type, goal).toBe('say')
      expect(record.text, goal).toContain(
        'a **second GitHub account** to play the test buyer - NOT your org-owner account',
      )
      expect(record.text, goal).toContain(
        "Create it now if you don't have one - I'll ask for its handle later.",
      )
    }
  })

  it('the road map describes the path the GOAL chose, not the other one', async () => {
    const full = byId(await drive('sandbox', 'full'), 'road-map')
    expect(full.text).toContain(
      "Here is the full path ahead: (1) GitHub - org, team, repo, org hardening, and the worker's access token; (2) your worker's address; (3) Stripe - product, payment link, and webhook; (4) I write the config and deploy, once; (5) a synthetic check, then a real test purchase, a refund test, and an optional mistyped-handle test.",
    )
    expect(full.text).toContain(
      'If you are configuring everything from scratch (new GitHub org, new Stripe account), budget about an hour; if your dashboards are already set up it is much faster. You can stop and resume - every step is re-runnable.',
    )

    const quick = byId(await drive('sandbox', 'quick'), 'road-map')
    expect(quick.text).toContain(
      'Quick path ahead: your GitHub side, the config, one deploy, and a synthetic end-to-end check - a few minutes once your org exists.',
    )
    // A Quick run walks no Stripe dashboard and buys nothing, so the Full map must not leak into it.
    expect(quick.text).not.toContain('payment link')
    expect(quick.text).not.toContain('budget about an hour')
  })

  it('4b3 walks the hardening checklist and names the two switches that break the product', async () => {
    // Ported from the GitHub walkthrough's hardening section. These two are not hygiene: a restricted
    // fine-grained PAT policy means the 4c token cannot manage the org at all, and org-wide 2FA removes
    // the buyers it is supposed to protect. Both fail silently on a run whose owner has 2FA anyway.
    const record = byId(await drive('sandbox', 'full'), 'org-harden')
    expect(record.type).toBe('do')
    expect(record.text).toContain(
      'Now lock the org down - your members are paying customers, not teammates. These switches restrict members; owners keep full access.',
    )
    expect(record.text).toContain(
      '- Do **NOT** "Require two-factor authentication for everyone" - it removes members without 2FA (your buyers) and blocks them from accepting invites. Enable 2FA on your own owner account instead.',
    )
    expect(record.text).toContain(
      '- Under **Fine-grained personal access tokens** - select **Allow access via fine-grained personal access tokens**. The worker\'s token needs this; "Restrict" breaks grants.',
    )
    expect(record.text).toContain('Type **done** when the checklist is set.')
  })

  it('4b3 walks the PAT policy by its own three titled sections', async () => {
    // Live screenshots (2026-07-17) put this block on its own **Settings** subpage under Personal access
    // tokens, with three titled sections - the earlier single bullet named a navigation path one level
    // off, which is the dashboard-name class no code check can reach.
    const record = byId(await drive('sandbox', 'full'), 'org-harden')
    expect(record.text).toContain('**Personal access tokens -> Settings:**')
    for (const item of [
      "- Under **Require approval of fine-grained personal access tokens** - select **Require administrator approval**. Your own owner-minted token is ready immediately; only members' tokens wait for approval.",
      "- Under **Set maximum lifetimes for personal access tokens** - check **Fine-grained personal access tokens must expire** and set the maximum lifetime (366 days is the longest). The worker's token expires with it - GitHub emails you a reminder ahead; rotate the token then, or grants and revokes stop.",
    ]) {
      expect(record.text, item).toContain(item)
    }
    // The OAuth bullet stays where it was; only the PAT bullet was replaced.
    expect(record.text).toContain('**Third-party Access:**')
    expect(record.text).toContain(
      '- **OAuth app policy** - keep Access restricted.',
    )
  })

  it('4b3 carries the whole Member privileges list, Base permissions leading it', async () => {
    // The walkthrough's list in full. Base permissions LEADS it - it is the floor the rest of the walk
    // sits on - and 4b2 names it nowhere, so the deployer reads it once.
    const record = byId(await drive('sandbox', 'full'), 'org-harden')
    for (const item of [
      '- **Base permissions** - **No permission**. This is the floor every member gets; left at Read, everyone already sees the repos and a grant proves nothing.',
      "- **Repository creation** - uncheck Public and Private (members don't create repos).",
      '- **Repository forking** - off.',
      '- **Projects base permissions** - No access.',
      '- **Pages creation** - uncheck Public and Private.',
      '- **App access requests** - disable.',
      '- **GitHub Apps** ("Allow repository admins to install...") - off.',
      '- **Admin repository permissions** - all off: visibility change, deletion and transfer, issue deletion, branch renames.',
      '- **Member team permissions** - Team creation off.',
      '- **OAuth app policy** - keep Access restricted.',
    ]) {
      expect(record.text, item).toContain(item)
    }
    // First in its list, and only here: 4b2 carried a second copy until this screen took the whole walk.
    expect(record.text!.indexOf('- **Base permissions**')).toBeLessThan(
      record.text!.indexOf('- **Repository creation**'),
    )
    expect(
      byId(await drive('sandbox', 'full'), 'github-team-lock').text,
    ).not.toContain('Base permissions')
    expect(
      byId(await drive('production', 'full'), 'github-team-lock').text,
    ).not.toContain('Base permissions')
  })

  it('4b3 is env-neutral - an org is hardened the same way whichever worker it feeds', async () => {
    expect(byId(await drive('production', 'full'), 'org-harden').text).toBe(
      byId(await drive('sandbox', 'full'), 'org-harden').text,
    )
  })

  it('preflight names only the secrets template, and promises the config later', async () => {
    // It used to claim it had copied the config templates too. config-write writes those, later, from
    // answers this screen has not collected - so the claim described work that had not happened.
    const record = byId(await drive('sandbox', 'full'), 'preflight')
    expect(record.type).toBe('say')
    expect(record.text).toContain('- Node, wrangler, git - OK')
    expect(record.text).toContain('- secrets template (`.dev.vars`) - created')
    expect(record.text).not.toContain('config, wrangler, and secrets templates')
    expect(record.text).toContain(
      "Everything's ready. Next, your GitHub side. (I'll write your config and `wrangler.jsonc` for you later, once we have your product and KV details.)",
    )
  })

  it('preflight names the production secrets template on a production run', async () => {
    expect(byId(await drive('production', 'full'), 'preflight').text).toContain(
      '- secrets template (`.dev.vars.production`) - created',
    )
  })

  it('the org question explains why a personal account will not do', async () => {
    const record = byId(await drive('sandbox', 'full'), 'github-org')
    expect(record.type).toBe('ask')
    expect(record.kind).toBe('text')
    expect(record.text).toContain(
      'A personal account has no teams, so an org is required - a free one is fine.',
    )
    expect(record.text).toContain("What's your organization's slug?")
  })

  it('the test-buyer question explains why the org owner cannot be the buyer', async () => {
    const record = byId(await drive('sandbox', 'full'), 'test-buyer')
    expect(record.text).toContain(
      "an account already in your org never gets an invite, so it can't test the real path",
    )
    expect(record.text).toContain("What's the test buyer's GitHub handle?")
  })

  it('the payment-link screen carries all three points, metadata included', async () => {
    const record = byId(await drive('sandbox', 'full'), 'payment-link')
    expect(record.type).toBe('do')
    // The button is **Create test payment link** in Test mode - maintainer-confirmed live 2026-07-16,
    // and the wizard is always in Test mode. "New" is what the dashboard used to say; a deployer who
    // reads it hunts for a button that is not on their screen.
    expect(record.text).toContain(
      '**Payment Links -> Create test payment link -> Products or subscriptions**, select your product, quantity 1',
    )
    expect(record.text).not.toContain('Payment Links -> New')
    expect(record.text).toContain('Three things matter:')
    expect(record.text).toContain(
      '**Advanced options -> Add custom fields**, add ONE field - Type **Text**, Label **GitHub username**.',
    )
    // The step whose absence makes every Full run ack 200 and grant nothing.
    expect(record.text).toContain(
      'scroll to **Metadata**, click **Edit metadata**, and add key `product_id`',
    )
    expect(record.text).toContain(
      "Stripe's checkout webhook omits line items, so the worker reads the product from this metadata - without it the sale maps to no team and grants nothing.",
    )
    expect(record.text).toContain(
      'Type **done** when the link is created and the metadata is set.',
    )
  })

  it('the payment-link redirect names the by-txn route the worker actually serves', async () => {
    // create-worker.ts serves `/claim/by-txn/:adapter/:txn`. The two-segment `/claim/:token` is a
    // DIFFERENT route that expects a claim token, so a checkout-session id sent there is a dead link,
    // not a slow one - every buyer would land on it.
    const record = byId(await drive('sandbox', 'full'), 'payment-link')
    expect(record.text).toContain('/claim/by-txn/stripe/{CHECKOUT_SESSION_ID}')
    expect(record.text).not.toMatch(/\/claim\/\{CHECKOUT_SESSION_ID\}/)
  })

  it('the payment-link redirect names the surface that carries it', async () => {
    // The redirect lives behind a tab the deployer has to find, and the level matters: live-confirmed
    // 2026-07-16, the TAB is After payment and Confirmation page is a section inside it. Naming only
    // "set the redirect" left them hunting; naming the wrong level sent them looking for a tab that is
    // not in the tab bar.
    const record = byId(await drive('sandbox', 'full'), 'payment-link')
    expect(record.text).toContain(
      "Wire the redirect: open the **After payment** tab, and under **Confirmation page** choose **Don't show confirmation page**, then set the redirect URL to",
    )
  })

  it('the product screen names the current Stripe menu path', async () => {
    const record = byId(await drive('sandbox', 'full'), 'stripe-product')
    expect(record.text).toContain('**Product catalog -> Create product**')
    expect(record.text).toContain('Name it and set a one-time price.')
    // The screen names the CURRENT dashboard and nothing else. It used to carry a parenthetical saying
    // what Stripe renamed this from; that is walkthrough context for whoever ports the wording, not
    // something a deployer standing in front of the current UI can act on.
    expect(record.text).not.toContain('Stripe renamed this')
    expect(record.text).not.toContain('Products -> Add product')
  })

  it('the webhook screen names the events first, then the endpoint - the real flow', async () => {
    const record = byId(await drive('sandbox', 'full'), 'webhook-secret')
    expect(record.text).toContain(
      '**Developers -> Webhooks (Event destinations) -> Add destination**',
    )
    expect(record.text).toContain(
      'Events - send exactly these three: `checkout.session.completed`, `charge.refunded`, `charge.dispute.created`.',
    )
    expect(record.text).toContain('**Configure destination -> Endpoint URL:**')
    // The events really are asked for before the URL, so the screen must not send the deployer hunting
    // for a URL field that is not on screen yet.
    expect(
      record.text!.indexOf('Events - send exactly these three'),
    ).toBeLessThan(
      record.text!.indexOf('Configure destination -> Endpoint URL'),
    )
    expect(record.text).toContain(
      "_(I generated the path - obscurity only, the worker doesn't validate it)_",
    )
    expect(record.text).toContain(
      '_You can reveal and copy it again anytime from that page._',
    )
  })

  it('the synthetic check credits the cancellation to the check, not the worker', async () => {
    // The cleanup is the check's own direct GitHub DELETE; it never goes through the worker.
    const record = byId(await drive('sandbox', 'full'), 'synthetic-check')
    expect(record.type).toBe('say')
    expect(record.text).toContain(
      'sends a **real** GitHub invite to `octocat-test`; the check then cancels it automatically. One invite email, one cancellation - no money, nothing to accept...',
    )
  })

  it('the synthetic check closes differently per goal', async () => {
    expect(
      byId(await drive('sandbox', 'full'), 'synthetic-check').text,
    ).toContain("Synthetic check **green**. Now let's do it for real.")
    expect(
      byId(await drive('sandbox', 'quick'), 'synthetic-check').text,
    ).toContain(
      "Synthetic check **green**. Your grant path works end to end - a signed event in, a real GitHub invite out. Refunds aren't tested here; a Full run does that.",
    )
  })

  it('nothing ever claims the synthetic check proved the revoke path', async () => {
    // It sends one `checkout.session.completed` and cleans up with a direct DELETE - `charge.refunded`
    // is never sent, so the worker's revoke path is not exercised. Four strings once said it was: the
    // goal screen's Quick option, E1's Quick close, and both Quick closings.
    for (const goal of ['full', 'quick'] as WizardGoal[]) {
      for (const env of ['sandbox', 'production'] as WizardEnv[]) {
        for (const record of await drive(env, goal)) {
          if (!['goal', 'synthetic-check', 'closing'].includes(record.id))
            continue
          const texts = [
            record.text ?? '',
            ...(record.options ?? []).map((o) => o.description),
          ]
          for (const text of texts) {
            const where = `${record.id} in ${env}/${goal}`
            expect(text, where).not.toContain('revoke plumbing')
            expect(text, where).not.toContain('grant and revoke plumbing')
          }
        }
      }
    }
  })

  it('the purchase screen gives the test card and the field order', async () => {
    const record = byId(await drive('sandbox', 'full'), 'purchase')
    expect(record.type).toBe('do')
    // The label the buyer SEES is the one the payment-link step set, so E2 must name that and not the
    // derived key.
    expect(record.text).toContain(
      '2. **GitHub username** - enter `octocat-test` in the **GitHub username** field.',
    )
    expect(record.text).toContain('**Card** `4242 4242 4242 4242`')
  })

  it('a pasted secret line has no space on either side of the `=`', async () => {
    // `.dev.vars` is parsed as NAME=value. `GITHUB_TOKEN = ghp_...` yields a name with a trailing space
    // and a value with a leading one, so the name-check reads it as missing.
    //
    // The line is now ONE code span carrying the placeholder - `GITHUB_TOKEN=YOUR-TOKEN` - and that is
    // what this pins. The earlier form closed the span at the `=` and put the placeholder outside it
    // (`` `GITHUB_TOKEN=` _your token_ ``), which RENDERS a space immediately after the `=`, directly
    // under a sentence saying not to leave one. The instruction was right and the example contradicted it.
    for (const [screen, line] of [
      ['github-pat', '`GITHUB_TOKEN=YOUR-TOKEN`'],
      ['webhook-secret', '`STRIPE_WEBHOOK_SECRET=YOUR-SIGNING-SECRET`'],
    ] as const) {
      const record = byId(await drive('sandbox', 'full'), screen)
      const name = line.slice(1).split('=')[0]
      expect(record.text, screen).toContain(line)
      expect(record.text, screen).not.toContain(`${name} =`)
      expect(record.text, screen).not.toContain(`${name}= `)
      // The placeholder never escapes the span, in either direction.
      expect(record.text, screen).not.toContain(`\`${name}=\` `)
      expect(record.text, screen).toContain(
        'paste it on its own line, no spaces around the `=`:',
      )
    }
  })

  it("accept-invite insists on the second account's browser tab", async () => {
    const record = byId(await drive('sandbox', 'full'), 'accept-invite')
    expect(record.type).toBe('do')
    expect(record.text).toContain(
      "Open it **in the browser tab where you're logged in as `octocat-test`**, not your main account, and accept the invitation.",
    )
  })

  // Accepting an invitation and holding the access are two different states, and every step after this
  // one depends on the second. GitHub says as much itself: it answers the acceptance with a banner
  // warning that access takes a moment. So `done` here must not mean "I clicked accept".
  it('accept-invite: `done` means accepted AND the access actually granted, not the click', async () => {
    const record = byId(await drive('sandbox', 'full'), 'accept-invite')
    expect(record.text).toContain(
      'GitHub answers the acceptance with a banner saying access can take a moment to come through. Refresh `https://github.com/acme` in that same tab and you will see what `octocat-test` now has access to.',
    )
    expect(record.text).toContain(
      "Type **done** when you've accepted AND you can see `octocat-test` in the organization with the team membership.",
    )
    // the understated done-condition is gone, not merely followed by a better one
    expect(record.text).not.toContain("Type **done** when you've accepted.")
  })

  // The SAME defect on the second acceptance screen. The typo test's grant is a real GitHub invitation
  // and the refund that cleans it up depends on the membership existing, so `done` here has to mean the
  // access, not the click - and the two acceptance screens must not disagree about what `done` means.
  it('typo-accept: `done` means accepted AND the access actually granted, like the first acceptance', async () => {
    const record = byId(await drive('sandbox', 'full'), 'typo-accept')
    expect(record.type).toBe('do')
    expect(record.text).toContain(
      'The same banner appears as last time, saying access can take a moment. Refresh `https://github.com/acme` in that tab to see what `octocat-test` has access to now.',
    )
    expect(record.text).toContain(
      "Type **done** when you've accepted AND you can see `octocat-test` in the organization with the team membership.",
    )
    expect(record.text).not.toContain("Type **done** when you've accepted.")
  })

  // Neither screen may drift from the other on the one sentence that says what `done` means, whichever
  // of the two a deployer reaches first.
  it('both acceptance screens end on the identical done-condition', async () => {
    const records = await drive('sandbox', 'full')
    const lastLine = (id: string) =>
      byId(records, id).text!.trim().split('\n').at(-1)
    expect(lastLine('typo-accept')).toBe(lastLine('accept-invite'))
  })
})

// --- env-awareness and the env branch variants --------------------------------------------------
//
// Rule: every env-aware step carries its env, and the branch variants are selected by state, never by
// the agent. The secrets-file name is the one that bites - a production run told to paste a live secret
// into `.dev.vars` writes it to a file that run never reads.

describe('env-awareness', () => {
  it("every record of a run carries that run's env and goal", async () => {
    for (const env of ['sandbox', 'production'] as WizardEnv[]) {
      for (const goal of ['full', 'quick'] as WizardGoal[]) {
        for (const record of await drive(env, goal)) {
          // welcome/env precede the env choice and are the only env-less screens, like check-env.
          if (record.id === 'welcome' || record.id === 'env') continue
          expect(record.env, `${record.id} in ${env}/${goal}`).toBe(env)
          if (record.id !== 'goal') {
            expect(record.goal, `${record.id} in ${env}/${goal}`).toBe(goal)
          }
        }
      }
    }
  })

  it("every action a screen declares carries the run's env", async () => {
    for (const env of ['sandbox', 'production'] as WizardEnv[]) {
      const actions = (await drive(env, 'full'))
        .filter((r) => r.action)
        .map((r) => r.action!)
      // The steps the driver will run once execution lands, each named with its env.
      expect(actions.map((a) => a.step)).toEqual([
        'preflight',
        ...(env === 'sandbox' ? ['resolve-url'] : []),
        'config-write',
        'secrets-check',
        'deploy',
        'e2e',
      ])
      for (const action of actions) expect(action.env).toBe(env)
    }
  })

  it('the driver refuses to build an env-aware screen with no env named', async () => {
    const noEnv = { cursor: 'preflight', answers: {}, flags: {} }
    expect(() => currentRecord(noEnv as never)).toThrow(DriverError)
    expect(() => currentRecord(noEnv as never)).toThrow(
      /env-aware but no environment is set/,
    )
  })

  it('sandbox names .dev.vars on every screen that names a secrets file', async () => {
    const records = await drive('sandbox', 'full')
    expect(byId(records, 'github-pat').text).toContain('open **`.dev.vars`**')
    expect(byId(records, 'webhook-secret').text).toContain(
      'Open **`.dev.vars`**',
    )
    expect(byId(records, 'secret-name-check').text).toBe(
      'Both secret names are present in `.dev.vars` - good. Ready to deploy.\n\nDeploying now - one deploy, with your secrets uploaded from `.dev.vars`. This provisions the worker and binds KV...',
    )
  })

  it('production names .dev.vars.production on every screen that names a secrets file', async () => {
    const records = await drive('production', 'full')
    expect(byId(records, 'github-pat').text).toContain(
      'open **`.dev.vars.production`**',
    )
    expect(byId(records, 'webhook-secret').text).toContain(
      'Open **`.dev.vars.production`**',
    )
    expect(byId(records, 'secret-name-check').text).toBe(
      "Both secret names are present in `.dev.vars.production` - good. Ready to deploy.\n\nDeploying now - one deploy, with your secrets uploaded from `.dev.vars.production`. This provisions the worker and binds KV...\n\n_A custom domain needs a moment for DNS and its certificate - I'll wait, then check._",
    )
  })

  it('no production screen ever names the bare .dev.vars file', async () => {
    // The live-secret hazard: `.dev.vars.production` contains `.dev.vars`, so this asserts the bare
    // name never appears as its own token.
    for (const record of await drive('production', 'full')) {
      expect(record.text, record.id).not.toMatch(/`\.dev\.vars`/)
    }
  })

  it('the repo attach is optional in sandbox and required in production', async () => {
    expect(
      byId(await drive('sandbox', 'full'), 'github-team-lock').text,
    ).toContain(
      "_For this sandbox test it's optional - a grant still proves the flow - but attach one before real buyers, or a grant unlocks nothing._",
    )
    const production = byId(
      await drive('production', 'full'),
      'github-team-lock',
    )
    expect(production.text).toContain(
      "**Attach the repo(s) now.** I can't verify this with the worker token, so this one is on you: a grant without an attached repo unlocks nothing for the buyer.",
    )
    expect(production.text).not.toContain("For this sandbox test it's optional")
  })

  it('4b2 asks whether the repo was attached in sandbox, and takes a bare done in production', async () => {
    // The live run's defect: the screen took a bare `done` for an action that is OPTIONAL here, so the
    // word could not say whether the maintainer had attached the repo or deferred it - they typed `skip`
    // and the driver had nowhere to put it. Sandbox therefore asks; production requires the attach, so
    // one word covers it.
    const sandbox = byId(await drive('sandbox', 'full'), 'github-team-lock')
    expect(sandbox.type).toBe('ask')
    expect(sandbox.kind).toBe('choice')
    expect(sandbox.field).toBe('repoAttached')
    expect(sandbox.options!.map((o) => o.value)).toEqual([
      'attached',
      'skipped',
    ])
    // Verbatim, because the label IS the answer: each one names exactly what it confirms.
    expect(sandbox.options!.map((o) => o.label)).toEqual([
      'Done - repo attached',
      'Skip for now',
    ])
    // The sandbox screen never asks for the word `done`; the options carry the confirmation.
    expect(sandbox.text).not.toContain('done')

    const production = byId(
      await drive('production', 'full'),
      'github-team-lock',
    )
    expect(production.type).toBe('do')
    expect(production.options).toBeUndefined()
    expect(production.field).toBeUndefined()
    expect(production.text).toContain(
      'Type **done** when the repo(s) are attached.',
    )
  })

  it('both 4b2 options are stored, and only `skipped` arms the closing reminder', async () => {
    for (const [answer, reminded] of [
      ['attached', false],
      ['skipped', true],
    ] as const) {
      const records = await drive('sandbox', 'full', { repoAttached: answer })
      expect(
        byId(records, 'closing').text!.includes(
          'If you skipped the repo attach',
        ),
        answer,
      ).toBe(reminded)
    }
  })

  it('the worker-url screen asks in BOTH envs - the subdomain is never assumed', async () => {
    const sandbox = byId(await drive('sandbox', 'full'), 'worker-url')
    expect(sandbox.type).toBe('ask')
    expect(sandbox.kind).toBe('text')
    expect(sandbox.field).toBe('subdomain')
    expect(sandbox.text).toContain(
      "Your worker runs on your Cloudflare account's `workers.dev` subdomain, and I can't read that reliably - so you tell me what it is.",
    )
    // The one route to the true value, and the whole point of the screen: the deployer reads it off the
    // panel that holds it rather than being told what it is.
    expect(sandbox.text).toContain(
      '**Compute -> Workers & Pages -> Account Details (the panel on the right) -> Subdomain**. It reads `SOMETHING.workers.dev`, and the subdomain is the part before `.workers.dev`.',
    )

    const production = byId(await drive('production', 'full'), 'worker-url')
    expect(production.type).toBe('ask')
    expect(production.kind).toBe('text')
    expect(production.field).toBe('domain')
    expect(production.text).toContain(
      'Your worker will run on your own domain. Which custom domain? (e.g. `access.example.com`)',
    )
    expect(production.text).toContain(
      'Its zone must be on this same Cloudflare account',
    )
  })

  it('the candidate is OFFERED as a default to confirm, never as the answer', async () => {
    // `wrangler whoami` names the account `acme-co`, so that is what the guess slugifies to - and the
    // deployer's dashboard says `acme-dev`. The screen has to make confirming conditional, or the guess
    // is just the old defect with a prompt in front of it.
    const record = byId(await drive('sandbox', 'full'), 'worker-url')
    expect(record.text).toContain(
      "My best guess from your account is `acme-co` - confirm that ONLY if it matches what the dashboard shows. What's the subdomain?",
    )
  })

  it('an account that yields no candidate is asked the same question, without one', async () => {
    const record = byId(
      await drive('sandbox', 'full', { deps: noSubdomainCandidate }),
      'worker-url',
    )
    expect(record.type).toBe('ask')
    expect(record.field).toBe('subdomain')
    expect(record.text).toContain(
      'Compute -> Workers & Pages -> Account Details (the panel on the right) -> Subdomain',
    )
    expect(record.text).not.toContain('My best guess')
    expect(record.text).not.toContain('SUBDOMAIN-GUESS')
  })

  it('the address announcement names the ANSWER, and comes after it', async () => {
    const records = await drive('sandbox', 'full')
    const announce = byId(records, 'worker-url-confirmed')
    expect(announce.type).toBe('say')
    expect(announce.text).toContain(
      '`https://repoaccess-core.acme-dev.workers.dev`',
    )
    expect(announce.text).toContain("That's the subdomain you confirmed.")
    // The sentence that died with the guess. It claimed a reading nothing performed.
    expect(announce.text).not.toContain('I read the subdomain')
    // And the guess never reaches the wire.
    expect(announce.text).not.toContain('acme-co')
    expect(announce.action).toEqual({ step: 'resolve-url', env: 'sandbox' })
  })

  it('a production run gets no address announcement - its ask is untouched', async () => {
    expect((await drive('production', 'full')).map((r) => r.id)).not.toContain(
      'worker-url-confirmed',
    )
  })

  /**
   * THE INVARIANT, and the defect it was written against.
   *
   * No path through a sandbox run may reach the address announcement without the deployer having
   * answered the subdomain question. The old driver reached it on every run that could produce a
   * candidate: it slugified the Cloudflare account NAME, announced the result as the worker's address,
   * and never asked - so a default-named account ("dana@example.com's Account") wired the provider
   * webhook and the health check to `dana-example-com-s-account.workers.dev`, a hostname the account does
   * not have. The ask branch that could have saved the run sat BELOW the guess and was unreachable.
   *
   * Written as a walk over the whole run rather than as an assertion about one screen, because the defect
   * was never in a screen's words - it was in which screens the run visited.
   */
  it('NO sandbox path reaches the address announcement without a subdomain answer', async () => {
    for (const goal of ['full', 'quick'] as WizardGoal[]) {
      for (const [world, deps] of [
        ['a candidate is available', {}],
        ['no candidate at all', noSubdomainCandidate],
      ] as const) {
        const label = `${goal} / ${world}`
        const records = await drive('sandbox', goal, { deps })
        const announced = records.findIndex((r) =>
          (r.text ?? '').includes("Your worker's address will be:"),
        )
        const asked = records.findIndex(
          (r) => r.type === 'ask' && r.field === 'subdomain',
        )
        expect(announced, label).toBeGreaterThan(-1)
        expect(asked, label).toBeGreaterThan(-1)
        expect(asked, label).toBeLessThan(announced)
        // And nothing up to and including the question names a worker ADDRESS. The question itself
        // legitimately says `SOMETHING.workers.dev` - what may not appear before the answer is a host
        // built from a subdomain, which is precisely what the guess used to announce.
        for (const record of records.slice(0, asked + 1)) {
          expect(record.text ?? '', `${label} / ${record.id}`).not.toMatch(
            /repoaccess-core\.[a-z0-9-]+\.workers\.dev/,
          )
        }
      }
    }
  })

  it('a subdomain that does not exist re-asks, with the dashboard route again', async () => {
    const { state, deps } = await driveTo('worker-url', 'sandbox', 'quick', {
      deps: { subdomainCheck: async () => SUBDOMAIN_MISSING },
    })
    const parked = await advance(state, 'nope', deps)
    expect(parked.cursor).toBe('worker-url')
    const record = currentRecord(parked)
    expect(record.type).toBe('recovery')
    // The step's own words say WHICH value failed and why.
    expect(record.detail).toContain('There is no `nope.workers.dev`')
    expect(record.modes!.map((m) => m.when)).toContain(
      'nothing answers at that subdomain',
    )
    expect(
      record.modes!.find((m) => m.when === 'nothing answers at that subdomain')!
        .text,
    ).toContain(
      '**Compute -> Workers & Pages -> Account Details (the panel on the right) -> Subdomain**',
    )
    // A parked ask takes a corrected VALUE, so the deployer answers again rather than typing `done`.
    expect(record.command).toBe('npm run wizard:drive answer YOUR-ANSWER')
  })

  it('a corrected subdomain is checked against the NEW value and advances', async () => {
    const existing = ['acme-dev']
    const { state, deps } = await driveTo('worker-url', 'sandbox', 'quick', {
      deps: {
        subdomainCheck: async ({ subdomain }: { subdomain: string }) =>
          existing.includes(subdomain) ? SUBDOMAIN_EXISTS : SUBDOMAIN_MISSING,
      },
    })
    const parked = await advance(state, 'nope', deps)
    expect(currentRecord(parked).type).toBe('recovery')

    const fixed = await advance(parked, 'acme-dev', deps)
    expect(fixed.answers.subdomain).toBe('acme-dev')
    expect(fixed.cursor).toBe('worker-url-confirmed')
    expect(fixed.flags.workerUrl).toBe(SANDBOX_BASE)
  })

  it('an inconclusive probe does not re-ask - a warn is not a verdict on the account', async () => {
    // An offline machine, a blocked resolver or a proxy failure says nothing about the deployer's
    // subdomain, and re-asking a value they read correctly off the dashboard is a dead end with no way
    // out: the same answer would fail the same way forever.
    const { state, deps } = await driveTo('worker-url', 'sandbox', 'quick', {
      deps: {
        subdomainCheck: async () => ({
          checks: [
            {
              name: 'workers.dev subdomain checked (acme-dev)',
              ok: false,
              severity: 'warn',
              fix: 'Could not check it from this machine',
            },
          ],
        }),
      },
    })
    const next = await advance(state, 'acme-dev', deps)
    expect(next.cursor).toBe('worker-url-confirmed')
  })

  it('the answer, not the candidate, is what gets wired', async () => {
    // The candidate the account yields (`acme-co`) and the answer (`acme-dev`) differ on purpose, so
    // every downstream address in the run is evidence about which one won.
    let seen: Record<string, unknown> = {}
    const records = await drive('sandbox', 'full', {
      deps: {
        resolveUrl: (opts: Record<string, string | null>) => {
          seen = opts
          return resolveUrlFake()(opts)
        },
      },
    })
    expect(seen.subdomain).toBe('acme-dev')
    for (const record of records) {
      expect(record.text ?? '', record.id).not.toContain('acme-co.workers.dev')
    }
  })

  it('only a production run carries the DNS propagation note, on the announcement', async () => {
    // It rides the announcement, not the result: the wait it describes is spent DURING the deploy, so a
    // deployer who reads it on the result screen is being warned about a pause already over.
    expect(
      byId(await drive('production', 'full'), 'secret-name-check').text,
    ).toContain(
      "_A custom domain needs a moment for DNS and its certificate - I'll wait, then check._",
    )
    for (const env of ['sandbox', 'production'] as const) {
      expect(byId(await drive(env, 'full'), 'deploy').text, env).not.toContain(
        'needs a moment for DNS',
      )
    }
    expect(
      byId(await drive('sandbox', 'full'), 'secret-name-check').text,
    ).not.toContain('needs a moment for DNS')
  })

  it('the deploy is ANNOUNCED before it runs and REPORTED after, never both at once', async () => {
    // The deploy runs on arrival at the `deploy` screen, so the announcement has to be on the screen
    // BEFORE it. Unannounced, the deployer sits through that pause with nothing on screen explaining it,
    // then reads the announcement and its outcome in one blob, after the fact.
    for (const env of ['sandbox', 'production'] as const) {
      const records = await drive(env, 'full')
      const announcement = byId(records, 'secret-name-check').text!
      const result = byId(records, 'deploy').text!
      expect(announcement, env).toContain('Deploying now - one deploy')
      expect(result, env).not.toContain('Deploying now')
      expect(result, env).toContain('Checking `/health`... OK')
      expect(announcement, env).not.toContain('Checking `/health`')
    }
  })

  it('the deploy screen announces the pause the driver is about to take, in both envs', async () => {
    // The pause below is 45 silent seconds between two screens. Unannounced it reads as a hung wizard,
    // which is the moment a deployer starts pressing things - so the screen that precedes it says why.
    for (const env of ['sandbox', 'production'] as const) {
      expect(byId(await drive(env, 'full'), 'deploy').text, env).toContain(
        "Next up is a synthetic check - I'll give the brand-new worker's workflow a minute to register with Cloudflare first.",
      )
    }
  })
})

// --- the four closings --------------------------------------------------------------------------
//
// A closing that overclaims is the defect this project keeps paying for: a Quick run never touches
// Stripe, so it must never be told a purchase was proven.

describe('closings (one per env x goal)', () => {
  it('the full sandbox closing claims the money flow, and the claim page only if E6 ran', async () => {
    const tested = byId(await drive('sandbox', 'full'), 'closing')
    expect(tested.type).toBe('say')
    expect(tested.text).toContain(
      'Done - your sandbox worker is proven end to end: purchase -> invite -> refund/revoke all worked.',
    )
    expect(tested.text).toContain('**To sell for real:**')

    // The default run TOOK the typo test, so the closing may say so - and must not say the opposite.
    expect(tested.text).toContain(
      '(A buyer who mistypes their handle self-corrects on the claim page - this run live-tested that path too.)',
    )
    expect(tested.text).not.toContain("didn't live-test it")

    // Declined, the claim path really was not live-tested, and the closing goes back to saying so. The
    // unconditional old line was true of every run until E6 existed and false the moment one runs it.
    const skipped = byId(
      await drive('sandbox', 'full', { typoTest: 'skip' }),
      'closing',
    )
    expect(skipped.text).toContain(
      "(A buyer who mistypes their handle self-corrects on the claim page - that path is built in; this run didn't live-test it.)",
    )
    expect(skipped.text).not.toContain('live-tested that path too')
  })

  it('the full production closing names the test-mode gap and the two failure modes', async () => {
    const record = byId(await drive('production', 'full'), 'closing')
    expect(record.text).toContain(
      'Done - your production worker is live on `access.example.com` and proven end to end.',
    )
    expect(record.text).toContain(
      '**One thing stands between you and selling: Stripe is still in test mode.**',
    )
    expect(record.text).toContain(
      'wrong secret -> `401`; wrong product id -> `200` and nothing granted',
    )
    expect(record.text).toContain(
      '**Do not hand your test Payment Link to a customer.**',
    )
  })

  it('the quick sandbox closing states it never touched Stripe', async () => {
    const record = byId(await drive('sandbox', 'quick'), 'closing')
    expect(record.text).toContain(
      'the synthetic test proved the grant path end to end: a signed event in, a real GitHub invite out, then cleaned up.',
    )
    expect(record.text).toContain(
      "**What this run did NOT do:** it didn't touch Stripe, prove a real purchase, or test the refund path",
    )
  })

  it('the quick production closing states it never touched Stripe', async () => {
    const record = byId(await drive('production', 'quick'), 'closing')
    expect(record.text).toContain(
      'Done - your production worker is deployed on `access.example.com`, and the synthetic test proved the grant path end to end.',
    )
    expect(record.text).toContain(
      "**What this run did NOT do:** it didn't touch Stripe, prove a real purchase, or test the refund path",
    )
  })

  it('no quick closing ever claims a purchase was proven', async () => {
    for (const env of ['sandbox', 'production'] as WizardEnv[]) {
      const text = byId(await drive(env, 'quick'), 'closing').text
      expect(text, env).not.toContain('purchase -> invite')
      expect(text, env).not.toContain('proven end to end: purchase')
    }
  })

  it('no closing ever tells the deployer they can start selling', async () => {
    for (const env of ['sandbox', 'production'] as WizardEnv[]) {
      for (const goal of ['full', 'quick'] as WizardGoal[]) {
        const text = byId(await drive(env, goal), 'closing').text ?? ''
        expect(text.toLowerCase(), `${env}/${goal}`).not.toContain(
          'start selling',
        )
      }
    }
  })

  it('the repo-attach reminder rides only on a sandbox run that actually SKIPPED it', async () => {
    // Two conditions, and the second is the new one. Production was told to attach the repo at 4b2, so
    // "if you skipped it" would be wrong there - that always held. But 4b2 now ASKS which of its two
    // actions the human did, so the driver knows: showing the reminder to a run that answered "attached"
    // is the driver misdescribing a run it drove. It is a conditional, not a hedge.
    for (const goal of ['full', 'quick'] as WizardGoal[]) {
      expect(
        byId(
          await drive('sandbox', goal, { repoAttached: 'skipped' }),
          'closing',
        ).text,
        goal,
      ).toContain('If you skipped the repo attach')
      expect(
        byId(
          await drive('sandbox', goal, { repoAttached: 'attached' }),
          'closing',
        ).text,
        goal,
      ).not.toContain('If you skipped the repo attach')
      expect(
        byId(await drive('production', goal), 'closing').text,
        goal,
      ).not.toContain('If you skipped the repo attach')
    }
  })

  it('every closing warns the token expires', async () => {
    for (const env of ['sandbox', 'production'] as WizardEnv[]) {
      for (const goal of ['full', 'quick'] as WizardGoal[]) {
        expect(
          byId(await drive(env, goal), 'closing').text,
          `${env}/${goal}`,
        ).toContain(
          '_Your token expires on the date you set - when it lapses, grants and revokes stop until you rotate it._',
        )
      }
    }
  })
})

// --- closed choices -----------------------------------------------------------------------------
//
// A known set is never hand-typed. This is not cosmetic: a live production run once made the deployer
// type `production` because the rule lived in prose instead of in code.

describe('closed choices', () => {
  const CHOICES: Record<string, string[]> = {
    env: ['sandbox', 'production'],
    goal: ['full', 'quick'],
    'revoke-policy': ['auto_revoke', 'log_only'],
  }

  it('env, goal and revoke-policy are choice records carrying both options', async () => {
    const records = await drive('sandbox', 'full')
    for (const [id, values] of Object.entries(CHOICES)) {
      const record = byId(records, id)
      expect(record.type, id).toBe('ask')
      expect(record.kind, id).toBe('choice')
      expect(
        record.options?.map((o) => o.value),
        id,
      ).toEqual(values)
    }
  })

  it('every option carries a label and a consequence, so a list renders without the driver', async () => {
    const records = await drive('sandbox', 'full')
    for (const id of Object.keys(CHOICES)) {
      for (const option of byId(records, id).options!) {
        expect(option.label.length, `${id}/${option.value}`).toBeGreaterThan(0)
        expect(
          option.description.length,
          `${id}/${option.value}`,
        ).toBeGreaterThan(20)
      }
    }
  })

  it('the option labels are the approved ones', async () => {
    const records = await drive('sandbox', 'full')
    expect(byId(records, 'env').options!.map((o) => o.label)).toEqual([
      'Sandbox / test',
      'Production',
    ])
    expect(byId(records, 'goal').options!.map((o) => o.label)).toEqual([
      'Full setup',
      'Quick check',
    ])
    expect(byId(records, 'revoke-policy').options!.map((o) => o.label)).toEqual(
      ['Automatically revoke', 'Log only'],
    )
  })

  it('a closed choice rejects a value outside its option set', async () => {
    const deps = okDeps({ id: 'env' }, 'auto_revoke')
    let state = initialState()
    state = await advance(state, null, deps) // welcome
    await expect(advance(state, 'prod', deps)).rejects.toThrow(DriverError)
    await expect(advance(state, 'prod', deps)).rejects.toThrow(/closed choice/)
  })

  it('no closed choice is emitted as free text', async () => {
    for (const id of Object.keys(CHOICES)) {
      expect(byId(await drive('sandbox', 'full'), id).kind, id).not.toBe('text')
    }
  })
})

// --- `do` and `done` ----------------------------------------------------------------------------

describe('do records and the word done', () => {
  it('every do screen ends by asking for the word done', async () => {
    for (const record of await drive('sandbox', 'full')) {
      if (record.type !== 'do') continue
      expect(record.text, record.id).toMatch(
        /Type \*\*done\*\*|type \*\*done\*\*/,
      )
    }
  })

  it('done on a do advances to the next screen once its verify passes', async () => {
    // github-pat is a `do`; test-buyer is what follows it.
    const { state, deps } = await driveTo('github-pat', 'sandbox', 'full')
    expect(currentRecord(state).type).toBe('do')
    const next = await advance(state, 'done', deps)
    expect(next.cursor).toBe('test-buyer')
  })

  it('4b3 has no verify of its own, so done advances straight to 4c', async () => {
    // Nothing on the hardening screen is readable with the worker PAT - it is minted with repository
    // access None, and these are org policy settings. So the screen is honest about advancing on the
    // human's word rather than pretending to check, exactly as 4b2 does.
    const { state, deps } = await driveTo('org-harden', 'sandbox', 'full')
    expect(currentRecord(state).type).toBe('do')
    expect((await advance(state, 'done', deps)).cursor).toBe('github-pat')
  })

  it('done is accepted regardless of case or surrounding space', async () => {
    const { state, deps } = await driveTo('github-pat', 'sandbox', 'full')
    expect((await advance(state, '  Done ', deps)).cursor).toBe('test-buyer')
  })

  it('a free-text screen rejects an empty answer', async () => {
    const { state, deps } = await driveTo('github-org', 'sandbox', 'full')
    await expect(advance(state, '   ', deps)).rejects.toThrow(/expects a value/)
  })
})

// --- the revoke line and the product id ---------------------------------------------------------

describe('config-written reflects the answers', () => {
  it('auto_revoke wires the automatic revoke line', async () => {
    expect(
      byId(await drive('sandbox', 'full'), 'config-written').text,
    ).toContain('- product `prod_ABC123` -> team `pro`, revoke: automatic')
  })

  it('log_only says access is kept, so it never reads as an automatic revoke', async () => {
    const record = byId(
      await drive('sandbox', 'full', { revokePolicy: 'log_only' }),
      'config-written',
    )
    expect(record.text).toContain(
      '- product `prod_ABC123` -> team `pro`, revoke: log only - access is kept on a refund',
    )
    expect(record.text).not.toContain('revoke: automatic')
  })

  it('a quick run wires the synthetic product id, a full run the real one', async () => {
    expect(
      byId(await drive('sandbox', 'quick'), 'config-written').text,
    ).toContain(`- product \`${QUICK_PRODUCT_ID}\` -> team \`pro\``)
    expect(
      byId(await drive('sandbox', 'full'), 'config-written').text,
    ).toContain('- product `prod_ABC123` -> team `pro`')
  })

  it('the config screen echoes the org and test buyer that were answered', async () => {
    const record = byId(await drive('sandbox', 'full'), 'config-written')
    expect(record.text).toContain('- your org: `acme`')
    expect(record.text).toContain('- test buyer: `octocat-test`')
  })
})

// --- placeholders -------------------------------------------------------------------------------

describe('placeholders', () => {
  it('fill substitutes a known slot and leaves an unknown one literal', async () => {
    expect(
      fill('org `YOUR-ORG`, acct `YOUR-ACCOUNT`', { 'YOUR-ORG': 'acme' }),
    ).toBe('org `acme`, acct `YOUR-ACCOUNT`')
  })

  it('fill replaces the longest key first, so a prefix cannot corrupt a longer slot', async () => {
    expect(
      fill('`YOUR-WORKER-URL` and `YOUR-WORKER`', {
        'YOUR-WORKER': 'w',
        'YOUR-WORKER-URL': 'https://w.example.com',
      }),
    ).toBe('`https://w.example.com` and `w`')
  })

  it('answer-derived slots are filled from the answers already collected', async () => {
    const records = await drive('sandbox', 'full')
    expect(byId(records, 'github-pat').text).toContain(
      '**Resource owner**: your organization (`acme`)',
    )
    expect(byId(records, 'refund').text).toContain(
      'Your worker should remove `octocat-test` from the team.',
    )
    // The team slot lives in the repo-attach reminder, which only a run that SKIPPED the attach carries.
    expect(
      byId(
        await drive('sandbox', 'full', { repoAttached: 'skipped' }),
        'closing',
      ).text,
    ).toContain('to team `pro` at Read')
  })

  it('the org question keeps YOUR-ORG literal, because no org has been answered yet', async () => {
    expect(byId(await drive('sandbox', 'full'), 'github-org').text).toContain(
      '(the part in the URL: `github.com/YOUR-ORG`)',
    )
  })

  it('the account name comes from the real whoami, not a guess', async () => {
    // The preflight probe ran `wrangler whoami` and parsed the account out of it.
    expect(byId(await drive('sandbox', 'full'), 'preflight').text).toContain(
      'Cloudflare login - OK, signed in as `acme-co`',
    )
  })

  it('resolve-url-derived slots are filled from the step that resolved them', async () => {
    // These stayed literal while the driver could not run resolve-url. It runs it now, so the deployer
    // reads their real worker URL and the real generated path - the exact string they paste into Stripe.
    const records = await drive('sandbox', 'full')
    expect(byId(records, 'worker-url-confirmed').text).toContain(
      '`https://repoaccess-core.acme-dev.workers.dev`',
    )
    expect(byId(records, 'webhook-secret').text).toContain(
      `\`https://repoaccess-core.acme-dev.workers.dev/wh/stripe/${FAKE_SECRET_PATH}0\``,
    )
    for (const record of records) {
      expect(record.text ?? '', record.id).not.toContain('YOUR-WORKER-URL')
      expect(record.text ?? '', record.id).not.toContain('YOUR-SECRET-PATH')
    }
  })

  it('a production run fills the payment-link and webhook URLs with the custom domain', async () => {
    const records = await drive('production', 'full')
    expect(byId(records, 'payment-link').text).toContain(
      '`https://access.example.com/claim/by-txn/stripe/{CHECKOUT_SESSION_ID}`',
    )
    expect(byId(records, 'webhook-secret').text).toContain(
      '`https://access.example.com/wh/stripe/',
    )
  })

  it('facts exposes only the answer-derived slots', async () => {
    const state = {
      cursor: 'closing',
      answers: { env: 'sandbox', goal: 'full', org: 'acme', team: 'pro' },
      flags: {},
    }
    expect(facts(state as never)).toEqual({
      'YOUR-ORG': 'acme',
      'TEAM-SLUG': 'pro',
      'SECRETS-FILE': '`.dev.vars`',
    })
  })

  it('productIdFor is the synthetic id on quick and the answered id on full', async () => {
    expect(productIdFor({ answers: { goal: 'quick' } } as never)).toBe(
      QUICK_PRODUCT_ID,
    )
    expect(
      productIdFor({ answers: { goal: 'full', productId: 'prod_X' } } as never),
    ).toBe('prod_X')
  })
})

// --- mechanical guards on every shipped string --------------------------------------------------
//
// These are the rules that only ever held because someone remembered them. They hold now because a test
// fails when they do not.

/** The argv an agent running a record's printed `command` verbatim would hand the driver. */
const argvOf = (command: string): string[] => command.split(' ').slice(3)

/** A state parked on `id`'s recovery, so the recovery records are built by the driver, never by hand. */
const parkedState = (
  id: string,
  env: WizardEnv,
  policy: string,
): WizardState => ({
  cursor: id,
  answers: {
    env,
    goal: 'full',
    org: 'acme',
    team: 'pro',
    testBuyer: 'octocat-test',
    domain: 'access.example.com',
    productId: 'prod_ABC123',
    revokePolicy: policy as RevokePolicy,
  },
  flags: {},
  recovery: { detail: null },
})

/** Every RECOVERY record too - those strings are user-facing prose and get the same guards. */
const recoveryRecordsFor = (env: WizardEnv, policy: string): WizardRecord[] =>
  SCREEN_IDS.map((id) => currentRecord(parkedState(id, env, policy)))

/** What a screen RENDERS when it is not parked - i.e. the type its recovery is parked on. */
const buildAt = (id: string, env: WizardEnv): string =>
  currentRecord({ ...parkedState(id, env, 'auto_revoke'), recovery: null }).type

describe('guards on the emitted text', () => {
  const everyRecord = async (): Promise<WizardRecord[]> => {
    const all: WizardRecord[] = []
    for (const env of ['sandbox', 'production'] as WizardEnv[]) {
      for (const goal of ['full', 'quick'] as WizardGoal[]) {
        all.push(...(await drive(env, goal)))
        all.push(...(await drive(env, goal, { revokePolicy: 'log_only' })))
      }
      for (const policy of ['auto_revoke', 'log_only']) {
        all.push(...recoveryRecordsFor(env, policy))
      }
    }
    // The subdomain question in its no-candidate rendering, which no other run above emits.
    all.push(
      ...(await drive('sandbox', 'full', { deps: noSubdomainCandidate })),
    )
    return all
  }

  // Every user-facing string a record carries, including a recovery's modes - the guards below must
  // cover recovery text too, not just screen text.
  const textsOf = (record: WizardRecord): string[] => [
    ...(record.text ? [record.text] : []),
    ...(record.note ? [record.note] : []),
    ...(record.detail ? [record.detail] : []),
    ...(record.modes ?? []).flatMap((m) => [m.when, m.text]),
    ...(record.options ?? []).flatMap((o) => [o.label, o.description]),
  ]

  it('no emitted string contains an em-dash', async () => {
    // Written as an escape, not the literal character: the repo bans em-dashes everywhere, and a guard
    // that spelled its own subject out would be the one file a tree-wide grep for them trips on.
    const EM_DASH = '\u2014'
    for (const record of await everyRecord()) {
      for (const text of textsOf(record)) {
        expect(text, record.id).not.toContain(EM_DASH)
      }
    }
  })

  it('no placeholder is wrapped in angle brackets', async () => {
    // Angle-bracket placeholders get HTML-escaped by some agent renderers and reach the deployer as a
    // literal `&lt;team-slug&gt;`, which reads as a broken wizard.
    for (const record of await everyRecord()) {
      for (const text of textsOf(record)) {
        expect(text, record.id).not.toMatch(/<[A-Za-z][A-Za-z0-9_-]*>/)
      }
    }
  })

  it('every screen id is unique and every screen is reachable in some run', async () => {
    expect(new Set(SCREEN_IDS).size).toBe(SCREEN_IDS.length)
    const reached = new Set((await everyRecord()).map((r) => r.id))
    expect([...SCREEN_IDS].sort()).toEqual([...reached].sort())
  })

  it('no emitted string carries a dev-only cross-reference', async () => {
    // The clone has no ADRs, no journal and no PRD, so such a pointer reads as a missing deliverable.
    for (const record of await everyRecord()) {
      for (const text of textsOf(record)) {
        expect(text, record.id).not.toMatch(
          /ADR-\d|AGENTS\.md|CLAUDE\.md|journal\/|PRD\s*§/i,
        )
      }
    }
  })
})

// --- every record prints its own command --------------------------------------------------------
//
// The agent COPIES a string instead of COMPOSING one. A live acceptance run on a cheap model composed
// `cd <path> && npm run wizard:drive -- next 2>&1 | head -50`: a compound the harness escalates whatever
// the allowlist says, a bare `next` the driver silently ignores, and a pipe that can truncate the record
// being rendered. Every defect there is a composing defect, so the driver stops asking anyone to compose.

describe('the command every record prints', () => {
  // The ENTIRE command surface, BARE WORDS only. Written out literally rather than built from the
  // driver's own constants: a test that derived them would follow a drift instead of catching it. No
  // `--` anywhere - that is the token PowerShell consumes before npm sees it, which is what broke the
  // earlier flag forms on Windows.
  const FORMS = [
    'npm run wizard:drive next',
    'npm run wizard:drive answer YOUR-ANSWER',
    'npm run wizard:drive answer done',
  ]

  const everyRecord = async (): Promise<WizardRecord[]> => {
    const all: WizardRecord[] = []
    for (const env of ['sandbox', 'production'] as WizardEnv[]) {
      for (const goal of ['full', 'quick'] as WizardGoal[]) {
        all.push(...(await drive(env, goal)))
        all.push(...(await drive(env, goal, { revokePolicy: 'log_only' })))
      }
      for (const policy of ['auto_revoke', 'log_only']) {
        all.push(...recoveryRecordsFor(env, policy))
      }
    }
    // The subdomain question in its no-candidate rendering, which no other run above emits.
    all.push(
      ...(await drive('sandbox', 'full', { deps: noSubdomainCandidate })),
    )
    return all
  }

  it('is one of the three documented forms, on every record', async () => {
    for (const record of await everyRecord()) {
      expect(FORMS, `${record.id} (${record.type})`).toContain(record.command)
    }
  })

  it('uses all three forms and never a fourth', async () => {
    // The completeness half. Without it a typo in a FORM entry that no record emits would still pass the
    // test above, which would then be green for a reason nobody checked.
    const emitted = new Set((await everyRecord()).map((r) => r.command))
    expect([...emitted].sort()).toEqual([...FORMS].sort())
  })

  it('carries no `--` and no shell-specific syntax, so it is identical in PowerShell and bash', async () => {
    // The guard for shell-neutrality. `--` leads the list for a reason: PowerShell consumes a bare `--`
    // as its own stop-parsing token, so npm reads the next word as an npm flag and errors on Windows -
    // the whole reason the surface is bare words. The rest are what turn the plain call into a compound
    // the harness escalates on EVERY call, defeating prompt-free.
    const BANNED = ['--', '&&', '|', '>', '<', ';', '$', '`', '"', "'"]
    for (const record of await everyRecord()) {
      for (const ch of BANNED) {
        expect(record.command, `${record.id} contains ${ch}`).not.toContain(ch)
      }
    }
  })

  it('matches the record type: say takes next, ask a value, do the word done', async () => {
    for (const record of await everyRecord()) {
      if (record.type === 'say')
        expect(record.command, record.id).toBe(FORMS[0])
      if (record.type === 'ask')
        expect(record.command, record.id).toBe(FORMS[1])
      if (record.type === 'do') expect(record.command, record.id).toBe(FORMS[2])
    }
  })

  it('a recovery parked on an ask asks for a value; every other recovery asks for done', async () => {
    // A recovery does NOT inherit its parked screen's form. Only `done` re-attempts a parked verify, so
    // a say-parked recovery printing the say's own `next` would re-emit itself forever - see the
    // round-trip guard below, which is what makes that unwireable rather than merely discouraged.
    for (const env of ['sandbox', 'production'] as WizardEnv[]) {
      for (const record of recoveryRecordsFor(env, 'auto_revoke')) {
        const parked = buildAt(record.id, env)
        const want = parked === 'ask' ? FORMS[1] : FORMS[2]
        expect(record.command, `${record.id} parked on ${parked}`).toBe(want)
      }
    }
  })

  // --- and every OPTION of a closed choice prints its own ---------------------------------------
  //
  // The record-level `command` on a choice can only be the `YOUR-ANSWER` placeholder, and filling it in
  // is a composing step. A live run proved that is enough of an opening: it rendered the env choice as a
  // numbered type-your-answer list and asked the deployer to hand-type `sandbox`. Pre-composing every
  // option closes it - the fallback path copies a string like every other path.

  const everyOption = async (): Promise<
    { id: string; option: ChoiceOption }[]
  > =>
    (await everyRecord())
      .filter((r) => r.kind === 'choice')
      .flatMap((r) => (r.options ?? []).map((option) => ({ id: r.id, option })))

  it('is `answer` + the option value, on every option of every closed choice', async () => {
    // Written out literally rather than built from the driver's prefix: a test that derived it would
    // follow a drift instead of catching it.
    for (const { id, option } of await everyOption()) {
      expect(option.command, `${id}/${option.value}`).toBe(
        `npm run wizard:drive answer ${option.value}`,
      )
    }
  })

  it('covers all five closed choices and every value they accept', async () => {
    // The completeness half. Without it a choice the driver forgot to give commands to would simply not
    // appear above, and the guard would be green for a reason nobody checked.
    const seen = new Map<string, string[]>()
    for (const { id, option } of await everyOption()) {
      if (!seen.has(id)) seen.set(id, [])
      const values = seen.get(id)!
      if (!values.includes(option.value)) values.push(option.value)
    }
    expect(Object.fromEntries([...seen].sort())).toEqual({
      env: ['sandbox', 'production'],
      goal: ['full', 'quick'],
      'github-team-lock': ['attached', 'skipped'],
      'revoke-policy': ['auto_revoke', 'log_only'],
      'typo-test': ['test', 'skip'],
    })
  })

  it('carries no `--` and no shell-specific syntax either', async () => {
    // Same shell-neutrality bar as the record-level forms: an option command is run in PowerShell and
    // bash alike, so it must be byte-identical in both.
    const BANNED = ['--', '&&', '|', '>', '<', ';', '$', '`', '"', "'"]
    for (const { id, option } of await everyOption()) {
      for (const ch of BANNED) {
        expect(
          option.command,
          `${id}/${option.value} contains ${ch}`,
        ).not.toContain(ch)
      }
    }
  })

  it('an option command really answers with that option, through the driver own parser', async () => {
    // The round trip, which is the only thing that makes "run it as printed" true. A command that parsed
    // back to some other value - or to a value the closed choice rejects - would still pass every string
    // pin above.
    for (const { id, option } of await everyOption()) {
      expect(
        parseDriverArgs(argvOf(option.command)),
        `${id}/${option.value}`,
      ).toEqual({ answer: option.value })
    }
  })
})

// --- the env seam -------------------------------------------------------------------------------
//
// The driver says 'sandbox' because that is the word the human chose. The step functions say null, and
// their CLI collapses `sandbox` to null on the way in for that reason. Getting this wrong is not subtle
// in production and completely silent in a mocked test, which is how it survived phase 2.

describe('the env the STEPS are given', () => {
  it('translates sandbox to null, and production to production', async () => {
    expect(stepEnv({ answers: { env: 'sandbox' } } as never)).toBeNull()
    expect(stepEnv({ answers: { env: 'production' } } as never)).toBe(
      'production',
    )
  })

  it('every step call in a sandbox run is given null, never the word sandbox', async () => {
    // `deploy({env:'sandbox'})` reads env.sandbox out of wrangler.jsonc - a key that does not exist - so
    // it refuses on a placeholder KV id even when the real id is wired, and would otherwise have run
    // `--env sandbox --secrets-file .dev.vars.production`: wrong env, wrong secrets file.
    const seen: Record<string, unknown[]> = {}
    const record =
      (name: string, result: unknown) => (opts: { env?: unknown }) => {
        ;(seen[name] ??= []).push(opts.env)
        return result
      }
    await drive('sandbox', 'full', {
      deps: {
        preflight: record('preflight', { checks: [{ name: AUTH, ok: true }] }),
        githubVerify: record('githubVerify', { checks: [] }),
        secretsCheck: record('secretsCheck', { checks: [] }),
        deploy: record('deploy', { checks: [] }),
        e2e: record('e2e', { checks: [] }),
        kvCreate: record('kvCreate', { checks: [] }),
        resolveUrl: (opts: Record<string, string>) => {
          ;(seen.resolveUrl ??= []).push(opts.env)
          return resolveUrlFake()(opts)
        },
      },
    })
    for (const [step, envs] of Object.entries(seen)) {
      expect(envs.length, step).toBeGreaterThan(0)
      for (const env of envs) expect(env, step).toBeNull()
    }
  })

  it('a production run passes production through unchanged', async () => {
    const seen: unknown[] = []
    await drive('production', 'quick', {
      deps: {
        deploy: (opts: { env?: unknown }) => {
          seen.push(opts.env)
          return { checks: [] }
        },
      },
    })
    expect(seen).toEqual(['production'])
  })
})

// --- config-write: the two deployer files -------------------------------------------------------
//
// The generator is the reason this phase exists: nothing else writes these files, and a wrong byte in
// either is a worker that deploys green and grants nobody anything. So the tests drive the REAL
// templates and assert the exact entries, never "it wrote something".

/** Drive a whole run and hand back the fake disk it wrote to. */
async function driveWithFs(
  env: WizardEnv,
  goal: WizardGoal,
  overrides: Partial<WizardAnswers> & { seed?: Record<string, string> } = {},
) {
  const { seed, ...answerOverrides } = overrides
  const fs = makeFs(seed)
  await drive(env, goal, { ...answerOverrides, deps: fs })
  return fs
}

/**
 * Load a generated config exactly the way the wizard's own steps do - native `.ts` import, which is what
 * `loadConfig` uses and why the wizard has a Node floor. Anything less (eval, a regex) would test a
 * parser we do not ship; this proves the file Node itself will load.
 */
let cfgSeq = 0
async function loadProfiles(source: string) {
  const dir = mkdtempSync(join(tmpdir(), 'repoaccess-cfg-'))
  const file = join(dir, `config${cfgSeq++}.ts`)
  writeFileSync(file, source)
  try {
    const mod = await import(pathToFileURL(file).href)
    return mod as {
      sandbox: Record<string, any>
      production: Record<string, any>
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('config-write generates src/config/repoaccess.config.ts', () => {
  it('writes the run profile with the exact product -> team entry, under the adapter key', async () => {
    const fs = await driveWithFs('sandbox', 'full')
    const { sandbox } = await loadProfiles(fs.files[CONFIG_PATH])

    expect(sandbox.githubOrg).toBe('acme')
    // The nesting is load-bearing: resolveProductConfig reads map[adapter][product_id]. A ProductConfig
    // parked on the adapter key typechecks and then resolves to nothing - the 200-and-no-grant trap.
    expect(sandbox.productTeamMap.stripe['prod_ABC123']).toEqual({
      teams: ['pro'],
      grant_mode: 'username',
      revoke_policy: { mode: 'auto_revoke' },
    })
    // defaults must survive: the Workflow asserts it and throws without it.
    expect(sandbox.productTeamMap.defaults).toEqual({
      teams: [],
      grant_mode: 'claim',
      revoke_policy: { mode: 'log_only' },
    })
    expect(sandbox.e2e).toEqual({
      testUsername: 'octocat-test',
      url: SANDBOX_BASE,
      secretPath: `${FAKE_SECRET_PATH}0`,
    })
  })

  it('the revoke_policy is the 6a choice, not a default', async () => {
    const fs = await driveWithFs('sandbox', 'full', {
      revokePolicy: 'log_only',
    })
    const { sandbox } = await loadProfiles(fs.files[CONFIG_PATH])
    expect(sandbox.productTeamMap.stripe['prod_ABC123'].revoke_policy).toEqual({
      mode: 'log_only',
    })
  })

  it('a quick run wires the synthetic product id', async () => {
    const fs = await driveWithFs('sandbox', 'quick')
    const { sandbox } = await loadProfiles(fs.files[CONFIG_PATH])
    expect(Object.keys(sandbox.productTeamMap.stripe)).toEqual([
      QUICK_PRODUCT_ID,
    ])
  })

  it('BOTH profiles exist and are valid, so both worker entries still typecheck', async () => {
    // tsc checks src/index.ts (sandbox) AND src/index.production.ts (production). A run that configured
    // one profile must still leave the other one a valid config, not a hole.
    for (const env of ['sandbox', 'production'] as WizardEnv[]) {
      const fs = await driveWithFs(env, 'full')
      const { sandbox, production } = await loadProfiles(fs.files[CONFIG_PATH])
      for (const [name, profile] of Object.entries({ sandbox, production })) {
        expect(typeof profile.githubOrg, `${env}/${name}`).toBe('string')
        expect(profile.productTeamMap.defaults, `${env}/${name}`).toBeDefined()
        expect(
          Array.isArray(profile.productTeamMap.defaults.teams),
          `${env}/${name}`,
        ).toBe(true)
      }
    }
  })

  it('the profile this run did not configure stays NEUTRAL', async () => {
    const fs = await driveWithFs('sandbox', 'full')
    const { production } = await loadProfiles(fs.files[CONFIG_PATH])
    expect(production.githubOrg).toBe('')
    expect(Object.keys(production.productTeamMap)).toEqual(['defaults'])
  })

  it('a second run PRESERVES the profile it did not collect answers for (D5)', async () => {
    // The failure this guards: a production run silently resetting the sandbox worker's org and product
    // map, which nothing would notice until the next sandbox deploy granted nobody anything.
    const first = await driveWithFs('sandbox', 'full')
    const second = await driveWithFs('production', 'full', {
      seed: { [CONFIG_PATH]: first.files[CONFIG_PATH] },
      org: 'acme-live',
      productId: 'prod_LIVE',
    })
    const { sandbox, production } = await loadProfiles(
      second.files[CONFIG_PATH],
    )

    expect(sandbox.githubOrg).toBe('acme')
    expect(sandbox.productTeamMap.stripe['prod_ABC123']).toBeDefined()
    expect(production.githubOrg).toBe('acme-live')
    expect(production.productTeamMap.stripe['prod_LIVE']).toBeDefined()
  })

  it('preserves the template comments that explain the config', async () => {
    const fs = await driveWithFs('sandbox', 'full')
    const text = fs.files[CONFIG_PATH]
    expect(text).toContain('SPDX-License-Identifier: AGPL-3.0-or-later')
    expect(text).toContain(
      "SECRETS are NOT here: `GITHUB_TOKEN`, the adapters' `*_WEBHOOK_SECRET`",
    )
    expect(text).toContain('`defaults.teams` is EMPTY')
  })

  it('an awkward value is DATA, not syntax - it cannot break or inject into the file', async () => {
    const nasty = 'ev"il\\, teams: [] } //'
    const fs = await driveWithFs('sandbox', 'full', { org: nasty })
    const { sandbox } = await loadProfiles(fs.files[CONFIG_PATH])
    // It survives as a plain string, and the surrounding config is intact - not truncated or reshaped.
    expect(sandbox.githubOrg).toBe(nasty)
    expect(sandbox.productTeamMap.stripe['prod_ABC123'].teams).toEqual(['pro'])
  })

  it('setProfile refuses a file whose export it cannot find, rather than guessing', async () => {
    expect(setProfile('export const other = 1\n', 'sandbox', '{}')).toBeNull()
  })
})

describe('config-write generates wrangler.jsonc', () => {
  it('wires this env KV id into the real template, and leaves the other env alone', async () => {
    const fs = await driveWithFs('sandbox', 'full')
    const wrangler = parseJsonc(fs.files[WRANGLER_PATH])
    expect(wrangler.kv_namespaces[0].id).toBe(KV_ID)
    // The production id is untouched: a sandbox run never provisions or wires production.
    expect(wrangler.env.production.kv_namespaces[0].id).toBe(
      'PLACEHOLDER_PRODUCTION_ENTITLEMENTS_REPLACE_ME',
    )
    // And the id the deploy step reads is no longer a placeholder - the whole point.
    expect(fs.files[WRANGLER_PATH]).not.toContain(
      'PLACEHOLDER_SANDBOX_ENTITLEMENTS_REPLACE_ME',
    )
  })

  it('a production run wires the production id and the custom-domain route', async () => {
    const fs = await driveWithFs('production', 'full')
    const wrangler = parseJsonc(fs.files[WRANGLER_PATH])
    expect(wrangler.env.production.kv_namespaces[0].id).toBe(PROD_KV_ID)
    // Without this route wrangler never serves the domain: it publishes to workers.dev, /health answers
    // there, and the run reports the worker live on a host it is not on.
    expect(wrangler.env.production.routes).toEqual([
      { pattern: 'access.example.com', custom_domain: true },
    ])
    expect(customDomainPattern(wrangler, 'production')).toBe(
      'access.example.com',
    )
  })

  it('a sandbox run leaves the route commented out, as the template ships it', async () => {
    const fs = await driveWithFs('sandbox', 'full')
    expect(
      customDomainPattern(parseJsonc(fs.files[WRANGLER_PATH]), 'production'),
    ).toBeNull()
  })

  it('preserves the comments and the other bindings', async () => {
    const fs = await driveWithFs('production', 'full')
    const text = fs.files[WRANGLER_PATH]
    expect(text).toContain('RepoAccess core worker bindings.')
    expect(text).toContain('Pending claims (TTL 30d), team slug')
    const wrangler = parseJsonc(text)
    expect(wrangler.workflows[0].name).toBe('oss-access-workflow')
    expect(wrangler.secrets.required).toEqual([
      'GITHUB_TOKEN',
      'STRIPE_WEBHOOK_SECRET',
    ])
    expect(wrangler.env.production.main).toBe('src/index.production.ts')
  })

  it('a second production run re-points an already-live route', async () => {
    const first = await driveWithFs('production', 'full')
    const second = await driveWithFs('production', 'full', {
      seed: { [WRANGLER_PATH]: first.files[WRANGLER_PATH] },
      domain: 'access2.example.com',
    })
    expect(
      customDomainPattern(
        parseJsonc(second.files[WRANGLER_PATH]),
        'production',
      ),
    ).toBe('access2.example.com')
  })

  it('an awkward domain is quoted as DATA and the file still parses', async () => {
    const text = setProductionRoute(WRANGLER_TEMPLATE, 'a"b.example.com')
    expect(customDomainPattern(parseJsonc(text!), 'production')).toBe(
      'a"b.example.com',
    )
  })

  it('setKvId refuses when it cannot uniquely locate the slot', async () => {
    expect(setKvId('{ "kv_namespaces": [] }', 'sandbox', KV_ID)).toBeNull()
  })

  it('the committed template still carries both slots this generator fills', async () => {
    // If a template edit removes the placeholder id or the commented route block, the generator has
    // nothing to fill - and the deploy would bind the wrong namespace or skip the domain. Fail here.
    expect(WRANGLER_TEMPLATE).toContain(
      'PLACEHOLDER_SANDBOX_ENTITLEMENTS_REPLACE_ME',
    )
    expect(WRANGLER_TEMPLATE).toContain(
      'PLACEHOLDER_PRODUCTION_ENTITLEMENTS_REPLACE_ME',
    )
    expect(
      setProductionRoute(WRANGLER_TEMPLATE, 'x.example.com'),
    ).not.toBeNull()
    expect(setProfile(CONFIG_TEMPLATE, 'sandbox', '{}')).not.toBeNull()
    expect(setProfile(CONFIG_TEMPLATE, 'production', '{}')).not.toBeNull()
  })
})

describe('emitValue keeps every deployer-supplied value as DATA', () => {
  it('quotes strings, including the awkward ones', async () => {
    expect(emitValue('plain')).toBe('"plain"')
    expect(emitValue('ev"il')).toBe('"ev\\"il"')
    expect(emitValue('back\\slash')).toBe('"back\\\\slash"')
  })

  it('quotes KEYS too - a product id is a key', async () => {
    expect(emitValue({ 'prod_a"b': { teams: [] } })).toContain('"prod_a\\"b"')
  })
})

// --- 4d: the handle must EXIST ------------------------------------------------------------------

describe('verify: the test buyer at 4d, continued', () => {
  const noSuchAccount = {
    createApi: () => ({
      get: async (path: string) =>
        path.startsWith('/users/')
          ? { status: 404, json: null }
          : { status: 200, json: { state: 'active' } },
    }),
  }

  it('a handle GitHub has never heard of parks on 4d, naming the spelling', async () => {
    // The gap this closes: `testBuyerCheck` asks "is this account in the org?" and reads 404 as "no" -
    // the right answer for a real outsider and the wrong one for a typo, because GitHub 404s both. So a
    // misspelled handle used to sail through and surface three screens later as E1's poll timing out.
    const { state, deps } = await driveTo('test-buyer', 'sandbox', 'full', {
      deps: noSuchAccount,
    })
    const next = await advance(state, 'octocat-tset', deps)
    expect(next.cursor).toBe('test-buyer')

    const record = currentRecord(next)
    expect(record.type).toBe('recovery')
    expect(record.detail).toContain('GitHub has no account called octocat-tset')
    expect(record.modes!.map((m) => m.when)).toContain('no such account')
  })

  it('an existing handle that is IN the org still fails, with the in-org recovery', async () => {
    const { state, deps } = await driveTo('test-buyer', 'sandbox', 'full', {
      deps: githubFailing(
        "test buyer 'octocat-test' is not in the org",
        "'octocat-test' is already a member or owner of 'acme', so it will NEVER receive an invite",
      ),
    })
    const next = await advance(state, 'octocat-test', deps)
    expect(next.cursor).toBe('test-buyer')
    const record = currentRecord(next)
    expect(record.detail).toContain('will NEVER receive an invite')
    expect(record.modes!.map((m) => m.when)).toContain('already in the org')
  })

  it('a real outsider passes and advances', async () => {
    const { state, deps } = await driveTo('test-buyer', 'sandbox', 'full')
    expect((await advance(state, 'octocat-test', deps)).cursor).toBe(
      'worker-url',
    )
  })
})

// --- resolve-url, e2e, and the persisted secret path --------------------------------------------

describe('the synthetic check gets what it needs to run', () => {
  it('e2e receives the resolved url and the persisted secret path', async () => {
    // Without a url the step returns `deployed worker URL provided: false` and never runs - E1 parked on
    // its recovery for every live run.
    let seen: Record<string, any> = {}
    await drive('sandbox', 'quick', {
      deps: {
        e2e: async (opts: Record<string, any>) => {
          seen = opts
          return { checks: [{ name: 'worker ack (2xx)', ok: true }] }
        },
      },
    })
    expect(seen.url).toBe(SANDBOX_BASE)
    expect(seen.config.e2e).toEqual({
      testUsername: 'octocat-test',
      url: SANDBOX_BASE,
      secretPath: `${FAKE_SECRET_PATH}0`,
    })
  })

  it('a resolve is handed the path the run already holds - it is random per call otherwise', async () => {
    // The deployer types this path into their Stripe endpoint URL and config-write writes it into the
    // config, so a second resolve that quietly minted a different one would leave the two disagreeing.
    //
    // The happy path now resolves ONCE per run - screen 5 asks for its input and resolves from the
    // answer, where it used to resolve on arrival as well - so this drives the seam directly rather than
    // counting calls. The state is one a resumed run really has: the path is in `flags` because a `npm
    // run wizard:drive` call rereads it from the state file, and nothing about that may re-mint it.
    const paths: string[] = []
    const deps = okDeps({ id: 'worker-url' }, 'auto_revoke', {
      resolveUrl: resolveUrlFake(paths),
    })
    const state = {
      cursor: 'worker-url',
      answers: { env: 'sandbox', goal: 'full', subdomain: 'acme-dev' },
      flags: { secretPath: 'kept-across-calls' },
      recovery: null,
    }
    const next = await advance(state as never, 'acme-dev', deps)
    expect(paths).toEqual(['kept-across-calls'])
    expect(next.flags.secretPath).toBe('kept-across-calls')
  })

  it('the path the deployer is told is the path the whole run uses', async () => {
    const paths: string[] = []
    const records = await drive('sandbox', 'full', {
      deps: { resolveUrl: resolveUrlFake(paths) },
    })
    expect(new Set(paths).size).toBe(1)
    expect(byId(records, 'webhook-secret').text).toContain(paths[0])
  })

  it('the screens and the written config agree on the url and the path', async () => {
    const fs = makeFs()
    const records = await drive('sandbox', 'full', { deps: fs })
    const { sandbox } = await loadProfiles(fs.files[CONFIG_PATH])
    expect(byId(records, 'webhook-secret').text).toContain(
      `${sandbox.e2e.url}/wh/stripe/${sandbox.e2e.secretPath}`,
    )
  })
})

// --- preflight gates on everything it claims -----------------------------------------------------

const AUTH = 'Cloudflare authenticated (wrangler whoami)'

describe('the preflight verify', () => {
  it('fails on a NON-auth check, not just the login', async () => {
    // The screen asserts "Node, wrangler, git - OK". Gating only on the login made every other one of
    // those claims decorative: an unsupported Node printed OK and the run walked on.
    const { state, deps } = await driveTo('preflight', 'sandbox', 'quick', {
      deps: {
        preflight: async () => ({
          checks: [
            { name: AUTH, ok: true },
            {
              name: 'node supports .ts config import (>= 22.18.0)',
              ok: false,
              fix: 'Upgrade Node to >= 22.18.0 for native .ts import - current 20.0.0',
            },
          ],
        }),
      },
    })
    const next = await advance(state, null, deps)
    expect(next.cursor).toBe('preflight')
    const record = currentRecord(next)
    expect(record.type).toBe('recovery')
    expect(record.detail).toContain('Upgrade Node to >= 22.18.0')
  })

  it('a missing template blocks too', async () => {
    const { state, deps } = await driveTo('preflight', 'sandbox', 'quick', {
      deps: {
        preflight: async () => ({
          checks: [
            { name: AUTH, ok: true },
            {
              name: '.dev.vars present',
              ok: false,
              fix: 'Restore .dev.vars.example (the secret-name template)',
            },
          ],
        }),
      },
    })
    expect((await advance(state, null, deps)).cursor).toBe('preflight')
  })

  it('an advisory preflight check does not block', async () => {
    const { state, deps } = await driveTo('preflight', 'sandbox', 'quick', {
      deps: {
        preflight: async () => ({
          checks: [
            { name: AUTH, ok: true },
            { name: 'something advisory', ok: false, severity: 'warn' },
          ],
        }),
      },
    })
    expect((await advance(state, null, deps)).cursor).toBe('github-org')
  })
})

// --- what the driver refuses to gate on ----------------------------------------------------------

describe('checks the driver never blocks on', () => {
  it('the org repo-creation policy is advice, not a gate', async () => {
    // It is red both when the policy is genuinely open AND when the worker PAT (repository access Public repositories)
    // simply cannot read it. Nothing can tell those apart, so gating could strand a correct setup at 4c
    // forever. It is a recommendation on the 4b screen instead.
    const { state, deps } = await driveTo('github-pat', 'sandbox', 'full', {
      deps: githubFailing(
        'members cannot create public repos',
        'Could not read the org repo-creation policy (the PAT may lack admin:org read)',
      ),
    })
    expect((await advance(state, 'done', deps)).cursor).toBe('test-buyer')
  })

  it('4b3 names it by the control the deployer can actually see', async () => {
    // "members can create public repositories" is the API field name, not anything on the settings page.
    // The dashboard control is Repository creation -> the Public checkbox. It lives on 4b3 now, whose
    // checklist covers both checkboxes; 4b2 carried a shorter version of the same advice and lost it
    // rather than say it twice.
    expect(byId(await drive('sandbox', 'full'), 'org-harden').text).toContain(
      "- **Repository creation** - uncheck Public and Private (members don't create repos).",
    )
    expect(
      byId(await drive('sandbox', 'full'), 'github-team-lock').text,
    ).not.toContain('Repository creation')
  })

  it('kv-create\'s "id set" check is not a gate - config-write is what sets it', async () => {
    const { state, deps } = await driveTo(
      'config-written',
      'sandbox',
      'quick',
      {
        deps: {
          kvCreate: async () => ({
            checks: [
              { name: 'ENTITLEMENTS namespace created (sandbox)', ok: true },
              {
                name: 'wrangler.jsonc ENTITLEMENTS id set (sandbox)',
                ok: false,
                fix: 'Set the ENTITLEMENTS kv_namespaces id to abcdef0123456789abcdef0123456789 in wrangler.jsonc (sandbox), then re-run',
              },
            ],
          }),
        },
      },
    )
    expect((await advance(state, null, deps)).cursor).toBe('secret-name-check')
  })

  it('but a kv-create failure that really blocks DOES stop the run', async () => {
    const { state, deps } = await driveTo(
      'config-written',
      'sandbox',
      'quick',
      {
        deps: {
          kvCreate: async () => ({
            checks: [
              {
                name: 'create ENTITLEMENTS namespace (sandbox)',
                ok: false,
                fix: 'Could not create the KV namespace (expected title repoaccess-core-ENTITLEMENTS)',
              },
            ],
          }),
        },
      },
    )
    const next = await advance(state, null, deps)
    expect(next.cursor).toBe('config-written')
    expect(currentRecord(next).detail).toContain(
      'Could not create the KV namespace',
    )
  })
})

// --- ordering: KV before config-write, config-write before deploy ---------------------------------

describe('the setup-execution order', () => {
  it('kv-create runs BEFORE config-write writes the id it reports', async () => {
    const order: string[] = []
    const fs = makeFs()
    await drive('sandbox', 'quick', {
      deps: {
        kvCreate: async () => {
          order.push('kv-create')
          return { checks: [] }
        },
        writeFile: (path: string, text: string) => {
          order.push(`write:${path}`)
          fs.writeFile(path, text)
        },
        readFile: fs.readFile,
        deploy: async () => {
          order.push('deploy')
          return { checks: [] }
        },
      },
    })
    expect(order).toEqual([
      'kv-create',
      `write:${CONFIG_PATH}`,
      `write:${WRANGLER_PATH}`,
      'deploy',
    ])
  })

  it('the deploy finds a real KV id, not the placeholder', async () => {
    const fs = await driveWithFs('sandbox', 'quick')
    expect(parseJsonc(fs.files[WRANGLER_PATH]).kv_namespaces[0].id).toBe(KV_ID)
  })
})

// --- the production deploy checks the host it told the deployer about -----------------------------

describe('the deploy verify', () => {
  it('passes the resolved custom domain as the expected base', async () => {
    // Without expectBase the step has nothing to compare the deployed host against, so a production
    // deploy that landed on workers.dev went green while the screen named the custom domain.
    let seen: Record<string, any> = {}
    await drive('production', 'quick', {
      deps: {
        deploy: async (opts: Record<string, any>) => {
          seen = opts
          return { checks: [] }
        },
      },
    })
    expect(seen.expectBase).toBe(PROD_BASE)
    expect(seen.env).toBe('production')
  })

  it('a sandbox run expects its workers.dev base', async () => {
    let seen: Record<string, any> = {}
    await drive('sandbox', 'quick', {
      deps: {
        deploy: async (opts: Record<string, any>) => {
          seen = opts
          return { checks: [] }
        },
      },
    })
    expect(seen.expectBase).toBe(SANDBOX_BASE)
  })
})

// --- confirming a parked deploy re-probes; it does not deploy again -------------------------------
//
// The deploy screen is `verifyOnArrival`, and its guard (`verifiedAt`) only covers the arrival that
// PASSED. When the wrangler half succeeded and only `/health` did not answer, nothing was measured, so
// `done` ran the whole step again - a second `wrangler deploy` to answer a question about the first.
// Live-observed as two versions two minutes apart, with the wizard's eventual green answering from the
// SECOND one. The published address is what tells the two apart: recorded on the way out (on the failure
// as much as on the pass), its presence means there is a worker to look at rather than a deploy to redo.

describe('a parked deploy is confirmed by re-probing, never by deploying again', () => {
  /**
   * A deploy whose wrangler half SUCCEEDS (so it resolves an address) and whose /health half fails.
   * `healthy` flips what the separate re-probe seam answers, so a test can let the retry pass.
   */
  const parkedDeploy = (state: { deploys: number; probes: unknown[] }) => ({
    deploy: async () => {
      state.deploys += 1
      return {
        url: SANDBOX_BASE,
        checks: [
          {
            name: "GET /health -> {status:'ok'} (sandbox)",
            ok: false,
            fix: 'The check never reached Cloudflare',
          },
        ],
      }
    },
    deployHealth: async (opts: unknown) => {
      state.probes.push(opts)
      return {
        checks: [{ name: "GET /health -> {status:'ok'} (sandbox)", ok: true }],
      }
    },
  })

  it('the retry calls the health path with the published address, and never deploys twice', async () => {
    const seen = { deploys: 0, probes: [] as unknown[] }
    const { state, deps } = await driveTo('deploy', 'sandbox', 'quick', {
      deps: parkedDeploy(seen),
    })
    expect(currentRecord(state).type).toBe('recovery')
    expect(seen.deploys).toBe(1)
    expect(seen.probes).toEqual([])
    // The address the deploy really published to is remembered even though the step FAILED - that is
    // exactly the state the retry has to tell apart from "nothing was deployed".
    expect(state.flags.deployedUrl).toBe(SANDBOX_BASE)

    const retried = await advance(state, 'done', deps)
    expect(seen.deploys, 'the retry must NOT deploy again').toBe(1)
    expect(seen.probes).toEqual([
      // no pre-probe pause: the deployer already spent their own minutes on the recovery and, if they
      // followed it, on a browser check of this very address.
      { env: null, url: SANDBOX_BASE, preProbeDelay: 0 },
    ])
    // The deployer's own confirmation is honoured: the run moves on to the measured say.
    expect(currentRecord(retried).type).toBe('say')
    expect(currentRecord(retried).id).toBe('deploy')
  })

  it('a production retry re-probes with the production env, still without deploying', async () => {
    const seen = { deploys: 0, probes: [] as unknown[] }
    const { state, deps } = await driveTo('deploy', 'production', 'quick', {
      deps: parkedDeploy(seen),
    })
    await advance(state, 'done', deps)
    expect(seen.deploys).toBe(1)
    expect(seen.probes).toEqual([
      { env: 'production', url: SANDBOX_BASE, preProbeDelay: 0 },
    ])
  })

  it('a re-probe that still fails re-parks and STILL does not deploy', async () => {
    const seen = { deploys: 0, probes: [] as unknown[] }
    const { state, deps } = await driveTo('deploy', 'sandbox', 'quick', {
      deps: {
        ...parkedDeploy(seen),
        deployHealth: async (opts: unknown) => {
          seen.probes.push(opts)
          return {
            checks: [
              {
                name: "GET /health -> {status:'ok'} (sandbox)",
                ok: false,
                fix: 'https://repoaccess-core.acme-dev.workers.dev/health answered HTTP 403.',
              },
            ],
          }
        },
      },
    })
    const retried = await advance(state, 'done', deps)
    expect(seen.deploys).toBe(1)
    expect(seen.probes.length).toBe(1)
    const record = currentRecord(retried)
    expect(record.type).toBe('recovery')
    expect(record.id).toBe('deploy')
    // The re-probe's own evidence reaches the deployer, so the second failure is not anonymous either.
    expect(record.detail).toContain('HTTP 403')
  })

  it('a deploy that has NOT run yet still deploys', async () => {
    // The arrival. Nothing is published, so there is nothing to probe and the step must run in full.
    const seen = { deploys: 0, probes: [] as unknown[] }
    await drive('sandbox', 'quick', {
      deps: {
        deploy: async () => {
          seen.deploys += 1
          return { url: SANDBOX_BASE, checks: [] }
        },
        deployHealth: async (opts: unknown) => {
          seen.probes.push(opts)
          return { checks: [] }
        },
      },
    })
    expect(seen.deploys).toBe(1)
    expect(seen.probes).toEqual([])
  })

  it('a deploy whose WRANGLER half failed re-deploys on retry - there is nothing to probe', async () => {
    // The step returns no address when `wrangler deploy` itself failed, and that absence is the whole
    // signal. Reading the parked recovery as "already deployed" here would strand the deployer on a
    // health check against a worker that was never published.
    const seen = { deploys: 0, probes: [] as unknown[] }
    let failing = true
    const { state, deps } = await driveTo('deploy', 'sandbox', 'quick', {
      deps: {
        deploy: async () => {
          seen.deploys += 1
          return failing
            ? {
                checks: [
                  {
                    name: 'wrangler deploy (sandbox)',
                    ok: false,
                    fix: 'wrangler deploy failed. wrangler said: workerd/server error [code: 10057]',
                  },
                ],
              }
            : { url: SANDBOX_BASE, checks: [] }
        },
        deployHealth: async (opts: unknown) => {
          seen.probes.push(opts)
          return { checks: [] }
        },
      },
    })
    expect(currentRecord(state).type).toBe('recovery')
    expect(state.flags.deployedUrl).toBeUndefined()

    failing = false
    const retried = await advance(state, 'done', deps)
    expect(seen.deploys, 'the retry must deploy, not probe').toBe(2)
    expect(seen.probes).toEqual([])
    expect(currentRecord(retried).type).toBe('say')
  })

  it('a deploy that published but resolved NO address also re-deploys', async () => {
    // wrangler succeeded, the output carried no workers.dev URL and no custom domain is wired: the step
    // has nothing to health-check, so it returns no address and the retry is a deploy like any first one.
    const seen = { deploys: 0, probes: [] as unknown[] }
    const { state, deps } = await driveTo('deploy', 'sandbox', 'quick', {
      deps: {
        deploy: async () => {
          seen.deploys += 1
          return {
            checks: [
              {
                name: 'deployed (sandbox)',
                ok: false,
                fix: 'Deploy succeeded but the worker URL could not be parsed from wrangler output',
              },
            ],
          }
        },
        deployHealth: async (opts: unknown) => {
          seen.probes.push(opts)
          return { checks: [] }
        },
      },
    })
    expect(state.flags.deployedUrl).toBeUndefined()
    await advance(state, 'done', deps)
    expect(seen.deploys).toBe(2)
    expect(seen.probes).toEqual([])
  })

  it('advancing off the measured say deploys nothing and probes nothing', async () => {
    // The case the existing arrival guard already covered, asserted here too so the new branch cannot
    // quietly take it over: a PASSING deploy records the address as well, and moving on must use neither.
    const seen = { deploys: 0, probes: [] as unknown[] }
    const { state, deps } = await driveTo('deploy', 'sandbox', 'quick', {
      deps: {
        deploy: async () => {
          seen.deploys += 1
          return { url: SANDBOX_BASE, checks: [] }
        },
        deployHealth: async (opts: unknown) => {
          seen.probes.push(opts)
          return { checks: [] }
        },
      },
    })
    expect(currentRecord(state).type).toBe('say')
    expect(state.flags.deployedUrl).toBe(SANDBOX_BASE)
    const moved = await advance(state, null, deps)
    expect(seen.deploys).toBe(1)
    expect(seen.probes).toEqual([])
    expect(moved.cursor).toBe('synthetic-check')
  })
})

// --- the CLI seam -------------------------------------------------------------------------------

describe('driver CLI arguments', () => {
  it('parses the bare-word forms the shim documents, and no flag form', async () => {
    expect(parseDriverArgs(['start'])).toEqual({ start: true })
    // `reset` is NOT a synonym for `start` any more: `start` refuses over a saved run, so reset is the
    // only word left that means discard it anyway. Parsing them to the same thing would erase the choice.
    expect(parseDriverArgs(['reset'])).toEqual({ reset: true })
    expect(parseDriverArgs(['next'])).toEqual({ next: true })
    expect(parseDriverArgs(['answer', 'sandbox'])).toEqual({
      answer: 'sandbox',
    })
    expect(parseDriverArgs(['answer', 'done'])).toEqual({ answer: 'done' })
    // `answer` takes everything after it, joined - so a multi-word value needs no quotes in any shell.
    expect(parseDriverArgs(['answer', 'my', 'org', 'name'])).toEqual({
      answer: 'my org name',
    })
    // The flag forms are gone: `--` is what PowerShell eats, so the shell-broken form is inexpressible.
    expect(parseDriverArgs(['--start'])).toEqual({})
    expect(parseDriverArgs(['--next'])).toEqual({})
    expect(parseDriverArgs(['--answer', 'sandbox'])).toEqual({})
  })

  it('every printed command parses back to the call it names', async () => {
    // The shim promises the command runs as printed. That is only true if the driver's own parser reads
    // it, so the round trip is asserted rather than assumed. The `-- next` a live run composed - which
    // PowerShell turned into an npm error - is not even a form here: no `--` reaches the parser.
    expect(parseDriverArgs(argvOf('npm run wizard:drive next'))).toEqual({
      next: true,
    })
    expect(parseDriverArgs(argvOf('npm run wizard:drive answer done'))).toEqual(
      {
        answer: 'done',
      },
    )
    expect(parseDriverArgs(argvOf('npm run wizard:drive start'))).toEqual({
      start: true,
    })
  })

  it('a rejected answer carries the form to call again with', async () => {
    // The one response with no record on it, and the one the agent most needs a command on: without it
    // this is exactly where a weak model starts composing. A rejected answer runs nothing and moves
    // nothing, so the call to make is the one the record it just answered already asked for.
    const cwd = mkdtempSync(join(tmpdir(), 'wizard-driver-err-'))
    try {
      await main(['start'], cwd, {} as never) // welcome
      const asked = await main(['next'], cwd, {} as never) // the env choice
      if ('done' in asked) throw new Error('the run ended before the env ask')
      expect(asked.id).toBe('env')

      // `env` is a closed choice, so a hand-typed value is a contract violation, not a setup fault.
      const err = await main(['answer', 'staging'], cwd, {} as never).catch(
        (e) => e,
      )
      expect(err).toBeInstanceOf(DriverError)
      expect(err.command).toBe(asked.command)
      expect(err.command).toBe('npm run wizard:drive answer YOUR-ANSWER')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  // --- `start` over a saved run ------------------------------------------------------------------
  //
  // The deploy recovery tells a blocked deployer their progress is saved and to come back later. `start`
  // is the word the shim documents for beginning a run, so the deployer who came back and followed it
  // would have destroyed exactly what they were promised - silently, and with no undo. The refusal is
  // what makes that promise keepable.

  it('start REFUSES over a saved run, and does not touch it', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'wizard-driver-start-'))
    try {
      await main(['start'], cwd, {} as never) // welcome
      const asked = await main(['next'], cwd, {} as never) // the env choice
      const saved = readFileSync(join(cwd, STATE_FILE), 'utf8')

      const err = await main(['start'], cwd, {} as never).catch((e) => e)
      expect(err).toBeInstanceOf(DriverError)
      expect(err.message).toBe(
        'A run is already in progress here and `start` would erase it. To RESUME where it left off, run `npm run wizard:drive` with no extra words. To DISCARD the saved run and begin fresh, run `npm run wizard:drive reset`.',
      )
      // The whole point: the run is still there afterwards, byte for byte.
      expect(readFileSync(join(cwd, STATE_FILE), 'utf8')).toBe(saved)
      // And the resume the refusal names really does land back on the same record.
      expect(await main([], cwd, {} as never)).toEqual(asked)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('reset still discards the saved run and begins fresh', async () => {
    // The escape hatch the refusal points at. If this stopped working the refusal would be a dead end.
    const cwd = mkdtempSync(join(tmpdir(), 'wizard-driver-reset-'))
    try {
      await main(['start'], cwd, {} as never)
      await main(['next'], cwd, {} as never) // the env choice
      const fresh = await main(['reset'], cwd, {} as never)
      expect(fresh).toMatchObject({ id: 'welcome' })
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('start still begins a run when there is no saved one', async () => {
    // The refusal must gate on the FILE, not on the word - a fresh clone has to be able to start.
    const cwd = mkdtempSync(join(tmpdir(), 'wizard-driver-fresh-'))
    try {
      expect(await main(['start'], cwd, {} as never)).toMatchObject({
        id: 'welcome',
      })
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})

// --- verifies: `done` is checked, not trusted ---------------------------------------------------
//
// Every test here names WHAT it expects: the record type, the step it parked on, and the identifying
// text of the failure. Asserting only "it failed" cannot tell a failed verify from a step that never
// ran, which is the false green this project keeps removing.

/** A github-verify result carrying exactly one failing check. */
const githubFailing = (name: string, fix: string) => ({
  githubVerify: async () => ({ checks: [{ name, ok: false, fix }] }),
})

describe('verify: the GitHub block at 4c', () => {
  it('passes when github-verify is green and advances to the test buyer', async () => {
    const { state, deps } = await driveTo('github-pat', 'sandbox', 'full')
    const next = await advance(state, 'done', deps)
    expect(next.cursor).toBe('test-buyer')
    expect(next.recovery).toBeFalsy()
  })

  it('a bad token parks on 4c and names the cause, without advancing', async () => {
    const { state, deps } = await driveTo('github-pat', 'sandbox', 'full', {
      deps: githubFailing(
        'GITHUB_TOKEN authenticates',
        'GITHUB_TOKEN is invalid or expired - regenerate the fine-grained PAT and set it in .dev.vars',
      ),
    })
    const next = await advance(state, 'done', deps)
    expect(next.cursor).toBe('github-pat')

    const record = currentRecord(next)
    expect(record.type).toBe('recovery')
    expect(record.id).toBe('github-pat')
    expect(record.retry).toBe('github-pat')
    // The LIVE cause, from the failing check's own fix - not a generic "something went wrong".
    expect(record.detail).toContain('regenerate the fine-grained PAT')
    expect(record.modes!.map((m) => m.when)).toContain(
      'token invalid or expired',
    )
  })

  it('a wrong ORG routes recovery back to 4a, the screen that owns it', async () => {
    const { state, deps } = await driveTo('github-pat', 'sandbox', 'full', {
      deps: githubFailing(
        "org 'acme' exists and is accessible",
        "Org 'acme' not found or the PAT cannot access it - verify the name and grant the token access at https://github.com/orgs/acme",
      ),
    })
    const next = await advance(state, 'done', deps)
    // NOT github-pat: a wrong org is re-asked at 4a, or the user is stranded on a `done` they cannot fix.
    expect(next.cursor).toBe('github-org')

    const record = currentRecord(next)
    expect(record.type).toBe('recovery')
    expect(record.id).toBe('github-org')
    expect(record.detail).toContain('not found or the PAT cannot access it')
    expect(record.modes!.map((m) => m.when)).toContain(
      'no organization at that slug',
    )
  })

  it('a wrong TEAM SLUG routes recovery back to 4b, so it can be re-asked', async () => {
    const { state, deps } = await driveTo('github-pat', 'sandbox', 'full', {
      deps: githubFailing(
        "team 'pro' exists",
        "Create team 'pro' at https://github.com/orgs/acme/new-team",
      ),
    })
    const next = await advance(state, 'done', deps)
    expect(next.cursor).toBe('github-team')

    const record = currentRecord(next)
    expect(record.id).toBe('github-team')
    expect(record.detail).toContain('new-team')
    expect(record.modes!.map((m) => m.when)).toContain('team not found')
  })

  it('an advisory check never blocks - the PAT cannot verify repo attachment', async () => {
    const { state, deps } = await driveTo('github-pat', 'sandbox', 'full', {
      deps: {
        githubVerify: async () => ({
          checks: [
            { name: 'GITHUB_TOKEN authenticates', ok: true },
            {
              name: "team 'pro' has a repo attached",
              ok: false,
              severity: 'warn',
              fix: 'The wizard cannot verify repo attachment with the worker PAT',
            },
          ],
        }),
      },
    })
    // A structural false-negative must not strand a correct setup.
    expect((await advance(state, 'done', deps)).cursor).toBe('test-buyer')
  })

  it('re-running the verify after a fix advances', async () => {
    let failing = true
    const { state, deps } = await driveTo('github-pat', 'sandbox', 'full', {
      deps: {
        githubVerify: async () =>
          failing
            ? {
                checks: [
                  {
                    name: 'GITHUB_TOKEN authenticates',
                    ok: false,
                    fix: 'invalid',
                  },
                ],
              }
            : { checks: [{ name: 'GITHUB_TOKEN authenticates', ok: true }] },
      },
    })
    const parked = await advance(state, 'done', deps)
    expect(currentRecord(parked).type).toBe('recovery')

    failing = false // the human fixed the token
    const fixed = await advance(parked, 'done', deps)
    expect(fixed.cursor).toBe('test-buyer')
  })
})

describe('verify: the test buyer at 4d', () => {
  it('an in-org buyer fails at 4d and names why an insider cannot test the flow', async () => {
    const { state, deps } = await driveTo('test-buyer', 'sandbox', 'full', {
      deps: githubFailing(
        "test buyer 'octocat-test' is not in the org",
        "'octocat-test' is already a member or owner of 'acme', so it will NEVER receive an invite",
      ),
    })
    const next = await advance(state, 'octocat-test', deps)
    expect(next.cursor).toBe('test-buyer')

    const record = currentRecord(next)
    expect(record.type).toBe('recovery')
    expect(record.id).toBe('test-buyer')
    expect(record.detail).toContain('will NEVER receive an invite')
    expect(record.modes!.map((m) => m.when)).toContain('already in the org')
  })
})

describe('verify: the secret name-check', () => {
  it('fails naming the missing name, and does not advance to the deploy', async () => {
    const { state, deps } = await driveTo(
      'secret-name-check',
      'sandbox',
      'full',
      {
        deps: {
          secretsCheck: async () => ({
            checks: [
              { name: 'GITHUB_TOKEN in .dev.vars', ok: true },
              {
                name: 'STRIPE_WEBHOOK_SECRET in .dev.vars',
                ok: false,
                fix: 'Add STRIPE_WEBHOOK_SECRET=... to .dev.vars (name only - the wizard never reads the value)',
              },
            ],
          }),
        },
      },
    )
    const next = await advance(state, null, deps)
    expect(next.cursor).toBe('secret-name-check')

    const record = currentRecord(next)
    expect(record.type).toBe('recovery')
    expect(record.detail).toContain(
      'Add STRIPE_WEBHOOK_SECRET=... to .dev.vars',
    )
    expect(record.modes!.map((m) => m.when)).toContain('a name is missing')
  })

  it('a production run checks .dev.vars.production, not .dev.vars', async () => {
    const seen: string[] = []
    const { state, deps } = await driveTo(
      'secret-name-check',
      'production',
      'quick',
      {
        deps: {
          secretsCheck: async ({ env }: { env: string | null }) => {
            seen.push(String(env))
            return {
              checks: [
                { name: 'GITHUB_TOKEN in .dev.vars.production', ok: true },
                {
                  name: 'STRIPE_WEBHOOK_SECRET in .dev.vars.production',
                  ok: true,
                },
              ],
            }
          },
        },
      },
    )
    expect((await advance(state, null, deps)).cursor).toBe('deploy')
    expect(seen).toContain('production')
  })

  it('the deployed-secrets half does NOT gate here - the deploy has not run yet', async () => {
    // A production secrets-check also asserts each name is uploaded to the worker, which cannot be true
    // before the one deploy that uploads them. Gating on it would be a false red at this step.
    const { state, deps } = await driveTo(
      'secret-name-check',
      'production',
      'quick',
      {
        deps: {
          secretsCheck: async () => ({
            checks: [
              { name: 'GITHUB_TOKEN in .dev.vars.production', ok: true },
              {
                name: 'STRIPE_WEBHOOK_SECRET in .dev.vars.production',
                ok: true,
              },
              {
                name: 'production secrets uploaded (wrangler secret list)',
                ok: false,
                fix: 'Could not list production secrets - this check needs a deployed worker',
              },
            ],
          }),
        },
      },
    )
    expect((await advance(state, null, deps)).cursor).toBe('deploy')
  })
})

describe('verify: the deploy and the synthetic check', () => {
  it('a failed /health parks on the deploy with the propagation guidance', async () => {
    const { state, deps } = await driveTo('deploy', 'production', 'quick', {
      deps: {
        deploy: async () => ({
          checks: [
            {
              name: '/health responds',
              ok: false,
              fix: 'The worker did not answer /health - a custom domain can take a while to provision',
            },
          ],
        }),
      },
    })
    const next = await advance(state, null, deps)
    expect(next.cursor).toBe('deploy')

    const record = currentRecord(next)
    expect(record.type).toBe('recovery')
    expect(record.detail).toContain('did not answer /health')
    expect(record.modes!.map((m) => m.when)).toContain(
      'health fails on a brand-new custom domain',
    )
    // The DNS diagnostic is deliberate: a brand-new name is usually a stale negative cache, not a
    // failed deploy, and we never tell the deployer to touch their WAF over it.
    const dns = record.modes!.find(
      (m) => m.when === 'health fails on a brand-new custom domain',
    )!
    expect(dns.text).toContain('nslookup access.example.com 1.1.1.1')
  })

  it('the synthetic check never reports green when the check failed', async () => {
    const { state, deps } = await driveTo(
      'synthetic-check',
      'sandbox',
      'quick',
      {
        deps: {
          e2e: async () => ({
            checks: [
              {
                name: 'worker ack (2xx)',
                ok: false,
                fix: 'The worker did not ack the signed webhook (status 401) - check the deploy and STRIPE_WEBHOOK_SECRET',
              },
            ],
          }),
        },
      },
    )
    const next = await advance(state, null, deps)
    expect(next.cursor).toBe('synthetic-check')

    const record = currentRecord(next)
    expect(record.type).toBe('recovery')
    // Emphatically NOT the "Synthetic check **green**" say.
    expect(record.text).toBeUndefined()
    expect(record.detail).toContain('did not ack the signed webhook')
    expect(record.modes!.map((m) => m.when)).toContain(
      'the worker did not accept the event',
    )
  })

  it('the synthetic check owns a 404 mode, so a propagating name is not read as a 401', async () => {
    // The live run hit `status 404` and the block's causes covered only 401 / no-invite / cleanup, so
    // the deployer read secret-mismatch advice for a name that had simply not propagated yet.
    const { state, deps } = await driveTo(
      'synthetic-check',
      'sandbox',
      'quick',
      {
        deps: {
          e2e: async () => ({
            checks: [
              {
                name: 'worker ack (2xx)',
                ok: false,
                fix: 'The worker did not ack the signed webhook (status 404)',
              },
            ],
          }),
        },
      },
    )
    const record = currentRecord(await advance(state, null, deps))
    const mode = record.modes!.find(
      (m) => m.when === 'the check reports status 404',
    )!
    expect(mode).toBeDefined()
    expect(mode.text).toContain('still propagating')
    // The retry is `done`, and the fallback is a browser read of /health - never "redeploy and hope".
    // The URL slot renders the run's REAL deployed address, so the deployer can click what they read.
    expect(mode.text).toContain('type **done** to retry')
    expect(mode.text).toContain(`\`${SANDBOX_BASE}/health\``)
    expect(mode.text).not.toContain('YOUR-WORKER-URL')
  })

  it('the first-deploy mode leads the no-invite causes, so a lagging engine is not read as a setup fault', async () => {
    // Live run 7: on a FIRST deploy the Workflows execution plane can lag - the worker acks, create()
    // succeeds, and the instance errors "Worker not found" before its first step. Every other no-invite
    // cause sends a deployer whose setup is FINE to go inspect it, so this one comes first.
    const { state, deps } = await driveTo(
      'synthetic-check',
      'sandbox',
      'quick',
      {
        deps: {
          e2e: async () => ({
            checks: [
              { name: 'worker ack (2xx)', ok: true },
              {
                name: 'invite created',
                ok: false,
                fix: 'No invite appeared in the poll window',
              },
            ],
          }),
        },
      },
    )
    const record = currentRecord(await advance(state, null, deps))
    const whens = record.modes!.map((m) => m.when)
    expect(whens).toContain('no invite right after the FIRST deploy')
    expect(
      whens.indexOf('no invite right after the FIRST deploy'),
    ).toBeLessThan(whens.indexOf('no invite appeared'))
    const mode = record.modes!.find(
      (m) => m.when === 'no invite right after the FIRST deploy',
    )!
    expect(mode.text).toBe(
      'On a brand-new worker the Workflows engine can lag the deploy by a minute or two - the event is accepted, but the workflow errors before its first step ("Worker not found" in the Cloudflare dashboard). Nothing is misconfigured: wait another minute, then type **done** to retry.',
    )
  })
})

// --- the pre-e2e pause ---------------------------------------------------------------------------
//
// Run 7's diagnosis: a FIRST deploy creates the workflow seconds before the synthetic event, and the
// Workflows EXECUTION plane can lag it - the worker acks, the instance is created, and it errors
// "Worker not found" before its first step. Nothing is misconfigured; the driver was simply too fast.
// So it waits on ARRIVAL, before the check. The sleep is a dep, so these tests spend none of it.

describe('the driver pauses before the synthetic check', () => {
  /** Record the order of the two calls that matter, so "before" is pinned rather than assumed. */
  const pauseDeps = () => {
    const calls: string[] = []
    return {
      calls,
      overrides: {
        sleep: async (ms: number) => {
          calls.push(`sleep:${ms}`)
        },
        e2e: async () => {
          calls.push('e2e')
          return { checks: [{ name: 'worker ack (2xx)', ok: true }] }
        },
      },
    }
  }

  it('sleeps ~45s exactly once, before the e2e call, in both envs and both goals', async () => {
    // ALWAYS, never "only when it looks like a first deploy": guessing which deploys are first is
    // guessing about prior state, and the window belongs to every real deployer's first deploy anyway.
    for (const env of ['sandbox', 'production'] as const) {
      for (const goal of ['full', 'quick'] as const) {
        const { calls, overrides } = pauseDeps()
        await drive(env, goal, { deps: overrides })
        expect(calls, `${env}/${goal}`).toEqual(['sleep:45000', 'e2e'])
      }
    }
  })

  it('does not sleep on a retry - the deployer has already spent their own minute on the recovery', async () => {
    // The recovery tells them to wait a minute and type `done`. Pausing again on the retry would spend
    // 45 more seconds on a wait they just performed themselves.
    let e2eCalls = 0
    const sleeps: number[] = []
    const { state, deps } = await driveTo(
      'synthetic-check',
      'sandbox',
      'quick',
      {
        deps: {
          sleep: async (ms: number) => {
            sleeps.push(ms)
          },
          e2e: async () => {
            e2eCalls += 1
            return e2eCalls === 1
              ? {
                  checks: [
                    {
                      name: 'worker ack (2xx)',
                      ok: false,
                      fix: 'The worker did not ack the signed webhook (status 404)',
                    },
                  ],
                }
              : { checks: [{ name: 'worker ack (2xx)', ok: true }] }
          },
        },
      },
    )
    // Arriving here is what `driveTo` just did: one pause, one failed check, a parked recovery.
    expect(currentRecord(state).type).toBe('recovery')
    expect(sleeps).toEqual([45_000])
    expect(e2eCalls).toBe(1)

    // The retry runs the check again and does NOT pause again.
    const retried = await advance(state, 'done', deps)
    expect(e2eCalls).toBe(2)
    expect(sleeps).toEqual([45_000])
    expect(currentRecord(retried).type).toBe('say')
  })

  it('is the synthetic check only - no other arrival pauses on the way there', async () => {
    // The three says that also run a step on arrival (config-written, secret-name-check, deploy) measure
    // things that are true the moment they are asked. A pause on any of them would be a wait nobody needs
    // and no screen announced. Stopping ON deploy means all three have already arrived and run.
    const { calls, overrides } = pauseDeps()
    await driveTo('deploy', 'sandbox', 'quick', { deps: overrides })
    expect(calls).toEqual([])
  })
})

// --- autonomous says report MEASURED results, never predictions ----------------------------------
//
// The live defect this section pins: the deploy screen printed "Checking `/health`... OK" and the health
// check then FAILED. Nothing was wrong with the words - they were emitted BEFORE the step that would
// have made them true. A `say` whose text reports an outcome runs its step on ARRIVAL and is emitted
// only on a pass; on a failure the recovery is emitted in its place.

/**
 * The four autonomous says whose text asserts a result: the step that measures it, the claim the text
 * makes, and a check that step can really fail on. The failing check is NAMED as the step names it -
 * secrets-check in particular gates on the LOCAL half only, so a generically-named check would not gate
 * and the test would prove nothing.
 */
const RESULT_SAYS = [
  {
    id: 'config-written',
    step: 'kvCreate',
    claim: 'Config wired',
    failing: {
      name: 'create ENTITLEMENTS namespace (sandbox)',
      ok: false,
      fix: 'Could not create the KV namespace',
    },
  },
  {
    id: 'secret-name-check',
    step: 'secretsCheck',
    claim: 'Both secret names are present',
    failing: {
      name: 'STRIPE_WEBHOOK_SECRET in .dev.vars',
      ok: false,
      fix: 'Add STRIPE_WEBHOOK_SECRET=... to .dev.vars',
    },
  },
  {
    id: 'deploy',
    step: 'deploy',
    claim: 'Checking `/health`... OK',
    failing: {
      name: 'GET /health',
      ok: false,
      fix: 'The worker did not answer /health',
    },
  },
  {
    id: 'synthetic-check',
    step: 'e2e',
    claim: 'Synthetic check **green**',
    failing: {
      name: 'worker ack (2xx)',
      ok: false,
      fix: 'The worker did not ack the signed webhook',
    },
  },
] as const

/**
 * Walk a run that is expected to FAIL, collecting every record emitted until it parks on a recovery.
 * `drive` cannot be used: a parked recovery never advances, so a failing run would spin to the guard.
 */
async function driveUntilParked(
  env: WizardEnv,
  goal: WizardGoal,
  depOverrides: Record<string, unknown> = {},
): Promise<WizardRecord[]> {
  const answers: WizardAnswers = { ...ANSWERS, env, goal }
  const cursor: { id: string | null } = { id: null }
  const deps = okDeps(cursor, 'auto_revoke', depOverrides)
  let state = initialState()
  const records: WizardRecord[] = []
  let guard = 0
  while (!isComplete(state)) {
    if (guard++ > 60) throw new Error('driver did not terminate')
    const record = currentRecord(state)
    cursor.id = record.id
    records.push(record)
    if (record.type === 'recovery') return records
    state = await advance(state, answerFor(record, answers), deps)
  }
  return records
}

describe('an autonomous say reports only a measured result', () => {
  it('each result say is emitted only AFTER its own step really ran, and ran once', async () => {
    // The regression this pins by ORDER, not by wording: with the record rendered first, `ran:deploy`
    // landed after `emitted:deploy` and the OK was a prediction.
    const log: string[] = []
    const answers: WizardAnswers = { ...ANSWERS, env: 'sandbox', goal: 'quick' }
    const cursor: { id: string | null } = { id: null }
    const base = okDeps(cursor, 'auto_revoke')
    const traced: Record<string, unknown> = { ...base }
    for (const { step } of RESULT_SAYS) {
      const real = base[step] as (o: unknown) => unknown
      traced[step] = async (opts: unknown) => {
        log.push(`ran:${step}`)
        return real(opts)
      }
    }

    let state = initialState()
    let guard = 0
    while (!isComplete(state)) {
      if (guard++ > 60) throw new Error('driver did not terminate')
      const record = currentRecord(state)
      cursor.id = record.id
      if (RESULT_SAYS.some((s) => s.id === record.id)) {
        log.push(`emitted:${record.id}`)
      }
      state = await advance(state, answerFor(record, answers), traced)
    }

    for (const { id, step } of RESULT_SAYS) {
      expect(log, id).toContain(`ran:${step}`)
      expect(log.indexOf(`ran:${step}`), id).toBeLessThan(
        log.indexOf(`emitted:${id}`),
      )
      // Arrival measures it; advancing off the say must not deploy (or re-send the event) again.
      expect(log.filter((l) => l === `ran:${step}`).length, id).toBe(1)
    }
  })

  it('a failed step emits recovery, and the say that would have claimed it worked is never emitted', async () => {
    for (const { id, step, claim, failing } of RESULT_SAYS) {
      const records = await driveUntilParked('sandbox', 'quick', {
        [step]: async () => ({ checks: [failing] }),
      })
      const last = records[records.length - 1]
      expect(last.id, id).toBe(id)
      expect(last.type, id).toBe('recovery')
      expect(last.text, id).toBeUndefined()
      for (const record of records) {
        expect(record.text ?? '', `${id} via ${record.id}`).not.toContain(claim)
      }
    }
  })

  it('the command a say-parked recovery prints really re-attempts the step', async () => {
    // The loop-closing guard, and the reason a say-parked recovery does NOT print the say's own form.
    // `next` here is a NO-OP: `advance` re-attempts a parked verify only on `done`, so a record that
    // printed `next` would hand the agent a command that re-emits the identical record forever. PROVEN
    // against this screen before the form was chosen - the deploy health check failing is not a
    // hypothetical, it is what the first live acceptance attempt hit.
    let failing = true
    let deploys = 0
    const { state, deps } = await driveTo('deploy', 'sandbox', 'quick', {
      deps: {
        deploy: async () => {
          deploys++
          return failing
            ? {
                checks: [
                  { name: 'GET /health', ok: false, fix: 'no answer yet' },
                ],
              }
            : { checks: [{ name: 'GET /health', ok: true }] }
        },
      },
    })
    const parked = currentRecord(state)
    expect(parked.type).toBe('recovery')
    expect(deploys).toBe(1)

    failing = false // the worker answers now, so a real re-attempt MUST pass
    // Run the record's OWN command, through the driver's OWN arg parser - the defect this guards against
    // is a command that parses to an answer the parked recovery ignores.
    const opts = parseDriverArgs(argvOf(parked.command))
    const retried = await advance(state, opts.answer, deps)
    expect(deploys, 'the printed command must re-run the step').toBe(2)
    expect(currentRecord(retried).type, 'and clear the recovery').toBe('say')
  })

  it('a step that passes on a retry THEN emits its say, now measured', async () => {
    let failing = true
    let deploys = 0
    const { state, deps } = await driveTo('deploy', 'sandbox', 'quick', {
      deps: {
        deploy: async () => {
          deploys++
          return failing
            ? {
                checks: [
                  { name: 'GET /health', ok: false, fix: 'no answer yet' },
                ],
              }
            : { checks: [{ name: 'GET /health', ok: true }] }
        },
      },
    })
    // Arrival measured a failure, so the deployer reads the recovery - never an unmeasured OK.
    expect(currentRecord(state).type).toBe('recovery')
    expect(currentRecord(state).id).toBe('deploy')
    expect(deploys).toBe(1)

    failing = false // the worker answered on the retry
    const retried = await advance(state, 'done', deps)
    expect(retried.cursor).toBe('deploy')
    const record = currentRecord(retried)
    expect(record.type).toBe('say')
    expect(record.text).toContain('Checking `/health`... OK')
    expect(deploys).toBe(2)

    // Advancing off the now-measured say moves on without deploying a third time.
    expect((await advance(retried, null, deps)).cursor).toBe('synthetic-check')
    expect(deploys).toBe(2)
  })
})

// --- the deploy recovery branches by env ---------------------------------------------------------

describe('the deploy recovery block branches by env', () => {
  const deployFailing = {
    deploy: async () => ({
      checks: [{ name: 'GET /health', ok: false, fix: 'no answer' }],
    }),
  }

  it('a sandbox run leads with the short mode - it has no custom domain to propagate', async () => {
    // The live failure: a workers.dev run was handed custom-domain DNS/cert advice as the LEAD, sending
    // the deployer hunting a problem a sandbox run cannot have.
    const { state } = await driveTo('deploy', 'sandbox', 'quick', {
      deps: deployFailing,
    })
    const record = currentRecord(state)
    expect(record.type).toBe('recovery')
    expect(record.modes!.map((m) => m.when)).toEqual([
      'the deploy itself failed - wrangler reported an API or upload error',
      'health fails right after a sandbox deploy',
      'the deployed host differs from the wired URL',
    ])
    const text = record.modes!.map((m) => m.text).join('\n')
    for (const alarming of [
      'NXDOMAIN',
      'ERR_NAME_NOT_RESOLVED',
      'nslookup',
      'ipconfig /flushdns',
      'certificate',
      'up to about 30',
    ]) {
      expect(text, alarming).not.toContain(alarming)
    }
  })

  it("the sandbox mode names the run's REAL worker URL, never a literal example host", async () => {
    // The slot must pass through the same fill() as a screen, or the deployer is told to open a host
    // that does not exist.
    const { state } = await driveTo('deploy', 'sandbox', 'quick', {
      deps: deployFailing,
    })
    const mode = currentRecord(state).modes!.find(
      (m) => m.when === 'health fails right after a sandbox deploy',
    )!
    expect(mode.text).toContain(
      'open `https://repoaccess-core.acme-dev.workers.dev/health` in your own browser',
    )
    expect(mode.text).not.toContain('YOUR-WORKER-URL')
  })

  // The live failure this pins: the agent read the recovery as an instruction to ITSELF and reached for a
  // browser tool. The wizard is agent-driven, so a recovery that says "open this in your browser" has two
  // possible readers and must name which one it means - and must say what the agent does instead.
  it('both health modes name the DEPLOYER as the one who opens a browser, and the agent as the one who re-probes', async () => {
    const healthMode = async (env: WizardEnv, when: string) => {
      const { state } = await driveTo('deploy', env, 'quick', {
        deps: deployFailing,
      })
      return currentRecord(state).modes!.find((m) => m.when === when)!
    }
    const modes = [
      await healthMode('sandbox', 'health fails right after a sandbox deploy'),
      await healthMode(
        'production',
        'it loads in my browser but the check fails',
      ),
    ]
    for (const mode of modes) {
      // addressed to the deployer, explicitly and by name
      expect(mode.text, mode.when).toContain(
        'Deployer, this one is yours to look at, not mine:',
      )
      expect(mode.text, mode.when).toContain('in your own browser')
      // and the agent's own next action, stated so it cannot be read as "go and browse"
      expect(mode.text, mode.when).toContain(
        'I do not open a browser - I re-probe the worker from here.',
      )
      // ... nor as "deploy it again". This is a claim about verifyDeploy, asserted below, not a comfort
      // phrase: a parked deploy whose wrangler half succeeded re-probes the recorded address.
      expect(mode.text, mode.when).toContain('never deploys a second one')
    }
  })

  it('a production run keeps the custom-domain modes', async () => {
    const { state } = await driveTo('deploy', 'production', 'quick', {
      deps: deployFailing,
    })
    expect(currentRecord(state).modes!.map((m) => m.when)).toEqual([
      'the deploy itself failed - wrangler reported an API or upload error',
      'health fails on a brand-new custom domain',
      'it loads in my browser but the check fails',
      'the deployed host differs from the wired URL',
    ])
  })

  // The mode for the deploy failure that is nobody's setup. Live run 6 hit a real Cloudflare Workflows
  // outage - the dashboard itself was returning `workflows.api.error.internal_server` - and every mode the
  // block had sent the deployer to inspect a setup that was fine. It LEADS both blocks because when it is
  // the cause, every other mode is actively wrong; it is byte-identical in both because an API outage is
  // not env-specific.
  it('leads BOTH env blocks with the API-error mode, byte-identical in each', async () => {
    const modeFor = async (env: WizardEnv) =>
      currentRecord(
        (await driveTo('deploy', env, 'quick', { deps: deployFailing })).state,
      ).modes![0]
    const sandbox = await modeFor('sandbox')
    const production = await modeFor('production')
    expect(sandbox.when).toBe(
      'the deploy itself failed - wrangler reported an API or upload error',
    )
    expect(sandbox).toEqual(production)
    expect(sandbox.text).toContain(
      "This is Cloudflare's side, not your setup: the deploy call reached Cloudflare and Cloudflare answered with an error (a `/accounts/...` request failed, an `internal_server` error).",
    )
    expect(sandbox.text).toContain(
      'Wait a few minutes, then type **done** to retry.',
    )
    expect(sandbox.text).toContain(
      "You can check Cloudflare's health via the **System Status** link at the bottom of the Cloudflare dashboard.",
    )
    expect(sandbox.text).toContain(
      'Do not change your account, zone, or settings over this - nothing in your setup causes an API-side error.',
    )
  })

  // The mode's closing sentence is a CLAIM about the driver, not a comfort phrase, so it is asserted
  // against the driver rather than trusted. A failed deploy must persist the parked recovery, and
  // re-reading that state with no answer must reproduce THIS screen - without re-running the deploy.
  it('its "progress is saved, and re-running resumes right here" claim is true', async () => {
    const { state } = await driveTo('deploy', 'sandbox', 'quick', {
      deps: deployFailing,
    })
    const parked = currentRecord(state)
    // The sentence names the literal resume call, because "re-running the wizard" is exactly the phrase a
    // deployer would honour by running `start` - which refuses now, but naming the right form is what
    // stops them needing the refusal at all.
    expect(parked.modes![0].text).toContain(
      'your progress is saved, and re-running the wizard resumes right here - `npm run wizard:drive`, no extra words.',
    )
    // The round trip the sentence promises: what a resume really reads back off the disk.
    const cwd = mkdtempSync(join(tmpdir(), 'wizard-resume-'))
    try {
      writeState(state, cwd)
      const resumed = currentRecord(readState(cwd)!)
      expect(resumed).toEqual(parked)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})

// --- E3 / E4 / E5: the membership verifies -------------------------------------------------------

/** A fake GitHub whose team membership is whatever the test says it is; the account itself exists. */
const membership = (state: 'pending' | 'active' | 'none') => ({
  createApi: () => ({
    get: async (path: string) =>
      path.startsWith('/users/')
        ? { status: 200, json: { login: 'octocat-test' } }
        : state === 'none'
          ? { status: 404, json: null }
          : { status: 200, json: { state } },
  }),
})

describe('verify: the grant fired (E3)', () => {
  it('a pending invite proves the grant fired and advances', async () => {
    const { state, deps } = await driveTo('awaiting-grant', 'sandbox', 'full', {
      deps: membership('pending'),
    })
    expect((await advance(state, 'done', deps)).cursor).toBe('accept-invite')
  })

  it('no invite at all parks on E3 and says the grant has not fired', async () => {
    const { state, deps } = await driveTo('awaiting-grant', 'sandbox', 'full', {
      deps: membership('none'),
    })
    const next = await advance(state, 'done', deps)
    expect(next.cursor).toBe('awaiting-grant')

    const record = currentRecord(next)
    expect(record.type).toBe('recovery')
    expect(record.detail).toContain('the grant has not fired')
    expect(record.modes!.map((m) => m.when)).toContain(
      'the page never shows granted',
    )
  })
})

describe('verify: the invite was accepted (E4)', () => {
  it('an ACTIVE membership means accepted, and advances', async () => {
    const { state, deps } = await driveTo('accept-invite', 'sandbox', 'full', {
      deps: membership('active'),
    })
    expect((await advance(state, 'done', deps)).cursor).toBe('refund')
  })

  it('a still-PENDING invite does not pass - that is the whole point of the step', async () => {
    const { state, deps } = await driveTo('accept-invite', 'sandbox', 'full', {
      deps: membership('pending'),
    })
    const next = await advance(state, 'done', deps)
    expect(next.cursor).toBe('accept-invite')

    const record = currentRecord(next)
    expect(record.type).toBe('recovery')
    expect(record.detail).toContain('still pending')
    // The approved wording: the invite went to the SECOND account's inbox.
    expect(record.modes!.map((m) => m.when)).toContain('not in org after done')
    const mode = record.modes!.find((m) => m.when === 'not in org after done')!
    expect(mode.text).toContain(
      "the invite email went to your **second** account's inbox, not your main one",
    )
    expect(mode.text).toContain('logged into GitHub **as `octocat-test`**')
  })
})

describe('verify: the refund outcome (E5) is policy-correct', () => {
  // The false green this pair exists to stop: a naive "assert removed" passes auto_revoke and would
  // fail forever under log_only, against a worker behaving exactly as configured.

  it('auto_revoke passes only when the buyer was REMOVED', async () => {
    const { state, deps } = await driveTo('refund', 'sandbox', 'full', {
      revokePolicy: 'auto_revoke',
      refundMembership: 'none',
    })
    // On to E6's offer: auto_revoke freed the handle, which is what makes the typo test runnable.
    expect((await advance(state, 'done', deps)).cursor).toBe('typo-test')
  })

  it('auto_revoke fails when the buyer is STILL in the team', async () => {
    const { state, deps } = await driveTo('refund', 'sandbox', 'full', {
      revokePolicy: 'auto_revoke',
      refundMembership: 'active',
    })
    const next = await advance(state, 'done', deps)
    expect(next.cursor).toBe('refund')

    const record = currentRecord(next)
    expect(record.type).toBe('recovery')
    expect(record.detail).toContain('the revoke has not happened')
    expect(record.modes!.map((m) => m.when)).toContain('still in the team')
  })

  it('log_only passes when the buyer is STILL in the team - retention IS the proof', async () => {
    const { state, deps } = await driveTo('refund', 'sandbox', 'full', {
      revokePolicy: 'log_only',
      refundMembership: 'active',
    })
    // Straight to the closing: E6 is not offered on a log_only run - see the E6 gating tests below.
    expect((await advance(state, 'done', deps)).cursor).toBe('closing')
  })

  it('log_only FAILS when the buyer was removed, and says access should have been kept', async () => {
    const { state, deps } = await driveTo('refund', 'sandbox', 'full', {
      revokePolicy: 'log_only',
      refundMembership: 'none',
    })
    const next = await advance(state, 'done', deps)
    expect(next.cursor).toBe('refund')

    const record = currentRecord(next)
    expect(record.type).toBe('recovery')
    expect(record.detail).toContain('Log only should have kept their access')
    // Its OWN recovery block, not the auto_revoke one.
    expect(record.modes!.map((m) => m.when)).toEqual([
      'they were removed anyway',
    ])
  })

  it('the E5 screen itself asks the policy-correct question', async () => {
    const auto = byId(
      await drive('sandbox', 'full', { revokePolicy: 'auto_revoke' }),
      'refund',
    )
    expect(auto.text).toContain(
      'Your worker should remove `octocat-test` from the team.',
    )

    const log = byId(
      await drive('sandbox', 'full', { revokePolicy: 'log_only' }),
      'refund',
    )
    expect(log.text).toContain(
      'Because you chose Log only, the worker records the refund but keeps access - so `octocat-test` should **still** be in the team.',
    )
    expect(log.text).not.toContain('should remove `octocat-test`')
  })

  it('the full sandbox closing tells the truth about which policy ran', async () => {
    expect(
      byId(
        await drive('sandbox', 'full', { revokePolicy: 'auto_revoke' }),
        'closing',
      ).text,
    ).toContain('purchase -> invite -> refund/revoke all worked')

    const log = byId(
      await drive('sandbox', 'full', { revokePolicy: 'log_only' }),
      'closing',
    )
    expect(log.text).toContain(
      'purchase -> invite -> the refund was recorded and access was kept, per your Log only policy',
    )
    expect(log.text).not.toContain('refund/revoke all worked')
  })
})

// --- E5 names the exact payment ------------------------------------------------------------------
//
// "Payments -> the payment" sent a live deployer hunting. The grant-record probe reads the REMOTE store
// and fills the id, so the screen points at one row. What it must never do is name the WRONG row: the
// synthetic check's cleanup deletes its own grant record, but that delete is advisory and can fail, so a
// `pi_e2e_...` grant can linger - and an unfiltered lookup would hand the deployer one that has no payment
// to refund at all.

describe('the refund screen names the payment it resolved', () => {
  it('fills PI-ID with the real purchase, never the synthetic check own grant', async () => {
    const record = byId(await drive('sandbox', 'full'), 'refund')
    expect(record.text).toContain(
      `open **Transactions**, find payment \`${REAL_PI}\`, click the **...** button at the end of its row -> **Refund payment**, and refund the **full amount**.`,
    )
    expect(record.text).not.toContain('pi_e2e_')
    expect(record.text).not.toContain('PI-ID')
  })

  it('the auto_revoke done-condition waits for the REMOVAL, not just the refund', async () => {
    // The verify checks membership. A `done` typed the instant Stripe confirms the refund races the
    // worker and parks a recovery for a run that is behaving correctly, so the screen names what the
    // verify will actually look for. log_only has no removal to wait for and must not say this.
    expect(byId(await drive('sandbox', 'full'), 'refund').text).toContain(
      'Type **done** when the refund is through and `octocat-test` has been removed from the team and the org - GitHub also emails them a removal notice.',
    )
    const logOnly = byId(
      await drive('sandbox', 'full', { revokePolicy: 'log_only' }),
      'refund',
    ).text
    expect(logOnly).toContain(
      "should **still** be in the team. Check they're still there",
    )
    expect(logOnly).not.toContain('has been removed from the team and the org')
  })

  it('the typo-refund done-condition waits for the second removal', async () => {
    expect(byId(await drive('sandbox', 'full'), 'typo-refund').text).toContain(
      'Type **done** when refunded and `octocat-test` is removed from the team again.',
    )
  })

  it('names the live-confirmed Transactions path, not the retired Payments one', async () => {
    // Maintainer-confirmed live, 2026-07-16. Pinned because the old wording was never pinned - the same
    // way the Cloudflare `Add a site` name rotted unnoticed.
    for (const policy of ['auto_revoke', 'log_only'] as RevokePolicy[]) {
      const record = byId(
        await drive('sandbox', 'full', { revokePolicy: policy }),
        'refund',
      )
      expect(record.text, policy).toContain('open **Transactions**')
      expect(record.text, policy).toContain(
        'click the **...** button at the end of its row -> **Refund payment**',
      )
      expect(record.text, policy).not.toContain('Payments -> the payment')
    }
  })

  it('the log_only screen names the payment too, and still asks the inverse question', async () => {
    const record = byId(
      await drive('sandbox', 'full', { revokePolicy: 'log_only' }),
      'refund',
    )
    expect(record.text).toContain(`find payment \`${REAL_PI}\``)
    expect(record.text).toContain('should **still** be in the team')
  })

  it('DESCRIBES the payment when the lookup cannot single one out, and never prints the slot', async () => {
    // Nothing this run can claim as its own: an empty store, a store whose contents never moved across
    // the purchase, and a lookup that failed outright. In none of them can we honestly name a payment,
    // and the fallback is worse for the deployer but still true - unlike a literal `PI-ID`, or a guess
    // at which row they meant.
    const ambiguous = [
      { name: 'no grants at all', grants: [] },
      {
        name: 'two purchases, neither of them new',
        grants: [
          { adapter: 'stripe', transactionId: 'pi_ONE' },
          { adapter: 'stripe', transactionId: 'pi_TWO' },
        ],
      },
      {
        name: 'the lookup itself failed',
        grants: undefined,
      },
    ]
    for (const world of ambiguous) {
      const record = byId(
        await drive('sandbox', 'full', {
          deps: {
            grantRecord: () => ({ checks: [], grants: world.grants }),
          },
        }),
        'refund',
      )
      expect(record.text, world.name).toContain(
        'find your test payment (the `$...` one from this run)',
      )
      expect(record.text, world.name).not.toContain('PI-ID')
      // The path itself is unchanged - only the way the payment is identified.
      expect(record.text, world.name).toContain('open **Transactions**')
    }
  })

  it('a lookup that fails never blocks the refund - it is a slot, not a gate', async () => {
    const { state, deps } = await driveTo('refund', 'sandbox', 'full', {
      deps: { grantRecord: () => ({ checks: [], grants: [] }) },
      refundMembership: 'none',
    })
    expect(currentRecord(state).type).toBe('do')
    expect((await advance(state, 'done', deps)).cursor).toBe('typo-test')
  })
})

// --- the payment is resolved by DIFFERENCE, so a store that is not virgin still names it -----------
//
// A live production run read the fallback on BOTH refund screens while every sandbox run named the id.
// Nothing about the two runs differed except the STORE: a sandbox namespace is fresh, and a production
// namespace belongs to a worker that keeps its name across runs, so it still holds the grants of every
// earlier run that ended before its own refund. A rule that names a payment only when the store holds
// exactly one refundable grant therefore cannot fire in production at all - which is the one place a
// deployer is refunding real money and most needs to be pointed at the right row.
//
// So the id is resolved by subtracting a snapshot taken before the purchase. These drive the PRODUCTION
// env for that reason: it is the environment the defect was found in.

const OLD_GRANTS = ['pi_3OLDRUN000001', 'pi_3OLDRUN000002']

/**
 * The rule this round replaced: name the payment when the store holds exactly one refundable grant.
 *
 * It is written out here so the dirty-store cases carry their own control. An assertion that the new
 * rule names the id proves nothing on its own - the old rule might have named it too. Asserting that
 * this one returns nothing on the SAME store is what shows the difference is load-bearing, and it stays
 * true if someone reverts the mechanism, at which point the tests below go red rather than quietly
 * agreeing with it.
 */
const uniquenessRule = (ids: string[]) => (ids.length === 1 ? ids[0] : null)

/** What the probe really reads at each refund screen: the store as of the screen BEFORE it. */
const refundableAt = (screenId: string, seed: string[]) =>
  grantStoreAt(screenId, seed)
    .filter((g) => !g.transactionId.startsWith('pi_e2e_'))
    .map((g) => g.transactionId)

describe('the refund screens name this run payment on a store earlier runs already used', () => {
  it('a production store holding two earlier grants still names the new one, on both screens', async () => {
    const records = await drive('production', 'full', { storeSeed: OLD_GRANTS })

    const refund = byId(records, 'refund').text
    expect(refund).toContain(`find payment \`${REAL_PI}\``)
    for (const old of OLD_GRANTS) expect(refund).not.toContain(old)
    expect(refund).not.toContain(
      'your test payment (the `$...` one from this run)',
    )

    // The SAME baseline serves the cleanup screen: by then E5's refund has deleted the first purchase's
    // grant, so the claim grant is again the only id the snapshot does not hold.
    const typo = byId(records, 'typo-refund').text
    expect(typo).toContain(`find payment \`${TYPO_PI}\``)
    expect(typo).not.toContain(REAL_PI)
    for (const old of OLD_GRANTS) expect(typo).not.toContain(old)
  })

  it('and the rule it replaced could not have named either of them', async () => {
    // The control for the test above, on the exact lists the two probes read. Three refundable grants at
    // E5 and three again at the cleanup screen: the old rule wanted exactly one, so on this store it
    // returned nothing and both screens printed the fallback - which is what the live run reported.
    expect(refundableAt('accept-invite', OLD_GRANTS)).toEqual([
      ...OLD_GRANTS,
      REAL_PI,
    ])
    expect(uniquenessRule(refundableAt('accept-invite', OLD_GRANTS))).toBeNull()
    expect(refundableAt('typo-accept', OLD_GRANTS)).toEqual([
      ...OLD_GRANTS,
      TYPO_PI,
    ])
    expect(uniquenessRule(refundableAt('typo-accept', OLD_GRANTS))).toBeNull()
  })

  it('falls back when NOTHING new appeared, however full the store is', async () => {
    // The purchase never landed a grant record. Everything in the store predates this run, so there is
    // no id we can honestly call the deployer's - and a store this size is exactly where guessing would
    // be worst.
    const records = await drive('production', 'full', {
      deps: {
        grantRecord: () => ({
          checks: [],
          grants: OLD_GRANTS.map((transactionId) => ({
            adapter: 'stripe',
            transactionId,
          })),
        }),
      },
    })
    expect(byId(records, 'refund').text).toContain(
      'find your test payment (the `$...` one from this run)',
    )
    expect(byId(records, 'refund').text).not.toContain('PI-ID')
  })

  it('falls back when SEVERAL are new, and names neither of them', async () => {
    // Two grants appeared after the snapshot - a second purchase of the deployer's own, or a genuine
    // buyer on a production worker. Either way the run cannot say which row it means.
    const SECOND_PI = 'pi_3SECONDBUY0001'
    let seen = 0
    const records = await drive('production', 'full', {
      deps: {
        grantRecord: () => {
          // The first call is the pre-purchase snapshot; every later one sees two new payments.
          const extra = seen++ === 0 ? [] : [REAL_PI, SECOND_PI]
          return {
            checks: [],
            grants: [...OLD_GRANTS, ...extra].map((transactionId) => ({
              adapter: 'stripe',
              transactionId,
            })),
          }
        },
      },
    })
    const refund = byId(records, 'refund').text
    expect(refund).toContain(
      'find your test payment (the `$...` one from this run)',
    )
    expect(refund).not.toContain(REAL_PI)
    expect(refund).not.toContain(SECOND_PI)
  })

  it('a snapshot that could not be read costs the run nothing it had', async () => {
    // `grant-record` omits `grants` when the list failed, so the snapshot comes back empty and the
    // subtraction is the identity - which leaves exactly the rule that was there before it: name the
    // payment when the store holds one, describe it otherwise. So a dirty store still falls back
    // (naming an earlier run's payment is the one thing it must not do), and a fresh store is still
    // named. The read failing must also not throw or park anything, which is why these drive whole runs.
    const dirty = await drive('production', 'full', {
      deps: {
        grantRecord: (() => {
          let call = 0
          return () =>
            call++ === 0
              ? { checks: [], grants: undefined }
              : {
                  checks: [],
                  grants: [...OLD_GRANTS, REAL_PI].map((transactionId) => ({
                    adapter: 'stripe',
                    transactionId,
                  })),
                }
        })(),
      },
    })
    const refund = byId(dirty, 'refund').text
    expect(refund).toContain(
      'find your test payment (the `$...` one from this run)',
    )
    for (const old of OLD_GRANTS) expect(refund).not.toContain(old)

    // A fresh store with one grant is still named, snapshot or no snapshot - there is nothing else it
    // could be, which is why this degrades rather than refusing.
    const clean = await drive('production', 'full', {
      deps: {
        grantRecord: (() => {
          let call = 0
          return () =>
            call++ === 0
              ? { checks: [], grants: undefined }
              : {
                  checks: [],
                  grants: [{ adapter: 'stripe', transactionId: REAL_PI }],
                }
        })(),
      },
    })
    expect(byId(clean, 'refund').text).toContain(`find payment \`${REAL_PI}\``)
  })

  it('the synthetic check own grant is never the new one, on a dirty store either', async () => {
    // The e2e grant is filtered out of BOTH reads, so a leftover from an earlier run cannot sit in the
    // snapshot and a fresh one cannot be mistaken for the purchase. Here the store holds an old e2e
    // grant AND the current run's, and the screen still names the payment.
    const records = await drive('production', 'full', {
      storeSeed: [...OLD_GRANTS, 'pi_e2e_aaaaaaaaaaaaaaaa'],
    })
    const refund = byId(records, 'refund').text
    expect(refund).toContain(`find payment \`${REAL_PI}\``)
    expect(refund).not.toContain('pi_e2e_')
  })

  it('a dirty store still never gates - the refund screen advances on done', async () => {
    const { state, deps } = await driveTo('refund', 'production', 'full', {
      storeSeed: OLD_GRANTS,
      refundMembership: 'none',
    })
    expect((await advance(state, 'done', deps)).cursor).toBe('typo-test')
  })
})

// --- E6, the optional typo/claim test ------------------------------------------------------------
//
// The old orchestrator made this mandatory; it returns as an offer. The gating is the load-bearing part:
// under `log_only` E5 leaves the buyer ON the team, so the claim grant reconciles to a no-op and E6's
// two mirror verifies would green before the deployer touched anything. A step that passes without the
// human is worse than no step, so the offer is not made at all there.

describe('E6 is offered only where it can actually prove something', () => {
  it('a full auto_revoke run is offered the typo test', async () => {
    const record = byId(await drive('sandbox', 'full'), 'typo-test')
    expect(record.type).toBe('ask')
    expect(record.kind).toBe('choice')
    expect(record.field).toBe('typoTest')
    expect(record.options!.map((o) => o.value)).toEqual(['test', 'skip'])
    expect(record.options!.map((o) => o.label)).toEqual([
      'Test the typo path',
      'Skip',
    ])
    expect(record.text).toContain(
      'One more thing you can prove, optional: what a buyer sees after mistyping their GitHub username',
    )
  })

  it('a log_only run is NEVER offered it - its verifies would pass with nobody doing anything', async () => {
    // Proven against the code, not assumed: workflow.ts returns before any DELETE under log_only, so at
    // E6 the buyer is still `active` from E4. verifyGrantFired accepts pending|active and
    // verifyInviteAccepted accepts active - both green on arrival. A verify must assert the
    // POLICY-CORRECT outcome, and under log_only there is no outcome here left to assert.
    const ids = (
      await drive('sandbox', 'full', { revokePolicy: 'log_only' })
    ).map((r) => r.id)
    for (const id of SCREEN_IDS.filter((s) => s.startsWith('typo-'))) {
      expect(ids, id).not.toContain(id)
    }
    expect(ids).toEqual(FULL_SEQUENCE.filter((id) => !id.startsWith('typo-')))
  })

  it('a quick run is never offered it either - it has no purchase to mistype', async () => {
    const ids = (await drive('sandbox', 'quick')).map((r) => r.id)
    for (const id of SCREEN_IDS.filter((s) => s.startsWith('typo-'))) {
      expect(ids, id).not.toContain(id)
    }
  })

  it('declining walks straight to the closing, and nothing of E6 is built', async () => {
    const ids = (await drive('sandbox', 'full', { typoTest: 'skip' })).map(
      (r) => r.id,
    )
    expect(ids).toEqual(FULL_SEQUENCE_TYPO_SKIPPED)
  })

  it('taking it walks the whole ported choreography, in order', async () => {
    const ids = (await drive('sandbox', 'full')).map((r) => r.id)
    expect(ids).toEqual(FULL_SEQUENCE)
    // Purchase -> claim page -> accept -> clean up. The order IS the walkthrough's.
    expect(ids.slice(ids.indexOf('typo-test'))).toEqual([
      'typo-test',
      'typo-purchase',
      'typo-claim',
      'typo-accept',
      'typo-refund',
      'closing',
    ])
  })
})

// --- the typo test's fake handle is GENERATED, once per run --------------------------------------
//
// A literal example baked into every copy of the wizard is a handle somebody eventually registers, and
// from that day on the typo test invites a stranger to the deployer's org. Minting one per run removes
// the shared target; minting it ONCE per run is what lets every screen name the same handle.
describe('the typo handle', () => {
  it('is `nouser-` plus 12 lowercase base36 characters - a valid GitHub username shape', () => {
    for (let i = 0; i < 50; i++) {
      const handle = makeTypoHandle()
      expect(handle).toMatch(/^nouser-[0-9a-z]{12}$/)
      expect(handle).toHaveLength(19)
    }
  })

  it('is deterministic under an injected RNG', () => {
    expect(makeTypoHandle(() => 0)).toBe('nouser-000000000000')
    // 35/36 lands on the last base36 character in every position.
    expect(makeTypoHandle(() => 35 / 36)).toBe('nouser-zzzzzzzzzzzz')
  })

  it('varies between runs, so no two deployers type the same fake handle', () => {
    const handles = new Set(Array.from({ length: 200 }, () => makeTypoHandle()))
    expect(handles.size).toBe(200)
  })

  it('is minted once and stays the same on every screen of the run that names it', async () => {
    // The deployer types it at checkout and reads it back afterwards. A handle regenerated per screen
    // would send them to buy under one name and look for another.
    let calls = 0
    const records = await drive('sandbox', 'full', {
      deps: {
        random: () => {
          calls++
          return 0.5
        },
      },
    })
    expect(calls).toBe(12)
    const minted = makeTypoHandle(() => 0.5)
    const naming = records.filter((r) => r.text?.includes('nouser-'))
    expect(naming.length).toBeGreaterThan(0)
    for (const record of naming) {
      expect(record.text, record.id).toContain(`\`${minted}\``)
      expect(record.text, record.id).not.toContain('TYPO-HANDLE')
    }
  })

  it('is never minted by a run that does not take the typo test', async () => {
    let calls = 0
    const deps = {
      random: () => {
        calls++
        return 0.5
      },
    }
    for (const records of [
      await drive('sandbox', 'full', { deps, typoTest: 'skip' }),
      await drive('sandbox', 'quick', { deps }),
    ]) {
      for (const record of records) {
        expect(record.text ?? '', record.id).not.toContain('nouser-')
      }
    }
    expect(calls).toBe(0)
  })
})

describe('E6 asks E3, E4 and E5 again - about the SECOND purchase', () => {
  it('the purchase screen changes only the handle, and says so', async () => {
    const record = byId(
      await drive('sandbox', 'full', { deps: { random: () => 0 } }),
      'typo-purchase',
    )
    expect(record.type).toBe('do')
    expect(record.text).toContain('`nouser-000000000000`')
    expect(record.text).toContain('**Card** `4242 4242 4242 4242`')
    expect(record.text).toContain(
      'The worker will not find that account. Instead of failing the sale it falls back to the claim page',
    )
    // The neutral-state warning lives HERE, not on the claim screen: it is only useful if it is read
    // BEFORE the redirect lands. Pinned to its position - directly after the sentence it qualifies -
    // because a warning that arrives after the deployer has met the state is not a warning.
    expect(record.text).toContain(
      'which is the thing worth seeing. (It may show a neutral "setting up your access" state for a moment first, then resolve on its own.)',
    )
  })

  it('the claim screen sends the CORRECTED handle, and explains why it is free to reuse', async () => {
    const record = byId(await drive('sandbox', 'full'), 'typo-claim')
    expect(record.text).toContain('Enter `octocat-test` there and submit.')
    // MOVED to typo-purchase, not duplicated - two screens carrying the same aside is how the deployer
    // learns to skim it.
    expect(record.text).not.toContain('setting up your access')
    // Only true because E5 revoked it - which is exactly why E6 is auto_revoke-only.
    expect(record.text).toContain(
      'That handle is free to reuse - the refund at the last step revoked it.',
    )
  })

  /**
   * A membership fake pinned to ONE answer. The run has to REACH the E6 screen first, and reaching it
   * means passing E3/E4/E5 - so the failure has to be injected at the target screen, not for the whole
   * walk. (Overriding `createApi` from the start fails E3 instead, and the run never gets here.)
   */
  const membershipStuckAt = (membership: 'none' | 'pending' | 'active') => ({
    createApi: () => ({
      get: async (path: string) =>
        path.startsWith('/users/')
          ? { status: 200, json: { login: 'octocat-test' } }
          : membership === 'none'
            ? { status: 404, json: null }
            : { status: 200, json: { state: membership } },
    }),
  })

  it('each E6 verify routes its recovery to its OWN screen, not to E3/E4/E5', async () => {
    // The bug this prevents: a shared verify hard-coding E3's owner would park the typo test's failure
    // on a screen the deployer finished two steps ago, and no answer there could clear it.
    for (const [screen, membership, detail] of [
      ['typo-claim', 'none', 'the grant has not fired'],
      ['typo-accept', 'pending', 'is still pending'],
      ['typo-refund', 'active', 'the revoke has not happened'],
    ] as const) {
      const { state, deps } = await driveTo(screen, 'sandbox', 'full')
      const next = await advance(state, 'done', {
        ...deps,
        ...membershipStuckAt(membership),
      })
      expect(next.cursor, screen).toBe(screen)
      const record = currentRecord(next)
      expect(record.type, screen).toBe('recovery')
      expect(record.detail, screen).toContain(detail)
      expect(record.retry, screen).toBe(screen)
    }
  })

  it('the not-redirected mode scopes its DNS advice to the page, never to the grant', async () => {
    // The old wording ("will not load but the grant still fires") described a case this screen cannot
    // be in: the deployer is here because they did NOT reach the claim page, so a fired grant is not
    // the thing in front of them. The evidence that the address is good is the FIRST purchase.
    const { state, deps } = await driveTo('typo-claim', 'sandbox', 'full')
    const next = await advance(state, 'done', {
      ...deps,
      ...membershipStuckAt('none'),
    })
    const mode = currentRecord(next).modes!.find(
      (m) => m.when === 'I was not redirected to the claim page',
    )!
    expect(mode.text).toContain(
      'If the page will not load in your browser at all, that is DNS on your machine, not the worker - the first purchase already used this same address.',
    )
    expect(mode.text).not.toContain('the grant still fires')
  })

  it('the second refund gets its OWN recovery modes, not E5 own', async () => {
    const { state, deps } = await driveTo('typo-refund', 'sandbox', 'full')
    const next = await advance(state, 'done', {
      ...deps,
      ...membershipStuckAt('active'),
    })
    const record = currentRecord(next)
    expect(record.modes!.map((m) => m.when)).toContain(
      'which payment do I refund',
    )
  })

  it('the second refund does a FRESH lookup, so it names the claim grant and not the refunded one', async () => {
    // E5's revoke deleted the first grant record, so by E6 the store holds the e2e grant plus the NEW
    // claim grant. Naming the already-refunded payment would send the deployer to a row with nothing
    // left to refund. The default world already models that arrival-by-arrival, so no override is needed
    // - and the one baseline taken before the FIRST purchase is what both screens subtract.
    const records = await drive('sandbox', 'full')
    expect(byId(records, 'refund').text).toContain(`\`${REAL_PI}\``)
    expect(byId(records, 'typo-refund').text).toContain(`\`${TYPO_PI}\``)
    expect(byId(records, 'typo-refund').text).not.toContain(REAL_PI)
  })
})

// --- the Cloudflare auth branch (screen 3) -------------------------------------------------------

describe('the Cloudflare auth branch', () => {
  const signedOut = {
    preflight: async () => ({
      checks: [
        {
          name: 'Cloudflare authenticated (wrangler whoami)',
          ok: false,
          fix: 'Run `wrangler login` to authenticate with Cloudflare, then re-run',
        },
      ],
    }),
  }

  it('signed in: a say that names the real account and moves on', async () => {
    const record = byId(await drive('sandbox', 'quick'), 'preflight')
    expect(record.type).toBe('say')
    expect(record.text).toContain(
      'Cloudflare login - OK, signed in as `acme-co`',
    )
    expect(record.text).toContain("Everything's ready. Next, your GitHub side.")
  })

  it('signed out: a do that asks for wrangler login and never claims login is OK', async () => {
    const { state } = await driveTo('preflight', 'sandbox', 'quick', {
      deps: signedOut,
    })
    const record = currentRecord(state)
    expect(record.type).toBe('do')
    expect(record.text).toContain('Cloudflare login - **not signed in**')
    expect(record.text).toContain(
      'One thing before GitHub: run `npx wrangler login`',
    )
    // The bug this branch was reworded to kill: asserting "login - OK" above a line telling you to log in.
    expect(record.text).not.toContain('login - OK')
    expect(record.text).not.toContain("Everything's ready")
  })

  it('signed out: done does not advance while whoami still fails', async () => {
    const { state, deps } = await driveTo('preflight', 'sandbox', 'quick', {
      deps: signedOut,
    })
    const next = await advance(state, 'done', deps)
    expect(next.cursor).toBe('preflight')
    expect(currentRecord(next).type).toBe('recovery')
    expect(currentRecord(next).detail).toContain('Still not signed in')
  })

  it('signed out then logged in: done advances once whoami succeeds', async () => {
    let loggedIn = false
    const { state, deps } = await driveTo('preflight', 'sandbox', 'quick', {
      deps: {
        preflight: async () => ({
          checks: [
            {
              name: 'Cloudflare authenticated (wrangler whoami)',
              ok: loggedIn,
              ...(loggedIn ? {} : { fix: 'Run `wrangler login`' }),
            },
          ],
        }),
      },
    })
    expect(currentRecord(state).type).toBe('do')
    loggedIn = true // the human ran `wrangler login`
    expect((await advance(state, 'done', deps)).cursor).toBe('github-org')
  })
})

// --- questions ----------------------------------------------------------------------------------

describe('a question is answered from recovery, never off-path', () => {
  it('anything that is not done at a do returns to that same step', async () => {
    const { state, deps } = await driveTo('payment-link', 'sandbox', 'full')
    const next = await advance(state, 'what is metadata?', deps)

    expect(next.cursor).toBe('payment-link')
    const record = currentRecord(next)
    expect(record.type).toBe('recovery')
    expect(record.retry).toBe('payment-link')
    expect(record.modes!.map((m) => m.when)).toContain(
      'the metadata is not set',
    )
  })

  it('a question emits no command for the agent to run', async () => {
    const { state, deps } = await driveTo('webhook-secret', 'sandbox', 'full')
    const record = currentRecord(await advance(state, 'which events?', deps))
    expect(record).not.toHaveProperty('action')
    expect(record.modes!.map((m) => m.when)).toContain('wrong events selected')
  })

  it('a question runs no verify - it asks nothing of GitHub', async () => {
    let calls = 0
    const { state, deps } = await driveTo('github-pat', 'sandbox', 'full', {
      deps: {
        githubVerify: async () => {
          calls++
          return { checks: [{ name: 'ok', ok: true }] }
        },
      },
    })
    const before = calls
    await advance(state, 'where do I find the token?', deps)
    expect(calls).toBe(before)
  })

  it('after a question, done still runs the verify and advances', async () => {
    const { state, deps } = await driveTo('github-pat', 'sandbox', 'full')
    const asked = await advance(state, 'a question', deps)
    expect(currentRecord(asked).type).toBe('recovery')
    expect((await advance(asked, 'done', deps)).cursor).toBe('test-buyer')
  })
})

// --- a recovery parked on an `ask` accepts a CORRECTED VALUE -------------------------------------
//
// The dead end this section exists to keep closed: the driver re-asked and then DISCARDED the answer.
// A recovery record carries `modes`, not `kind`/`options`/`field`, so an answer read against IT stored
// nothing. A failed GitHub verify routes a wrong org to 4a and a wrong slug to 4b precisely so they can
// be re-asked - which only means something if the new value is kept.

/** A GitHub where `/users/{handle}` answers for known handles only - the 4d existence check's question. */
const handlesKnown = (known: string[]) => ({
  createApi: () => ({
    get: async (path: string) => {
      if (path.startsWith('/users/')) {
        return known.includes(path.slice('/users/'.length))
          ? { status: 200, json: { login: 'x' } }
          : { status: 404, json: null }
      }
      return { status: 200, json: { state: 'active' } }
    },
  }),
})

describe('answering a recovery parked on an ask', () => {
  it('a corrected handle at 4d is CHECKED against the NEW value, and advances', async () => {
    // The hard deadlock: test-buyer's own verify re-parked EVERY non-`done` answer, and its verify is the
    // only thing that can clear its own recovery - so a corrected handle could never be accepted at all.
    const { state, deps } = await driveTo('test-buyer', 'sandbox', 'full', {
      deps: handlesKnown(['octocat-test']),
    })
    const parked = await advance(state, 'octocat-tset', deps)
    expect(parked.cursor).toBe('test-buyer')
    expect(currentRecord(parked).type).toBe('recovery')

    const fixed = await advance(parked, 'octocat-test', deps)
    expect(fixed.answers.testBuyer).toBe('octocat-test')
    expect(fixed.cursor).toBe('worker-url')
    expect(fixed.recovery).toBeFalsy()
  })

  it('a corrected handle that is ALSO wrong re-parks, naming the new handle', async () => {
    const { state, deps } = await driveTo('test-buyer', 'sandbox', 'full', {
      deps: handlesKnown(['octocat-test']),
    })
    const parked = await advance(state, 'octocat-tset', deps)
    const again = await advance(parked, 'octocat-nope', deps)

    expect(again.cursor).toBe('test-buyer')
    const record = currentRecord(again)
    expect(record.type).toBe('recovery')
    // The reason names the value just given, not the one it replaced.
    expect(record.detail).toContain('octocat-nope')
    expect(record.detail).not.toContain('octocat-tset')
    expect(again.answers.testBuyer).toBe('octocat-nope')
  })

  it('a corrected org at a 4a-parked recovery is STORED, and the run walks forward', async () => {
    const { state, deps } = await driveTo('github-pat', 'sandbox', 'full', {
      deps: githubFailing(
        "org 'acme' exists and is accessible",
        "Org 'acme' not found or the PAT cannot access it",
      ),
    })
    const parked = await advance(state, 'done', deps)
    expect(parked.cursor).toBe('github-org')

    const fixed = await advance(parked, 'acme-real', deps)
    // The value the human typed is the value the run now carries - this is what used to be dropped.
    expect(fixed.answers.org).toBe('acme-real')
    // 4a has no verify of its own: the check that OWNS the org runs at 4c, so the run walks forward to
    // it, re-rendering 4b/4b2/4c on the way. A changed org genuinely needs those redone.
    expect(fixed.cursor).toBe('github-team')
    expect(fixed.recovery).toBeFalsy()
  })

  it('a corrected team slug at a 4b-parked recovery is STORED', async () => {
    const { state, deps } = await driveTo('github-pat', 'sandbox', 'full', {
      deps: githubFailing("team 'pro' exists", "Create team 'pro'"),
    })
    const parked = await advance(state, 'done', deps)
    expect(parked.cursor).toBe('github-team')

    const fixed = await advance(parked, 'pro-buyers', deps)
    expect(fixed.answers.team).toBe('pro-buyers')
    expect(fixed.cursor).toBe('github-team-lock')
  })

  it('`done` at an ask-recovery re-attempts with the STORED value and does not clear it', async () => {
    const known: string[] = []
    const { state, deps } = await driveTo('test-buyer', 'sandbox', 'full', {
      deps: handlesKnown(known),
    })
    const parked = await advance(state, 'octocat-new', deps)
    expect(currentRecord(parked).type).toBe('recovery')
    expect(parked.answers.testBuyer).toBe('octocat-new')

    known.push('octocat-new') // the human went and created the account
    const done = await advance(parked, 'done', deps)
    expect(done.answers.testBuyer).toBe('octocat-new')
    expect(done.cursor).toBe('worker-url')
  })

  it('a closed-choice recovery answer outside the option set is rejected, as the ask rejects it', async () => {
    const parked = {
      cursor: 'revoke-policy',
      answers: { env: 'sandbox', goal: 'full' },
      flags: {},
      recovery: { detail: null },
    }
    const deps = okDeps({ id: 'revoke-policy' }, 'log_only')
    await expect(advance(parked as never, 'sometimes', deps)).rejects.toThrow(
      DriverError,
    )
    await expect(advance(parked as never, 'sometimes', deps)).rejects.toThrow(
      /closed choice - expected one of auto_revoke, log_only/,
    )
    const ok = await advance(parked as never, 'log_only', deps)
    expect(ok.answers.revokePolicy).toBe('log_only')
  })

  it('a non-done answer at a DO-parked recovery is still a question - nothing runs, nothing moves', async () => {
    // Held for both flavours: a `do` WITH a verify (github-pat) and one WITHOUT (payment-link). Only the
    // verify block used to hold the cursor, so on a no-verify `do` a SECOND question walked silently on
    // to the next screen.
    for (const screen of ['payment-link', 'github-pat']) {
      let verifies = 0
      const { state, deps } = await driveTo(screen, 'sandbox', 'full', {
        deps: {
          githubVerify: async () => {
            verifies++
            return { checks: [{ name: 'ok', ok: true }] }
          },
        },
      })
      const asked = await advance(state, 'a question', deps)
      expect(asked.cursor, screen).toBe(screen)
      expect(currentRecord(asked).type, screen).toBe('recovery')

      const before = verifies
      const again = await advance(asked, 'another question', deps)
      expect(again.cursor, screen).toBe(screen)
      expect(currentRecord(again).type, screen).toBe('recovery')
      expect(verifies, screen).toBe(before)
    }
  })
})

// --- recovery data ------------------------------------------------------------------------------

describe('recovery blocks', () => {
  it('every interactive step has a recovery block with at least one named mode', async () => {
    const INTERACTIVE = [
      'preflight',
      'github-org',
      'github-team',
      'github-team-lock',
      'org-harden',
      'github-pat',
      'test-buyer',
      'worker-url',
      'stripe-product',
      'payment-link',
      'webhook-secret',
      'config-written',
      'secret-name-check',
      'deploy',
      'synthetic-check',
      'purchase',
      'awaiting-grant',
      'accept-invite',
      'refund',
      'typo-test',
      'typo-purchase',
      'typo-claim',
      'typo-accept',
      'typo-refund',
    ]
    for (const id of INTERACTIVE) {
      const state = {
        cursor: id,
        answers: {
          env: 'sandbox',
          goal: 'full',
          revokePolicy: 'auto_revoke',
          typoTest: 'test',
        },
        flags: {},
        recovery: { detail: null },
      }
      const record = currentRecord(state as never)
      expect(record.type, id).toBe('recovery')
      expect(record.modes!.length, id).toBeGreaterThan(0)
      for (const mode of record.modes!) {
        expect(mode.when.length, `${id}/${mode.when}`).toBeGreaterThan(0)
        expect(mode.text.length, `${id}/${mode.when}`).toBeGreaterThan(30)
      }
    }
  })

  it('4b2 answers the one question its own sandbox option provokes', async () => {
    // The block was EMPTY for one relay: re-homing the base-permissions mode took its only mode with it.
    // Sandbox never parks here (a closed choice refuses a bad answer outright), so this mode is the
    // PRODUCTION run's - and the question is the one a deployer who has seen the sandbox skip option asks.
    const record = currentRecord({
      cursor: 'github-team-lock',
      answers: { env: 'production', goal: 'full' },
      flags: {},
      recovery: { detail: null },
    } as never)
    expect(record.type).toBe('recovery')
    const mode = record.modes!.find(
      (m) => m.when === 'can I skip this on a production run?',
    )!
    expect(mode).toBeDefined()
    expect(mode.text).toBe(
      "No - a production run cannot skip the attach: a grant without an attached repo unlocks nothing for a real buyer, and I can't verify it with the worker token (its repository access is the minimal Public repositories option), so this one is on you. Attach the repo(s) at Team -> Repositories -> **Add repository**, then type **done**.",
    )
  })

  it('a production question at 4b2 really parks on that mode rather than walking on', async () => {
    // The path the empty block would have stranded: 4b2 has no verify, so a question is the only thing
    // holding the cursor, and an empty block would have shown the deployer nothing at all.
    const { state, deps } = await driveTo(
      'github-team-lock',
      'production',
      'full',
    )
    const next = await advance(state, 'do I have to do this now?', deps)
    expect(next.cursor).toBe('github-team-lock')
    const record = currentRecord(next)
    expect(record.type).toBe('recovery')
    expect(record.modes!.length).toBeGreaterThan(0)
  })

  it('4b3 owns the base-permissions mode, and 4b2 no longer does', async () => {
    // The mode followed its bullet: 4b2 is attach-only now, so a deployer asking about Base permissions
    // is standing on the hardening walk when they ask.
    const record = currentRecord({
      cursor: 'org-harden',
      answers: { env: 'sandbox', goal: 'full' },
      flags: {},
      recovery: { detail: null },
    } as never)
    const mode = record.modes!.find(
      (m) => m.when === 'base permissions not set to No permission',
    )!
    expect(mode).toBeDefined()
    expect(mode.text).toContain('Set them to **No permission**')

    const lock = currentRecord({
      cursor: 'github-team-lock',
      answers: { env: 'production', goal: 'full' },
      flags: {},
      recovery: { detail: null },
    } as never)
    expect(lock.modes!.map((m) => m.when)).not.toContain(
      'base permissions not set to No permission',
    )
  })

  it('the fine-grained-PAT mode names the subpage the switch really lives on', async () => {
    // Live screenshots (2026-07-17): the switch is under Personal access tokens -> **Settings**, not on
    // the Personal access tokens landing page. The screen's own bullet was one level off and so was this.
    const record = currentRecord({
      cursor: 'org-harden',
      answers: { env: 'sandbox', goal: 'full' },
      flags: {},
      recovery: { detail: null },
    } as never)
    const mode = record.modes!.find(
      (m) => m.when === 'fine-grained tokens are restricted',
    )!
    expect(mode.text).toContain(
      'Org -> Settings -> Personal access tokens -> **Settings**, under Fine-grained personal access tokens',
    )
  })

  it('the zone recovery names the LIVE Cloudflare control, not a retired one', async () => {
    // The first catch of a stale dashboard NAME by OBSERVATION rather than by a walkthrough: this mode
    // said `Websites -> Add a site`, which does not exist in the dashboard. Adding a domain lives under
    // **Domains** (maintainer-confirmed live, 2026-07-16). Pinned because the old name was NOT pinned,
    // which is how it rotted unnoticed: no walkthrough covers Cloudflare, so the suite is the only guard.
    const record = currentRecord({
      cursor: 'worker-url',
      answers: {
        env: 'production',
        goal: 'quick',
        domain: 'access.example.com',
      },
      flags: {},
      recovery: { detail: null },
    } as never)
    const mode = record.modes!.find(
      (m) => m.when === 'the zone is not on this Cloudflare account',
    )!
    expect(mode.text).toContain("it's under **Domains** in the dashboard")
    expect(mode.text).not.toContain('Add a site')
    expect(mode.text).not.toContain('Websites')
    // And the slot still renders the run's real domain, like any other recovery text.
    expect(mode.text).toContain('`access.example.com`')
  })

  it('recovery text fills its placeholders like any other screen', async () => {
    const { state, deps } = await driveTo('github-pat', 'sandbox', 'full', {
      deps: githubFailing('GITHUB_TOKEN authenticates', 'invalid'),
    })
    const record = currentRecord(await advance(state, 'done', deps))
    const owner = record.modes!.find((m) => m.when === 'wrong resource owner')!
    expect(owner.text).toContain('`acme`')
    expect(owner.text).not.toContain('YOUR-ORG')
  })

  it('recovery names the env-correct secrets file, never the wrong one', async () => {
    for (const [env, file] of [
      ['sandbox', '.dev.vars'],
      ['production', '.dev.vars.production'],
    ] as const) {
      const { state, deps } = await driveTo('github-pat', env, 'full', {
        deps: githubFailing('GITHUB_TOKEN authenticates', 'invalid'),
      })
      const record = currentRecord(await advance(state, 'done', deps))
      const noToken = record.modes!.find((m) => m.when === 'no token found')!
      expect(noToken.text, env).toContain(`\`${file}\``)
      if (env === 'sandbox') {
        expect(noToken.text, env).not.toContain('.dev.vars.production')
      }
    }
  })
})

// --- the agent shim documents the record type the agent was holding when it went off-path ----------
//
// The rendering table had rows for `say`, `ask/choice`, `ask/text` and `do`, and NONE for `recovery` -
// which is the record an agent is holding at exactly the moment the run has gone wrong and it is most
// tempted to improvise. On a live run it was holding one, read "open this in your browser" as addressed
// to ITSELF, and reached for a browser tool. The wording fix went into the driver's own text; this is the
// structural half, and it is asserted against the REAL committed shim, because that file is what an agent
// reads and a test over a copy of it would grade nothing.
describe('docs/setup-wizard.md covers the recovery record', () => {
  const SHIM = readFileSync(join(REPO_ROOT, 'docs/setup-wizard.md'), 'utf8')

  /**
   * Every pipe-prefixed line from the rendering table's header to the END OF THE FILE - so it is that
   * table's rows plus any later table's, not the one table. The rows are only ever read by their FIRST
   * cell (`| \`say\``, `| \`recovery\``), which no other table in the shim uses, so the wider slice
   * costs nothing today. It is written down because a future table whose first column held a record
   * type would be read as this one's.
   */
  const shimRows = () =>
    SHIM.slice(SHIM.indexOf('| `type`'))
      .split('\n')
      .filter((line) => line.startsWith('|'))

  /**
   * Every record this driver emits, from a DRIVEN sweep: both envs, both goals, both revoke policies,
   * and every screen's parked recovery. It is the widest statement available here of what the driver can
   * really produce.
   *
   * The downstream repo asks this same question of its committed record corpus, which is the same
   * instrument frozen to a file. There is no corpus here, so the sweep IS the instrument.
   */
  const everyEmittedType = async (): Promise<string[]> => {
    const types = new Set<string>()
    for (const env of ['sandbox', 'production'] as WizardEnv[]) {
      for (const goal of ['full', 'quick'] as WizardGoal[]) {
        for (const record of await drive(env, goal)) types.add(record.type)
        for (const record of await drive(env, goal, {
          revokePolicy: 'log_only',
        }))
          types.add(record.type)
      }
      for (const policy of ['auto_revoke', 'log_only']) {
        for (const record of recoveryRecordsFor(env, policy))
          types.add(record.type)
      }
    }
    return [...types].sort()
  }

  it('the rendering table has a row for every record type the driver can emit', async () => {
    // DERIVED, not listed. This used to hardcode `['say', 'ask', 'do', 'recovery']` under a comment
    // claiming it was read off the driver - so it could not catch the one thing it exists to catch, a
    // NEW record type reaching the wizard without reaching the document that tells an agent how to
    // render it. A hardcoded list passes for exactly as long as somebody remembers to extend it.
    //
    // Reading a row by its FIRST cell is what keeps a type merely MENTIONED in some other row's prose
    // from counting as documented. `ask` covers both `kind` variants and matches the two `| \`ask\``
    // rows.
    const emitted = await everyEmittedType()
    // The sweep is the instrument, so a sweep that stopped producing recoveries must not read as a
    // pass - that is the type this guard was built for.
    expect(emitted).toContain('recovery')
    expect(emitted.length).toBeGreaterThan(3)
    const rows = shimRows()
    for (const type of emitted) {
      expect(
        rows.some((line) => line.startsWith(`| \`${type}\``)),
        `no shim row for record type '${type}'`,
      ).toBe(true)
    }
  })

  it('the recovery row says what the record is and that its prose is rendered verbatim', () => {
    const row = shimRows().find((line) => line.startsWith('| `recovery`'))!
    expect(row).toContain('did not pass')
    expect(row).toContain('holds the run HERE')
    expect(row).toContain('`modes`')
    expect(row).toContain('verbatim')
  })

  it('the shim says a recovery addresses the DEPLOYER, and names the agent`s own move', () => {
    expect(SHIM).toContain(
      "**A recovery's instructions are the DEPLOYER's to carry out, not yours.**",
    )
    // the three things the live failure needed said: relay and wait, re-run the verification on `done`,
    // and do NOT reach for your own tools instead
    expect(SHIM).toContain('you relay it and wait')
    expect(SHIM).toContain("re-runs this step's verification")
    expect(SHIM).toContain(
      'never to\nsubstitute your own tools for their action',
    )
  })

  it('the table preamble does not claim every record carries `text` - a recovery carries `modes`', () => {
    // The row would otherwise contradict the sentence directly above it. Checked against the driver: a
    // recovery record really has no `text` field.
    const record = currentRecord({
      cursor: 'deploy',
      answers: { env: 'sandbox', goal: 'quick' },
      flags: {},
      recovery: { detail: null },
    } as never)
    expect(record.type).toBe('recovery')
    expect((record as { text?: string }).text).toBeUndefined()
    expect(record.modes!.length).toBeGreaterThan(0)
    expect(SHIM).not.toContain('`env`, `goal` and `text`')
  })
})
