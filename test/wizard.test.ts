// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Gary Stupak

import { describe, it, expect } from 'vitest'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import {
  checkEnv,
  doctor,
  preflight,
  ensureSecretsFiles,
  ensureConfigFiles,
  cloudflareAuthCheck,
  githubVerify,
  secretsCheck,
  kvCreate,
  grantRecord,
  deploy,
  e2e,
  resolveUrl,
  buildE2eEvent,
  stripeSignatureHeader,
  resolveE2eProduct,
  resolveE2ePack,
  STRIPE_E2E_PACK,
  collectTeams,
  parseJsonc,
  readEnvNames,
  readSecretValue,
  secretsFileFor,
  selectConfig,
  readRequiredSecrets,
  kvTitle,
  extractWorkerUrl,
  defaultFetchHealth,
  healthEvidence,
  deployHealth,
  BROWSER_UA,
  sameWorkerHost,
  isValidHostname,
  generateSecretPath,
  customDomainPattern,
  slugifySubdomain,
  parseWhoamiAccount,
  deriveSubdomain,
  whoamiEmailLocalPart,
  subdomainCheck,
  wranglerError,
  nodeSupportsTsImport,
  MIN_NODE_VERSION,
  type WizardCheck,
  type WizardResult,
} from '../scripts/wizard.mjs'
import { verifyHmac } from '../src/security/verify'
import { stripe } from '../src/adapters/stripe'

// Seed suite for the hardened wizard. Asserts the emit/exit contract, the check-env
// shape, and the github-verify check logic against MOCKED GitHub responses (org-missing,
// team-missing, public-repos-allowed, token-invalid, all-green, token-non-leak). A real GitHub run
// is a maintainer live-test step, not CI.

const wizardPath = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'scripts',
  'wizard.mjs',
)

function expectResultShape(result: WizardResult) {
  expect(typeof result.step).toBe('string')
  expect(typeof result.ok).toBe('boolean')
  expect(Array.isArray(result.checks)).toBe(true)
  expect(typeof result.next).toBe('string')
  for (const check of result.checks) {
    expect(typeof check.name).toBe('string')
    expect(typeof check.ok).toBe('boolean')
    if ('fix' in check) expect(typeof check.fix).toBe('string')
    if ('severity' in check) expect(['error', 'warn']).toContain(check.severity)
    if ('needsInput' in check) expect(typeof check.needsInput).toBe('string')
  }
  // ok aggregates over non-warn checks only; advisory warns never fail the step.
  expect(result.ok).toBe(
    result.checks.filter((c) => c.severity !== 'warn').every((c) => c.ok),
  )
}

const named = (result: WizardResult, substr: string): WizardCheck | undefined =>
  result.checks.find((c) => c.name.includes(substr))

// --- injectable-seam fixtures ------------------------------------------------------------------

type Route = {
  status: number
  json?: unknown
  headers?: Record<string, string>
}

function mockApi(routes: Record<string, Route>) {
  const calls: string[] = []
  return {
    calls,
    async get(path: string) {
      calls.push(path)
      const r = routes[path] ?? { status: 404, json: null }
      return {
        status: r.status,
        json: r.json ?? null,
        headers: { get: (n: string) => r.headers?.[n] ?? null },
      }
    },
  }
}

// A fake global fetch that records the Authorization header it was sent (for the non-leak test).
function fakeFetch(routes: Record<string, Route>) {
  const seen: Array<{ url: string; auth: unknown }> = []
  const fn = async (url: string, init: any) => {
    seen.push({ url, auth: init?.headers?.authorization })
    const path = url.replace('https://api.github.com', '')
    const r = routes[path] ?? { status: 404, json: null }
    return {
      status: r.status,
      async json() {
        return r.json ?? null
      },
      headers: { get: (n: string) => r.headers?.[n] ?? null },
    }
  }
  ;(fn as any).seen = seen
  return fn as any
}

const CONFIG = {
  githubOrg: 'acme',
  productTeamMap: {
    defaults: { teams: [] },
    stripe: { prod_x: { teams: ['pro'] } },
  },
}

const greenRoutes: Record<string, Route> = {
  '/user': { status: 200, json: { login: 'bot' } },
  '/orgs/acme': {
    status: 200,
    json: { members_can_create_public_repositories: false },
  },
  '/orgs/acme/teams/pro': { status: 200, json: { slug: 'pro' } },
  '/orgs/acme/teams/pro/repos': {
    status: 200,
    json: [{ name: 'secret-repo' }],
  },
  '/orgs/acme/teams/pro/members': { status: 200, json: [] },
}

// --- contract + check-env ----------------------------------------------------------------------

describe('wizard result contract', () => {
  it('check-env returns the { step, ok, checks, next } shape', () => {
    const result = checkEnv()
    expect(result.step).toBe('check-env')
    expectResultShape(result)
  })

  it('check-env passes in this repo (node floor, wrangler+git, example, aliases)', () => {
    const result = checkEnv()
    const failed = result.checks.filter((c: WizardCheck) => !c.ok)
    expect(failed).toEqual([])
    expect(result.ok).toBe(true)
    // >= rather than an exact count: the exact number churns on every check add/remove for little value
    expect(result.checks.length).toBeGreaterThanOrEqual(5)
  })

  it('doctor aggregates the read-only checks (ok = AND of sub-checks)', async () => {
    // A neutral config (no e2e.testUsername) means the test-buyer add-on is a no-op: doctor stays the
    // offline check-env core and never touches the network.
    const result = await doctor({ config: { githubOrg: '' } })
    expect(result.step).toBe('doctor')
    expectResultShape(result)
    expect(result.checks.length).toBeGreaterThanOrEqual(5)
    expect(result.ok).toBe(result.checks.every((c: WizardCheck) => c.ok))
    expect(named(result, 'test buyer')).toBeUndefined()
  })

  it('doctor: with a configured test buyer OUTSIDE the org (404) -> passing add-on check, both envs', async () => {
    for (const env of [undefined, 'production'] as const) {
      const result = await doctor({
        env,
        config: { githubOrg: 'acme', e2e: { testUsername: 'octocat' } },
        api: mockApi({ '/orgs/acme/memberships/octocat': { status: 404 } }),
      })
      expect(result.ok).toBe(true)
      expect(named(result, "test buyer 'octocat'")?.ok).toBe(true)
    }
  })

  it('doctor: a test buyer that IS a member (200) -> hard FAIL naming the two ways out, both envs', async () => {
    for (const env of [undefined, 'production'] as const) {
      const result = await doctor({
        env,
        config: { githubOrg: 'acme', e2e: { testUsername: 'insider' } },
        api: mockApi({
          '/orgs/acme/memberships/insider': {
            status: 200,
            json: { state: 'active', role: 'member' },
          },
        }),
      })
      expect(result.ok).toBe(false)
      const check = named(result, "test buyer 'insider'")
      expect(check?.ok).toBe(false)
      expect(check?.severity).not.toBe('warn')
      expect(check?.fix).toContain('second GitHub account')
      expect(check?.fix).toContain('remove')
    }
  })

  it('doctor: a 403 on the membership read -> advisory WARN (never a hard red), both envs', async () => {
    for (const env of [undefined, 'production'] as const) {
      const result = await doctor({
        env,
        config: { githubOrg: 'acme', e2e: { testUsername: 'octocat' } },
        api: mockApi({ '/orgs/acme/memberships/octocat': { status: 403 } }),
      })
      // a 403 degrades to a manual browser confirm, so doctor stays green
      expect(result.ok).toBe(true)
      const check = named(result, "test buyer 'octocat'")
      expect(check?.ok).toBe(false)
      expect(check?.severity).toBe('warn')
      expect(check?.fix).toContain('Org, People')
    }
  })

  it('pins a Node floor that supports .ts import', () => {
    expect(MIN_NODE_VERSION).toBe('22.18.0')
    expect(nodeSupportsTsImport('22.18.0')).toBe(true)
    expect(nodeSupportsTsImport('23.5.0')).toBe(false)
    expect(nodeSupportsTsImport('23.6.0')).toBe(true)
    expect(nodeSupportsTsImport('24.0.0')).toBe(true)
    expect(nodeSupportsTsImport('22.6.0')).toBe(false)
  })
})

// --- preflight (check-env + secrets-file copy + Cloudflare auth, seams mocked) -----------------

describe('preflight (Step 0 superset)', () => {
  it('ensureSecretsFiles (sandbox, default env) creates ONLY .dev.vars, never .dev.vars.production', () => {
    const cwd = 'proj'
    const devVars = join(cwd, '.dev.vars')
    const devVarsExample = join(cwd, '.dev.vars.example')
    // .dev.vars missing, its template present; nothing production-related is touched.
    const present = new Set([devVarsExample])
    const copied: Array<[string, string]> = []
    const checks = ensureSecretsFiles(cwd, {
      exists: (p: string) => present.has(p),
      copy: (src: string, dst: string) => {
        copied.push([src, dst])
      },
    })
    // sandbox creates only .dev.vars
    expect(copied).toEqual([[devVarsExample, devVars]])
    expect(checks).toHaveLength(1)
    // the check NAME stays stable whether or not work was done; the "just created" fact
    // rides on the informational `detail` field, not the name (a name that flipped broke a
    // fresh clone's first `npm test`).
    expect(checks[0].name).toBe('.dev.vars present')
    expect(checks[0].ok).toBe(true)
    expect(checks[0].detail).toContain('created from .dev.vars.example')
    // the stray .dev.vars.production the maintainer saw must NOT be created
    expect(
      checks.some((c: WizardCheck) => c.name.includes('.dev.vars.production')),
    ).toBe(false)
  })

  it('ensureSecretsFiles (production) creates ONLY .dev.vars.production', () => {
    const cwd = 'proj'
    const prod = join(cwd, '.dev.vars.production')
    const prodExample = join(cwd, '.dev.vars.production.example')
    const present = new Set([prodExample])
    const copied: Array<[string, string]> = []
    const checks = ensureSecretsFiles(cwd, {
      env: 'production',
      exists: (p: string) => present.has(p),
      copy: (src: string, dst: string) => {
        copied.push([src, dst])
      },
    })
    expect(copied).toEqual([[prodExample, prod]])
    expect(checks).toHaveLength(1)
    // stable name, "just created" rides on detail (see the sandbox case above)
    expect(checks[0].name).toBe('.dev.vars.production present')
    expect(checks[0].ok).toBe(true)
    expect(checks[0].detail).toContain(
      'created from .dev.vars.production.example',
    )
  })

  it('ensureSecretsFiles leaves an existing production file alone (never copies)', () => {
    const cwd = 'proj'
    const present = new Set([join(cwd, '.dev.vars.production')])
    const checks = ensureSecretsFiles(cwd, {
      env: 'production',
      exists: (p: string) => present.has(p),
      copy: () => {
        throw new Error('should not copy')
      },
    })
    expect(checks).toHaveLength(1)
    expect(checks[0].name).toBe('.dev.vars.production present')
    expect(checks[0].ok).toBe(true)
    // an existing file is reported present with no "created" detail
    expect(checks[0].detail).toBeUndefined()
  })

  it('ensureSecretsFiles leaves an existing sandbox file alone (never copies)', () => {
    const cwd = 'proj'
    const present = new Set([join(cwd, '.dev.vars')])
    const checks = ensureSecretsFiles(cwd, {
      exists: (p: string) => present.has(p),
      copy: () => {
        throw new Error('should not copy')
      },
    })
    expect(
      checks.find((c: WizardCheck) => c.name === '.dev.vars present')?.ok,
    ).toBe(true)
  })

  it('ensureSecretsFiles reports a fix when neither the file nor its template exists', () => {
    const checks = ensureSecretsFiles('proj', {
      exists: () => false,
      copy: () => {
        throw new Error('should not copy')
      },
    })
    expect(checks.every((c: WizardCheck) => !c.ok)).toBe(true)
    expect(checks[0].fix).toContain('.dev.vars.example')
  })

  it('ensureConfigFiles creates the config + wrangler templates when both are absent', () => {
    const cwd = 'proj'
    const configExample = join(cwd, 'src/config/repoaccess.config.example.ts')
    const wranglerExample = join(cwd, 'wrangler.jsonc.example')
    // Both real files missing, both templates present.
    const present = new Set([configExample, wranglerExample])
    const copied: Array<[string, string]> = []
    const checks = ensureConfigFiles(cwd, {
      exists: (p: string) => present.has(p),
      copy: (src: string, dst: string) => {
        copied.push([src, dst])
      },
    })
    expect(copied).toEqual([
      [configExample, join(cwd, 'src/config/repoaccess.config.ts')],
      [wranglerExample, join(cwd, 'wrangler.jsonc')],
    ])
    expect(checks.map((c: WizardCheck) => c.name)).toEqual([
      'src/config/repoaccess.config.ts present',
      'wrangler.jsonc present',
    ])
    expect(checks.every((c: WizardCheck) => c.ok)).toBe(true)
    // stable name; the "just created" fact rides on `detail` (same rule as the secrets copy)
    expect(checks[0].detail).toContain(
      'created from src/config/repoaccess.config.example.ts',
    )
    expect(checks[1].detail).toContain('created from wrangler.jsonc.example')
  })

  it('ensureConfigFiles leaves existing config/wrangler files alone (never copies)', () => {
    const cwd = 'proj'
    const present = new Set([
      join(cwd, 'src/config/repoaccess.config.ts'),
      join(cwd, 'wrangler.jsonc'),
    ])
    const checks = ensureConfigFiles(cwd, {
      exists: (p: string) => present.has(p),
      copy: () => {
        throw new Error('should not copy')
      },
    })
    expect(checks.every((c: WizardCheck) => c.ok)).toBe(true)
    // an existing file is reported present with no "created" detail
    expect(checks.every((c: WizardCheck) => c.detail === undefined)).toBe(true)
  })

  it('ensureConfigFiles reports a fix when a real file and its template are both absent', () => {
    const checks = ensureConfigFiles('proj', {
      exists: () => false,
      copy: () => {
        throw new Error('should not copy')
      },
    })
    expect(checks.every((c: WizardCheck) => !c.ok)).toBe(true)
    expect(checks[0].fix).toContain('repoaccess.config.example.ts')
    expect(checks[1].fix).toContain('wrangler.jsonc.example')
  })

  it('cloudflareAuthCheck passes on whoami exit 0, else a wrangler login fix', () => {
    const ok = cloudflareAuthCheck(() => ({
      ok: true,
      status: 0,
      stdout: '',
      stderr: '',
    }))
    expect(ok.ok).toBe(true)
    const fail = cloudflareAuthCheck(() => ({
      ok: false,
      status: 1,
      stdout: '',
      stderr: '',
    }))
    expect(fail.ok).toBe(false)
    expect(fail.fix).toContain('npx wrangler login')
  })

  it('is green in this repo when Cloudflare auth passes (env + secrets files + whoami)', () => {
    // The fs seams model a tree where every real file is ALREADY in place, which is the state this
    // case is about - so both ensure* steps take their already-present branch and copy nothing. Passed
    // explicitly because the defaults are `existsSync`/`copyFileSync` against `process.cwd()`: without
    // them this test really did copy `.dev.vars.example` into the repository root as a side effect of
    // running the suite. Nothing here asserts on `copied`; it exists so the double is a no-op sink.
    const copied: Array<[string, string]> = []
    const result = preflight({
      run: mockRun({ whoami: { ok: true } }),
      exists: () => true,
      copy: (src: string, dst: string) => {
        copied.push([src, dst])
      },
    })
    expect(result.step).toBe('preflight')
    expect(result.ok).toBe(true)
    expectResultShape(result)
    // subsumes the check-env preflight
    expect(named(result, 'wrangler resolvable')?.ok).toBe(true)
    expect(named(result, '.dev.vars present')?.ok).toBe(true)
    // the config-as-code + wrangler templates are put in place too
    expect(named(result, 'src/config/repoaccess.config.ts present')?.ok).toBe(
      true,
    )
    expect(named(result, 'wrangler.jsonc present')?.ok).toBe(true)
    expect(named(result, 'Cloudflare authenticated')?.ok).toBe(true)
  })

  it('preflight carries the STABLE check name in the created-from-template case (fresh-clone regression)', () => {
    // Fresh clone: `.dev.vars` is gitignored and absent, its template is present. Preflight copies it
    // AND must still report the stable `.dev.vars present` name (ok:true) - the exact case that made a
    // fresh clone's FIRST `npm test` red when the name flipped to `.dev.vars created from ...`. Seams
    // force the created branch deterministically without touching disk.
    const copied: Array<[string, string]> = []
    const result = preflight({
      run: mockRun({ whoami: { ok: true } }),
      // Fresh clone: every gitignored real file is absent, every committed `.example` template present -
      // the config module, wrangler.jsonc, and .dev.vars all get created from their templates.
      exists: (p: string) =>
        p.endsWith('.dev.vars.example') ||
        p.endsWith('repoaccess.config.example.ts') ||
        p.endsWith('wrangler.jsonc.example'),
      copy: (src: string, dst: string) => {
        copied.push([src, dst])
      },
    })
    expect(result.ok).toBe(true)
    // config + wrangler + .dev.vars, all created from their templates
    expect(copied).toHaveLength(3)
    const createdVars = named(result, '.dev.vars present')
    expect(createdVars?.ok).toBe(true)
    expect(createdVars?.detail).toContain('created from .dev.vars.example')
    const createdConfig = named(
      result,
      'src/config/repoaccess.config.ts present',
    )
    expect(createdConfig?.ok).toBe(true)
    expect(createdConfig?.detail).toContain(
      'created from src/config/repoaccess.config.example.ts',
    )
    const createdWrangler = named(result, 'wrangler.jsonc present')
    expect(createdWrangler?.ok).toBe(true)
    expect(createdWrangler?.detail).toContain(
      'created from wrangler.jsonc.example',
    )
  })

  it('fails when Cloudflare auth is missing, with a wrangler login fix', () => {
    // Same reason as the green case above: every real file present, so the ensure* steps copy nothing
    // and the only failing check is the one this test is about. Without the seams this ran against the
    // real repository root and wrote `.dev.vars` into it.
    const copied: Array<[string, string]> = []
    const result = preflight({
      run: mockRun({}),
      exists: () => true,
      copy: (src: string, dst: string) => {
        copied.push([src, dst])
      },
    })
    expect(result.ok).toBe(false)
    expect(named(result, 'Cloudflare authenticated')?.fix).toContain(
      'npx wrangler login',
    )
  })
})

// --- github-verify (mocked API) ----------------------------------------------------------------

describe('github-verify check logic', () => {
  it('all mocks green -> ok:true, one check per verified item', async () => {
    const result = await githubVerify({
      config: CONFIG,
      api: mockApi(greenRoutes),
    })
    expect(result.step).toBe('github-verify')
    expect(result.ok).toBe(true)
    expectResultShape(result)
    expect(named(result, 'authenticates')?.ok).toBe(true)
    expect(named(result, "org 'acme'")?.ok).toBe(true)
    expect(named(result, 'public repos')?.ok).toBe(true)
    expect(named(result, "team 'pro' exists")?.ok).toBe(true)
    expect(named(result, 'repo attached')?.ok).toBe(true)
    expect(named(result, 'manage team membership')?.ok).toBe(true)
  })

  it('org missing -> ok:false with an org fix, short-circuits', async () => {
    const result = await githubVerify({
      config: CONFIG,
      api: mockApi({ ...greenRoutes, '/orgs/acme': { status: 404 } }),
    })
    expect(result.ok).toBe(false)
    const org = named(result, "org 'acme'")
    expect(org?.ok).toBe(false)
    expect(org?.fix).toContain('github.com/orgs/acme')
    // short-circuit: no team checks after a missing org
    expect(named(result, "team 'pro'")).toBeUndefined()
  })

  it('team missing -> ok:false with a create-team fix', async () => {
    const result = await githubVerify({
      config: CONFIG,
      api: mockApi({ ...greenRoutes, '/orgs/acme/teams/pro': { status: 404 } }),
    })
    expect(result.ok).toBe(false)
    const team = named(result, "team 'pro' exists")
    expect(team?.ok).toBe(false)
    expect(team?.fix).toContain('new-team')
  })

  it('sandbox (default env): no repo -> advisory WARN, github-verify stays GREEN (not blocked)', async () => {
    const result = await githubVerify({
      config: CONFIG,
      api: mockApi({
        ...greenRoutes,
        '/orgs/acme/teams/pro/repos': { status: 200, json: [] },
      }),
    })
    // the worker PAT cannot verify repo attachment, so this is advisory, not a plumbing failure
    expect(result.ok).toBe(true)
    const repo = named(result, 'repo attached')
    expect(repo?.ok).toBe(false)
    expect(repo?.severity).toBe('warn')
    expect(repo?.fix).toContain('cannot verify repo attachment')
    // the team-exists error check still passed
    expect(named(result, "team 'pro' exists")?.ok).toBe(true)
  })

  it('production env: no repo -> STILL advisory WARN (worker PAT cannot verify), stays GREEN', async () => {
    const result = await githubVerify({
      env: 'production',
      config: CONFIG,
      api: mockApi({
        ...greenRoutes,
        '/orgs/acme/teams/pro/repos': { status: 200, json: [] },
      }),
    })
    // the worker PAT is minted with repository access = Public repositories (the minimal option), so a repo-less result is a structural
    // false-negative even in production - advisory, not a hard gate. Manual confirm covers production.
    expect(result.ok).toBe(true)
    const repo = named(result, 'repo attached')
    expect(repo?.ok).toBe(false)
    expect(repo?.severity).toBe('warn')
    expect(repo?.fix).toContain('worker PAT')
  })

  it('members can create public repos -> hardening check fails', async () => {
    const result = await githubVerify({
      config: CONFIG,
      api: mockApi({
        ...greenRoutes,
        '/orgs/acme': {
          status: 200,
          json: { members_can_create_public_repositories: true },
        },
      }),
    })
    expect(result.ok).toBe(false)
    const hardening = named(result, 'public repos')
    expect(hardening?.ok).toBe(false)
    expect(hardening?.fix).toContain('uncheck Public')
  })

  it('hardening field not visible -> ok:false with a verify-manually fix (no false pass)', async () => {
    const result = await githubVerify({
      config: CONFIG,
      api: mockApi({ ...greenRoutes, '/orgs/acme': { status: 200, json: {} } }),
    })
    const hardening = named(result, 'public repos')
    expect(hardening?.ok).toBe(false)
    expect(hardening?.fix).toContain('verify manually')
  })

  it('invalid token -> auth check fails and short-circuits', async () => {
    const result = await githubVerify({
      config: CONFIG,
      api: mockApi({ ...greenRoutes, '/user': { status: 401 } }),
    })
    expect(result.ok).toBe(false)
    expect(result.checks).toHaveLength(1)
    expect(named(result, 'authenticates')?.fix).toContain('invalid or expired')
  })

  it('rate limit -> graceful, no crash', async () => {
    const result = await githubVerify({
      config: CONFIG,
      api: mockApi({
        ...greenRoutes,
        '/user': { status: 403, headers: { 'x-ratelimit-remaining': '0' } },
      }),
    })
    expect(result.ok).toBe(false)
    expect(named(result, 'authenticates')?.fix).toContain('rate limit')
  })

  it('never leaks the token: uses it in the Authorization header, never in the output', async () => {
    const token = 'ghp_SECRET_DO_NOT_LEAK_123'
    const fetchSpy = fakeFetch(greenRoutes)
    const result = await githubVerify({
      config: CONFIG,
      token,
      fetch: fetchSpy,
    })
    expect(result.ok).toBe(true)
    // token WAS used (proves the seam wired the header)...
    expect(fetchSpy.seen.some((s: any) => String(s.auth).includes(token))).toBe(
      true,
    )
    // ...but never appears in the emitted result.
    expect(JSON.stringify(result)).not.toContain(token)
  })

  it('test buyer OUTSIDE the org (404) -> passing check, in BOTH envs', async () => {
    for (const env of [undefined, 'production'] as const) {
      const result = await githubVerify({
        env,
        config: { ...CONFIG, e2e: { testUsername: 'octocat' } },
        api: mockApi({
          ...greenRoutes,
          '/orgs/acme/memberships/octocat': { status: 404 },
        }),
      })
      expect(result.ok).toBe(true)
      expect(named(result, "test buyer 'octocat'")?.ok).toBe(true)
    }
  })

  it('test buyer already IN the org (200) -> HARD FAIL in BOTH envs, fix names the two ways out', async () => {
    for (const env of [undefined, 'production'] as const) {
      const result = await githubVerify({
        env,
        config: { ...CONFIG, e2e: { testUsername: 'owner' } },
        api: mockApi({
          ...greenRoutes,
          '/orgs/acme/memberships/owner': {
            status: 200,
            json: { state: 'active', role: 'admin' },
          },
        }),
      })
      expect(result.ok).toBe(false)
      const check = named(result, "test buyer 'owner'")
      expect(check?.ok).toBe(false)
      // a hard error, not an advisory warn - it must block the run in both envs
      expect(check?.severity).not.toBe('warn')
      expect(check?.fix).toContain('second GitHub account')
      expect(check?.fix).toContain('remove')
    }
  })

  it('test buyer membership read 403 -> advisory WARN, stays GREEN in BOTH envs', async () => {
    for (const env of [undefined, 'production'] as const) {
      const result = await githubVerify({
        env,
        config: { ...CONFIG, e2e: { testUsername: 'octocat' } },
        api: mockApi({
          ...greenRoutes,
          '/orgs/acme/memberships/octocat': { status: 403 },
        }),
      })
      // the token cannot read membership: degrade to manual confirm, never a hard-red panic
      expect(result.ok).toBe(true)
      const check = named(result, "test buyer 'octocat'")
      expect(check?.ok).toBe(false)
      expect(check?.severity).toBe('warn')
      expect(check?.fix).toContain('Org, People')
    }
  })

  it('no e2e.testUsername configured -> the test-buyer check is skipped entirely (no-op)', async () => {
    const result = await githubVerify({
      config: CONFIG,
      api: mockApi(greenRoutes),
    })
    expect(named(result, 'test buyer')).toBeUndefined()
  })

  it('collectTeams walks the flat productTeamMap (nested + direct), deduped', () => {
    expect(collectTeams(CONFIG)).toEqual(['pro'])
    expect(
      collectTeams({
        productTeamMap: {
          defaults: { teams: ['base'] },
          stripe: { teams: ['pro'] },
          other: { p1: { teams: ['pro', 'plus'] } },
        },
      }),
    ).toEqual(['base', 'pro', 'plus'])
  })
})

// --- env-aware value + config reads (production reads the production sources) -------------------

describe('env-aware secret VALUE read and config select', () => {
  it('secretsFileFor maps the env to its secrets VALUE file', () => {
    expect(secretsFileFor(null)).toBe('.dev.vars')
    expect(secretsFileFor(undefined)).toBe('.dev.vars')
    expect(secretsFileFor('production')).toBe('.dev.vars.production')
  })

  it('readSecretValue: production reads .dev.vars.production, sandbox reads .dev.vars', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wizard-'))
    writeFileSync(join(dir, '.dev.vars'), 'GITHUB_TOKEN=sandbox_token\n')
    writeFileSync(
      join(dir, '.dev.vars.production'),
      'GITHUB_TOKEN=prod_token\n',
    )
    // empty processEnv so the file (not the real process env) is the source
    expect(readSecretValue('GITHUB_TOKEN', dir, { processEnv: {} })).toBe(
      'sandbox_token',
    )
    expect(
      readSecretValue('GITHUB_TOKEN', dir, { env: null, processEnv: {} }),
    ).toBe('sandbox_token')
    expect(
      readSecretValue('GITHUB_TOKEN', dir, {
        env: 'production',
        processEnv: {},
      }),
    ).toBe('prod_token')
  })

  it('selectConfig: production picks the production profile, sandbox picks sandbox', () => {
    const mod = {
      sandbox: { githubOrg: 'acme-sandbox' },
      production: { githubOrg: 'acme-prod' },
    }
    const org = (c: unknown) => (c as { githubOrg?: string })?.githubOrg
    expect(org(selectConfig(mod))).toBe('acme-sandbox')
    expect(org(selectConfig(mod, null))).toBe('acme-sandbox')
    expect(org(selectConfig(mod, 'production'))).toBe('acme-prod')
    // a single-profile config still resolves for either env (no regression)
    const only = { default: { githubOrg: 'solo' } }
    expect(org(selectConfig(only))).toBe('solo')
    expect(org(selectConfig(only, 'production'))).toBe('solo')
  })
})

// --- secrets-check (names only, never values) --------------------------------------------------

const REQUIRED = {
  base: ['GITHUB_TOKEN', 'STRIPE_WEBHOOK_SECRET'],
  production: ['GITHUB_TOKEN'],
}

describe('secrets-check (names only)', () => {
  it('parseJsonc tolerates comments and trailing commas', () => {
    const jsonc = `{
      // a line comment
      "secrets": { "required": ["A", "B"] }, /* block */
      "env": { "production": { "secrets": { "required": ["A"] } } },
    }`
    const parsed = parseJsonc(jsonc)
    expect(parsed.secrets.required).toEqual(['A', 'B'])
    expect(parsed.env.production.secrets.required).toEqual(['A'])
  })

  // A TRAILING COMMA FOLLOWED BY A COMMENT is the shape this project's own templates produce, and it
  // was rejected until 0.9.3.
  //
  // Why it matters more than a parser curiosity: the wrangler template lists each adapter's secret
  // COMMENTED OUT, for the deployer to uncomment as they compose that adapter. Whichever entry they
  // uncomment last is followed by a comma and then the remaining commented lines - so the shape is not
  // an edge case, it is what the template DESIGN produces in a real seller's live file. Wrangler
  // itself accepts that JSONC and deploys from it. A wizard that refused to read it would be
  // rejecting a file the deploy accepts, which is a lie on the seam between the two.
  //
  // The contract these tests pin: for the JSONC shapes this project's templates produce, parseJsonc
  // agrees with wrangler.
  describe('parseJsonc: a trailing comma followed by a comment', () => {
    it('parses the minimal repro', () => {
      expect(parseJsonc('{"a":["X",\n  // note\n]}')).toEqual({ a: ['X'] })
    })

    it('parses the shipped template tail, shaped exactly as it ships', () => {
      // The real thing: one uncommented entry, its comma, then several commented-out adapters before
      // the bracket. This is the fixture the defect was found on.
      const jsonc = `{
  "secrets": {
    "required": [
      "GITHUB_TOKEN",
      // -- Provider A --
      // "A_WEBHOOK_SECRET",
      // -- Provider B --
      // "B_WEBHOOK_SECRET",
    ],
  },
}`
      expect(parseJsonc(jsonc).secrets.required).toEqual(['GITHUB_TOKEN'])
    })

    it('parses it with a BLOCK comment between the comma and the bracket', () => {
      expect(parseJsonc('{"a":["X",\n  /* note */\n]}')).toEqual({ a: ['X'] })
    })

    it('parses the object form', () => {
      expect(parseJsonc('{"a": 1, // note\n}')).toEqual({ a: 1 })
    })
  })

  // The regressions. Each of these passed BEFORE the fix and must keep passing: the comma logic now
  // runs on comment-free text, and the risk of that change is doing something to STRINGS.
  describe('parseJsonc: shapes that already worked keep working', () => {
    it('an array with no trailing comma', () => {
      expect(parseJsonc('{"a":["X"]}')).toEqual({ a: ['X'] })
    })

    it('an array with a bare trailing comma', () => {
      expect(parseJsonc('{"a":["X",]}')).toEqual({ a: ['X'] })
    })

    it('a string VALUE containing a comment marker survives untouched', () => {
      // The whole reason both passes are string-aware. A URL in a config file is the everyday case.
      expect(
        parseJsonc('{"a": "https://x.test//p", "b": "/* not a comment */"}'),
      ).toEqual({
        a: 'https://x.test//p',
        b: '/* not a comment */',
      })
    })

    it('a string VALUE containing a quote-comma sequence does not confuse the comma logic', () => {
      expect(parseJsonc('{"a": "x\\",", "b": 1}')).toEqual({ a: 'x",', b: 1 })
    })

    it('a string value ending in a comma, last in its array', () => {
      expect(parseJsonc('{"a":["x,",\n // note\n]}')).toEqual({ a: ['x,'] })
    })
  })

  it('readRequiredSecrets reads the real wrangler.jsonc (base + production)', () => {
    const req = readRequiredSecrets()
    expect(req?.base).toEqual(['GITHUB_TOKEN', 'STRIPE_WEBHOOK_SECRET'])
    expect(req?.production).toEqual(['GITHUB_TOKEN', 'STRIPE_WEBHOOK_SECRET'])
  })

  it('readEnvNames returns KEY names only, discarding values', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wizard-'))
    const file = join(dir, '.dev.vars')
    writeFileSync(
      file,
      '# comment\nGITHUB_TOKEN=ghp_super_secret\n\nexport STRIPE_WEBHOOK_SECRET="whsec_secret"\n',
    )
    const names = readEnvNames(file)
    expect(names).toEqual(['GITHUB_TOKEN', 'STRIPE_WEBHOOK_SECRET'])
    // the parsed result carries no value substring
    expect(JSON.stringify(names)).not.toContain('secret')
  })

  it('sandbox (default env): checks ONLY .dev.vars base names, never the deployed worker', () => {
    let listed = false
    const result = secretsCheck({
      required: REQUIRED,
      readNames: () => ['GITHUB_TOKEN', 'STRIPE_WEBHOOK_SECRET'],
      listSecrets: () => {
        listed = true
        return { ok: true, names: [] }
      },
    })
    expect(result.step).toBe('secrets-check')
    expect(result.ok).toBe(true)
    expectResultShape(result)
    // the false-red the maintainer hit: no deployed-worker check runs in a sandbox run
    expect(listed).toBe(false)
    expect(named(result, 'uploaded to the production worker')).toBeUndefined()
    expect(named(result, 'GITHUB_TOKEN in .dev.vars')?.ok).toBe(true)
  })

  it('production: all names present locally and on the deployed worker -> ok:true', () => {
    const result = secretsCheck({
      env: 'production',
      required: REQUIRED,
      readNames: (f) =>
        f === '.dev.vars.production'
          ? ['GITHUB_TOKEN']
          : ['GITHUB_TOKEN', 'STRIPE_WEBHOOK_SECRET'],
      listSecrets: () => ({ ok: true, names: ['GITHUB_TOKEN'] }),
    })
    expect(result.step).toBe('secrets-check')
    expect(result.ok).toBe(true)
    expectResultShape(result)
  })

  it('a missing local name -> ok:false with an add-to-file fix', () => {
    const result = secretsCheck({
      required: REQUIRED,
      readNames: () => ['GITHUB_TOKEN'],
    })
    expect(result.ok).toBe(false)
    const missing = named(result, 'STRIPE_WEBHOOK_SECRET in .dev.vars')
    expect(missing?.ok).toBe(false)
    expect(missing?.fix).toContain('.dev.vars')
  })

  it('a missing local file -> a file-present fix naming the setup, never a raw cp', () => {
    const result = secretsCheck({
      required: REQUIRED,
      readNames: () => null,
    })
    expect(result.ok).toBe(false)
    const fix = named(result, '.dev.vars present')?.fix
    expect(fix).toContain('npm run wizard:drive')
    expect(fix).toContain('.dev.vars.example')
    expect(fix).not.toContain('cp ')
  })

  it('production: the file-present fix names the env-correct secrets file', () => {
    const result = secretsCheck({
      env: 'production',
      required: REQUIRED,
      readNames: () => null,
      listSecrets: () => ({ ok: true, names: REQUIRED.production }),
    })
    // The driver carries the env; env-correctness rides in the FILE name, not the command.
    const fix = named(result, '.dev.vars.production present')?.fix
    expect(fix).toContain('.dev.vars.production')
    expect(fix).not.toContain('.dev.vars.example.production')
  })

  it('production unauthed / not deployed -> graceful ok:false, surfaces the real wrangler stderr', () => {
    const result = secretsCheck({
      env: 'production',
      required: REQUIRED,
      readNames: () => ['GITHUB_TOKEN'],
      listSecrets: () => ({ ok: false }),
    })
    expect(result.ok).toBe(false)
    expect(named(result, 'wrangler secret list')?.fix).toContain(
      'npx wrangler login',
    )
  })

  it('production: a production name not uploaded -> a secret-put fix', () => {
    const result = secretsCheck({
      env: 'production',
      required: REQUIRED,
      readNames: () => ['GITHUB_TOKEN'],
      listSecrets: () => ({ ok: true, names: [] }),
    })
    expect(result.ok).toBe(false)
    expect(named(result, 'GITHUB_TOKEN uploaded')?.fix).toContain(
      'wrangler secret put GITHUB_TOKEN',
    )
  })

  it('never leaks a value: a value in a fake .dev.vars never appears in the output', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wizard-'))
    writeFileSync(
      join(dir, 'wrangler.jsonc'),
      '{ "secrets": { "required": ["GITHUB_TOKEN"] }, "env": { "production": { "secrets": { "required": ["GITHUB_TOKEN"] } } }, }',
    )
    writeFileSync(
      join(dir, '.dev.vars'),
      'GITHUB_TOKEN=ghp_DO_NOT_LEAK_THIS_VALUE\nSTRIPE_WEBHOOK_SECRET=whsec_ALSO_SECRET\n',
    )
    // Real fs parse (readNames not injected); only the network seam is mocked.
    const result = secretsCheck({
      cwd: dir,
      listSecrets: () => ({ ok: true, names: ['GITHUB_TOKEN'] }),
    })
    const emitted = JSON.stringify(result)
    expect(emitted).not.toContain('ghp_DO_NOT_LEAK_THIS_VALUE')
    expect(emitted).not.toContain('whsec_ALSO_SECRET')
  })
})

// --- mutating steps: kv-create + deploy (mocked runCommand) ------------------------------------

// Mock the wrangler runner seam: match on the joined args, default to a failed command.
function mockRun(
  handlers: Record<string, { ok: boolean; stdout?: string; stderr?: string }>,
) {
  const calls: string[][] = []
  const fn = (args: string[]) => {
    calls.push(args)
    const h = handlers[args.join(' ')]
    return {
      ok: h?.ok ?? false,
      status: h?.ok ? 0 : 1,
      stdout: h?.stdout ?? '',
      stderr: h?.stderr ?? '',
    }
  }
  ;(fn as any).calls = calls
  return fn as any
}

const HEX_A = 'a'.repeat(32)
const HEX_B = 'b'.repeat(32)
const HEX_C = 'c'.repeat(32)
const HEX_D = 'd'.repeat(32)

// Config whose ids already match what the account reports (steady state).
const WCONF_MATCHED = {
  name: 'repoaccess-core',
  kv_namespaces: [{ binding: 'ENTITLEMENTS', id: HEX_A }],
  env: {
    production: { kv_namespaces: [{ binding: 'ENTITLEMENTS', id: HEX_B }] },
  },
}
// Config still carrying the shipped placeholder ids.
const WCONF_PLACEHOLDER = {
  name: 'repoaccess-core',
  kv_namespaces: [{ binding: 'ENTITLEMENTS', id: 'PLACEHOLDER_SANDBOX' }],
  env: {
    production: {
      kv_namespaces: [{ binding: 'ENTITLEMENTS', id: 'PLACEHOLDER_PROD' }],
    },
  },
}
// The REQUIRED convention titles carry the worker prefix: `<worker>-ENTITLEMENTS` /
// `<worker>-production-ENTITLEMENTS`.
const LIST_BOTH = JSON.stringify([
  { id: HEX_A, title: 'repoaccess-core-ENTITLEMENTS' },
  { id: HEX_B, title: 'repoaccess-core-production-ENTITLEMENTS' },
])

describe('kv-create (reconciliation)', () => {
  it('kvTitle enforces the REQUIRED <worker>-ENTITLEMENTS convention (default + named env)', () => {
    expect(kvTitle('repoaccess-core', null, 'ENTITLEMENTS')).toBe(
      'repoaccess-core-ENTITLEMENTS',
    )
    expect(kvTitle('repoaccess-core', 'production', 'ENTITLEMENTS')).toBe(
      'repoaccess-core-production-ENTITLEMENTS',
    )
  })

  it('convention namespaces exist + ids wired -> ok:true, and NEVER creates (idempotent)', () => {
    const run = mockRun({
      'kv namespace list': { ok: true, stdout: LIST_BOTH },
    })
    const result = kvCreate({ config: WCONF_MATCHED, run })
    expect(result.step).toBe('kv-create')
    expect(result.ok).toBe(true)
    expectResultShape(result)
    // reconciliation, not blind writes: a second run is a no-op, no create call
    expect(run.calls.some((a: string[]) => a.includes('create'))).toBe(false)
  })

  it('tolerates the real `kv namespace list` element shape (extra supports_url_encoding field)', () => {
    // Pinned to the real `wrangler kv namespace list` stdout: a JSON array whose elements carry a third
    // `supports_url_encoding` field alongside id + title. The reconciler matches on title/id and must
    // ignore the extra field. If a future wrangler bump changes the element keys or stops emitting a
    // JSON array on stdout, this (and the JSON.parse in kvCreate) breaks here, in the suite.
    const list = JSON.stringify([
      {
        id: HEX_A,
        title: 'repoaccess-core-ENTITLEMENTS',
        supports_url_encoding: true,
      },
      {
        id: HEX_B,
        title: 'repoaccess-core-production-ENTITLEMENTS',
        supports_url_encoding: true,
      },
    ])
    const run = mockRun({ 'kv namespace list': { ok: true, stdout: list } })
    const result = kvCreate({ config: WCONF_MATCHED, run })
    expect(result.ok).toBe(true)
    // matched the convention namespaces by title -> no create call
    expect(run.calls.some((a: string[]) => a.includes('create'))).toBe(false)
  })

  it('reconciles by the wired id when the title is custom (maintainer-created namespace)', () => {
    // A namespace the maintainer created under a non-convention title, already wired in wrangler.jsonc.
    const list = JSON.stringify([
      { id: HEX_A, title: 'my-custom-kv' },
      { id: HEX_B, title: 'my-custom-prod-kv' },
    ])
    const run = mockRun({ 'kv namespace list': { ok: true, stdout: list } })
    const result = kvCreate({ config: WCONF_MATCHED, run })
    expect(result.ok).toBe(true)
    // matched by id, so no duplicate is created
    expect(run.calls.some((a: string[]) => a.includes('create'))).toBe(false)
    expect(named(result, 'namespace exists (sandbox)')?.ok).toBe(true)
  })

  it('sandbox run: namespace missing -> creates ONLY the sandbox convention title (no --env), reports the id', () => {
    const run = mockRun({
      'kv namespace list': { ok: true, stdout: '[]' },
      'kv namespace create repoaccess-core-ENTITLEMENTS': {
        ok: true,
        stdout: `id = "${HEX_C}"`,
      },
      'kv namespace create repoaccess-core-production-ENTITLEMENTS': {
        ok: true,
        stdout: `id = "${HEX_D}"`,
      },
    })
    // Default (env null) = sandbox: reconcile ONLY the sandbox namespace.
    const result = kvCreate({ config: WCONF_PLACEHOLDER, run })
    expect(result.ok).toBe(false) // id not yet in wrangler.jsonc
    expect(named(result, 'namespace created (sandbox)')?.ok).toBe(true)
    // the create name carries the worker prefix and NO --env flag (title already encodes the env)
    expect(run.calls).toContainEqual([
      'kv',
      'namespace',
      'create',
      'repoaccess-core-ENTITLEMENTS',
    ])
    // ENV-AWARE: a sandbox run must NOT create (or even touch) the production namespace
    expect(run.calls).not.toContainEqual([
      'kv',
      'namespace',
      'create',
      'repoaccess-core-production-ENTITLEMENTS',
    ])
    expect(named(result, 'id set (production)')).toBeUndefined()
    const idset = named(result, 'id set (sandbox)')
    expect(idset?.ok).toBe(false)
    expect(idset?.fix).toContain(HEX_C)
  })

  it('production run: namespace missing -> creates ONLY the production convention title, reports the id', () => {
    const run = mockRun({
      'kv namespace list': { ok: true, stdout: '[]' },
      'kv namespace create repoaccess-core-ENTITLEMENTS': {
        ok: true,
        stdout: `id = "${HEX_C}"`,
      },
      'kv namespace create repoaccess-core-production-ENTITLEMENTS': {
        ok: true,
        stdout: `id = "${HEX_D}"`,
      },
    })
    const result = kvCreate({
      config: WCONF_PLACEHOLDER,
      run,
      env: 'production',
    })
    expect(result.ok).toBe(false) // id not yet in wrangler.jsonc
    expect(named(result, 'namespace created (production)')?.ok).toBe(true)
    expect(run.calls).toContainEqual([
      'kv',
      'namespace',
      'create',
      'repoaccess-core-production-ENTITLEMENTS',
    ])
    // ENV-AWARE: a production run must NOT create (or even touch) the sandbox namespace
    expect(run.calls).not.toContainEqual([
      'kv',
      'namespace',
      'create',
      'repoaccess-core-ENTITLEMENTS',
    ])
    expect(named(result, 'id set (sandbox)')).toBeUndefined()
    const idset = named(result, 'id set (production)')
    expect(idset?.ok).toBe(false)
    expect(idset?.fix).toContain(HEX_D)
  })

  it('safety net: a bare ENTITLEMENTS (no worker prefix) is FLAGGED as off-convention (advisory warn)', () => {
    // An old bugged run left a bare `ENTITLEMENTS`; the convention namespace also exists and is wired.
    const list = JSON.stringify([
      { id: HEX_C, title: 'ENTITLEMENTS' }, // off-convention artifact
      { id: HEX_A, title: 'repoaccess-core-ENTITLEMENTS' },
      { id: HEX_B, title: 'repoaccess-core-production-ENTITLEMENTS' },
    ])
    const run = mockRun({ 'kv namespace list': { ok: true, stdout: list } })
    const result = kvCreate({ config: WCONF_MATCHED, run })
    const flag = named(result, "bare 'ENTITLEMENTS'")
    expect(flag?.ok).toBe(false)
    expect(flag?.severity).toBe('warn')
    expect(flag?.fix).toContain('repoaccess-core-ENTITLEMENTS')
    // advisory only: the convention namespaces are wired, so the step still passes
    expect(result.ok).toBe(true)
    // never silently re-created
    expect(run.calls.some((a: string[]) => a.includes('create'))).toBe(false)
  })

  it('list fails -> graceful ok:false, surfaces the REAL wrangler stderr (not a generic catch-all)', () => {
    const run = mockRun({
      'kv namespace list': {
        ok: false,
        stderr: 'Authentication error [code: 10000]',
      },
    })
    const result = kvCreate({ config: WCONF_PLACEHOLDER, run })
    expect(result.ok).toBe(false)
    expect(named(result, 'list KV namespaces')?.fix).toContain(
      'Authentication error [code: 10000]',
    )
  })

  it('create fails -> safety net: surfaces the real stderr AND the actual namespaces present', () => {
    const run = mockRun({
      'kv namespace list': {
        ok: true,
        stdout: JSON.stringify([{ id: HEX_A, title: 'some-other-kv' }]),
      },
      'kv namespace create repoaccess-core-ENTITLEMENTS': {
        ok: false,
        stderr: 'A namespace with this account ID and title already exists',
      },
    })
    const result = kvCreate({ config: WCONF_PLACEHOLDER, run })
    expect(result.ok).toBe(false)
    const create = named(result, 'create ENTITLEMENTS namespace (sandbox)')
    expect(create?.ok).toBe(false)
    // real stderr surfaced
    expect(create?.fix).toContain('already exists')
    // safety net: the actual titles/ids present are reported so the human can wire the right one
    expect(create?.fix).toContain('some-other-kv')
    expect(create?.fix).toContain(HEX_A)
    // and the expected convention title is named
    expect(create?.fix).toContain('repoaccess-core-ENTITLEMENTS')
  })
})

describe('grant-record (REMOTE ENTITLEMENTS read)', () => {
  // A `wrangler kv key list` result: two grant records plus unrelated keys the parser must ignore.
  const GRANT_LIST = JSON.stringify([
    { name: 'grant:stripe:pi_3AbC123' },
    { name: 'claim:tok_xyz' },
    { name: 'claim_txn:stripe:pi_3AbC123' },
    { name: 'grant:stripe:pi_9ZzY789' },
  ])

  it('sandbox: parses the pi_... transaction ids, exposes them on result.grants, bakes in --remote (no --env)', () => {
    const run = mockRun({
      'kv key list --binding ENTITLEMENTS --remote': {
        ok: true,
        stdout: GRANT_LIST,
      },
    })
    const result = grantRecord({ run })
    expect(result.step).toBe('grant-record')
    expect(result.ok).toBe(true)
    expectResultShape(result)
    expect(result.grants).toEqual([
      { adapter: 'stripe', transactionId: 'pi_3AbC123' },
      { adapter: 'stripe', transactionId: 'pi_9ZzY789' },
    ])
    // each pi_ is surfaced in a check name so the orchestrator can read it
    expect(named(result, 'pi_3AbC123')?.ok).toBe(true)
    expect(named(result, 'pi_9ZzY789')?.ok).toBe(true)
    // --remote is REQUIRED and baked in; a sandbox run sends NO --env
    expect(run.calls).toContainEqual([
      'kv',
      'key',
      'list',
      '--binding',
      'ENTITLEMENTS',
      '--remote',
    ])
  })

  it('production run forwards --env production', () => {
    const run = mockRun({
      'kv key list --binding ENTITLEMENTS --remote --env production': {
        ok: true,
        stdout: GRANT_LIST,
      },
    })
    const result = grantRecord({ run, env: 'production' })
    expect(result.ok).toBe(true)
    expect(run.calls).toContainEqual([
      'kv',
      'key',
      'list',
      '--binding',
      'ENTITLEMENTS',
      '--remote',
      '--env',
      'production',
    ])
  })

  it('empty store -> ok:false with the complete-the-purchase fix (not the local-store trap)', () => {
    const run = mockRun({
      'kv key list --binding ENTITLEMENTS --remote': { ok: true, stdout: '[]' },
    })
    const result = grantRecord({ run })
    expect(result.ok).toBe(false)
    expect(result.grants).toEqual([])
    const check = named(result, 'grant records present')
    expect(check?.ok).toBe(false)
    expect(check?.fix).toContain('complete the real test purchase')
    expect(check?.fix).toContain('REMOTE')
  })

  it('wrangler failure -> ok:false surfacing the injected stderr', () => {
    const run = mockRun({
      'kv key list --binding ENTITLEMENTS --remote': {
        ok: false,
        stderr: 'Authentication error [code: 10000]',
      },
    })
    const result = grantRecord({ run })
    expect(result.ok).toBe(false)
    expect(named(result, 'list REMOTE ENTITLEMENTS keys')?.fix).toContain(
      'Authentication error [code: 10000]',
    )
  })
})

describe('deploy', () => {
  it('extractWorkerUrl pulls the workers.dev URL', () => {
    expect(
      extractWorkerUrl('Published\nhttps://repoaccess-core.acme.workers.dev'),
    ).toBe('https://repoaccess-core.acme.workers.dev')
    expect(extractWorkerUrl('no url here')).toBe(null)
  })

  it('sandbox deploy: uses --env="" --secrets-file .dev.vars, reports the URL, folds /health into ok', async () => {
    const run = mockRun({
      'deploy --env= --secrets-file .dev.vars': {
        ok: true,
        stdout: 'https://repoaccess-core.acme.workers.dev',
      },
    })
    const result = await deploy({
      config: WCONF_MATCHED,
      run,
      sleep: () => Promise.resolve(),
      fetchHealth: () => ({ ok: true, status: 200, body: { status: 'ok' } }),
    })
    expect(result.ok).toBe(true)
    // the proven command form (both flags restored)
    expect(run.calls[0]).toEqual([
      'deploy',
      '--env=',
      '--secrets-file',
      '.dev.vars',
    ])
    expect(named(result, 'deployed (sandbox)')?.name).toContain('workers.dev')
    expect(named(result, '/health')?.ok).toBe(true)
  })

  it('production deploy: uses --env production --secrets-file .dev.vars.production', async () => {
    const run = mockRun({
      'deploy --env production --secrets-file .dev.vars.production': {
        ok: true,
        stdout: 'https://repoaccess-core-production.acme.workers.dev',
      },
    })
    const result = await deploy({
      env: 'production',
      config: WCONF_MATCHED,
      run,
      sleep: () => Promise.resolve(),
      fetchHealth: () => ({ ok: true, status: 200, body: { status: 'ok' } }),
    })
    expect(result.ok).toBe(true)
    expect(run.calls[0]).toEqual([
      'deploy',
      '--env',
      'production',
      '--secrets-file',
      '.dev.vars.production',
    ])
  })

  it('post-deploy URL match: warns (advisory, non-blocking) when the deployed host differs from the resolved base', async () => {
    const run = mockRun({
      'deploy --env= --secrets-file .dev.vars': {
        ok: true,
        stdout: 'https://repoaccess-core.acme.workers.dev',
      },
    })
    const result = await deploy({
      config: WCONF_MATCHED,
      run,
      expectBase: 'https://repoaccess-core.OTHER.workers.dev',
      sleep: () => Promise.resolve(),
      fetchHealth: () => ({ ok: true, status: 200, body: { status: 'ok' } }),
    })
    const match = named(result, 'matches the resolved base')
    expect(match?.ok).toBe(false)
    expect(match?.severity).toBe('warn')
    expect(match?.fix).toContain('update the webhook endpoint URL')
    // advisory only: a healthy deploy with a mismatched URL is still ok:true
    expect(result.ok).toBe(true)
  })

  it('precondition fail (placeholder KV id) -> reports a fix and does NOT deploy', async () => {
    const run = mockRun({})
    const result = await deploy({ config: WCONF_PLACEHOLDER, run })
    expect(result.ok).toBe(false)
    const fix = named(result, 'KV id configured')?.fix
    expect(fix).toContain('ENTITLEMENTS namespace')
    expect(fix).toContain('npm run wizard:drive')
    expect(run.calls.length).toBe(0)
  })

  it('production precondition fail -> the fix carries the env in its label', async () => {
    const run = mockRun({})
    const result = await deploy({
      config: WCONF_PLACEHOLDER,
      env: 'production',
      run,
    })
    expect(result.ok).toBe(false)
    // The driver carries the env; the deployer's command is env-agnostic, so the env rides in the label.
    expect(named(result, 'KV id configured')?.fix).toContain('(production)')
    expect(run.calls.length).toBe(0)
  })

  it('deploy command fails -> graceful ok:false, surfaces the real wrangler stderr', async () => {
    const run = mockRun({
      'deploy --env= --secrets-file .dev.vars': {
        ok: false,
        stderr: 'workerd/server error [code: 10057]',
      },
    })
    const result = await deploy({ config: WCONF_MATCHED, run })
    expect(result.ok).toBe(false)
    expect(named(result, 'wrangler deploy')?.fix).toContain(
      'workerd/server error [code: 10057]',
    )
  })

  it('unhealthy worker -> /health check fails', async () => {
    const run = mockRun({
      'deploy --env= --secrets-file .dev.vars': {
        ok: true,
        stdout: 'https://repoaccess-core.acme.workers.dev',
      },
    })
    const result = await deploy({
      config: WCONF_MATCHED,
      run,
      sleep: () => Promise.resolve(),
      fetchHealth: () => ({
        ok: true,
        status: 200,
        body: { status: 'degraded' },
      }),
    })
    expect(result.ok).toBe(false)
    expect(named(result, '/health')?.ok).toBe(false)
  })

  it('production custom-domain deploy: no workers.dev URL -> falls back to the wired custom domain for /health', async () => {
    const run = mockRun({
      'deploy --env production --secrets-file .dev.vars.production': {
        ok: true,
        // a custom-domain deploy prints a route, not a workers.dev URL
        stdout: 'Deployed repoaccess-core\nroute: access.example.com/*',
      },
    })
    let probed: string | null = null
    const result = await deploy({
      env: 'production',
      config: WCONF_MATCHED,
      expectBase: 'https://access.example.com',
      run,
      sleep: () => Promise.resolve(),
      fetchHealth: (url: string) => {
        probed = url
        return { ok: true, status: 200, body: { status: 'ok' } }
      },
    })
    expect(result.ok).toBe(true)
    // health-checked the custom domain, not a workers.dev host that was never printed
    expect(probed).toBe('https://access.example.com')
    expect(named(result, 'using the wired custom domain')?.ok).toBe(true)
  })

  // Config carrying a real custom_domain route in env.production (what a wired production deploy looks
  // like). The FIX 1 fallback reads THIS route via customDomainPattern, not a config.e2e.url that
  // wrangler.jsonc never has.
  const WCONF_PROD_ROUTE = {
    name: 'repoaccess-core',
    kv_namespaces: [{ binding: 'ENTITLEMENTS', id: HEX_A }],
    env: {
      production: {
        kv_namespaces: [{ binding: 'ENTITLEMENTS', id: HEX_B }],
        routes: [{ pattern: 'access.example.com', custom_domain: true }],
      },
    },
  }

  it('production custom-domain deploy: /health falls back to the wrangler.jsonc custom_domain route (no --expect-url needed)', async () => {
    const run = mockRun({
      'deploy --env production --secrets-file .dev.vars.production': {
        ok: true,
        // a custom-domain deploy prints a route, not a workers.dev URL
        stdout: 'Deployed repoaccess-core\nroute: access.example.com/*',
      },
    })
    let probed: string | null = null
    const result = await deploy({
      env: 'production',
      config: WCONF_PROD_ROUTE,
      run,
      healthAttempts: 1,
      sleep: () => Promise.resolve(),
      fetchHealth: (url: string) => {
        probed = url
        return { ok: true, status: 200, body: { status: 'ok' } }
      },
    })
    expect(result.ok).toBe(true)
    // the wired custom domain (from routes[], via customDomainPattern) is the /health target
    expect(probed).toBe('https://access.example.com')
    expect(named(result, 'using the wired custom domain')?.ok).toBe(true)
  })

  it('sandbox deploy: the parsed workers.dev URL wins and the custom_domain route is NEVER consulted', async () => {
    const run = mockRun({
      'deploy --env= --secrets-file .dev.vars': {
        ok: true,
        stdout: 'https://repoaccess-core.acme.workers.dev',
      },
    })
    // Even though env.production declares a custom_domain route, a sandbox (top-level) deploy must ignore
    // it: customDomainPattern(config, null) reads the top-level routes (none), so expectedBase stays null.
    let probed: string | null = null
    const result = await deploy({
      config: WCONF_PROD_ROUTE,
      run,
      sleep: () => Promise.resolve(),
      fetchHealth: (url: string) => {
        probed = url
        return { ok: true, status: 200, body: { status: 'ok' } }
      },
    })
    expect(result.ok).toBe(true)
    expect(probed).toBe('https://repoaccess-core.acme.workers.dev')
    // the custom-domain fallback was never used, and there is no advisory URL-match warn (no base to match)
    expect(named(result, 'using the wired custom domain')).toBeUndefined()
    expect(named(result, 'matches the resolved base')).toBeUndefined()
  })

  it('production deploy: /health retries then degrades to the negative-cache message (nslookup + flush, never a zone diagnosis)', async () => {
    const run = mockRun({
      'deploy --env production --secrets-file .dev.vars.production': {
        ok: true,
        stdout: 'https://repoaccess-core-production.acme.workers.dev',
      },
    })
    let calls = 0
    const result = await deploy({
      env: 'production',
      config: WCONF_MATCHED,
      run,
      // BOTH budgets, because there are two: this probe never reaches Cloudflare (status 0), which is a
      // not-yet failure, so it is `propagatingAttempts` that governs it. Passing only the answered budget
      // would leave the other at its production default and this test would be measuring a number it did
      // not set.
      healthAttempts: 3,
      propagatingAttempts: 3,
      sleep: () => Promise.resolve(),
      fetchHealth: () => {
        calls++
        return { ok: false, status: 0, body: null }
      },
    })
    expect(result.ok).toBe(false)
    // retried the full attempt budget (seam-mockable backoff, no real waiting)
    expect(calls).toBe(3)
    const health = named(result, '/health')
    expect(health?.ok).toBe(false)
    // names the negative-cache symptom + the outside-the-cache check + the flush, and never promises a time
    expect(health?.fix).toMatch(/NXDOMAIN|ERR_NAME_NOT_RESOLVED/)
    expect(health?.fix).toContain('nslookup')
    expect(health?.fix).toContain('flushdns')
    expect(health?.fix).not.toMatch(/~?\s*\d+\s*(min|minute)/i)
    // reassures rather than diagnoses: it says do NOT touch the zone/WAF/bot, never instructs changing them
    expect(health?.fix).toMatch(/Never a reason to touch/i)
  })

  it('production custom domain: WAITS (~30s) before the FIRST /health probe and announces why', async () => {
    const run = mockRun({
      'deploy --env production --secrets-file .dev.vars.production': {
        ok: true,
        stdout: 'https://repoaccess-core-production.acme.workers.dev',
      },
    })
    // Record the interleaving of sleeps and probes to prove the pause lands BEFORE the first probe.
    const events: string[] = []
    const notices: string[] = []
    const result = await deploy({
      env: 'production',
      config: WCONF_MATCHED,
      run,
      sleep: (ms: number) => {
        events.push(`sleep:${ms}`)
        return Promise.resolve()
      },
      notify: (msg: string) => notices.push(msg),
      fetchHealth: () => {
        events.push('probe')
        return { ok: true, status: 200, body: { status: 'ok' } }
      },
    })
    expect(result.ok).toBe(true)
    // the very first thing is the ~30s pre-probe pause, and only THEN the first probe
    expect(events[0]).toBe('sleep:30000')
    expect(events.indexOf('sleep:30000')).toBeLessThan(events.indexOf('probe'))
    // the pause is announced (reads as intent, not a hang) and names the DNS/cert reason
    expect(notices.length).toBe(1)
    expect(notices[0]).toMatch(/DNS/)
    expect(notices[0]).toMatch(/certificate/)
    // no propagation-time promise anywhere in the notice
    expect(notices[0]).not.toMatch(/\bminute/i)
  })

  it('sandbox: a SHORT pre-probe pause lands before the first probe, announced, and never the production 30s', async () => {
    const run = mockRun({
      'deploy --env= --secrets-file .dev.vars': {
        ok: true,
        stdout: 'https://repoaccess-core.acme.workers.dev',
      },
    })
    // Same interleaving proof as the production case above: the pause must land BEFORE the first probe,
    // otherwise the eager probe we are fixing is still there.
    const events: string[] = []
    const notices: string[] = []
    const result = await deploy({
      config: WCONF_MATCHED,
      run,
      sleep: (ms: number) => {
        events.push(`sleep:${ms}`)
        return Promise.resolve()
      },
      notify: (msg: string) => notices.push(msg),
      fetchHealth: () => {
        events.push('probe')
        return { ok: true, status: 200, body: { status: 'ok' } }
      },
    })
    expect(result.ok).toBe(true)
    // the pause is FIRST, the probe follows it - never the other way round
    expect(events[0]).toBe('sleep:7000')
    expect(events.indexOf('sleep:7000')).toBeLessThan(events.indexOf('probe'))
    // short: sandbox waits for edge propagation only, never production's DNS/certificate 30s
    expect(events).not.toContain('sleep:30000')
    // announced, so the pause reads as intent rather than a hang, and it does not borrow the DNS reason
    expect(notices.length).toBe(1)
    expect(notices[0]).toMatch(/deliberate, not a hang/)
    expect(notices[0]).not.toMatch(/DNS|certificate/)
  })

  it('sandbox: /health retries inside the SCRIPT (small budget with backoff), so the agent never improvises one', async () => {
    const run = mockRun({
      'deploy --env= --secrets-file .dev.vars': {
        ok: true,
        stdout: 'https://repoaccess-core.acme.workers.dev',
      },
    })
    let calls = 0
    const result = await deploy({
      config: WCONF_MATCHED,
      run,
      sleep: () => Promise.resolve(),
      fetchHealth: () => {
        calls++
        return { ok: false, status: 0, body: null }
      },
    })
    expect(result.ok).toBe(false)
    // A probe that never reaches Cloudflare is the propagation case, so it gets the LONGER budget: six
    // attempts, sleeping 3+6+9+12+15s, which with the 7s pre-probe is a ~52s window rather than the ~16s
    // a live run gave up inside on a workers.dev address that had simply not propagated.
    expect(calls).toBe(6)
    // sandbox keeps the plain message, not the custom-domain negative-cache one
    expect(named(result, '/health')?.fix).toContain('check the deploy logs')
  })

  // The probe wears a browser User-Agent so that a zone rule aimed at non-browser clients cannot halt a
  // setup on a worker that is live and healthy. The assertion pins the header on, because dropping it
  // was tried and reverted: a wizard is not an auditor of somebody's firewall.
  it('defaultFetchHealth sends a browser User-Agent (bot-UA filtering net)', async () => {
    let sentUA: unknown = null
    const spy = async (_url: string, init: any) => {
      sentUA = init?.headers?.['user-agent']
      return {
        ok: true,
        status: 200,
        async json() {
          return { status: 'ok' }
        },
      }
    }
    const res = await defaultFetchHealth('https://w.example', spy as any)
    expect(res.ok).toBe(true)
    expect(sentUA).toBe(BROWSER_UA)
  })
})

// --- healthEvidence: four cases, four actions ----------------------------------------------------
//
// Every case here exists because collapsing it into another loses the action the deployer has to take:
// wait (never reached / not bound yet), look at what answered (a wrong body), or go and find the rule
// that refused the request (403). The 403 case is the one a live incident bought: on 2026-08-23 a
// user-agent rule on the maintainer's zone refused every delivery from a provider that sends no
// user-agent header, for hours, while the worker itself was healthy. Whenever a 403 does reach this
// check, "answered HTTP 403" on its own is the least useful thing it could say.

describe('healthEvidence names what the probe saw', () => {
  const URL_ = 'https://w.example'

  it('status 0 -> never reached Cloudflare, carrying what threw', () => {
    const text = healthEvidence(
      {
        ok: false,
        status: 0,
        body: null,
        error: 'fetch failed: getaddrinfo ENOTFOUND w.example',
      },
      URL_,
    )
    expect(text).toContain('never reached Cloudflare')
    expect(text).toContain('getaddrinfo ENOTFOUND w.example')
    expect(text).toContain('propagating')
  })

  it('404 -> the edge answering about an address no worker is bound to yet', () => {
    const text = healthEvidence({ ok: false, status: 404, body: null }, URL_)
    expect(text).toContain('answered HTTP 404')
    expect(text).toContain('no worker is bound')
    expect(text).toContain('not there yet')
  })

  it('403 -> names the rule in front of the worker AND what this probe cannot see', () => {
    const text = healthEvidence({ ok: false, status: 403, body: null }, URL_)
    expect(text).toContain('answered HTTP 403')
    // the firewall half: something in front of the worker refused it, and the same rule will refuse
    // the provider's webhook, which is the reason this case is worth a message of its own
    expect(text).toContain('your worker did not')
    expect(text).toContain('user agent')
    expect(text).toContain('Bot Fight Mode')
    expect(text).toContain('webhook')
    // the limitation half: a green probe here does NOT clear an ASN or country rule
    expect(text).toContain('ASN')
    expect(text).toContain('country')
    // and where to go and read the rule's name
    expect(text).toContain('Security -> Analytics')
  })

  it('200 with a wrong body -> answered, but the body did not say ok', () => {
    const text = healthEvidence({ ok: true, status: 200, body: {} }, URL_)
    expect(text).toContain('answered HTTP 200')
    expect(text).toContain('did not say')
  })
})

// --- the 403 evidence describes the caller the probe actually IS ---------------------------------
//
// A COUPLING, not a wording check. The 403 branch explains itself by comparing the probe to the
// provider's webhook, and that comparison is only true of a probe of one particular SHAPE. While the
// probes went out bare the comparison held; when the browser UA came back it stopped holding, and
// nothing failed - the message went on describing a caller the probe was no longer. Two facts that must
// move together had nothing holding them together.
//
// So the shape is READ from the header the probe actually sends - never re-declared from BROWSER_UA,
// which would only restate the constant to itself - and the message is held to whatever that read
// returns. Change either side alone and this goes red.

describe('the 403 evidence describes the probe that was actually sent', () => {
  const URL_ = 'https://w.example'

  // Observe, do not assume: run the real probe and keep the user-agent it put on the wire.
  const observeProbeUA = async () => {
    let sentUA: unknown = null
    const spy = async (_url: string, init: any) => {
      sentUA = init?.headers?.['user-agent']
      return {
        ok: true,
        status: 200,
        async json() {
          return { status: 'ok' }
        },
      }
    }
    await defaultFetchHealth('https://w.example', spy as any)
    return sentUA
  }

  it('names the shape the probe sends, and never the other one', async () => {
    const sentUA = await observeProbeUA()
    const looksLikeABrowser =
      typeof sentUA === 'string' && /mozilla/i.test(sentUA)
    const text = healthEvidence({ ok: false, status: 403, body: null }, URL_)

    // TRUE ON EITHER SHAPE, which is why it sits outside the branch: the conclusion never rested on
    // what the probe wears. A rule strict enough to refuse this probe refuses a webhook either way.
    expect(text).toMatch(/will refuse your sales/)

    if (looksLikeABrowser) {
      // it must say the probe looks like a browser ...
      expect(text).toMatch(/looking like a browser|wears a browser user agent/)
      // ... must NOT claim the likeness only a bare probe has ...
      expect(text).not.toMatch(/same kind of caller/)
      // ... and must NOT claim to detect a rule a browser walks straight past.
      expect(text).not.toMatch(/detects a user-agent/)
    } else {
      // A bare probe IS the provider's kind of caller, and the message may say so.
      expect(text).toMatch(/same kind of caller/)
      expect(text).not.toMatch(
        /looking like a browser|wears a browser user agent/,
      )
    }
  })
})

// --- the probe tells a local failure from an answer ---------------------------------------------
//
// The live symptom: the wizard reported it could not confirm `/health`, and the worker's own log held
// NO `/health` entry at that moment - the request never left the deployer's machine, on a workers.dev
// address that had not propagated. Flattened to `ok: false` that is indistinguishable from a 403 the
// worker really returned, and the two need opposite actions: wait, versus go and look at what answered.
// So the probe carries WHICH it was, the retry budget follows it, and the check says it out loud.

describe('the /health probe distinguishes never-reached from answered', () => {
  const deployRun = () =>
    mockRun({
      'deploy --env= --secrets-file .dev.vars': {
        ok: true,
        stdout: 'https://repoaccess-core.acme.workers.dev',
      },
    })

  it('defaultFetchHealth: a throw is status 0 WITH what threw; an answer carries its real status', async () => {
    // Node's fetch reports a bare "fetch failed" and puts the half worth reading in `cause`, so a probe
    // that only kept `message` would report nothing a deployer could act on.
    const threw = await defaultFetchHealth('https://w.example', (async () => {
      throw new Error('fetch failed', {
        cause: new Error('getaddrinfo ENOTFOUND w.example'),
      })
    }) as any)
    expect(threw.status).toBe(0)
    expect(threw.ok).toBe(false)
    expect(threw.error).toContain('fetch failed')
    expect(threw.error).toContain('ENOTFOUND')

    const answered = await defaultFetchHealth(
      'https://w.example',
      (async () => ({
        ok: false,
        status: 403,
        async json() {
          return null
        },
      })) as any,
    )
    expect(answered.status).toBe(403)
    expect(answered.ok).toBe(false)
    // Nothing threw, so there is nothing to name - the status IS the evidence.
    expect(answered.error).toBeUndefined()
  })

  it('the check REPORTS a status when Cloudflare answered, and says so when it never reached it', async () => {
    const unreached = await deploy({
      config: WCONF_MATCHED,
      run: deployRun(),
      sleep: () => Promise.resolve(),
      fetchHealth: () => ({
        ok: false,
        status: 0,
        body: null,
        error:
          'fetch failed: getaddrinfo ENOTFOUND repoaccess-core.acme.workers.dev',
      }),
    })
    const unreachedFix = named(unreached, '/health')?.fix ?? ''
    expect(unreachedFix).toContain('never reached Cloudflare')
    expect(unreachedFix).toContain('ENOTFOUND')
    // and it must NOT invent a status it never got
    expect(unreachedFix).not.toMatch(/HTTP \d/)

    const answered = await deploy({
      config: WCONF_MATCHED,
      run: deployRun(),
      sleep: () => Promise.resolve(),
      fetchHealth: () => ({ ok: false, status: 403, body: null }),
    })
    const answeredFix = named(answered, '/health')?.fix ?? ''
    expect(answeredFix).toContain('HTTP 403')
    expect(answeredFix).not.toContain('never reached Cloudflare')
  })

  it('a 200 whose body is not {status:ok} is reported as answered, not as unreachable', async () => {
    const result = await deploy({
      config: WCONF_MATCHED,
      run: deployRun(),
      sleep: () => Promise.resolve(),
      fetchHealth: () => ({
        ok: true,
        status: 200,
        body: { status: 'degraded' },
      }),
    })
    const fix = named(result, '/health')?.fix ?? ''
    expect(fix).toContain('HTTP 200')
    expect(fix).toContain("did not say {status:'ok'}")
    expect(fix).not.toContain('never reached Cloudflare')
  })

  it('the retry budget follows the failure: sandbox probes 6 times unreached, 3 times answered', async () => {
    // The number that was wrong. Three attempts at 3s + 6s is a ~16s window from the 7s pre-probe, and a
    // live run gave up inside it on an address that was merely propagating. An ANSWERED status does not
    // change on the next attempt, so that budget stays short - the deployer is watching a prompt.
    let unreachedCalls = 0
    await deploy({
      config: WCONF_MATCHED,
      run: deployRun(),
      sleep: () => Promise.resolve(),
      fetchHealth: () => {
        unreachedCalls++
        return { ok: false, status: 0, body: null }
      },
    })
    expect(unreachedCalls).toBe(6)

    let answeredCalls = 0
    await deploy({
      config: WCONF_MATCHED,
      run: deployRun(),
      sleep: () => Promise.resolve(),
      fetchHealth: () => {
        answeredCalls++
        return { ok: false, status: 403, body: null }
      },
    })
    expect(answeredCalls).toBe(3)
  })

  // The SECOND live run's symptom, and the one the six-attempt budget was not reached by. The wizard
  // reported "the health check returned a 404" - an ANSWER, so it took the short budget and gave up in
  // ~16s - while the worker's own log held no entry for the probe. Both facts at once have one reading:
  // under an account subdomain that already exists, `*.<account>.workers.dev` resolves by wildcard DNS,
  // so the just-deployed name is reachable before its route is bound, and Cloudflare's EDGE answers 404
  // for it. The request never reaches a worker, which is why nothing is logged. That is "not there yet",
  // it is fixed by waiting and by nothing else, and it therefore belongs on the patient budget with
  // status 0 - while a 403 or a wrong-bodied 200 is a worker that IS serving and stays on the short one.
  it('a 404 waits on the LONG budget (it is the deploy still arriving); a 403 stays on the short one', async () => {
    const budgetFor = async (status: number) => {
      let calls = 0
      await deploy({
        config: WCONF_MATCHED,
        run: deployRun(),
        sleep: () => Promise.resolve(),
        fetchHealth: () => {
          calls++
          return { ok: false, status, body: null }
        },
      })
      return calls
    }
    // sandbox: six for the not-yet statuses, three for an answer about a worker that is serving
    expect(await budgetFor(404)).toBe(6)
    expect(await budgetFor(0)).toBe(6)
    expect(await budgetFor(403)).toBe(3)
    expect(await budgetFor(500)).toBe(3)
  })

  it('the 404 evidence says whose 404 it is - the edge, not a wrong route', async () => {
    // The third case, and it must not collapse back into the anonymous "answered HTTP 404": a deployer
    // reading that goes hunting a routing mistake, which is the opposite of the action (wait).
    const result = await deploy({
      config: WCONF_MATCHED,
      run: deployRun(),
      sleep: () => Promise.resolve(),
      fetchHealth: () => ({ ok: false, status: 404, body: null }),
    })
    const fix = named(result, '/health')?.fix ?? ''
    expect(fix).toContain('HTTP 404')
    expect(fix).toContain('no worker is bound to that hostname YET')
    expect(fix).toContain('never reached a worker')
    // it is an ANSWER, so it must not borrow the never-reached-Cloudflare wording
    expect(fix).not.toContain('never reached Cloudflare')
  })

  it('production is untouched: both its budgets are 5, so a 404 waits exactly as long as anything else', async () => {
    // The negative-cache reasoning behind production's single budget is deliberate, so folding 404 into
    // the patient branch must not change a number there. It does not: 5 and 5.
    const prodRun = () =>
      mockRun({
        'deploy --env production --secrets-file .dev.vars.production': {
          ok: true,
          stdout: 'https://repoaccess-core-production.acme.workers.dev',
        },
      })
    const budgetFor = async (status: number) => {
      let calls = 0
      await deploy({
        env: 'production',
        config: WCONF_MATCHED,
        run: prodRun(),
        sleep: () => Promise.resolve(),
        fetchHealth: () => {
          calls++
          return { ok: false, status, body: null }
        },
      })
      return calls
    }
    expect(await budgetFor(404)).toBe(5)
    expect(await budgetFor(403)).toBe(5)
  })

  it('a name that resolves mid-retry drops onto the short budget from that attempt on', async () => {
    // The budget is read off the LAST result, not off the first one. Two unreached probes, then a 403:
    // the third attempt is the answered budget's last, so it stops there rather than running to six.
    const seen: number[] = []
    await deploy({
      config: WCONF_MATCHED,
      run: deployRun(),
      sleep: () => Promise.resolve(),
      fetchHealth: () => {
        const status = seen.length < 2 ? 0 : 403
        seen.push(status)
        return { ok: false, status, body: null }
      },
    })
    expect(seen).toEqual([0, 0, 403])
  })

  it('deployHealth re-probes a published worker on its own, under the same check name', async () => {
    // The seam the driver's retry uses. Same check, same name, same budgets - a second implementation
    // would be free to drift from the one the deployer's first probe walked.
    let probed: string | null = null
    const ok = await deployHealth({
      url: 'https://repoaccess-core.acme.workers.dev',
      preProbeDelay: 0,
      sleep: () => Promise.resolve(),
      fetchHealth: (url: string) => {
        probed = url
        return { ok: true, status: 200, body: { status: 'ok' } }
      },
    })
    expect(ok.ok).toBe(true)
    expect(probed).toBe('https://repoaccess-core.acme.workers.dev')
    expect(named(ok, '/health')?.name).toBe(
      "GET /health -> {status:'ok'} (sandbox)",
    )

    // preProbeDelay 0 means no pause and no notice: the caller's own recovery already spent the wait.
    const sleeps: number[] = []
    const notices: string[] = []
    await deployHealth({
      url: 'https://repoaccess-core.acme.workers.dev',
      preProbeDelay: 0,
      sleep: (ms: number) => {
        sleeps.push(ms)
        return Promise.resolve()
      },
      notify: (m: string) => notices.push(m),
      fetchHealth: () => ({ ok: true, status: 200, body: { status: 'ok' } }),
    })
    expect(sleeps).toEqual([])
    expect(notices).toEqual([])

    // No url is not a health failure to diagnose - it means the deploy has not run.
    const none = await deployHealth({})
    expect(none.ok).toBe(false)
    expect(named(none, '/health')?.fix).toContain('deploy has to run first')
  })

  it('deploy returns the address it probed, and only once wrangler really published', async () => {
    // What lets a caller re-probe THIS deploy instead of repeating it. Absent on every path where there
    // is nothing published to look at.
    const published = await deploy({
      config: WCONF_MATCHED,
      run: deployRun(),
      sleep: () => Promise.resolve(),
      fetchHealth: () => ({ ok: false, status: 0, body: null }),
    })
    // present even though the health half FAILED - that is the case the retry exists for
    expect(published.ok).toBe(false)
    expect(published.url).toBe('https://repoaccess-core.acme.workers.dev')

    const wranglerFailed = await deploy({
      config: WCONF_MATCHED,
      run: mockRun({
        'deploy --env= --secrets-file .dev.vars': {
          ok: false,
          stderr: 'workerd/server error [code: 10057]',
        },
      }),
    })
    expect(wranglerFailed.url).toBeUndefined()

    // Deployed, but nothing to health-check: no workers.dev URL in the output and no custom domain.
    const noAddress = await deploy({
      config: WCONF_MATCHED,
      run: mockRun({
        'deploy --env= --secrets-file .dev.vars': {
          ok: true,
          stdout: 'Deployed repoaccess-core',
        },
      }),
    })
    expect(noAddress.url).toBeUndefined()
  })
})

// --- resolve-url (env-aware predictable worker URL) --------------------------------------------

describe('resolve-url helpers', () => {
  it('isValidHostname accepts real domains, rejects schemes/paths/ports/single labels', () => {
    expect(isValidHostname('access.example.com')).toBe(true)
    expect(isValidHostname('repoaccess-core.acme.workers.dev')).toBe(true)
    expect(isValidHostname('a.io')).toBe(true)
    expect(isValidHostname('https://access.example.com')).toBe(false)
    expect(isValidHostname('access.example.com/wh')).toBe(false)
    expect(isValidHostname('access.example.com:8080')).toBe(false)
    expect(isValidHostname('localhost')).toBe(false)
    expect(isValidHostname('-bad.example.com')).toBe(false)
    expect(isValidHostname('')).toBe(false)
    expect(isValidHostname(undefined)).toBe(false)
  })

  it('generateSecretPath is 32 hex chars, and honors an injected rand', () => {
    expect(generateSecretPath()).toMatch(/^[0-9a-f]{32}$/)
    const fixed = generateSecretPath((n: number) => Buffer.alloc(n, 0xab))
    expect(fixed).toBe('ab'.repeat(16))
  })

  it('customDomainPattern reads a real custom_domain route, treats placeholder/absent as null', () => {
    expect(
      customDomainPattern(
        {
          env: {
            production: {
              routes: [{ pattern: 'access.example.com', custom_domain: true }],
            },
          },
        },
        'production',
      ),
    ).toBe('access.example.com')
    expect(
      customDomainPattern(
        {
          env: {
            production: {
              routes: [{ pattern: 'your-domain.example', custom_domain: true }],
            },
          },
        },
        'production',
      ),
    ).toBe(null)
    // Core reality: no route at all
    expect(customDomainPattern({ name: 'repoaccess-core' }, 'production')).toBe(
      null,
    )
  })

  it('sameWorkerHost compares hostnames only, ignoring scheme/path', () => {
    expect(
      sameWorkerHost(
        'https://w.acme.workers.dev',
        'https://w.acme.workers.dev/wh/stripe/x',
      ),
    ).toBe(true)
    expect(
      sameWorkerHost(
        'https://w.acme.workers.dev',
        'https://w.OTHER.workers.dev',
      ),
    ).toBe(false)
    expect(sameWorkerHost('not a url', 'https://w.acme.workers.dev')).toBe(
      false,
    )
  })

  it('wranglerError prefers stderr, falls back to stdout, hints login when empty, and redacts a secret without eating the diagnosis', () => {
    expect(wranglerError({ stderr: 'boom [10057]', stdout: 'x' })).toBe(
      'boom [10057]',
    )
    expect(wranglerError({ stderr: '', stdout: 'from stdout' })).toBe(
      'from stdout',
    )
    expect(wranglerError({ stderr: '', stdout: '' })).toContain(
      'npx wrangler login',
    )

    // BOTH HALVES IN ONE ASSERTION, and that is the point rather than economy. This text is a
    // DIAGNOSTIC: it reaches a human and it is persisted. Redacting a secret out of it is only
    // correct if what is left still explains the failure, so a pattern greedy enough to swallow the
    // error code or the surrounding sentence would trade a real diagnosis for a useless one - a worse
    // outcome than the shape risk the redaction exists to close. Asserting "the token is gone" alone
    // would pass for a function that returned the empty string.
    expect(
      wranglerError({
        stderr:
          'Authentication error [code: 10000]: token github_pat_11ABCDE0Y0aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789 is invalid',
      }),
    ).toBe('Authentication error [code: 10000]: token [redacted] is invalid')

    // Redaction runs BEFORE the 400-char truncation, and this asserts the ORDER by the one difference
    // it actually makes: what the character budget gets spent on. Redacting first, the secret collapses
    // to `[redacted]` and the words after it still fit; slicing first, the budget is spent on secret
    // BYTES and `trailing` is cut off the end. So the exact string is the assertion - an exact `toBe`
    // including what comes AFTER the secret, because that tail is the part that moves.
    //
    // NOT asserted, because it cannot fail: that the secret leaves no readable fragment. Every current
    // pattern still matches its own truncated fragment (`github_pat_11ABCDE0` matches
    // `github_pat_[A-Za-z0-9_-]+`), so a `not.toContain('github_pat_')` check passes in BOTH orders and
    // guards nothing. That the patterns behave that way is an accident of this particular set, not a
    // property `wranglerError` can lean on - which is the real reason the order is fixed here: the next
    // prefix added need not share it, and whoever adds it will not be thinking about the 400-char
    // boundary. Redacting first means they never have to.
    expect(
      wranglerError({
        stderr: `${'x'.repeat(380)} github_pat_11ABCDE0Y0aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789 trailing`,
      }),
    ).toBe(`${'x'.repeat(380)} [redacted] trailing`)

    // `Bearer` is an ENGLISH WORD, so matching it alone reaches ordinary prose - and "bearer token" is
    // a phrase both wrangler and the Cloudflare API print. Unbounded, the pattern turned
    // "Bearer token is invalid" into "[redacted] is invalid", which is the over-redaction this file
    // calls the worse failure: the sentence that names the problem becomes the sentence that hides it.
    // The value after the scheme word therefore has to be credential-SHAPED, not just present.
    expect(
      wranglerError({
        stderr: 'Bearer token is invalid or expired [code: 10001]',
      }),
    ).toBe('Bearer token is invalid or expired [code: 10001]')
    expect(
      wranglerError({ stderr: 'no bearer token found in the request' }),
    ).toBe('no bearer token found in the request')
    // ...and a real one still goes. Both directions in view together, because a bound set too tight
    // would pass the two assertions above while quietly letting credentials through.
    expect(
      wranglerError({
        stderr:
          'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abcdefghijklmnop rejected',
      }),
    ).toBe('Authorization: [redacted] rejected')
  })

  it('slugifySubdomain lowercases and hyphenates non-alphanumeric runs, trims hyphens', () => {
    expect(slugifySubdomain("Dana Lee's Account")).toBe('dana-lee-s-account')
    expect(slugifySubdomain('Acme')).toBe('acme')
    expect(slugifySubdomain('  --Foo_Bar--  ')).toBe('foo-bar')
    expect(slugifySubdomain('')).toBe(null)
    expect(slugifySubdomain(undefined)).toBe(null)
  })

  it('parseWhoamiAccount pulls { name, id } from the whoami table row', () => {
    const whoami = [
      'Getting User settings...',
      '┌──────────────────────┬──────────────────────────────────┐',
      '│ Account Name         │ Account ID                       │',
      '├──────────────────────┼──────────────────────────────────┤',
      '│ Acme Inc             │ ' + 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4' + ' │',
      '└──────────────────────┴──────────────────────────────────┘',
    ].join('\n')
    expect(parseWhoamiAccount(whoami)).toEqual({
      name: 'Acme Inc',
      id: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4',
    })
    expect(parseWhoamiAccount('no table here')).toBe(null)
  })

  it('parseWhoamiAccount survives the FULL wrangler whoami output shape (banner + token-permissions block)', () => {
    // The capture below is the real `wrangler whoami` stdout as it stood at `4.110.0` (synthetic account
    // name/id), and the version in its banner is part of that capture rather than a value to keep
    // current. What this test protects is the PARSER: that it isolates the single data row and ignores
    // the banner, the credentials path and the Token Permissions block around it, and never mistakes a
    // hex-looking string elsewhere for the account id. It is deliberately NOT re-captured on every
    // wrangler bump - a change in wrangler's output FORMAT is a different failure with a different
    // instrument, and it surfaces on a live run as a wrong subdomain and a broken worker URL.
    const whoami = [
      '',
      ' ⛅️ wrangler 4.110.0',
      '────────────────────',
      'Getting User settings...',
      '👋 You are logged in with an OAuth Token, associated with the email user@example.com.',
      '🔐 Credentials are stored in: C:\\Users\\dev\\.wrangler\\config\\default.toml',
      '┌──────────────┬────────────────────────────────┐',
      '│ Account Name │ Account ID                       │',
      '├──────────────┼────────────────────────────────┤',
      '│ Acme Inc     │ a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4 │',
      '└──────────────┴────────────────────────────────┘',
      '🔓 Token Permissions:',
      'Scope (Access)',
      '- account (read)',
      '- user (read)',
      '- workers (write)',
      '- workers_kv (write)',
    ].join('\n')
    expect(parseWhoamiAccount(whoami)).toEqual({
      name: 'Acme Inc',
      id: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4',
    })
  })

  it('whoamiEmailLocalPart reads the login email wrangler names, and only that one', () => {
    expect(
      whoamiEmailLocalPart(
        'You are logged in with an OAuth Token, associated with the email dana@example.com.',
      ),
    ).toBe('dana')
    // An address that is NOT the one wrangler introduces stays out of it: a warning or an example line
    // would otherwise be read as the deployer's own login.
    expect(
      whoamiEmailLocalPart('contact support@cloudflare.com if this fails'),
    ).toBe(null)
    expect(whoamiEmailLocalPart('')).toBe(null)
    expect(whoamiEmailLocalPart(undefined)).toBe(null)
  })

  it('deriveSubdomain ranks its candidates: scan, then email local part, then account slug', () => {
    // Every one of these is a SUGGESTION for the question the deployer answers, so the order is about
    // which guess is worth offering first - not about which one is trusted. None is.
    const whoami = (stdout: string) => () => ({
      ok: true,
      status: 0,
      stderr: '',
      stdout,
    })
    // explicit override
    expect(deriveSubdomain({ explicit: 'myacct', run: whoami('') })).toEqual({
      subdomain: 'myacct',
      method: 'explicit',
    })

    // A `*.workers.dev` host wrangler really printed beats everything derived, because it is the one
    // candidate that is evidence rather than inference.
    expect(
      deriveSubdomain({
        run: whoami(
          'associated with the email dana@example.com\npreview at foo.bar.workers.dev\n│ Acme Inc │ a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4 │',
        ),
      }),
    ).toEqual({ subdomain: 'bar', method: 'whoami-scan' })

    // THE ORDERING THAT COST US A LIVE RUN. A fresh account is named after its login email, so the
    // account-name slug and the email local part are both available and they disagree: the slug says
    // `dana-example-com-s-account` and the real subdomain is `dana`. The email wins.
    expect(
      deriveSubdomain({
        run: whoami(
          "associated with the email dana@example.com\n│ dana@example.com's Account │ a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4 │",
        ),
      }),
    ).toEqual({ subdomain: 'dana', method: 'email-local-part' })

    // The local part is slugified like any other candidate, so it can at least be a legal subdomain.
    expect(
      deriveSubdomain({
        run: whoami('associated with the email dana.lee+cf@example.com'),
      }),
    ).toEqual({ subdomain: 'dana-lee-cf', method: 'email-local-part' })

    // account-name slug, last, and only when nothing better is on offer
    expect(
      deriveSubdomain({
        run: whoami('│ Acme Inc │ a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4 │'),
      }),
    ).toEqual({ subdomain: 'acme-inc', method: 'account-slug' })

    // nothing derivable
    expect(deriveSubdomain({ run: whoami('nothing useful') })).toBe(null)
    // no runner at all
    expect(deriveSubdomain({})).toBe(null)
  })
})

describe('the workers.dev subdomain existence probe', () => {
  const CONFIG = { name: 'repoaccess-core' }

  it('an HTTP answer of ANY status proves the subdomain exists', async () => {
    // 404 is the interesting one: under a subdomain that exists, wildcard DNS resolves every name and
    // Cloudflare's edge answers 404 for one no worker is bound to yet. That is the normal case here -
    // the wizard runs this BEFORE the deploy.
    for (const status of [404, 200, 403, 500]) {
      const result = await subdomainCheck({
        config: CONFIG,
        subdomain: 'acme',
        fetchHealth: async () => ({ ok: false, status, body: null }),
      })
      expect(result.ok, String(status)).toBe(true)
    }
  })

  it('a DNS answer of no-such-name proves it does not, and says where to read the real one', async () => {
    const result = await subdomainCheck({
      config: CONFIG,
      subdomain: 'nope',
      fetchHealth: async () => ({
        ok: false,
        status: 0,
        body: null,
        error:
          'fetch failed: getaddrinfo ENOTFOUND repoaccess-core.nope.workers.dev',
      }),
    })
    expect(result.ok).toBe(false)
    const check = named(result, 'workers.dev subdomain exists (nope)')
    expect(check?.fix).toContain('There is no `nope.workers.dev`')
    expect(check?.fix).toContain(
      'Compute -> Workers & Pages -> Account Details (the panel on the right) -> Subdomain',
    )
  })

  it('any OTHER local failure is inconclusive and never re-asks', async () => {
    // An offline machine or a blocked resolver says nothing about the deployer's account, and a value
    // they read correctly off the dashboard would then fail the same way on every retry - a dead end
    // with no way out of it. So it warns and the answer stands.
    const result = await subdomainCheck({
      config: CONFIG,
      subdomain: 'acme',
      fetchHealth: async () => ({
        ok: false,
        status: 0,
        body: null,
        error: 'fetch failed: connect ECONNREFUSED 127.0.0.1:8080',
      }),
    })
    expect(result.ok).toBe(true)
    expect(
      named(result, 'workers.dev subdomain checked (acme)')?.severity,
    ).toBe('warn')
  })

  it('probes the address the run would really use, never a bare subdomain', async () => {
    let seen = ''
    await subdomainCheck({
      config: CONFIG,
      subdomain: 'acme',
      fetchHealth: async (url: string) => {
        seen = url
        return { ok: false, status: 404, body: null }
      },
    })
    expect(seen).toBe('https://repoaccess-core.acme.workers.dev')
  })

  it('with nothing to probe it warns rather than blocking - resolve-url owns that failure', async () => {
    for (const opts of [
      { config: CONFIG },
      { config: {}, subdomain: 'acme' },
    ]) {
      const result = await subdomainCheck({
        ...opts,
        fetchHealth: async () => {
          throw new Error('must not be probed')
        },
      })
      expect(result.ok).toBe(true)
    }
  })
})

describe('resolve-url step', () => {
  it('sandbox with the ANSWERED subdomain -> base + webhook URL + raw secret_path (resolved attached)', () => {
    const result = resolveUrl({
      config: { name: 'repoaccess-core' },
      subdomain: 'acme',
      secretPath: 'deadbeef',
    })
    expect(result.step).toBe('resolve-url')
    expect(result.ok).toBe(true)
    expectResultShape(result)
    expect(result.resolved?.base).toBe(
      'https://repoaccess-core.acme.workers.dev',
    )
    expect(result.resolved?.webhookUrl).toBe(
      'https://repoaccess-core.acme.workers.dev/wh/stripe/deadbeef',
    )
    expect(result.resolved?.secretPath).toBe('deadbeef')
    // The check says where the value came from, and there is only one answer now: the deployer.
    expect(named(result, 'confirmed by the deployer')?.ok).toBe(true)
  })

  it('sandbox NEVER guesses a subdomain - with no answer it asks, whatever whoami says', () => {
    // The defect this step used to have: it slugified the Cloudflare account name and resolved a URL
    // from it. A fresh account is named after its login email, so that produced a confident wrong host,
    // and the provider webhook and the health check were wired to it. There is no honest automatic
    // answer available (see deriveSubdomain), so the guess is not merely discouraged here - the step
    // cannot express it: the `run` seam was REMOVED from this step rather than left unused, so there is
    // no wrangler for it to ask and no option through which a caller could hand it one. That deletion is
    // what this test stands on - a step that merely happened not to call whoami would look the same.
    const result = resolveUrl({ config: { name: 'repoaccess-core' } })
    expect(result.ok).toBe(false)
    const sub = named(result, 'workers.dev subdomain')
    expect(sub?.needsInput).toBe('subdomain')
    // It names the panel the value is really read off, and says the setup asks for it - no retired
    // per-step command, no flag.
    expect(sub?.fix).toContain(
      'Compute -> Workers & Pages -> Account Details (the panel on the right) -> Subdomain',
    )
    expect(sub?.fix).toContain('the setup asks you for it')
    expect(sub?.fix).not.toContain('npm run wizard:')
    expect(result.resolved).toBeUndefined()
  })

  it('production with a valid --domain -> https://<domain> base', () => {
    const result = resolveUrl({
      env: 'production',
      config: { name: 'repoaccess-core' },
      domain: 'access.example.com',
      secretPath: 'cc',
    })
    expect(result.ok).toBe(true)
    expect(result.resolved?.base).toBe('https://access.example.com')
    expect(result.resolved?.webhookUrl).toBe(
      'https://access.example.com/wh/stripe/cc',
    )
  })

  it('production with an invalid domain -> a failing check, no resolved', () => {
    const result = resolveUrl({
      env: 'production',
      config: { name: 'repoaccess-core' },
      domain: 'https://nope.example.com/path',
    })
    expect(result.ok).toBe(false)
    expect(named(result, 'custom domain valid')?.ok).toBe(false)
    expect(result.resolved).toBeUndefined()
  })

  it('production with no route and no domain (Core reality) -> needs-input:prod-domain', () => {
    const result = resolveUrl({
      env: 'production',
      config: { name: 'repoaccess-core' },
    })
    expect(result.ok).toBe(false)
    const dom = named(result, 'production custom domain')
    expect(dom?.needsInput).toBe('prod-domain')
    // The driver collects the domain via screen 5 and config-write writes it into the wrangler.jsonc
    // route, so the fix says exactly that - it names no retired per-step command and does not claim
    // resolve-url wires the route.
    expect(dom?.fix).toContain('writes it into the wrangler.jsonc route')
    expect(dom?.fix).not.toContain('npm run wizard:')
  })

  it('production reads a real custom_domain route from wrangler.jsonc', () => {
    const result = resolveUrl({
      env: 'production',
      config: {
        name: 'repoaccess-core',
        env: {
          production: {
            routes: [{ pattern: 'access.example.com', custom_domain: true }],
          },
        },
      },
      secretPath: 'dd',
    })
    expect(result.ok).toBe(true)
    expect(result.resolved?.base).toBe('https://access.example.com')
  })
})

// --- e2e (synthetic Stripe chain, mocked fetch + crypto) ---------------------------------------

// A fake fetch routed by a per-test handler; records every call for cleanup/leak assertions.
function e2eFetch(
  handler: (method: string, url: string) => { status: number; json?: unknown },
) {
  const calls: Array<{ method: string; url: string }> = []
  const fn = async (url: string, init: any) => {
    const method = (init?.method ?? 'GET').toUpperCase()
    calls.push({ method, url })
    const r = handler(method, url) ?? { status: 404 }
    return {
      status: r.status,
      async json() {
        return r.json ?? null
      },
    }
  }
  ;(fn as any).calls = calls
  return fn as any
}

const E2E_CONFIG = {
  githubOrg: 'acme',
  productTeamMap: {
    defaults: { teams: [] },
    stripe: { prod_x: { teams: ['pro'] } },
  },
  e2e: { testUsername: 'octocat', url: 'https://worker.example' },
}

// Happy-path routes: ack 2xx, membership pending, empty invitation list, deletes succeed.
const greenE2eFetch = () =>
  e2eFetch((method, url) => {
    if (url.includes('/wh/stripe/')) return { status: 200 }
    if (method === 'GET' && url.includes('/teams/pro/memberships/octocat'))
      return { status: 200, json: { state: 'pending' } }
    if (method === 'GET' && url.includes('/invitations'))
      return { status: 200, json: [] }
    if (method === 'DELETE') return { status: 204 }
    return { status: 404 }
  })

const noop = () => Promise.resolve()

// The wrangler seam for e2e's post-run KV cleanup (delete the synthetic grant record). Default OK so a
// test that does not care about the delete never spawns a real wrangler; dedicated tests inject a
// recording mockRun to assert the delete args.
const okRun = () => ({ ok: true, status: 0, stdout: '', stderr: '' })

describe('e2e synthetic chain', () => {
  it('buildE2eEvent parses to a payment_success grant (the adapter grant event)', () => {
    const event = buildE2eEvent({
      productId: 'prod_x',
      username: 'octocat',
      transactionId: 'pi_e2e_1',
    })
    const normalized = stripe.parse({
      bodyText: JSON.stringify(event),
      headers: new Headers(),
    })
    expect(normalized?.event_type).toBe('payment_success')
    expect(normalized?.github_username).toBe('octocat')
    expect(normalized?.product_id).toBe('prod_x')
    expect(normalized?.transaction_id).toBe('pi_e2e_1')
  })

  it('the Stripe signature is byte-exact accepted by the real adapter verify', async () => {
    const secret = 'whsec_e2e_proof'
    const body = JSON.stringify(
      buildE2eEvent({
        productId: 'prod_x',
        username: 'octocat',
        transactionId: 'pi_e2e_1',
      }),
    )
    const ts = Math.floor(Date.now() / 1000) // within Stripe's 300s tolerance
    const header = stripeSignatureHeader(body, secret, ts)
    const result = await verifyHmac(
      stripe.verification as any,
      { bodyText: body, headers: new Headers({ 'stripe-signature': header }) },
      { STRIPE_WEBHOOK_SECRET: secret } as any,
    )
    expect(result.ok).toBe(true)
  })

  it('stripeSignatureHeader has the t=..,v1=<hex> shape', () => {
    expect(stripeSignatureHeader('body', 'secret', 123)).toMatch(
      /^t=123,v1=[0-9a-f]{64}$/,
    )
  })

  it('resolveE2eProduct picks a product mapped to a team (or null)', () => {
    expect(resolveE2eProduct(E2E_CONFIG)).toEqual({
      productId: 'prod_x',
      teams: ['pro'],
    })
    expect(
      resolveE2eProduct({
        productTeamMap: {
          defaults: { teams: [] },
          stripe: { p1: { teams: [] }, p2: { teams: ['x'] } },
        },
      }),
    ).toEqual({ productId: 'p2', teams: ['x'] })
    expect(
      resolveE2eProduct({
        e2e: { productId: 'p1' },
        productTeamMap: {
          defaults: { teams: [] },
          stripe: { p1: { teams: ['t'] } },
        },
      }),
    ).toEqual({ productId: 'p1', teams: ['t'] })
    expect(
      resolveE2eProduct({ productTeamMap: { defaults: { teams: [] } } }),
    ).toBe(null)
  })

  it('all green: posts, acks, observes the invite, cleans up -> ok:true', async () => {
    const result = await e2e({
      config: E2E_CONFIG,
      stripeSecret: 'whsec_x',
      githubToken: 'ghp_x',
      fetch: greenE2eFetch(),
      run: okRun,
      transactionId: 'pi_e2e_1',
      timestamp: 1700000000,
      sleep: noop,
    })
    expect(result.step).toBe('e2e')
    expect(result.ok).toBe(true)
    expectResultShape(result)
    expect(named(result, 'signed and posted')?.ok).toBe(true)
    expect(named(result, 'ack')?.ok).toBe(true)
    expect(named(result, 'invite observed')?.ok).toBe(true)
    expect(named(result, 'cleanup: invite cancelled')?.ok).toBe(true)
    // the synthetic grant record is also removed (no leftover pi_ in a production KV)
    expect(named(result, 'grant record deleted')?.ok).toBe(true)
  })

  it('never leaks a secret: neither STRIPE_WEBHOOK_SECRET nor GITHUB_TOKEN in the output', async () => {
    const result = await e2e({
      config: E2E_CONFIG,
      stripeSecret: 'whsec_LEAK_STRIPE',
      githubToken: 'ghp_LEAK_GITHUB',
      fetch: greenE2eFetch(),
      run: okRun,
      transactionId: 'pi_e2e_1',
      timestamp: 1700000000,
      sleep: noop,
    })
    const emitted = JSON.stringify(result)
    expect(emitted).not.toContain('whsec_LEAK_STRIPE')
    expect(emitted).not.toContain('ghp_LEAK_GITHUB')
  })

  // Same header as the /health probe above, for the same reason: the wizard's own synthetic delivery
  // must not be the thing a zone rule refuses, on a worker that is live and healthy.
  it('the synthetic e2e POST sends a browser User-Agent (bot-UA filtering net)', async () => {
    let whUA: unknown = null
    const fetchImpl = async (url: string, init: any) => {
      if (url.includes('/wh/stripe/')) {
        whUA = init?.headers?.['user-agent']
        return {
          status: 200,
          async json() {
            return null
          },
        }
      }
      if (url.includes('/invitations'))
        return {
          status: 200,
          async json() {
            return []
          },
        }
      if (url.includes('/memberships/'))
        return {
          status: 200,
          async json() {
            return { state: 'pending' }
          },
        }
      return {
        status: 404,
        async json() {
          return null
        },
      }
    }
    const result = await e2e({
      config: E2E_CONFIG,
      stripeSecret: 'whsec_x',
      githubToken: 'ghp_x',
      fetch: fetchImpl as any,
      run: okRun,
      transactionId: 'pi_e2e_ua',
      timestamp: 1700000000,
      sleep: noop,
    })
    expect(named(result, 'ack')?.ok).toBe(true)
    expect(whUA).toBe(BROWSER_UA)
  })

  it('non-2xx ack -> ack fails, invite poll skipped, cleanup still runs', async () => {
    const fetchImpl = e2eFetch((method, url) => {
      if (url.includes('/wh/stripe/')) return { status: 400 }
      if (method === 'GET' && url.includes('/invitations'))
        return { status: 200, json: [] }
      if (method === 'DELETE') return { status: 404 }
      return { status: 404 }
    })
    const result = await e2e({
      config: E2E_CONFIG,
      stripeSecret: 'whsec_x',
      githubToken: 'ghp_x',
      fetch: fetchImpl,
      run: okRun,
      transactionId: 'pi_e2e_1',
      timestamp: 1700000000,
      sleep: noop,
    })
    expect(result.ok).toBe(false)
    expect(named(result, 'ack')?.ok).toBe(false)
    expect(named(result, 'invite observed')).toBeUndefined()
    expect(named(result, 'cleanup: invite cancelled')).toBeDefined()
  })

  it('invite never appears -> timeout ok:false, cleanup still runs', async () => {
    const fetchImpl = e2eFetch((method, url) => {
      if (url.includes('/wh/stripe/')) return { status: 200 }
      if (method === 'GET' && url.includes('/memberships/octocat'))
        return { status: 404 }
      if (method === 'GET' && url.includes('/invitations'))
        return { status: 200, json: [] }
      if (method === 'DELETE') return { status: 404 }
      return { status: 404 }
    })
    const result = await e2e({
      config: E2E_CONFIG,
      stripeSecret: 'whsec_x',
      githubToken: 'ghp_x',
      fetch: fetchImpl,
      run: okRun,
      transactionId: 'pi_e2e_1',
      timestamp: 1700000000,
      pollAttempts: 2,
      sleep: noop,
    })
    expect(named(result, 'invite observed')?.ok).toBe(false)
    expect(named(result, 'cleanup: invite cancelled')?.ok).toBe(true)
  })

  it('cleanup runs even when the POST throws (dangling invite is never left)', async () => {
    const calls: Array<{ method: string; url: string }> = []
    const fetchImpl = async (url: string, init: any) => {
      const method = (init?.method ?? 'GET').toUpperCase()
      calls.push({ method, url })
      if (url.includes('/wh/stripe/')) throw new Error('network down')
      if (url.includes('/invitations'))
        return {
          status: 200,
          async json() {
            return []
          },
        }
      return {
        status: 404,
        async json() {
          return null
        },
      }
    }
    const result = await e2e({
      config: E2E_CONFIG,
      stripeSecret: 'whsec_x',
      githubToken: 'ghp_x',
      fetch: fetchImpl as any,
      run: okRun,
      transactionId: 'pi_e2e_1',
      timestamp: 1700000000,
      sleep: noop,
    })
    // The unreachable-worker failure has its OWN check name, distinct from the success path's "signed
    // and posted", so a red here can only mean the POST could not reach the worker.
    expect(named(result, 'reached the worker')?.ok).toBe(false)
    expect(named(result, 'signed and posted')).toBeUndefined()
    expect(named(result, 'cleanup: invite cancelled')).toBeDefined()
    expect(
      calls.some(
        (c) => c.method === 'DELETE' && c.url.includes('/memberships/octocat'),
      ),
    ).toBe(true)
  })

  it('missing test username -> a fix, and never touches the network', async () => {
    const result = await e2e({
      config: {
        githubOrg: 'acme',
        productTeamMap: {
          defaults: { teams: [] },
          stripe: { prod_x: { teams: ['pro'] } },
        },
      },
      url: 'https://worker.example',
      stripeSecret: 'whsec_x',
      githubToken: 'ghp_x',
      fetch: (() => {
        throw new Error('should not fetch')
      }) as any,
    })
    expect(result.ok).toBe(false)
    expect(named(result, 'test username')?.fix).toContain('you control')
  })

  it('missing deployed URL -> a fix', async () => {
    const result = await e2e({
      config: {
        githubOrg: 'acme',
        productTeamMap: {
          defaults: { teams: [] },
          stripe: { prod_x: { teams: ['pro'] } },
        },
        e2e: { testUsername: 'octocat' },
      },
      stripeSecret: 'whsec_x',
      githubToken: 'ghp_x',
      fetch: (() => {
        throw new Error('should not fetch')
      }) as any,
    })
    expect(result.ok).toBe(false)
    expect(named(result, 'URL provided')?.fix).toContain('--url')
  })

  it('cleanup deletes the synthetic grant record with --remote and no --env (sandbox)', async () => {
    const run = mockRun({
      'kv key delete grant:stripe:pi_e2e_1 --binding ENTITLEMENTS --remote': {
        ok: true,
      },
    })
    const result = await e2e({
      config: E2E_CONFIG,
      stripeSecret: 'whsec_x',
      githubToken: 'ghp_x',
      fetch: greenE2eFetch(),
      run,
      transactionId: 'pi_e2e_1',
      timestamp: 1700000000,
      sleep: noop,
    })
    expect(result.ok).toBe(true)
    // same --remote / env-aware invocation grant-record uses; a sandbox run sends NO --env
    expect(run.calls).toContainEqual([
      'kv',
      'key',
      'delete',
      'grant:stripe:pi_e2e_1',
      '--binding',
      'ENTITLEMENTS',
      '--remote',
    ])
    expect(named(result, 'grant record deleted')?.ok).toBe(true)
  })

  it('production cleanup forwards --env production on the grant-record delete', async () => {
    const run = mockRun({
      'kv key delete grant:stripe:pi_e2e_1 --binding ENTITLEMENTS --remote --env production':
        { ok: true },
    })
    const result = await e2e({
      env: 'production',
      config: E2E_CONFIG,
      stripeSecret: 'whsec_x',
      githubToken: 'ghp_x',
      fetch: greenE2eFetch(),
      run,
      transactionId: 'pi_e2e_1',
      timestamp: 1700000000,
      sleep: noop,
    })
    expect(result.ok).toBe(true)
    expect(run.calls).toContainEqual([
      'kv',
      'key',
      'delete',
      'grant:stripe:pi_e2e_1',
      '--binding',
      'ENTITLEMENTS',
      '--remote',
      '--env',
      'production',
    ])
  })

  it('a failed grant-record delete is an advisory WARN and never turns a green e2e red', async () => {
    const run = () => ({
      ok: false,
      status: 1,
      stdout: '',
      stderr: 'kv delete boom',
    })
    const result = await e2e({
      config: E2E_CONFIG,
      stripeSecret: 'whsec_x',
      githubToken: 'ghp_x',
      fetch: greenE2eFetch(),
      run,
      transactionId: 'pi_e2e_1',
      timestamp: 1700000000,
      sleep: noop,
    })
    // the whole chain (post, ack, invite, invite-cancel) is green, so a failed KV delete must not fail it
    expect(result.ok).toBe(true)
    const del = named(result, 'grant record deleted')
    expect(del?.ok).toBe(false)
    expect(del?.severity).toBe('warn')
    expect(del?.fix).toContain('kv delete boom')
  })
})

// The no-off-path rule as a machine check, not a convention. An agent DOES what our `fix` strings say,
// so a message that offers an env var or a shell chain is the bug: the assignment forces a compound, shell-specific command
// (`$env:X='v' && npm run ...` does not even parse in PowerShell), which falls outside the deployer's
// `Bash(npm run:*)` allowlist and turns a silent run into an approval storm on every later call. A live run
// broke exactly this way by following our own advice. Per-site assertions only cover the sites we thought
// of, so this scans the SOURCE: a newly added fix string cannot reintroduce the class.
// Enumerate every `fix` expression with its line and enclosing function. Deliberately NOT line-based:
// `runGithubChecks`'s fix is a ternary whose text sits on a CONTINUATION line, so a `grep fix:` scan
// cannot see it - which is exactly how two careful reviews of this file arrived at different counts of
// the same defect. A guard that inherits that blind spot would certify the sites we happened to notice.
// Walks the property value quote- and depth-aware, so multi-line and template-literal fixes are seen.
function extractFixes(
  src: string,
): { line: number; fn: string; text: string }[] {
  const fns: { name: string; index: number }[] = []
  const fnRe = /(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)/g
  for (let f = fnRe.exec(src); f; f = fnRe.exec(src)) {
    fns.push({ name: f[1], index: f.index })
  }

  const out: { line: number; fn: string; text: string }[] = []
  const fixRe = /\bfix:/g
  for (let m = fixRe.exec(src); m; m = fixRe.exec(src)) {
    const at = m.index
    const start = at + m[0].length
    let i = start
    let depth = 0
    let quote: string | null = null
    for (; i < src.length; i++) {
      const c = src[i]
      if (quote) {
        if (c === '\\') i++
        else if (c === quote) quote = null
        continue
      }
      if (c === "'" || c === '"' || c === '`') quote = c
      else if (c === '(' || c === '[' || c === '{') depth++
      else if (c === ')' || c === ']' || c === '}') {
        if (depth === 0) break
        depth--
      } else if (c === ',' && depth === 0) break
    }
    const fn = fns.filter((f) => f.index < at).pop()
    out.push({
      line: src.slice(0, at).split('\n').length,
      fn: fn?.name ?? '(top level)',
      text: src.slice(start, i),
    })
  }
  return out
}

// The no-off-path rule as a machine check, not a convention. An agent DOES what our `fix` strings say,
// so a message offering an env var, a shell chain, a missing script, or the wrong file IS the bug. A live run broke by
// following our own advice. Per-site assertions only cover the sites we thought of; these enumerate.
describe('fix strings never send the reader off the documented path', () => {
  const source = readFileSync(wizardPath, 'utf8')
  const fixes = extractFixes(source)

  it('extracts every fix, including the ternary a line-based scan cannot see', () => {
    expect(fixes.length).toBeGreaterThan(20)
    // The canary. This fix's text lives on a CONTINUATION line under a bare `fix:`, so it is invisible
    // to a `grep fix:` scan - the blind spot that made two reviews disagree on the count. The extractor
    // must see it; if it ever regresses to line-based, the guards below go quietly false-green.
    const inGithubChecks = fixes.filter((f) => f.fn === 'runGithubChecks')
    expect(
      inGithubChecks.some((f) => f.text.includes('invalid or expired')),
    ).toBe(true)
    const lineBased = source.split('\n').filter((l) => /\bfix:/.test(l))
    expect(lineBased.some((l) => l.includes('invalid or expired'))).toBe(false)
  })

  it('the REPOACCESS_ env-var path does not exist anywhere in the script', () => {
    // Removed, not deprecated. The reads were untested and unadvertised, kept alive only so a document
    // could say "do not use this" - a trap, and the one that broke a live run. The flag is now the only
    // way in, enforced by the code rather than by prose.
    expect(source).not.toContain('REPOACCESS_')
  })

  it('no fix reaches for an env assignment, an && chain, or a raw cp', () => {
    for (const f of fixes) {
      expect(`${f.fn}:${f.line} ${f.text}`).not.toMatch(/\$env:|&&|\bcp /)
    }
  })

  it('every npm script a fix names actually exists', () => {
    const pkg = JSON.parse(
      readFileSync(join(dirname(wizardPath), '..', 'package.json'), 'utf8'),
    )
    const named = fixes
      .flatMap((f) => [...f.text.matchAll(/npm run ([a-z][\w:-]*)/g)])
      .map((m) => m[1])
      // A capture ending in ':' is the residue of an interpolated name (`npm run wizard:${step}`), not a
      // script anyone can run. Those step names are validated separately, and better: check-env asserts
      // package.json declares a `wizard:` alias for EVERY entry in WIZARD_STEPS.
      .filter((script) => !script.endsWith(':'))
    // `npm run deploy` shipped here for months and is not a script at all - a deployer told to run it
    // gets "missing script", then improvises. The scripts are the contract; assert against them.
    expect(named.length).toBeGreaterThan(0)
    for (const script of named) expect(pkg.scripts).toHaveProperty(script)
  })

  it('a production run names the secrets file that run actually READS', async () => {
    // The source guard proves no fix hard-codes a filename; this proves the interpolation resolves to
    // the RIGHT one on a real run. Both directions matter: naming `.dev.vars` on a production run sends
    // a live key into a file nothing opens, and naming `.dev.vars.production` on a sandbox run is the
    // same mistake mirrored.
    const prod = await githubVerify({
      env: 'production',
      config: {},
      token: '',
    })
    expect(named(prod, 'GITHUB_TOKEN present')?.fix).toContain(
      '.dev.vars.production',
    )

    const sandbox = await githubVerify({ config: {}, token: '' })
    const sandboxFix = named(sandbox, 'GITHUB_TOKEN present')?.fix
    expect(sandboxFix).toContain('.dev.vars')
    expect(sandboxFix).not.toContain('.dev.vars.production')

    // The DEEP path: `runGithubChecks` only runs once a token exists, so a missing-token test never
    // reaches it. Its env arrives through a separate call-site argument, which a refactor can silently
    // drop - and the source guard stays green when it does, because the fix still interpolates. Only
    // driving the 401 branch in production proves the env survives the call chain.
    const rejected = await githubVerify({
      env: 'production',
      config: CONFIG,
      api: mockApi({ ...greenRoutes, '/user': { status: 401 } }),
    })
    expect(named(rejected, 'authenticates')?.fix).toContain(
      '.dev.vars.production',
    )

    // e2e is the step the incident report calls out: it reads VALUES from the env's file, so its
    // missing-secret fix is the one a production run actually meets.
    const e2eProd = await e2e({
      env: 'production',
      config: E2E_CONFIG,
      url: 'https://w.example.com',
      username: 'buyer',
      stripeSecret: '',
      githubToken: '',
    })
    expect(named(e2eProd, 'e2e secrets present')?.fix).toContain(
      '.dev.vars.production',
    )
  })

  it('no fix hard-codes a secrets VALUE file - it names the one THAT run reads', () => {
    // The hazard, created by our own message: on a production run the code reads
    // `.dev.vars.production`, so a fix saying `.dev.vars` sends a LIVE key into a file nothing opens,
    // and the run then fails having just told the deployer they did the right thing. Any fix naming a
    // secrets file must interpolate `secretsFileFor(env)`. The `.example` templates are exempt: they are
    // committed, names-only, and env-independent.
    //
    // No exemptions. There was one, for a guard that reported the two filenames because they were its
    // subject; removing the env default deleted that guard, so the exemption went with it rather than
    // being left as a hole for the next reader to puzzle over.
    const offenders = fixes
      .map((f) => ({
        site: `${f.fn}:${f.line}`,
        hardCoded: [...f.text.matchAll(/\.dev\.vars[\w.]*/g)]
          .map((m) => m[0])
          .filter((file) => !file.endsWith('.example')),
      }))
      .filter((f) => f.hardCoded.length > 0)
    expect(offenders).toEqual([])
  })
})

// The engine ships as a package SUBPATH (`repoaccess-core/wizard`) so a downstream wizard composes
// these same step functions instead of copying them. A copy is the failure this guards: it would
// pass every test it was given and then drift, silently, one release later.
describe('the wizard engine is consumable as a package subpath', () => {
  it('resolves via `repoaccess-core/wizard` and is the SAME module, not a copy', async () => {
    // Self-reference: a package whose manifest has an `exports` map can import itself by name, so
    // this resolves through the exports map exactly as a consumer's would - no node_modules copy,
    // no alias, nothing the test could fake into passing.
    const viaSubpath = await import('repoaccess-core/wizard')

    // Identity, not merely presence. `toBe` proves the subpath reaches the one engine module: a
    // second copy on disk would export functions of the same NAME that are not the same FUNCTION,
    // and only this assertion can tell those two worlds apart.
    expect(viaSubpath.deploy).toBe(deploy)
    expect(viaSubpath.githubVerify).toBe(githubVerify)
    expect(viaSubpath.kvCreate).toBe(kvCreate)
    expect(viaSubpath.grantRecord).toBe(grantRecord)
    expect(viaSubpath.e2e).toBe(e2e)
  })

  it('exports the step-function surface a downstream wizard composes', async () => {
    const wizardModule: Record<string, unknown> =
      await import('repoaccess-core/wizard')
    // The steps a wizard run drives, by name. Losing one is a breaking change for any consumer,
    // so it is spelled out rather than counted.
    const STEP_FUNCTIONS = [
      'checkEnv',
      'preflight',
      'cloudflareAuthCheck',
      'githubVerify',
      'secretsCheck',
      'kvCreate',
      'grantRecord',
      'deploy',
      'e2e',
      'resolveUrl',
      'ensureConfigFiles',
      'ensureSecretsFiles',
    ]
    for (const name of STEP_FUNCTIONS) {
      expect(typeof wizardModule[name], `${name} must be exported`).toBe(
        'function',
      )
    }
  })

  it('declares the subpath in the manifest, with types', () => {
    // The manifest is what npm publishes; a working self-reference here does not prove the
    // published shape, so the declaration itself is pinned.
    const pkg = JSON.parse(
      readFileSync(
        join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'),
        'utf8',
      ),
    )
    expect(pkg.exports['./wizard']).toEqual({
      types: './scripts/wizard.d.mts',
      default: './scripts/wizard.mjs',
    })
    // The engine files must also be in the `files` allowlist, or the export points at nothing once
    // the package is packed.
    expect(pkg.files).toContain('scripts/wizard.mjs')
    expect(pkg.files).toContain('scripts/wizard.d.mts')
  })
})

// --- the provider pack seam ---------------------------------------------------------------------
//
// The synthetic check's four provider-specific facts are supplied by the CALLER, so a downstream
// wizard can prove its own adapter's grant path without that adapter's knowledge entering core.
//
// THE PACK USED HERE IS INVENTED. `acmepay` is not a provider anybody integrates - the boundary this
// seam exists to hold applies to the tests as much as to the engine, so pinning it with a REAL
// non-core provider's event shape and signature scheme would put that provider's substance in core
// under the heading of a test. An invented pack proves the mechanism exactly as well.

const ACME_PACK = {
  webhookPath: 'acmepay',
  secretName: 'ACMEPAY_WEBHOOK_SECRET',
  buildEvent: ({
    productId,
    username,
    transactionId,
  }: {
    productId: string
    username: string
    transactionId: string
  }) => ({ kind: 'acme.paid', productId, username, ref: transactionId }),
  signatureHeader: (body: string, secret: string, timestamp: number) => ({
    name: 'x-acmepay-signature',
    value: `${timestamp}~${secret}~${body.length}`,
  }),
}

/** The same config, keyed by the invented adapter rather than by stripe. */
const ACME_CONFIG = {
  githubOrg: 'acme',
  productTeamMap: {
    defaults: { teams: [] },
    acmepay: { sku_x: { teams: ['pro'] } },
  },
  e2e: { testUsername: 'octocat', url: 'https://worker.example' },
}

/** Happy path for the invented adapter: the POST lands on its own route, everything else as usual. */
const greenAcmeFetch = () =>
  e2eFetch((method, url) => {
    if (url.includes('/wh/acmepay/')) return { status: 200 }
    if (method === 'GET' && url.includes('/teams/pro/memberships/octocat'))
      return { status: 200, json: { state: 'pending' } }
    if (method === 'GET' && url.includes('/invitations'))
      return { status: 200, json: [] }
    if (method === 'DELETE') return { status: 204 }
    return { status: 404 }
  })

describe('the e2e provider pack seam', () => {
  it('defaults to the built-in Stripe pack when no pack is given', () => {
    expect(resolveE2ePack(undefined)).toEqual({ pack: STRIPE_E2E_PACK })
    expect(resolveE2ePack(null)).toEqual({ pack: STRIPE_E2E_PACK })
  })

  it('the built-in pack carries exactly the four literals e2e used to inline', () => {
    // Pinned against the previous hard-codings, so the extraction cannot drift from what it replaced.
    expect(STRIPE_E2E_PACK.webhookPath).toBe('stripe')
    expect(STRIPE_E2E_PACK.secretName).toBe('STRIPE_WEBHOOK_SECRET')
    expect(STRIPE_E2E_PACK.buildEvent).toBe(buildE2eEvent)
    const sig = STRIPE_E2E_PACK.signatureHeader('body', 'secret', 123)
    expect(sig.name).toBe('stripe-signature')
    expect(sig.value).toBe(stripeSignatureHeader('body', 'secret', 123))
  })

  it('takes a supplied pack WHOLE - a partial pack is refused, never merged', async () => {
    // Merging would let a partial pack mix providers silently: one provider's event under another's
    // signature is a forged event, and the worker's 401 would name nothing about the real cause.
    expect(resolveE2ePack({ webhookPath: 'acmepay' } as never).error).toContain(
      'secretName',
    )
    const result = await e2e({
      config: ACME_CONFIG,
      pack: { webhookPath: 'acmepay', secretName: 'X' } as never,
      githubToken: 'ghp_x',
      fetch: greenAcmeFetch(),
      run: okRun,
      sleep: noop,
    })
    expect(result.ok).toBe(false)
    expect(named(result, 'provider pack usable')?.ok).toBe(false)
    expect(named(result, 'provider pack usable')?.fix).toContain('buildEvent')
  })

  it('refuses a pack whose builder or signer is not callable', () => {
    expect(
      resolveE2ePack({
        webhookPath: 'a',
        secretName: 'B',
        buildEvent: 'nope',
        signatureHeader: 'nope',
      } as never).error,
    ).toContain('must be functions')
  })

  it('posts the pack event to the pack route with the pack header', async () => {
    const fetchImpl = greenAcmeFetch()
    const result = await e2e({
      config: ACME_CONFIG,
      pack: ACME_PACK,
      secret: 'acme_secret',
      githubToken: 'ghp_x',
      fetch: fetchImpl,
      run: okRun,
      transactionId: 'tx_1',
      timestamp: 1700000000,
      sleep: noop,
    })
    expect(result.ok).toBe(true)

    // The ROUTE is the pack's adapter segment, not stripe.
    const posted = (fetchImpl as any).calls.find(
      (c: { method: string; url: string }) => c.method === 'POST',
    )
    expect(posted.url).toBe('https://worker.example/wh/acmepay/webhook')
    expect(posted.url).not.toContain('/wh/stripe/')
  })

  it('builds the pack EVENT and attaches the pack HEADER, byte for byte', async () => {
    let sentBody: string | null = null
    let sentHeaders: Record<string, string> = {}
    const fetchImpl = async (url: string, init: any) => {
      if (url.includes('/wh/acmepay/')) {
        sentBody = init.body
        sentHeaders = init.headers
        return {
          status: 200,
          async json() {
            return null
          },
        }
      }
      if (url.includes('/memberships/'))
        return {
          status: 200,
          async json() {
            return { state: 'pending' }
          },
        }
      if (url.includes('/invitations'))
        return {
          status: 200,
          async json() {
            return []
          },
        }
      return {
        status: 204,
        async json() {
          return null
        },
      }
    }
    await e2e({
      config: ACME_CONFIG,
      pack: ACME_PACK,
      secret: 'acme_secret',
      githubToken: 'ghp_x',
      fetch: fetchImpl as never,
      run: okRun,
      transactionId: 'tx_1',
      timestamp: 1700000000,
      sleep: noop,
    })

    // The event is the PACK's, not a checkout.session.completed.
    expect(JSON.parse(sentBody!)).toEqual({
      kind: 'acme.paid',
      productId: 'sku_x',
      username: 'octocat',
      ref: 'tx_1',
    })
    // The header NAME is the pack's too - it differs per provider as much as the scheme does.
    expect(sentHeaders['x-acmepay-signature']).toBe(
      `1700000000~acme_secret~${sentBody!.length}`,
    )
    expect(sentHeaders['stripe-signature']).toBeUndefined()
  })

  it('resolves the target product from the PACK adapter key', async () => {
    // `productTeamMap.acmepay`, not `.stripe`. Without this the product lookup would come up empty
    // for every non-default pack and the run would stop before it ever reached the network.
    const result = await e2e({
      config: ACME_CONFIG,
      pack: ACME_PACK,
      secret: 'acme_secret',
      githubToken: 'ghp_x',
      fetch: greenAcmeFetch(),
      run: okRun,
      sleep: noop,
    })
    expect(result.ok).toBe(true)
    // The stripe-keyed config has nothing under `acmepay`, so the same pack finds no product there.
    const wrongKey = await e2e({
      config: E2E_CONFIG,
      pack: ACME_PACK,
      secret: 'acme_secret',
      githubToken: 'ghp_x',
      fetch: greenAcmeFetch(),
      run: okRun,
      sleep: noop,
    })
    expect(named(wrongKey, 'product->team mapping')?.ok).toBe(false)
  })

  it('deletes the grant record under the PACK adapter segment', async () => {
    // `grant:<segment>:<txn>` - the third place the adapter segment is load-bearing. Deleting
    // `grant:stripe:...` after an acmepay grant would leave synthetic data in a production KV.
    const calls: string[][] = []
    await e2e({
      config: ACME_CONFIG,
      pack: ACME_PACK,
      secret: 'acme_secret',
      githubToken: 'ghp_x',
      fetch: greenAcmeFetch(),
      run: (args: string[]) => {
        calls.push(args)
        return { ok: true, status: 0, stdout: '', stderr: '' }
      },
      transactionId: 'tx_1',
      timestamp: 1700000000,
      sleep: noop,
    })
    const del = calls.find((a) => a[0] === 'kv')
    expect(del).toContain('grant:acmepay:tx_1')
    expect(del).not.toContain('grant:stripe:tx_1')
  })

  it('names the PACK secret when it is missing, not the Stripe one', async () => {
    const result = await e2e({
      config: ACME_CONFIG,
      pack: ACME_PACK,
      githubToken: 'ghp_x',
      // no secret, and no secrets file in this cwd
      cwd: mkdtempSync(join(tmpdir(), 'wizard-pack-')),
      fetch: greenAcmeFetch(),
      run: okRun,
      sleep: noop,
    })
    expect(result.ok).toBe(false)
    const check = named(result, 'e2e secrets present')
    expect(check?.name).toContain('ACMEPAY_WEBHOOK_SECRET')
    expect(check?.name).not.toContain('STRIPE_WEBHOOK_SECRET')
    expect(check?.fix).toContain('ACMEPAY_WEBHOOK_SECRET')
  })

  // --- red, then green, on the seam itself -------------------------------------------------------

  it('a pack whose signature the worker REJECTS fails the check (red)', async () => {
    // The worker only acks a signature it can verify. A pack signing the wrong thing is exactly the
    // failure this seam can introduce, so it is proven to be VISIBLE rather than silently green.
    const expected = `1700000000~right_secret~59`
    const rejectingWorker = e2eFetch((method, url) => {
      if (url.includes('/wh/acmepay/')) return { status: 401 }
      if (method === 'GET' && url.includes('/memberships/'))
        return { status: 404 }
      if (method === 'GET' && url.includes('/invitations'))
        return { status: 200, json: [] }
      if (method === 'DELETE') return { status: 204 }
      return { status: 404 }
    })
    const red = await e2e({
      config: ACME_CONFIG,
      pack: ACME_PACK,
      secret: 'wrong_secret',
      githubToken: 'ghp_x',
      fetch: rejectingWorker,
      run: okRun,
      transactionId: 'tx_1',
      timestamp: 1700000000,
      sleep: noop,
    })
    expect(red.ok).toBe(false)
    expect(named(red, 'ack')?.ok).toBe(false)
    // And the fix names the PACK's secret, which is the one the deployer would have to check.
    expect(named(red, 'ack')?.fix).toContain('ACMEPAY_WEBHOOK_SECRET')
    expect(expected).toBeTruthy()
  })

  it('the same pack against a worker that ACCEPTS its signature goes green', async () => {
    const green = await e2e({
      config: ACME_CONFIG,
      pack: ACME_PACK,
      secret: 'right_secret',
      githubToken: 'ghp_x',
      fetch: greenAcmeFetch(),
      run: okRun,
      transactionId: 'tx_1',
      timestamp: 1700000000,
      sleep: noop,
    })
    expect(green.ok).toBe(true)
    expect(named(green, 'ack')?.ok).toBe(true)
    expect(named(green, 'invite observed')?.ok).toBe(true)
  })

  // --- the default path is unchanged -------------------------------------------------------------

  it('omitting the pack still posts to /wh/stripe/ with a stripe-signature', async () => {
    // The behaviour-identity half. Every pre-pack caller passes no pack, so this is the path the
    // whole existing suite exercises - asserted here explicitly rather than only implied by it.
    const fetchImpl = greenE2eFetch()
    const result = await e2e({
      config: E2E_CONFIG,
      stripeSecret: 'whsec_x',
      githubToken: 'ghp_x',
      fetch: fetchImpl,
      run: okRun,
      transactionId: 'pi_e2e_1',
      timestamp: 1700000000,
      sleep: noop,
    })
    expect(result.ok).toBe(true)
    const posted = (fetchImpl as any).calls.find(
      (c: { method: string; url: string }) => c.method === 'POST',
    )
    expect(posted.url).toBe('https://worker.example/wh/stripe/webhook')
  })

  it('`secret` and the original `stripeSecret` are the same seam', async () => {
    // `stripeSecret` predates the pack and every existing caller passes it; `secret` is its
    // pack-neutral spelling. Both must reach the signature, or a pre-pack caller silently loses it.
    for (const opts of [{ stripeSecret: 'whsec_x' }, { secret: 'whsec_x' }]) {
      const result = await e2e({
        config: E2E_CONFIG,
        ...opts,
        githubToken: 'ghp_x',
        fetch: greenE2eFetch(),
        run: okRun,
        transactionId: 'pi_e2e_1',
        timestamp: 1700000000,
        sleep: noop,
      })
      expect(result.ok).toBe(true)
    }
  })
})

// --- the boundary, asserted POSITIVELY ------------------------------------------------------------
//
// The seam exists so a downstream can add a provider WITHOUT editing the engine. That promise is only
// kept while the engine names exactly one provider, and a reviewer should not have to grep for it.
//
// THIS ASSERTION USED TO BE A DENY-LIST, and the deny-list was itself the leak. It enumerated nine
// competitor brands so it could assert their absence - which put those nine brand names into a file
// that SHIPS in the clone, and the publish gate caught them as Pro substance in core. A deny-list on a
// shipped surface carries the very names it exists to exclude.
//
// The positive form has neither problem, and it is STRICTER. It extracts every provider-identifying
// literal BY SHAPE and asserts each one IS Stripe's, so it catches ANY foreign provider - including one
// no list could have named, because nobody had heard of it when the list was written.
//
// PROVEN, not argued: planting `/wh/acmepay/` reds the segment assertion and planting
// `ACMEPAY_WEBHOOK_SECRET` reds the secret assertion (both restored green). `acmepay` appears in NO
// deny-list anywhere - the old form would have greened on both, which is exactly the gap.

/** Every provider-identifying literal in the engine, extracted by SHAPE rather than by name. */
function providerLiterals(source: string) {
  const all = (re: RegExp) => [...source.matchAll(re)].map((m) => m[1])
  // A template expression (`${pack.webhookPath}`) is the SEAM doing its job, not a literal - the
  // character classes below exclude `$` and `{` so only hard-coded segments are collected.
  return {
    // `/wh/<segment>/` - the webhook route, wherever it is built or documented.
    routeSegments: all(/\/wh\/([A-Za-z0-9_-]+)\//g),
    // `grant:<segment>:` - the KV grant-record key.
    grantSegments: all(/grant:([A-Za-z0-9_-]+):/g),
    // the provider pack's own adapter-segment default.
    packSegments: all(/webhookPath:\s*'([A-Za-z0-9_-]+)'/g),
    // any secret NAME of the provider-webhook shape.
    secretNames: all(/\b([A-Z][A-Z0-9_]*_WEBHOOK_SECRET)\b/g),
  }
}

describe('the engine names exactly one provider, and it is Stripe', () => {
  const source = readFileSync(wizardPath, 'utf8')
  const found = providerLiterals(source)

  it('every adapter segment the engine hard-codes is `stripe`', () => {
    const segments = [
      ...found.routeSegments,
      ...found.grantSegments,
      ...found.packSegments,
    ]
    expect([...new Set(segments)]).toEqual(['stripe'])
  })

  it('every provider secret name the engine hard-codes is STRIPE_WEBHOOK_SECRET', () => {
    expect([...new Set(found.secretNames)]).toEqual(['STRIPE_WEBHOOK_SECRET'])
  })

  it('the extraction really matched something, in every shape it claims to cover', () => {
    // The completeness half, and it is not decoration: a regex that silently stops matching would make
    // every assertion above pass over an EMPTY set. A guard that greens because it found nothing is the
    // false green this suite keeps removing. These are minimums, not exact counts - the engine is free
    // to gain another correctly-Stripe mention without editing a test.
    expect(found.routeSegments.length).toBeGreaterThan(0)
    expect(found.packSegments.length).toBeGreaterThan(0)
    expect(found.secretNames.length).toBeGreaterThan(0)
  })

  it('the union of provider-identifying tokens is exactly Stripe and nothing else', () => {
    // One assertion over everything the shapes found, so a NEW shape added to `providerLiterals` is
    // covered here without a second edit.
    const union = new Set([
      ...found.routeSegments,
      ...found.grantSegments,
      ...found.packSegments,
      ...found.secretNames,
    ])
    expect([...union].sort()).toEqual(['STRIPE_WEBHOOK_SECRET', 'stripe'])
  })
})
