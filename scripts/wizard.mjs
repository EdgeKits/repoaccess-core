// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Gary Stupak

// Setup-wizard STEP LIBRARY. A zero-dependency Node build script - NOT worker code. Each step does
// one piece of the real work (check the environment, verify GitHub, create the KV namespace, deploy,
// run the synthetic end-to-end check); every wrangler/gh/etc. side effect runs INSIDE this script's
// child processes, invisible to the permission layer, so the non-repeatable prompts disappear by
// construction and Node absorbs cross-OS concerns once.
//
// This file has NO command line. A DRIVER is the setup's entry point: it imports these functions,
// sequences them, carries the env and owns the wording. The driver is per-distribution and is NOT part
// of the published npm package - only this step library is, via the `repoaccess-core/wizard` subpath.
// Clone the repository and the driver is there, at `scripts/wizard-driver.mjs` (`npm run wizard:drive`);
// install from npm and you write your own against that subpath, which is what a distribution built on
// core does.
// Steps are pure + testable - each returns its result object rather than printing one, and the only
// edge left here is `runCommand` (spawn).
//
// Result shape: { step, ok, outcome, checks: [ { name, ok, fix?, severity? } ], next }.

import { existsSync, readFileSync, copyFileSync } from 'node:fs'
import { join, delimiter } from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { createHmac, randomUUID, randomBytes } from 'node:crypto'

// Minimum Node for the wizard. The floor is set by native TypeScript type-stripping (so
// github-verify can `import()` the real src/config/repoaccess.config.ts with ZERO deps): unflagged
// from Node 22.18 on the 22 LTS line, 23.6 on the 23 line, and all of 24+. Below that, importing a
// .ts config would need a flag or a transpiler - neither allowed here.
export const MIN_NODE_VERSION = '22.18.0'

// True when this Node can import a .ts module without a flag. Encodes the real support matrix
// (22.18+ / 23.6+ / 24+) - a plain `>= 22.18` compare would wrongly pass 23.0-23.5.
export function nodeSupportsTsImport(version = process.versions.node) {
  const [major, minor] = version.split('.').map(Number)
  if (major >= 24) return true
  if (major === 23) return minor >= 6
  if (major === 22) return minor >= 18
  return false
}

// The one npm script the setup has. The driver sequences every step in this file by calling its
// function directly, so `wizard:drive` is the whole allowlist surface (`Bash(npm run wizard:drive)`)
// and the only entry point a deployer ever types.
export const WIZARD_DRIVER_SCRIPT = 'wizard:drive'

// --- edges (spawn; not exercised by the pure step tests) ---------------------------------------

// Cross-OS child-process runner. On Windows a `.cmd` shim (npx.cmd, wrangler.cmd) is not directly
// executable by spawn without a shell, so route through the shell there. Used by the mutating steps
// (kv-create, deploy; e2e still to come) via the `wranglerRunner` seam; the read-only steps do not
// spawn. Windows-verified; mac/Linux is a deferred cross-OS live-test (curator caveat).
export function runCommand(command, args = [], options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    shell: process.platform === 'win32',
    ...options,
  })
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}

// --- helpers -----------------------------------------------------------------------------------

// Resolve an executable WITHOUT spawning it (read-only): check the project-local node_modules/.bin
// first, then each PATH entry, honoring Windows executable extensions. Returns the path or null.
export function resolveBin(
  name,
  { cwd = process.cwd(), env = process.env } = {},
) {
  const exts =
    process.platform === 'win32' ? ['.cmd', '.exe', '.bat', ''] : ['']
  const dirs = [
    join(cwd, 'node_modules', '.bin'),
    ...(env.PATH ?? env.Path ?? '').split(delimiter),
  ]
  for (const dir of dirs) {
    if (!dir) continue
    for (const ext of exts) {
      const candidate = join(dir, name + ext)
      if (existsSync(candidate)) return candidate
    }
  }
  return null
}

// Every step ends the same way: next = a human-facing hint, ok = the pass/fail aggregate. A check may
// carry `severity: 'warn'` to mark it ADVISORY: it is still surfaced in the JSON, but excluded from the
// aggregate so it never fails the step. Everything else (default 'error') must pass for ok. This lets a
// delivery-completeness advisory (e.g. a team with no repo attached) inform without blocking a run.
//
// `outcome` names what happened in the step's own words, alongside the `ok` aggregate.
function finalize(step, checks, nextOk, nextFail = 're-run after fixes') {
  const ok = checks.filter((c) => c.severity !== 'warn').every((c) => c.ok)
  return {
    step,
    ok,
    outcome: ok ? 'ok' : 'failed',
    checks,
    next: ok ? nextOk : nextFail,
  }
}

// Confirm package.json declares the driver script. It is the deployer's only entry point, so a
// package.json without it leaves them nothing to run.
function hasDriverScript(cwd) {
  try {
    const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'))
    return Boolean((pkg.scripts ?? {})[WIZARD_DRIVER_SCRIPT])
  } catch {
    return false
  }
}

// --- read-only steps (spec section 3: safe to re-run; never read secret VALUES) ----------------

// Preconditions for everything else: a supported Node, resolvable wrangler + git, the secret-name
// template, and the wizard aliases. Reads NO secret values (only checks .dev.vars.example exists).
export function checkEnv({ cwd = process.cwd() } = {}) {
  const checks = []

  const tsImportOk = nodeSupportsTsImport()
  checks.push({
    name: `node supports .ts config import (>= ${MIN_NODE_VERSION})`,
    ok: tsImportOk,
    ...(tsImportOk
      ? {}
      : {
          fix: `Upgrade Node to >= ${MIN_NODE_VERSION} (or >= 23.6 / >= 24) for native .ts import - current ${process.versions.node}`,
        }),
  })

  const hasWrangler = resolveBin('wrangler', { cwd }) !== null
  checks.push({
    name: 'wrangler resolvable',
    ok: hasWrangler,
    ...(hasWrangler
      ? {}
      : { fix: 'Run npm install (wrangler is a devDependency)' }),
  })

  const hasGit = resolveBin('git', { cwd }) !== null
  checks.push({
    name: 'git resolvable',
    ok: hasGit,
    ...(hasGit ? {} : { fix: 'Install git and ensure it is on PATH' }),
  })

  const hasExample = existsSync(join(cwd, '.dev.vars.example'))
  checks.push({
    name: '.dev.vars.example present',
    ok: hasExample,
    ...(hasExample
      ? {}
      : { fix: 'Restore .dev.vars.example (the secret-name template)' }),
  })

  const hasDriver = hasDriverScript(cwd)
  checks.push({
    name: `package.json declares ${WIZARD_DRIVER_SCRIPT}`,
    ok: hasDriver,
    ...(hasDriver
      ? {}
      : {
          fix: `Restore the "${WIZARD_DRIVER_SCRIPT}" npm script - it is how the setup is run`,
        }),
  })

  return finalize('check-env', checks, 'environment ready')
}

// The offline core of doctor: check-env. Every other numbered step needs a token + network, the
// gitignored .dev.vars, a deployed worker, or is mutating (secrets-check / kv-create / deploy / e2e), so
// folding them in would make doctor non-deterministic (red on any fresh clone / CI). They stay out.
const READ_ONLY_STEPS = [checkEnv]

// Fully-LOCAL read-only checks at once - a preflight and, post-setup, a support diagnostic. The offline
// check-env is the deterministic core. As a support-tool add-on, doctor ALSO runs the test-buyer
// isolation check (the same one github-verify runs) when the config declares an e2e.testUsername: a
// deployer running doctor after setup should learn if that handle drifted INTO the org. A neutral core
// config has no e2e.testUsername, so this is a no-op on a fresh clone and doctor stays offline +
// deterministic there. When it IS configured, the check degrades to an advisory WARN on any read failure
// (no token, 403, or a network error) so a support run is never a hard red over an environment artifact -
// only a definitive in-org membership fails it. ENV-AWARE (opts.env), same source as the other steps.
export async function doctor(opts = {}) {
  const cwd = opts.cwd ?? process.cwd()
  const env = opts.env ?? null
  const checks = READ_ONLY_STEPS.flatMap((step) => step({ cwd }).checks)

  const config = opts.config ?? (await loadConfig(cwd, env))
  const testUsername = config?.e2e?.testUsername
  const org = config?.githubOrg
  if (testUsername && org) {
    let api = opts.api
    if (!api) {
      const token = opts.token ?? readToken(cwd, { env })
      api = token ? createGithubApi(token, opts.fetch ?? fetch) : null
    }
    if (api) {
      const check = await testBuyerCheck(api, org, testUsername)
      if (check) checks.push(check)
    } else {
      checks.push({
        name: `test buyer '${testUsername}' is not in the org`,
        ok: false,
        severity: 'warn',
        fix: `Set GITHUB_TOKEN in ${secretsFileFor(env)} so doctor can confirm '${testUsername}' is outside '${org}', or verify manually in your browser (Org, People).`,
      })
    }
  }

  return finalize('doctor', checks, 'all read-only checks pass')
}

// --- preflight (Step 0 superset: check-env + the two setup side effects) ------------------------

// Copy a secrets template into place when the real file is missing (idempotent - only when absent, so
// an existing .dev.vars is never clobbered). This is the "cp .dev.vars.example .dev.vars" the
// orchestrator used to issue as raw shell, moved inside the script so the agent only ever runs
// `npm run wizard:drive`. Names only ever touch disk here, inside a child process; the agent never reads
// the values (deny Read(.dev.vars*) + the child-process boundary). Seams (exists/copy) keep it
// fs-free in tests. Returns one check per env file. ENV-AWARE: a sandbox run (env null/undefined)
// creates ONLY `.dev.vars`; a production run (env 'production') creates ONLY `.dev.vars.production`.
// Copying both unconditionally left a stray `.dev.vars.production` on sandbox runs.
//
// A check's NAME is its stable identity and must NOT change with whether the step had to do work: it
// is always `<file> present`, whether the file was already there or the wizard just created it from the
// template. The "just created" fact is carried separately as an informational `detail` field on the
// same check, so the orchestrator can still tell the deployer a fresh file was written without the name
// shifting. (A name that flipped to `<file> created from ...` on a fresh clone broke the very first
// `npm test` for buyers who cloned and ran, since `.dev.vars` is gitignored and always absent then.)
export function ensureSecretsFiles(
  cwd = process.cwd(),
  { exists = existsSync, copy = copyFileSync, env = null } = {},
) {
  const files =
    env === 'production'
      ? [
          {
            file: '.dev.vars.production',
            example: '.dev.vars.production.example',
          },
        ]
      : [{ file: '.dev.vars', example: '.dev.vars.example' }]
  return files.map(({ file, example }) => {
    const name = `${file} present`
    const target = join(cwd, file)
    if (exists(target)) return { name, ok: true }
    const src = join(cwd, example)
    if (!exists(src)) {
      return {
        name,
        ok: false,
        fix: `Restore ${example} (the secret-name template) so the wizard can create ${file}`,
      }
    }
    try {
      copy(src, target)
      return { name, ok: true, detail: `created from ${example}` }
    } catch {
      return {
        name,
        ok: false,
        fix: `Could not create ${file} from ${example} - copy it into place manually`,
      }
    }
  })
}

// Copy the config-as-code + wrangler templates into place when the real files are missing (idempotent -
// only when absent, so a deployer's edited config/ids are never clobbered). Same "the cp lives inside the
// script, never issued as raw shell" rationale as ensureSecretsFiles: the deployer runs
// `npm run wizard:drive` and never meets a typecheck failure they did not cause - the worker
// (src/index.ts, src/index.production.ts) import the real `repoaccess.config.ts`, and without it the
// build fails loudly. Unlike the secrets files these are NOT env-aware: one config module carries both
// `sandbox`/`production` profiles and one wrangler.jsonc carries both environments. The check NAME is
// stable (`<file> present`) whether the file was already there or the wizard just created it; the "just
// created" fact rides on a `detail` field (same fresh-clone-first-`npm test` reasoning as the secrets
// copy above). Seams (exists/copy) keep it fs-free in tests.
export function ensureConfigFiles(
  cwd = process.cwd(),
  { exists = existsSync, copy = copyFileSync } = {},
) {
  const files = [
    {
      file: 'src/config/repoaccess.config.ts',
      example: 'src/config/repoaccess.config.example.ts',
    },
    { file: 'wrangler.jsonc', example: 'wrangler.jsonc.example' },
  ]
  return files.map(({ file, example }) => {
    const name = `${file} present`
    const target = join(cwd, file)
    if (exists(target)) return { name, ok: true }
    const src = join(cwd, example)
    if (!exists(src)) {
      return {
        name,
        ok: false,
        fix: `Restore ${example} (the config template) so the wizard can create ${file}`,
      }
    }
    try {
      copy(src, target)
      return { name, ok: true, detail: `created from ${example}` }
    } catch {
      return {
        name,
        ok: false,
        fix: `Could not create ${file} from ${example} - copy it into place manually`,
      }
    }
  })
}

// Confirm the deployer is authenticated with Cloudflare (`wrangler whoami` exits 0). Runs through the
// runCommand seam (child process), so no raw `wrangler whoami` is ever issued from the agent. This is
// a networked check, which is why preflight (not the offline `doctor`) hosts it.
export function cloudflareAuthCheck(run) {
  const res = run(['whoami'])
  return {
    name: 'Cloudflare authenticated (wrangler whoami)',
    ok: res.ok,
    ...(res.ok
      ? {}
      : {
          fix: 'Run `npx wrangler login` to authenticate with Cloudflare, then re-run',
        }),
  }
}

// preflight - the Step 0 superset. It runs the check-env preflight AND performs the two setup side
// effects the driver must never issue as raw / compound shell: copying the secrets template into place
// and confirming Cloudflare auth. The driver makes ONE call instead of a raw `cp` + `wrangler whoami` +
// `if [ -f .dev.vars ]...`. Because it copies a file and hits the network, it is deliberately NOT part
// of the offline, deterministic `doctor`; `check-env` stays the pure, re-runnable subset. Seams
// (run/exists/copy) make every branch mock-testable.
export function preflight(opts = {}) {
  const cwd = opts.cwd ?? process.cwd()
  const run = opts.run ?? wranglerRunner(cwd)
  const checks = [
    ...checkEnv({ cwd }).checks,
    ...ensureConfigFiles(cwd, {
      exists: opts.exists,
      copy: opts.copy,
    }),
    ...ensureSecretsFiles(cwd, {
      exists: opts.exists,
      copy: opts.copy,
      env: opts.env ?? null,
    }),
    cloudflareAuthCheck(run),
  ]
  return finalize(
    'preflight',
    checks,
    'environment ready, config + secrets files in place, Cloudflare authenticated',
  )
}

// --- github-verify (spec section 2-3: verification-driven, READ-ONLY - GitHub API GETs only) ---

// The secrets VALUE file for a deployment env: sandbox (null/undefined) reads `.dev.vars`, a
// production run reads `.dev.vars.production`. A production run MUST read the production file - the
// sandbox and production secrets differ, and reading `.dev.vars` for a prod verify/e2e would validate
// the wrong values (a production run surfaced this: it read the sandbox secrets).
export function secretsFileFor(env) {
  return env === 'production' ? '.dev.vars.production' : '.dev.vars'
}

// Read ONE secret VALUE by name (process env first, then the env's secrets file) for the script's own
// use - signing / Authorization headers. Used by github-verify (GITHUB_TOKEN) and e2e (GITHUB_TOKEN +
// STRIPE_WEBHOOK_SECRET). The value is NEVER printed in the JSON or returned to the agent. Unlike
// readEnvNames (which discards values), this is the deliberate value-read behind the child-process
// boundary. ENV-AWARE (opts.env): a production run reads `.dev.vars.production`, else `.dev.vars`.
export function readSecretValue(name, cwd = process.cwd(), opts = {}) {
  const processEnv = opts.processEnv ?? process.env
  if (processEnv[name]) return processEnv[name]
  const devVars = join(cwd, secretsFileFor(opts.env ?? null))
  if (!existsSync(devVars)) return null
  try {
    for (const raw of readFileSync(devVars, 'utf8').split(/\r?\n/)) {
      const line = raw.trim()
      if (!line || line.startsWith('#')) continue
      const eq = line.indexOf('=')
      if (eq <= 0) continue
      const key = line
        .slice(0, eq)
        .trim()
        .replace(/^export\s+/, '')
      if (key !== name) continue
      let value = line.slice(eq + 1).trim()
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1)
      }
      return value || null
    }
  } catch {
    return null
  }
  return null
}

// GITHUB_TOKEN (process env -> the env's secrets file), used only in the Authorization header, never
// printed. ENV-AWARE: a production run reads it from `.dev.vars.production`.
export function readToken(cwd = process.cwd(), opts = {}) {
  return readSecretValue('GITHUB_TOKEN', cwd, opts)
}

// Minimal read-only GitHub REST client (api.github.com only). Injectable seam: tests pass their own
// client (or a fake `fetch`) so the check logic runs against MOCKED responses, no network or token.
export function createGithubApi(token, fetchImpl = fetch) {
  return {
    async get(path) {
      const res = await fetchImpl(`https://api.github.com${path}`, {
        method: 'GET',
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          'user-agent': 'repoaccess-wizard',
        },
        redirect: 'manual',
      })
      let json = null
      try {
        json = await res.json()
      } catch {
        json = null
      }
      return { status: res.status, json, headers: res.headers }
    },
  }
}

// Never throw on a failed request - report it. A network error becomes status 0; the caller turns
// non-200 into an ok:false check with a fix, so rate-limits / outages degrade gracefully.
async function safeGet(api, path) {
  try {
    const res = await api.get(path)
    return {
      status: res.status ?? 0,
      json: res.json ?? null,
      headers: res.headers,
    }
  } catch {
    return { status: 0, json: null, headers: undefined }
  }
}

function rateLimited(res) {
  return (
    res.status === 403 && res.headers?.get?.('x-ratelimit-remaining') === '0'
  )
}

// Pick the config object from the loaded module for the target env. ENV-AWARE: a production run
// prefers `mod.production`; a sandbox run prefers `mod.sandbox`. Both then fall back through the other
// named exports and finally any export shaped like a RepoAccessConfig, so a single-profile config still
// resolves. A production run reading the sandbox profile was a real prod-path defect. Single source of
// truth = the real file.
export function selectConfig(mod, env = null) {
  const ordered =
    env === 'production'
      ? [mod.production, mod.default, mod.sandbox, ...Object.values(mod)]
      : [mod.sandbox, mod.default, mod.production, ...Object.values(mod)]
  return (
    ordered.find(
      (candidate) =>
        candidate &&
        typeof candidate === 'object' &&
        typeof candidate.githubOrg === 'string',
    ) ?? null
  )
}

// Load the deployer's TS config with NO deps via Node native type-stripping (guarded by check-env's
// node floor). The file is type-only imports + plain data, so stripping erases the lone `import type`
// and leaves the exported objects. ENV-AWARE: selects the production profile for a production run.
// Returns the selected config or null.
async function loadConfig(cwd, env = null) {
  const abs = join(cwd, 'src', 'config', 'repoaccess.config.ts')
  if (!existsSync(abs)) return null
  try {
    return selectConfig(await import(pathToFileURL(abs).href), env)
  } catch {
    return null
  }
}

// Every team slug the config grants, across the flat productTeamMap (adapter -> ProductConfig, or
// adapter -> { product_id -> ProductConfig }, plus the reserved `defaults`). Deduped.
export function collectTeams(config) {
  const map = (config && config.productTeamMap) || {}
  const teams = new Set()
  const addFrom = (value) => {
    if (value && Array.isArray(value.teams)) {
      for (const team of value.teams) if (team) teams.add(team)
    }
  }
  for (const value of Object.values(map)) {
    if (!value || typeof value !== 'object') continue
    if (Array.isArray(value.teams)) addFrom(value)
    else for (const sub of Object.values(value)) addFrom(sub)
  }
  return [...teams]
}

// Test-buyer isolation: the configured e2e.testUsername MUST be OUTSIDE the org. The wizard asks for
// the test-buyer handle exactly once (as e2e.testUsername), so that single answer is VERIFIED here, not
// trusted. GET /orgs/{org}/memberships/{username}:
//   404 -> PASS (an outsider, i.e. a real buyer).
//   200 with role member/admin (any state) -> FAIL (an insider), a hard error in BOTH envs and goals.
//   403 (the PAT cannot read membership) -> advisory WARN, confirm manually in the browser.
// Rationale (technical, not etiquette): an account already in the org NEVER receives an invite - GitHub
// adds it to the team outright - so an e2e against an in-org account greens a grant path no real buyer
// walks. Returns ONE check, or null when there is no testUsername to verify (a neutral config is a no-op).
export async function testBuyerCheck(api, org, testUsername) {
  if (!testUsername) return null
  const name = `test buyer '${testUsername}' is not in the org`
  const res = await safeGet(
    api,
    `/orgs/${encodeURIComponent(org)}/memberships/${encodeURIComponent(testUsername)}`,
  )
  if (res.status === 404) return { name, ok: true }
  if (
    res.status === 200 &&
    (res.json?.role === 'member' || res.json?.role === 'admin')
  ) {
    return {
      name,
      ok: false,
      fix: `'${testUsername}' is already a member or owner of '${org}', so it will NEVER receive an invite - GitHub adds an existing member to the team outright, and the synthetic e2e would green a grant path no real buyer ever walks. Two ways out: use a second GitHub account that is not in the org, or remove '${testUsername}' from the org first.`,
    }
  }
  if (res.status === 403) {
    return {
      name,
      ok: false,
      severity: 'warn',
      fix: `The PAT could not read org membership for '${testUsername}' (403). Confirm in your browser (Org, People) that '${testUsername}' is NOT listed as a member, then continue. Do not change the token's permissions for this.`,
    }
  }
  // Any other status (a network 0, an unexpected shape) is an environment artifact, not proof of an
  // insider: degrade to a manual browser confirm rather than a hard red.
  return {
    name,
    ok: false,
    severity: 'warn',
    fix: `Could not determine whether '${testUsername}' is in '${org}' (status ${res.status}). Confirm in your browser (Org, People) that it is NOT a member, then continue.`,
  }
}

// The check sequence. Pure over the injected api + config, so tests drive every branch with mocks.
// Short-circuits when a precondition (auth, org) makes downstream checks meaningless. The
// repo-attached check is always advisory (`warn`) - the worker PAT cannot verify repo attachment.
// Takes `env` for one reason: a fix that names a secrets file must name the one THIS run reads.
// Telling a production run to edit `.dev.vars` sends a live key into a file nothing opens.
async function runGithubChecks(api, config, env = null) {
  const checks = []

  // 1. Token authenticates. GET /user returns 200 for any token that authenticates.
  const user = await safeGet(api, '/user')
  if (rateLimited(user)) {
    checks.push({
      name: 'GITHUB_TOKEN authenticates',
      ok: false,
      fix: 'GitHub API rate limit reached - wait a few minutes and re-run',
    })
    return checks
  }
  const authOk = user.status === 200
  checks.push({
    name: 'GITHUB_TOKEN authenticates',
    ok: authOk,
    ...(authOk
      ? {}
      : {
          fix:
            user.status === 401
              ? `GITHUB_TOKEN is invalid or expired - regenerate the fine-grained PAT and set it in ${secretsFileFor(env)}`
              : 'Could not reach the GitHub API to validate GITHUB_TOKEN - check your network and re-run',
        }),
  })
  if (!authOk) return checks

  // 2. Org configured + accessible.
  const org = config && config.githubOrg
  if (!org) {
    checks.push({
      name: 'githubOrg configured',
      ok: false,
      fix: 'Set githubOrg in src/config/repoaccess.config.ts',
    })
    return checks
  }
  const orgRes = await safeGet(api, `/orgs/${encodeURIComponent(org)}`)
  const orgOk = orgRes.status === 200
  checks.push({
    name: `org '${org}' exists and is accessible`,
    ok: orgOk,
    ...(orgOk
      ? {}
      : {
          fix: `Org '${org}' not found or the PAT cannot access it - verify the name and grant the token access at https://github.com/orgs/${org}`,
        }),
  })
  if (!orgOk) return checks

  // 3. Org hardening: members cannot create PUBLIC repos. Read from the org response above. If the
  // field is not visible to the token, report ok:false with a verify-manually fix (never a false pass).
  const publicAllowed = orgRes.json?.members_can_create_public_repositories
  if (publicAllowed === false) {
    checks.push({ name: 'members cannot create public repos', ok: true })
  } else if (publicAllowed === true) {
    checks.push({
      name: 'members cannot create public repos',
      ok: false,
      fix: `Org -> Settings -> Member privileges -> Repository creation: uncheck Public (https://github.com/organizations/${org}/settings/member_privileges)`,
    })
  } else {
    checks.push({
      name: 'members cannot create public repos',
      ok: false,
      fix: `Could not read the org repo-creation policy (the PAT may lack admin:org read) - verify manually that members cannot create Public repos at https://github.com/organizations/${org}/settings/member_privileges`,
    })
  }

  // 3b. The configured e2e test buyer must be OUTSIDE the org (see testBuyerCheck). No-op when the
  // config has no e2e.testUsername (a neutral core config), so this never fires on a fresh clone.
  const testBuyer = await testBuyerCheck(api, org, config?.e2e?.testUsername)
  if (testBuyer) checks.push(testBuyer)

  // 4. Each configured team exists, and 5. has at least one repo attached (config names no repo, so
  // the rule is >= 1 attachment). Team members read (6) proves the PAT can manage membership.
  const teams = collectTeams(config)
  if (teams.length === 0) {
    checks.push({
      name: 'at least one team configured',
      ok: false,
      fix: 'Map at least one product to a team in productTeamMap (src/config/repoaccess.config.ts)',
    })
    return checks
  }

  let firstExistingTeam = null
  for (const team of teams) {
    const teamRes = await safeGet(
      api,
      `/orgs/${encodeURIComponent(org)}/teams/${encodeURIComponent(team)}`,
    )
    const teamOk = teamRes.status === 200
    checks.push({
      name: `team '${team}' exists`,
      ok: teamOk,
      ...(teamOk
        ? {}
        : {
            fix: `Create team '${team}' at https://github.com/orgs/${org}/new-team`,
          }),
    })
    if (!teamOk) continue
    if (!firstExistingTeam) firstExistingTeam = team

    // A grant = adding the buyer to the TEAM; the synthetic e2e verifies TEAM MEMBERSHIP, not repo
    // access. This check is ADVISORY (`warn`) in BOTH envs, and here is why: the worker PAT is minted
    // with repository access = Public repositories (the minimal option), so it cannot list a team's repos - a repo-less result is a
    // STRUCTURAL false-negative even when a repo IS attached. Escalating it to a hard error in
    // production wrongly blocked a live run. Repo attachment is confirmed MANUALLY in the setup walk
    // (required in production), not by this check.
    const reposRes = await safeGet(
      api,
      `/orgs/${encodeURIComponent(org)}/teams/${encodeURIComponent(team)}/repos`,
    )
    const repoOk = Array.isArray(reposRes.json) && reposRes.json.length >= 1
    const repoUrl = `https://github.com/orgs/${org}/teams/${team}/repositories`
    checks.push({
      name: `team '${team}' has a repo attached`,
      ok: repoOk,
      severity: 'warn',
      ...(repoOk
        ? {}
        : {
            fix: `The wizard cannot verify repo attachment with the worker PAT (its repository access is the minimal Public repositories option). Confirm manually that the private repo(s) are attached to the team at Read: ${repoUrl}`,
          }),
    })
  }

  // 6. Token capability: it can manage team membership. A benign read (GET team members) succeeding
  // implies the org Members permission the grant path needs.
  if (firstExistingTeam) {
    const membersRes = await safeGet(
      api,
      `/orgs/${encodeURIComponent(org)}/teams/${encodeURIComponent(firstExistingTeam)}/members`,
    )
    const capOk = membersRes.status === 200
    checks.push({
      name: 'PAT can manage team membership',
      ok: capOk,
      ...(capOk
        ? {}
        : {
            fix: 'Grant the fine-grained PAT org Members read/write so it can manage team membership (https://github.com/settings/tokens)',
          }),
    })
  }

  return checks
}

// Verify the human's GitHub dashboard setup via the API and report a fix per failed check. READ-ONLY
// (no mutations). Config + api + token are injectable seams so the check logic is fully mock-testable.
// ENV-AWARE (`env`: default sandbox/null; the driver passes 'production' for a production run):
// it selects the production config profile and reads the token from `.dev.vars.production`. The
// repo-attached check stays advisory in both envs (the worker PAT cannot verify it).
export async function githubVerify(opts = {}) {
  const cwd = opts.cwd ?? process.cwd()
  const env = opts.env ?? null

  let config = opts.config
  if (config === undefined) {
    config = await loadConfig(cwd, env)
    if (config === null) {
      return finalize(
        'github-verify',
        [
          {
            name: 'load src/config/repoaccess.config.ts',
            ok: false,
            fix: `Could not load src/config/repoaccess.config.ts - ensure it exists and Node is >= ${MIN_NODE_VERSION} (native .ts import)`,
          },
        ],
        'github ready',
      )
    }
  }

  let api = opts.api
  if (!api) {
    const token = opts.token ?? readToken(cwd, { env })
    if (!token) {
      return finalize(
        'github-verify',
        [
          {
            name: 'GITHUB_TOKEN present',
            ok: false,
            fix: `Set GITHUB_TOKEN in ${secretsFileFor(env)} (a fine-grained PAT with org Members read/write) - the wizard reads it directly; you never paste it to the agent`,
          },
        ],
        'github ready',
      )
    }
    api = createGithubApi(token, opts.fetch ?? fetch)
  }

  return finalize(
    'github-verify',
    await runGithubChecks(api, config, env),
    'github ready',
  )
}

// --- secrets-check (spec section 4: NAMES only, NEVER values) -----------------------------------

// Minimal, zero-dep JSONC parse: strip // and /* */ comments and trailing commas OUTSIDE strings,
// then JSON.parse. Enough for wrangler.jsonc (standard JSON + comments + trailing commas).
//
// TWO PASSES, AND THE ORDER IS THE WHOLE CORRECTNESS. A single pass has to decide "is this comma
// trailing?" by looking ahead at text it has not cleaned yet - so a comma followed by a COMMENT and
// then the bracket reads as "not trailing", the comma is kept, the comment is then removed, and what
// reaches JSON.parse is `["X",]`, which it rejects.
//
// That shape is not a curiosity, it is what this project's own templates produce. The wrangler
// template lists each adapter's secret COMMENTED OUT for the deployer to uncomment as they compose
// that adapter, so whichever entry they uncomment last is followed by a comma and then the remaining
// commented lines. Wrangler itself accepts that file and deploys from it; a wizard that could not
// read it would be refusing a file the deploy accepts, which is a lie on the seam between the two.
//
// So: strip comments first, then decide about commas on comment-free text. The contract is that for
// the JSONC shapes this project's templates produce, this agrees with wrangler.
//
// BOTH passes are string-aware, and that is the constraint the fix must not trade away: a `//` or a
// `/*` inside a JSON string is DATA (a URL is the everyday case), and a string containing `",` must
// not be read as a value ending followed by a comma.

/** Remove line and block comments. String contents pass through byte-for-byte. */
function stripJsoncComments(text) {
  let out = ''
  let inString = false
  let inLine = false
  let inBlock = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    const next = text[i + 1]
    if (inLine) {
      // Keep the newline: it is whitespace the next pass may need to scan across.
      if (ch === '\n') {
        inLine = false
        out += ch
      }
      continue
    }
    if (inBlock) {
      if (ch === '*' && next === '/') {
        inBlock = false
        i++
      }
      continue
    }
    if (inString) {
      out += ch
      if (ch === '\\') {
        // An escape consumes its next character whatever it is, so an escaped quote cannot end the
        // string early.
        out += next
        i++
      } else if (ch === '"') {
        inString = false
      }
      continue
    }
    if (ch === '"') {
      inString = true
      out += ch
      continue
    }
    if (ch === '/' && next === '/') {
      inLine = true
      i++
      continue
    }
    if (ch === '/' && next === '*') {
      inBlock = true
      i++
      continue
    }
    out += ch
  }
  return out
}

/** Drop commas whose next non-whitespace character closes the object or array. */
function dropTrailingCommas(text) {
  let out = ''
  let inString = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    const next = text[i + 1]
    if (inString) {
      out += ch
      if (ch === '\\') {
        out += next
        i++
      } else if (ch === '"') {
        inString = false
      }
      continue
    }
    if (ch === '"') {
      inString = true
      out += ch
      continue
    }
    if (ch === ',') {
      // Safe to look ahead now: comments are gone, so whatever follows the whitespace is real syntax.
      let j = i + 1
      while (j < text.length && /\s/.test(text[j])) j++
      if (text[j] === '}' || text[j] === ']') continue
    }
    out += ch
  }
  return out
}

export function parseJsonc(text) {
  return JSON.parse(dropTrailingCommas(stripJsoncComments(text)))
}

// Parse the whole wrangler.jsonc (comment/trailing-comma tolerant) or null if unreadable. The single
// reader behind readRequiredSecrets (secrets) and the kv-create / deploy reconciliation.
export function readWranglerConfig(cwd = process.cwd()) {
  const abs = join(cwd, 'wrangler.jsonc')
  if (!existsSync(abs)) return null
  try {
    return parseJsonc(readFileSync(abs, 'utf8'))
  } catch {
    return null
  }
}

// The canonical required-secret NAMES from wrangler.jsonc, per-env: base (sandbox) +
// production. Returns { base, production } or null if the config cannot be read.
export function readRequiredSecrets(cwd = process.cwd()) {
  const cfg = readWranglerConfig(cwd)
  if (!cfg) return null
  return {
    base: cfg?.secrets?.required ?? [],
    production: cfg?.env?.production?.secrets?.required ?? [],
  }
}

// Parse a .dev.vars file for KEY NAMES ONLY. The value (everything after the first `=`) is read but
// IMMEDIATELY discarded - it is never stored, returned, logged, or surfaced. Returns null if absent.
// This is the machine-enforced "the agent never sees your secrets": the SCRIPT touches the file, the
// agent only ever sees this names array. (Composes with the committed `deny Read(.dev.vars)`.)
export function readEnvNames(path) {
  if (!existsSync(path)) return null
  const names = []
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const name = line
      .slice(0, eq)
      .trim()
      .replace(/^export\s+/, '')
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) names.push(name)
    // NOTE: line.slice(eq + 1) (the VALUE) is deliberately never touched.
  }
  return names
}

// List the secret NAMES uploaded to the deployed production worker via `npx wrangler secret list` (names
// only - the API never returns values). Needs CF auth + a deployed worker; on any failure returns
// { ok: false } so the caller reports a fix instead of crashing.
function defaultListSecrets(cwd) {
  const res = runCommand(
    'npx',
    ['wrangler', 'secret', 'list', '--env', 'production'],
    { cwd },
  )
  if (!res.ok) return { ok: false }
  try {
    const parsed = JSON.parse(res.stdout)
    const names = Array.isArray(parsed)
      ? parsed.map((entry) => entry && entry.name).filter(Boolean)
      : []
    return { ok: true, names }
  } catch {
    return { ok: false }
  }
}

// Local file check: each required name is PRESENT as a key. Fixes name only, never a value. The
// missing-file fix describes the setup's own copy of the template rather than a raw `cp`: the copy lives
// inside the setup by design, and a raw shell command is both OS-specific and outside the `npm run`
// permission allowlist.
function localSecretChecks(fileName, required, readNames, env = null) {
  const names = readNames(fileName)
  if (names === null) {
    return [
      {
        name: `${fileName} present`,
        ok: false,
        fix: `The setup creates ${fileName} from ${fileName}.example when it runs - re-run npm run wizard:drive if it is missing, then fill in the secret values (the setup reads only the names)`,
      },
    ]
  }
  const present = new Set(names)
  return required.map((req) => ({
    name: `${req} in ${fileName}`,
    ok: present.has(req),
    ...(present.has(req)
      ? {}
      : {
          fix: `Add ${req}=... to ${fileName} (name only - the wizard never reads the value)`,
        }),
  }))
}

// Deployed-worker check: each production-required name is uploaded. Graceful on unauthed/not-deployed.
function deployedSecretChecks(required, listSecrets) {
  if (required.length === 0) return []
  const result = listSecrets()
  if (!result.ok) {
    return [
      {
        name: 'production secrets uploaded (npx wrangler secret list)',
        ok: false,
        fix: 'Could not list production secrets - this check needs Cloudflare auth + a deployed worker. Run `npx wrangler login`; the setup deploys the worker itself when you run npm run wizard:drive.',
      },
    ]
  }
  const uploaded = new Set(result.names ?? [])
  return required.map((req) => ({
    name: `${req} uploaded to the production worker`,
    ok: uploaded.has(req),
    ...(uploaded.has(req)
      ? {}
      : {
          fix: `Upload it: npx wrangler secret put ${req} --env production (you paste the value into wrangler, never to the agent)`,
        }),
  }))
}

// Verify secret NAMES are configured - NAMES ONLY, no secret VALUE ever read into the result. The
// check set is ENV-AWARE (opts.env, same source as github-verify / deploy): a sandbox run checks only
// `.dev.vars` (the base names), because the deployer fills only that file and no production worker
// exists yet; a production run checks `.dev.vars.production` locally AND that each name is uploaded to
// the deployed production worker (`npx wrangler secret list`). Running the prod-uploaded check in a sandbox
// run was the false-red the maintainer hit - it needs a deployed prod worker that a sandbox run has not
// created. With deploy now uploading via `--secrets-file`, the uploaded check is meaningful only after a
// prod deploy anyway. Seams (required / readNames / listSecrets) make every branch mock-testable.
export function secretsCheck(opts = {}) {
  const cwd = opts.cwd ?? process.cwd()
  const isProduction = opts.env === 'production'
  const required = opts.required ?? readRequiredSecrets(cwd)
  if (!required) {
    return finalize(
      'secrets-check',
      [
        {
          name: 'read wrangler.jsonc secrets.required',
          ok: false,
          fix: 'Could not read secrets.required from wrangler.jsonc - ensure the file exists and is valid',
        },
      ],
      'secret names present locally and on the deployed worker',
    )
  }
  const readNames =
    opts.readNames ?? ((fileName) => readEnvNames(join(cwd, fileName)))
  const listSecrets = opts.listSecrets ?? (() => defaultListSecrets(cwd))

  const checks = isProduction
    ? [
        ...localSecretChecks(
          '.dev.vars.production',
          required.production,
          readNames,
          'production',
        ),
        ...deployedSecretChecks(required.production, listSecrets),
      ]
    : localSecretChecks('.dev.vars', required.base, readNames)

  return finalize(
    'secrets-check',
    checks,
    isProduction
      ? 'secret names present in .dev.vars.production and uploaded to the production worker'
      : 'secret names present in .dev.vars (sandbox)',
  )
}

// --- mutating steps (spec section 3: idempotent / reconciliation-based, via runCommand) ---------

// Every mutating step wraps wrangler through this seam so tests inject a fake `run(args)` and drive
// each reconciliation branch with no real wrangler / network. Default spawns `npx wrangler <args>`.
function wranglerRunner(cwd) {
  return (args) => runCommand('npx', ['wrangler', ...args], { cwd })
}

// Secret-shaped tokens that must not survive into text a human reads or a state file keeps. Matched by
// known PREFIX, deliberately: this output is a DIAGNOSTIC, and a general high-entropy matcher would
// happily eat a resource id, an account id or an error code and turn a real diagnosis into a useless
// one. Over-redaction is the worse failure here, so the patterns stay narrow and are extended only when
// a provider introduces a new prefix.
//   whsec_      provider webhook signing secret
//   ghp_ gho_ ghs_ github_pat_   GitHub tokens, classic and fine-grained
//   Bearer <t>  an Authorization header echoed into output
//
// Only the `Bearer` pattern carries `i`, and the split is deliberate rather than an oversight: it
// matches an English SCHEME WORD that tools print however they like (`Bearer`, `bearer`, `BEARER`),
// whereas the others match literal token prefixes that the issuing provider defines in lower case. A
// blanket `i` there would widen each prefix to spellings no provider emits, for nothing.
//
// AND BECAUSE IT IS AN ENGLISH WORD, that pattern must be anchored by the SHAPE of what follows it,
// never by the word alone. "bearer token" is a phrase wrangler and the Cloudflare API both print, so an
// unbounded value turned `Bearer token is invalid or expired [code: 10001]` into
// `[redacted] is invalid or expired [code: 10001]` - the sentence that names the problem becoming the
// sentence that hides it. The `{16,}` bound is what tells a credential from a noun: real bearer tokens
// run 40 characters and up (Cloudflare 40, GitHub 40+), and nothing anyone issues is short enough to
// duck under it. The other two patterns need no such bound - their prefixes are not words.
const SECRET_PATTERNS = [
  /\b(?:whsec|ghp|gho|ghs)_[A-Za-z0-9_-]+/g,
  /\bgithub_pat_[A-Za-z0-9_-]+/g,
  /\bBearer\s+[A-Za-z0-9._-]{16,}/gi,
]

function redactSecrets(text) {
  let out = text
  for (const pattern of SECRET_PATTERNS)
    out = out.replace(pattern, '[redacted]')
  return out
}

// The real wrangler error to surface on a failed command: prefer stderr, fall back to stdout, and
// collapse whitespace to a single trimmed line (never a generic "run npx wrangler login" catch-all).
// Long output is bounded so the JSON fix stays readable. `login` genuinely appears in the stderr when
// that is the cause, so the deployer still sees it - just not as a false diagnosis of every failure.
//
// REDACTION RUNS BEFORE THE TRUNCATION, for two reasons, and NEITHER is "otherwise a readable prefix
// of the secret survives the cut". That was the reason first written here and it is false: every
// pattern above still matches its own truncated fragment (`github_pat_11ABCDE0` matches
// `github_pat_[A-Za-z0-9_-]+`), so a straddling token gets redacted in either order today.
//
//   1. It makes the guarantee independent of PATTERN SHAPE. That the current patterns match their own
//      fragments is an accident of this particular set, not something this function can lean on. A
//      prefix added later need not behave that way, and whoever adds it will not be thinking about the
//      400-char boundary. Redacting first means they never have to.
//   2. The budget gets spent on DIAGNOSIS rather than on secret bytes. Redact first and a 57-character
//      token costs 10 characters, leaving room for the words after it; slice first and those words are
//      cut off the end to make room for a secret that is about to be replaced anyway. That difference
//      is observable, and it is what the test pins.
export function wranglerError(res) {
  const raw = redactSecrets(
    (res?.stderr || res?.stdout || '').replace(/\s+/g, ' ').trim(),
  )
  if (!raw)
    return '(no output; run `npx wrangler login` if you are not authenticated)'
  return raw.length > 400 ? `${raw.slice(0, 400)}...` : raw
}

// The REQUIRED KV namespace title convention: `<worker>-ENTITLEMENTS` (top-level / default env) or
// `<worker>-<env>-ENTITLEMENTS` (named env, e.g. `repoaccess-core-production-ENTITLEMENTS`). This is a
// multi-worker-safety convention on a shared account, NOT cosmetic: two RepoAccess installs on one
// account must not collide on a bare `ENTITLEMENTS`. wrangler 4.107 does NOT auto-derive the
// `<worker>-` prefix (a fix4 misread: the bare title it saw came from the bugged wizard that had
// dropped the prefix, not from wrangler's default), so the wizard sets the full title EXPLICITLY as
// the create name. The BINDING stays `ENTITLEMENTS` (the code reads `env.ENTITLEMENTS`); only the
// title carries the convention. Worker name comes from `wrangler.jsonc` `name`.
export function kvTitle(workerName, env, binding) {
  return env ? `${workerName}-${env}-${binding}` : `${workerName}-${binding}`
}

// The id currently wired for a binding in wrangler.jsonc, for the given env (null = top-level).
function configKvId(config, env, binding) {
  const scope = env ? config?.env?.[env] : config
  const list = scope?.kv_namespaces ?? []
  return list.find((ns) => ns.binding === binding)?.id ?? null
}

// wrangler.jsonc ships placeholder ids a deployer must replace; treat those as "not set".
function isPlaceholderId(id) {
  return !id || /placeholder/i.test(id)
}

// kv-create - reconcile the ENTITLEMENTS KV namespace for ONE env (ENV-AWARE, same opts.env the
// other steps use): a sandbox / top-level run (env null) reconciles ONLY the sandbox
// `<worker>-ENTITLEMENTS` namespace; a production run (env 'production') reconciles
// ONLY `<worker>-production-ENTITLEMENTS`. Provisioning both unconditionally created a production
// namespace (and wired a prod id) on a sandbox run - the deploy precondition already checks only the
// target env's id, so a per-env reconcile stays consistent. Read current state (`kv namespace list`,
// account-wide), create only what is missing for the target env, then report whether wrangler.jsonc
// carries the resolved id. Idempotent: a second run finds the namespace and is a no-op (never a dup).
export function kvCreate(opts = {}) {
  const cwd = opts.cwd ?? process.cwd()
  const config = opts.config ?? readWranglerConfig(cwd)
  if (!config) {
    return finalize(
      'kv-create',
      [
        {
          name: 'read wrangler.jsonc',
          ok: false,
          fix: 'Could not read wrangler.jsonc - ensure the file exists and is valid',
        },
      ],
      'KV namespaces provisioned and wired',
    )
  }
  const run = opts.run ?? wranglerRunner(cwd)
  const binding = 'ENTITLEMENTS'
  const workerName = config.name ?? 'worker'

  // Read current state once (list is account-wide, not env-scoped). On failure surface the REAL
  // wrangler stderr instead of masking every failure as "run npx wrangler login".
  const listRes = run(['kv', 'namespace', 'list'])
  let namespaces = null
  if (listRes.ok) {
    try {
      const parsed = JSON.parse(listRes.stdout)
      namespaces = Array.isArray(parsed) ? parsed : []
    } catch {
      namespaces = null
    }
  }
  if (namespaces === null) {
    return finalize(
      'kv-create',
      [
        {
          name: 'list KV namespaces (wrangler)',
          ok: false,
          fix: `Could not list KV namespaces (this step needs Cloudflare auth). wrangler said: ${wranglerError(listRes)}`,
        },
      ],
      'KV namespaces provisioned and wired',
    )
  }

  // For the safety net: a compact view of every namespace wrangler actually reports (title=id), so a
  // reconcile miss can hand the human the REAL titles/ids to wire rather than blindly re-creating.
  const present = namespaces
    .map((ns) => `${ns.title ?? '?'}=${ns.id ?? '?'}`)
    .join(', ')

  // ENV-AWARE: reconcile ONLY the target env's namespace (sandbox for env null, production for
  // 'production'), never both - a sandbox run must not provision a production ENTITLEMENTS.
  const env = opts.env ?? null
  const targets =
    env === 'production'
      ? [{ env: 'production', label: 'production' }]
      : [{ env: null, label: 'sandbox' }]

  const checks = []
  for (const target of targets) {
    const title = kvTitle(workerName, target.env, binding)
    // The bare title (no worker prefix) the bugged wizard used to produce - present in the account only
    // if an old run created one. We flag it, never silently accept/wire it.
    const bareTitle = target.env ? `${target.env}-${binding}` : binding
    // Resolve the namespace two ways: by the REQUIRED convention title, OR by the id already wired in
    // wrangler.jsonc matching a listed id (covers a maintainer-created namespace with a custom title).
    const wiredId = configKvId(config, target.env, binding)
    const byTitle = namespaces.find((ns) => ns.title === title)?.id ?? null
    const byId =
      !isPlaceholderId(wiredId) && namespaces.some((ns) => ns.id === wiredId)
        ? wiredId
        : null
    let id = byTitle ?? byId

    // Safety net: a bare `ENTITLEMENTS` / `<env>-ENTITLEMENTS` (no worker prefix) means an old bugged
    // run created an off-convention namespace. Flag it (advisory) so the human recreates/renames to the
    // convention rather than leaving a collision-prone bare title on the account.
    const bareNs = namespaces.find((ns) => ns.title === bareTitle)
    if (bareNs) {
      checks.push({
        name: `bare '${bareTitle}' namespace present - not the convention (${target.label})`,
        ok: false,
        severity: 'warn',
        fix: `A bare '${bareTitle}' KV namespace (id ${bareNs.id}) exists with no worker prefix - an old off-convention artifact. Recreate/rename it to the convention title '${title}' (multi-worker safety), then wire that id.`,
      })
    }

    if (id) {
      checks.push({
        name: `ENTITLEMENTS namespace exists (${target.label})`,
        ok: true,
      })
    } else {
      // Set the convention title EXPLICITLY as the create name (wrangler 4.107 does not add the
      // `<worker>-` prefix itself). No `--env` on create: the title already encodes the env.
      const createRes = run(['kv', 'namespace', 'create', title])
      const match = createRes.ok && createRes.stdout.match(/[0-9a-f]{32}/i)
      if (!match) {
        // Safety net: could not create AND could not reconcile. Surface the real wrangler stderr and
        // the ACTUAL namespaces present so the human can wire the right id (a bare `ENTITLEMENTS` /
        // `${target.env}-ENTITLEMENTS` may already exist under a title our match missed).
        checks.push({
          name: `create ENTITLEMENTS namespace (${target.label})`,
          ok: false,
          fix: `Could not create the KV namespace (expected title '${title}'). wrangler said: ${wranglerError(createRes)}. Namespaces already present: [${present || 'none'}] - if one is the right ENTITLEMENTS namespace, wire its id into wrangler.jsonc (${target.label} env) instead.`,
        })
        continue
      }
      id = match[0]
      checks.push({
        name: `ENTITLEMENTS namespace created (${target.label})`,
        ok: true,
      })
    }

    // Reconcile wrangler.jsonc. Report-only (do NOT rewrite the JSONC - it would strip comments +
    // trailing commas). The maintainer pastes the id; a re-run then confirms it.
    const wired = wiredId === id
    checks.push({
      name: `wrangler.jsonc ENTITLEMENTS id set (${target.label})`,
      ok: wired,
      ...(wired
        ? {}
        : {
            fix: `Set the ENTITLEMENTS kv_namespaces id to ${id} in wrangler.jsonc (${target.label} env), then re-run`,
          }),
    })
  }

  return finalize('kv-create', checks, 'KV namespaces provisioned and wired')
}

// --- grant-record (read-only REMOTE ENTITLEMENTS audit; surfaces each grant's transaction_id) ---

// Parse a `npx wrangler kv key list` name array into the grant records. The grant key format is
// `grant:<adapter>:<transaction_id>` (the src writer, src/kv-keys.ts `grantKey`); the transaction_id is
// the `pi_...` for Stripe. Kept in sync with that builder. Non-grant keys (claim:, claim_txn:, fail:,
// session_txn:, claim_submitted:) are ignored. Splits at the FIRST colon after the prefix so a
// transaction_id that itself contains a colon is preserved whole.
function parseGrantKeys(names) {
  const prefix = 'grant:'
  const grants = []
  for (const name of names) {
    if (typeof name !== 'string' || !name.startsWith(prefix)) continue
    const rest = name.slice(prefix.length)
    const colon = rest.indexOf(':')
    if (colon <= 0) continue
    const adapter = rest.slice(0, colon)
    const transactionId = rest.slice(colon + 1)
    if (!adapter || !transactionId) continue
    grants.push({ adapter, transactionId })
  }
  return grants
}

// grant-record - after a REAL test purchase, list the grant records in the REMOTE ENTITLEMENTS
// store and surface each grant's transaction_id (the `pi_...` for Stripe) so the orchestrator can read
// the id it needs for the refund test. READ-ONLY (a `kv key list`, no writes). ENV-AWARE on opts.env
// (same source as the other steps): a sandbox run reads the top-level binding; a production run forwards
// `--env production`. `--remote` is REQUIRED and baked in: wrangler defaults to the LOCAL store, but the
// deployed worker writes REMOTE, so a local read would always be empty (the local-store trap). Runs
// through the `wranglerRunner(cwd)` seam so it stays prompt-free and mock-testable. Attaches the parsed
// grants on `result.grants` the same way resolve-url attaches `result.resolved`. Networked + needs a
// deployed worker, so it stays OUT of the offline `doctor`.
export function grantRecord(opts = {}) {
  const cwd = opts.cwd ?? process.cwd()
  const env = opts.env ?? null
  const label = env ?? 'sandbox'
  const run = opts.run ?? wranglerRunner(cwd)

  const res = run([
    'kv',
    'key',
    'list',
    '--binding',
    'ENTITLEMENTS',
    '--remote',
    ...(env ? ['--env', env] : []),
  ])
  if (!res.ok) {
    return finalize(
      'grant-record',
      [
        {
          name: `list REMOTE ENTITLEMENTS keys (${label})`,
          ok: false,
          fix: `Could not list the REMOTE ENTITLEMENTS keys (this step needs Cloudflare auth + a deployed worker). wrangler said: ${wranglerError(res)}`,
        },
      ],
      'grant records read from the REMOTE ENTITLEMENTS store',
    )
  }

  let names = null
  try {
    const parsed = JSON.parse(res.stdout)
    names = Array.isArray(parsed)
      ? parsed.map((entry) => entry && entry.name).filter(Boolean)
      : null
  } catch {
    names = null
  }
  if (names === null) {
    return finalize(
      'grant-record',
      [
        {
          name: `parse REMOTE ENTITLEMENTS key list (${label})`,
          ok: false,
          fix: `Could not parse the KV key list as a JSON array. wrangler said: ${wranglerError(res)}`,
        },
      ],
      'grant records read from the REMOTE ENTITLEMENTS store',
    )
  }

  const grants = parseGrantKeys(names)
  const checks = []
  if (grants.length === 0) {
    checks.push({
      name: `grant records present (${label})`,
      ok: false,
      fix: 'No grant records in the REMOTE ENTITLEMENTS store - complete the real test purchase first; this reads REMOTE, so it is not the local-store trap.',
    })
  } else {
    checks.push({
      name: `grant records present (${label}): ${grants.length}`,
      ok: true,
    })
    // Surface each transaction_id in its own check name so the orchestrator can read the `pi_...`.
    for (const grant of grants) {
      checks.push({
        name: `grant ${grant.adapter} transaction_id: ${grant.transactionId}`,
        ok: true,
      })
    }
  }

  const result = finalize(
    'grant-record',
    checks,
    'grant records read from the REMOTE ENTITLEMENTS store',
  )
  result.grants = grants
  return result
}

// Pull the deployed worker URL from `npx wrangler deploy` output (the workers.dev URL it prints).
export function extractWorkerUrl(text) {
  const match = text.match(/https:\/\/[^\s]+\.workers\.dev/)
  return match ? match[0] : null
}

// Do two URLs point at the same worker host? Compares the hostname only (scheme/path/trailing-slash
// noise ignored), case-insensitively. Used for the advisory post-deploy URL-match warning.
export function sameWorkerHost(a, b) {
  const host = (u) => {
    try {
      return new URL(u).hostname.toLowerCase()
    } catch {
      return null
    }
  }
  const ha = host(a)
  const hb = host(b)
  return ha !== null && ha === hb
}

// A realistic browser User-Agent for the wizard's OWN probes - the /health check and the synthetic e2e
// POST. It is here so those two checks are not refused by a zone rule aimed at non-browser clients: such
// a rule answers 403 to a bare fetch (measured on one zone: a browser UA got 200, a bare fetch got 403),
// which would halt a setup on a worker that is live and healthy. The wizard's job is to get a deployer to
// a working deployment on whatever zone they have, and a rule it cannot act on - and that may not even
// affect the provider, whose caller Cloudflare may class as a verified bot - is not a reason to stop.
export const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

// Default health probe: GET <url>/health (with a browser UA, see BROWSER_UA) and read the JSON body.
//
// `status: 0` is NOT something the worker returned - it is the marker for "the request threw before any
// HTTP response existed", so nothing left this machine and Cloudflare was never asked. Keeping that
// apart from a real status is the whole diagnosis on a brand-new address: a lookup that never resolved
// and a worker that answered 403 are indistinguishable once both are flattened to `ok: false`, and only
// one of the two is fixed by waiting. `error` carries what threw, because Node's fetch reports a bare
// "fetch failed" and puts the half worth reading (`getaddrinfo ENOTFOUND ...`) in `cause`.
export async function defaultFetchHealth(url, doFetch = fetch) {
  try {
    const res = await doFetch(`${url.replace(/\/$/, '')}/health`, {
      headers: { 'user-agent': BROWSER_UA },
    })
    let body = null
    try {
      body = await res.json()
    } catch {
      body = null
    }
    return { ok: res.ok, status: res.status, body }
  } catch (err) {
    const message = err?.message ?? String(err)
    const cause = err?.cause?.message
    return {
      ok: false,
      status: 0,
      body: null,
      error: cause ? `${message}: ${cause}` : message,
    }
  }
}

// The failures that mean NOT YET. Two statuses, ONE phenomenon - a deploy that has not arrived at this
// address - which is why they share a budget instead of each getting a number of its own.
//
// `status: 0` is the earlier stage: nothing left the deployer's machine (see defaultFetchHealth), so the
// hostname itself does not resolve. `404` is the later stage, and it is an answer from Cloudflare's EDGE
// rather than from a worker: under an account subdomain that already exists, `*.<account>.workers.dev`
// resolves immediately (wildcard DNS), so the name is reachable for the whole window between wrangler
// returning and the route being bound - and an unbound hostname there is answered 404 by the edge. That
// reconciles the live symptom exactly: the probe reported 404 while the worker's own log held no entry
// for it, because the request never reached a worker to be logged.
//
// Measured, not assumed: a name never deployed under an existing account subdomain answers HTTP 404 with
// an edge HTML error page, while the same name under a subdomain that does not exist throws ENOTFOUND.
//
// The cost of folding 404 in is bounded and worth naming: a URL that points at some OTHER worker which
// really is serving would answer its own 404, and this waits out the long budget before saying so. That
// buys a few tens of seconds and still reports honestly; the reverse mistake - giving up in ~16s on a
// worker that was merely propagating - is the one a live run actually made.
const isPropagating = (health) => health.status === 0 || health.status === 404

// Retry a health probe with backoff, on TWO budgets, because the two ways it fails are different
// problems. A custom-domain (production) deploy can lag while DNS + the edge certificate provision, so
// a single immediate probe would spuriously report a healthy worker as down. The window is unpredictable
// (a real run stayed unresolved on the deployer's own box for ~30 minutes while resolving fine
// elsewhere), so we never promise a propagation time - we probe slowly and few times, then hand off to a
// browser check. Sandbox (workers.dev) needs no DNS/cert provisioning but is not answering the instant
// wrangler returns, so it gets its own budget rather than a single immediate shot.
//
// THE TWO BUDGETS. A not-yet failure (isPropagating above) is fixed by waiting and by nothing else, so
// that branch gets the longer budget. Any OTHER real HTTP status means Cloudflare answered about a worker
// that IS serving, and such an answer does not change on the next attempt - a 403 from bot filtering
// stays a 403, a 200 with the wrong body stays wrong - so that branch keeps the short one. The budget is
// read off the LAST result, so a run whose address comes up mid-retry drops onto the short budget from
// that attempt on. Seams (attempts / propagatingAttempts / sleep) make the backoff mock-testable with no
// real waiting.
async function healthWithRetry(
  fetchHealth,
  url,
  { attempts, propagatingAttempts, sleep },
) {
  let health = { ok: false, status: 0, body: null }
  const ceiling = Math.max(attempts, propagatingAttempts)
  for (let i = 0; i < ceiling; i++) {
    health = await fetchHealth(url)
    if (health.ok && health.body?.status === 'ok') return health
    const budget = isPropagating(health) ? propagatingAttempts : attempts
    if (i + 1 >= budget) return health
    await sleep(Math.min(3000 * (i + 1), 15000))
  }
  return health
}

// What the probe actually SAW, in the check's own words, in FOUR cases - because there are four, and
// collapsing any two of them loses the action they call for. Without this every failure read the same: a
// lookup that never left the deployer's machine and a status the worker really returned both arrived as
// an anonymous "could not confirm", and the two call for opposite actions - wait, versus go and look at
// what answered. A 404 is the third: Cloudflare answered, so it is not the first case, but it answered
// ABOUT AN ADDRESS NO WORKER IS BOUND TO YET, so it is not the second either - the action is to wait,
// and saying "answered HTTP 404" without saying whose 404 it is reads as a wrong route.
//
// A 403 is the fourth, and it is the one that costs money when it is anonymous. Cloudflare answered but
// the worker did not: something in FRONT of it refused the request, which on a zone with a user-agent or
// bot-score rule is the same refusal the payment provider's webhook may meet - that is exactly what
// happened on 2026-08-23. The wizard's own probes wear a browser UA (see BROWSER_UA above) so they are
// not stopped by such a rule, so this branch fires on a 403 that arrives for some OTHER reason - and when
// one does, waiting never fixes it, so the message has to name the rule and where to read it, and it has
// to be honest about what one probe from one machine can see.
export function healthEvidence(health, url) {
  if (!health || health.status === 0) {
    const detail = health?.error ? ` (${health.error})` : ''
    return `The check never reached Cloudflare: the request failed on this machine before any HTTP response existed${detail}, which on a brand-new address usually means the name has not finished propagating.`
  }
  if (health.status === 404) {
    return `${url}/health answered HTTP 404, which on a just-deployed address is Cloudflare's edge saying no worker is bound to that hostname YET - the request never reached a worker at all, so this reads as "not there yet", not as a wrong route.`
  }
  if (health.status === 403) {
    return `${url}/health answered HTTP 403. Cloudflare answered, but your worker did not - something in front of it refused the request. That is almost always a security rule on this zone that filters by user agent or bot score, or Bot Fight Mode. This probe goes out looking like a browser, so a rule strict enough to refuse it will refuse your payment provider's webhook too: that caller does not look like a browser, and some providers send no user-agent header at all. A rule that refused this probe will refuse your sales. What this probe can and cannot see: it wears a browser user agent, so it never sees a rule that refuses only non-browser callers - a clean check is not evidence that your zone lets your sales in - and it runs from THIS machine, so it cannot see a rule that filters by ASN or country either, and a provider delivering from a datacenter can still be blocked while this check passes. To find the rule, open the Cloudflare dashboard, go to Domains, select this domain, then Security -> Analytics and the Events tab: that page names the rule that blocked it.`
  }
  if (health.ok) {
    return `${url}/health answered HTTP ${health.status}, but its body did not say {status:'ok'}.`
  }
  return `${url}/health answered HTTP ${health.status}.`
}

// The /health probe as ONE check: announce the pre-probe pause, wait, retry on the budget the failures
// call for, then report what happened.
//
// A production (custom-domain) deploy provisions DNS + the edge certificate AFTER wrangler returns, so
// the worker is live well before /health can answer. WAIT before the first probe, then retry slowly and
// few times. The pause is correctness, not politeness: an eager lookup of a not-yet-existing name gets
// cached as a NEGATIVE answer by the deployer's OWN resolver, and each retry re-confirms it - so an
// impatient prober poisons the very machine it is trying to help. On continued failure the message names
// that negative-cache symptom and the outside-the-cache check, NEVER a WAF / bot / zone-reconfiguration
// diagnosis. That rule is about the NOT-YET failures it was written for - `status: 0` and `404`, where a
// failed automated probe is a local-DNS artifact rather than a reason to touch the Cloudflare zone. A 403
// is the documented exception: Cloudflare ANSWERED, so it is not a local artifact, and healthEvidence
// names the zone rule out loud because that is the actual cause. Seams (healthAttempts /
// propagatingAttempts / preProbeDelay / sleep / notify) mock the wait with no real waiting.
//
// Sandbox (workers.dev) needs no DNS or certificate provisioning, but the deploy is still not answering
// the instant wrangler returns: propagation to the edge takes a moment. A 0ms/1-attempt probe therefore
// often reads a miss on a worker that is fine, and the AGENT then improvises a retry - off the documented
// path, which is the failure this script exists to prevent. A short pause plus a retry budget makes the
// FIRST probe usually succeed and keeps the retry inside the SCRIPT, where it is owned and testable.
//
// WHY SANDBOX ALONE GETS A LONGER NOT-YET BUDGET. Its old window was ~16s (7s pause, then 3s and 6s
// between three attempts), and a live run gave up inside it on a freshly created workers.dev address
// that had simply not propagated - the deployer's machine never reached Cloudflare at all. Six not-yet
// attempts stretch the sleeps to 3+6+9+12+15s, so the window is ~52s: about triple, still under a
// minute, and the same order as the 45s pause the very next screen already takes for Workflows to
// register. Past a minute the returns fall off - a name that has not come up by then is better answered
// by the deployer's own browser, which is exactly what the recovery hands them. A SECOND live run then
// spent that budget on the wrong branch: it got a 404 from the edge (the address resolved, the route was
// not bound yet), which is not `status: 0`, so it took the SHORT budget and gave up in ~16s again. The
// number was right and the branch was wrong; 404 now shares this budget rather than getting one of its
// own, because it is the same wait for the same deploy to arrive - a distinct number would be claiming a
// distinction the failure does not have. Production keeps ONE budget on purpose: its 30s pause plus five
// attempts is already the slow-and-few probing the negative-cache hazard above argues for, and its
// recovery names the symptom, the outside-the-cache lookup and the flush, so more probes there would work
// against the reason the pause exists. Both of its budgets are 5, so folding 404 in changes nothing there
// - which is the point: the fix lands where the failure was, and production's reasoning is untouched.
async function healthCheck(url, opts = {}) {
  const env = opts.env ?? null
  const label = env ?? 'sandbox'
  const isCustomDomain = env === 'production'
  const fetchHealth = opts.fetchHealth ?? defaultFetchHealth
  const healthAttempts = opts.healthAttempts ?? (isCustomDomain ? 5 : 3)
  const propagatingAttempts =
    opts.propagatingAttempts ?? (isCustomDomain ? 5 : 6)
  const preProbeDelay = opts.preProbeDelay ?? (isCustomDomain ? 30000 : 7000)
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  // Human-facing notice channel: stderr, so the single JSON result object on stdout stays clean.
  const notify = opts.notify ?? ((msg) => process.stderr.write(`${msg}\n`))
  if (preProbeDelay > 0) {
    notify(
      isCustomDomain
        ? 'Waiting ~30s before the first health check so DNS and the edge certificate can provision for the custom domain. This pause is deliberate, not a hang: probing a brand-new name too early can leave a stale "does not exist" answer in your local DNS cache.'
        : 'Waiting ~7s before the first health check so the deploy can propagate to the edge. This pause is deliberate, not a hang - probing the instant wrangler returns often reads a miss on a worker that is fine.',
    )
    await sleep(preProbeDelay)
  }
  const health = await healthWithRetry(fetchHealth, url, {
    attempts: healthAttempts,
    propagatingAttempts,
    sleep,
  })
  const healthOk = health.ok && health.body?.status === 'ok'
  const healthHost = url.replace(/^https?:\/\//, '').replace(/\/.*$/, '')
  const evidence = healthEvidence(health, url)
  // A 403 gets the evidence and NOTHING ELSE, in either env. Both recoveries below tell the deployer to
  // wait out a propagation delay and then confirm in their own BROWSER - and against a zone rule that
  // filters by user agent, the browser is precisely the caller that gets through. Appending them to a 403
  // would contradict the evidence line ("never a reason to touch your Cloudflare zone" against "go and
  // find the rule on this zone") and would green-light a deployment that can never receive a webhook.
  const blockedInFront = health.status === 403
  return {
    name: `GET /health -> {status:'ok'} (${label})`,
    ok: healthOk,
    ...(healthOk
      ? {}
      : {
          fix: blockedInFront
            ? `${evidence} Waiting does not clear a firewall rule, so this check keeps failing until the rule changes.`
            : isCustomDomain
              ? `${evidence} That does NOT mean the deploy failed. On a brand-new custom domain, a browser showing NXDOMAIN / ERR_NAME_NOT_RESOLVED is your OWN resolver's cached "this name does not exist" answer, not a down worker. Confirm from outside your cache: nslookup ${healthHost} 1.1.1.1 - if it returns an address, the worker is live and only your local DNS is stale. Flush it (ipconfig /flushdns on Windows, sudo dscacheutil -flushcache on macOS) or wait out the negative TTL, then open ${url}/health in your own browser, deployer, and continue once it shows {status:'ok'}. Never a reason to touch your Cloudflare zone, WAF, or bot settings.`
              : `${evidence} A fresh deploy can take a short while to answer everywhere, so this does not always mean the deploy failed - deployer, open ${url}/health in your own browser and continue once it shows {status:'ok'}. If it does not answer at all, check the deploy logs.`,
        }),
  }
}

/**
 * The /health half of `deploy`, on its own.
 *
 * `deploy` calls it, and so does a RETRY over a deploy whose wrangler half already succeeded: that run
 * has a published worker to look at, so the honest re-attempt is to probe it again rather than publish a
 * second version of it. Sharing one function is the point - a second implementation would be free to
 * drift from the one the deployer's first probe walked, and then the retry would answer a different
 * question from the one that failed.
 *
 * The pre-probe pause is an ARRIVAL pause, so a caller re-probing off a recovery passes
 * `preProbeDelay: 0`: that deployer has already spent their own minutes reading the recovery and
 * checking in a browser.
 */
export async function deployHealth(opts = {}) {
  const env = opts.env ?? null
  const label = env ?? 'sandbox'
  const url = opts.url
  const nextOk = `${label} worker answers /health`
  if (!url) {
    return finalize(
      'deploy-health',
      [
        {
          name: `GET /health -> {status:'ok'} (${label})`,
          ok: false,
          fix: 'There is no deployed worker URL to check yet - the deploy has to run first.',
        },
      ],
      nextOk,
    )
  }
  return finalize('deploy-health', [await healthCheck(url, opts)], nextOk)
}

// deploy - deploy the worker for an env (default sandbox; opts.env='production' for live), then
// GET /health and fold {status:'ok'} into the checks. Precondition (KV id set) is checked FIRST so a
// missing id reports a fix instead of half-deploying. Redeploy is idempotent.
export async function deploy(opts = {}) {
  const cwd = opts.cwd ?? process.cwd()
  const env = opts.env ?? null
  const label = env ?? 'sandbox'
  const config = opts.config ?? readWranglerConfig(cwd)
  if (!config) {
    return finalize(
      'deploy',
      [
        {
          name: 'read wrangler.jsonc',
          ok: false,
          fix: 'Could not read wrangler.jsonc - ensure the file exists and is valid',
        },
      ],
      `deployed to ${label} and healthy`,
    )
  }
  const run = opts.run ?? wranglerRunner(cwd)
  const fetchHealth = opts.fetchHealth ?? defaultFetchHealth

  // Precondition: the ENTITLEMENTS id must be real (not a placeholder) before we deploy.
  const kvId = configKvId(config, env, 'ENTITLEMENTS')
  if (isPlaceholderId(kvId)) {
    return finalize(
      'deploy',
      [
        {
          name: `ENTITLEMENTS KV id configured (${label})`,
          ok: false,
          fix: `The setup creates the ENTITLEMENTS namespace and writes its id into wrangler.jsonc (${label}) before deploying - re-run npm run wizard:drive if the id is still a placeholder`,
        },
      ],
      `deployed to ${label} and healthy`,
    )
  }

  const checks = [
    { name: `ENTITLEMENTS KV id configured (${label})`, ok: true },
  ]

  // Restore the proven deploy command (an earlier rework dropped both flags, causing the 10057
  // service-inherit error + the secret-bootstrap deadlock). `--secrets-file` uploads the required
  // secrets IN the deploy; the top-level env is targeted EXPLICITLY with `--env=` (empty) so wrangler
  // does not fall through to a named env. Matches the maintainer's known-good manual command.
  //   sandbox:    npx wrangler deploy --env="" --secrets-file .dev.vars
  //   production: npx wrangler deploy --env production --secrets-file .dev.vars.production
  const deployArgs = env
    ? ['deploy', '--env', env, '--secrets-file', '.dev.vars.production']
    : ['deploy', '--env=', '--secrets-file', '.dev.vars']
  const deployRes = run(deployArgs)
  if (!deployRes.ok) {
    checks.push({
      name: `npx wrangler deploy (${label})`,
      ok: false,
      fix: `npx wrangler deploy failed. wrangler said: ${wranglerError(deployRes)} (confirm the secrets in ${secretsFileFor(env)} are set)`,
    })
    return finalize('deploy', checks, `deployed to ${label} and healthy`)
  }

  // The already-known resolved base for this env: --expect-url, else the custom_domain route wired in
  // wrangler.jsonc for THIS env (turned into an https:// base). Used as the URL-match target below AND as
  // the health-check fallback next. `config` here is wrangler.jsonc, which has NO e2e block (the e2e
  // config lives in the TS config), so the only base wrangler.jsonc can supply is the wired route. A
  // custom-domain production deploy prints a route, not a .workers.dev URL, so extractWorkerUrl returns
  // null and /health resolves its base from that route. Sandbox prints a .workers.dev URL extractWorkerUrl
  // matches, and its top-level config has no custom_domain route, so this fallback is never consulted there.
  const customDomain = customDomainPattern(config, env)
  const expectedBase =
    opts.expectBase ?? (customDomain ? `https://${customDomain}` : null)

  // `npx wrangler deploy` prints a workers.dev URL for a default deploy, but a custom-domain (production)
  // deploy prints a ROUTE, not a `.workers.dev` URL, so extractWorkerUrl returns null. Fall back to the
  // resolved custom domain we already know for this env and health-check THAT, instead of giving up.
  let url = extractWorkerUrl(deployRes.stdout)
  if (!url) {
    if (expectedBase) {
      url = expectedBase
      checks.push({
        name: `deployed (${label}); no workers.dev URL in output, using the wired custom domain: ${url}`,
        ok: true,
      })
    } else {
      checks.push({
        name: `deployed (${label})`,
        ok: false,
        fix: 'Deploy succeeded but the worker URL could not be parsed from wrangler output and no custom domain is wired - GET /health manually',
      })
      return finalize('deploy', checks, `deployed to ${label} and healthy`)
    }
  } else {
    checks.push({ name: `deployed (${label}): ${url}`, ok: true })
  }

  // Post-deploy URL match: if the wizard resolved a base up front (for the Stripe webhook), compare the
  // ACTUAL deployed URL to it and WARN (advisory, never blocks) on mismatch - the seller edits the
  // webhook URL in ~10s. Expected base (computed above) comes from --expect-url or the custom_domain
  // route in wrangler.jsonc for this env.
  if (expectedBase) {
    const matches = sameWorkerHost(url, expectedBase)
    checks.push({
      name: `deployed URL matches the resolved base (${label})`,
      ok: matches,
      severity: 'warn',
      ...(matches
        ? {}
        : {
            fix: `Deployed at ${url} but the Stripe webhook was built for ${expectedBase} - update the webhook endpoint URL to the deployed host (a ~10s fix).`,
          }),
    })
  }

  // The probe, its pause and its retry budgets all live in `healthCheck` above, so a caller that already
  // has a published worker can re-run exactly this check without re-running the deploy around it.
  checks.push(await healthCheck(url, { ...opts, env, fetchHealth }))

  // `url` rides out with the result: it is the one thing a caller needs to re-probe this deploy instead
  // of repeating it, and it exists only once the wrangler half has really succeeded.
  return {
    ...finalize('deploy', checks, `deployed to ${label} and healthy`),
    url,
  }
}

// --- resolve-url (env-aware predictable worker URL, script-computable parts only) ---------------

// The interactive asks (subdomain / prod domain) live in the orchestrator; this step computes what it
// can non-interactively and FLAGS what it needs. A resolved base lets the Stripe webhook be created
// BEFORE the single deploy - which is what collapses the old double-deploy into one.

// RFC-1123-ish hostname check: dot-separated labels of letters/digits/hyphen (no leading/trailing
// hyphen), at least two labels (a real domain). Guards a user-supplied prod domain before we build a
// webhook URL from it. Rejects schemes, paths, ports, and empty input.
export function isValidHostname(host) {
  if (typeof host !== 'string' || host.length === 0 || host.length > 253) {
    return false
  }
  return /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i.test(
    host,
  )
}

// A random hex secret_path for the webhook route tail (`/wh/stripe/<secret_path>`). For HMAC adapters
// this is OBSCURITY ONLY: the worker never validates it (the route reads the segment but only the
// api_callback path compares it - the HMAC signature is the gate; see src/create-worker.ts). So any
// value works and it does NOT go in secrets.required; it is only a memory aid. Injectable rand for
// deterministic tests; defaults to 16 random bytes = 32 hex chars (matches the old wizard's
// `crypto.randomBytes(16).toString('hex')`).
export function generateSecretPath(rand = randomBytes) {
  return rand(16).toString('hex')
}

// The custom-domain route pattern wrangler.jsonc declares for an env, or null when absent/placeholder.
// PRODUCTION reads `routes[]` where `custom_domain: true`. Core ships NO such route today, so this
// normally returns null and the prod path asks the user for the domain.
export function customDomainPattern(config, env) {
  const scope = env ? config?.env?.[env] : config
  const routes = scope?.routes ?? []
  for (const r of routes) {
    if (r && r.custom_domain === true && typeof r.pattern === 'string') {
      // Only obvious placeholder markers - NOT a bare "example", which appears in legitimate
      // reserved-example domains a deployer might genuinely use.
      if (/replace|placeholder|your-domain|__|[<>]/i.test(r.pattern))
        return null
      return r.pattern
    }
  }
  return null
}

// Slugify a name into something that could legally be a workers.dev subdomain: lowercase, every run of
// non-alphanumeric chars -> a single hyphen, leading/trailing hyphens trimmed. It makes a candidate
// LEGAL, never CORRECT - every caller below feeds the result to an ask the deployer confirms.
export function slugifySubdomain(name) {
  if (typeof name !== 'string') return null
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || null
}

// Parse `wrangler whoami` output for the account { name, id }. The table row carries a 32-hex Account
// ID; the other non-empty cell on that row is the Account Name. Returns null if not found. Never reads
// or prints any token - whoami shows account identity + token SCOPES, not the token value.
export function parseWhoamiAccount(stdout) {
  if (typeof stdout !== 'string') return null
  for (const line of stdout.split(/\r?\n/)) {
    if (!/[│|]/.test(line)) continue
    const cells = line
      .split(/[│|]/)
      .map((c) => c.trim())
      .filter(Boolean)
    const id = cells.find((c) => /^[0-9a-f]{32}$/i.test(c))
    if (!id) continue
    const name = cells.find((c) => c !== id && !/^Account (Name|ID)$/i.test(c))
    if (name) return { name, id }
  }
  return null
}

// The login email `wrangler whoami` names, reduced to its LOCAL PART (everything before the `@`).
// Anchored on wrangler's own sentence rather than scanning for any address: an email in a warning or an
// example line would otherwise be read as the deployer's.
export function whoamiEmailLocalPart(stdout) {
  if (typeof stdout !== 'string') return null
  const match = stdout.match(
    /associated with the email[:\s]+['"]?([^\s@'"]+)@/i,
  )
  return match ? match[1] : null
}

// SUGGEST a workers.dev subdomain from what `wrangler whoami` prints. Every candidate here is a GUESS,
// none is ever accepted on its own, and the only thing it decides is what the setup's subdomain question
// offers as a default for the deployer to confirm against their dashboard.
//
// WHY IT CAN ONLY EVER BE A SUGGESTION. The exact value is behind the Cloudflare API
// (GET /accounts/<id>/workers/subdomain), which needs an API token this setup refuses to require; the
// other exact source is wrangler's own stored OAuth credential, which this wizard never touches; and an
// existence probe over DNS can only prove that a subdomain exists, never that it is this account's. So
// there is no honest automatic answer, and the value is ASKED.
//
// WHAT THE GUESS COST, which is why the ask exists. A fresh Cloudflare account is named after its login
// email ("dana@example.com's Account"), and slugifying that name produces `dana-example-com-s-account`
// while the account's real subdomain is `dana`. That was announced to the deployer as fact and wired into
// the provider webhook and the health check - every address pointing at a hostname the account does not
// have. It passed every earlier live run only because one maintainer's account name happens to match his
// subdomain.
//
// Order, best evidence first: a value the caller already holds -> a `*.workers.dev` host wrangler really
// printed -> the local part of the login email (on a default-named account that usually IS the subdomain)
// -> a slug of the account name (last, because it is exactly the one that fails on a default-named
// account). Returns { subdomain, method } or null.
export function deriveSubdomain({ explicit, run }) {
  if (explicit) return { subdomain: explicit, method: 'explicit' }
  if (!run) return null
  let whoami
  try {
    whoami = run(['whoami'])
  } catch {
    whoami = null
  }
  const stdout = whoami?.stdout ?? ''
  const scan = stdout.match(/([a-z0-9-]+)\.workers\.dev/i)
  if (scan) return { subdomain: scan[1], method: 'whoami-scan' }
  const local = slugifySubdomain(whoamiEmailLocalPart(stdout))
  if (local) return { subdomain: local, method: 'email-local-part' }
  const account = parseWhoamiAccount(stdout)
  if (account) {
    const slug = slugifySubdomain(account.name)
    if (slug) return { subdomain: slug, method: 'account-slug' }
  }
  return null
}

// Where the true subdomain is read from. One string, because the question, the step that cannot resolve
// without an answer, and every recovery mode must send the deployer to the same panel.
export const SUBDOMAIN_DASHBOARD_ROUTE =
  'Compute -> Workers & Pages -> Account Details (the panel on the right) -> Subdomain'

// Does the workers.dev subdomain the deployer gave us EXIST? An HTTP answer of any status proves it
// does; a DNS lookup that finds no such name proves it does not.
//
// WHAT THIS PROVES AND WHAT IT DOES NOT. It proves EXISTENCE, never OWNERSHIP: `*.<sub>.workers.dev`
// resolves for anybody's subdomain, so a typo that lands on a stranger's account passes here. The
// deploy's own `/health` check is the ownership truth - it answers only once THIS account has published
// THIS worker at that address - and that is why a pass here is silent and only a failure speaks.
//
// The distinction is MEASURED, not assumed (the same phenomenon isPropagating documents above): under a
// subdomain that exists, a name never deployed answers HTTP 404 from Cloudflare's edge, because wildcard
// DNS resolves the host; under a subdomain that does not exist, the lookup throws ENOTFOUND and no HTTP
// response exists at all.
//
// A `status: 0` that is NOT that DNS answer is INCONCLUSIVE and passes as a warning: an offline machine,
// a blocked resolver or a proxy failure says nothing about the deployer's account, and re-asking a value
// they read correctly off the dashboard would be a dead end with no way out of it.
export async function subdomainCheck(opts = {}) {
  const cwd = opts.cwd ?? process.cwd()
  const config = opts.config ?? readWranglerConfig(cwd)
  const name = config?.name
  const subdomain = opts.subdomain
  const nextOk = `\`${subdomain}.workers.dev\` exists`
  if (!name || !subdomain) {
    // Nothing to probe with. resolve-url reds on a missing worker name and on a missing subdomain
    // already, so this stays advisory rather than adding a second voice saying the same thing.
    return finalize(
      'subdomain-check',
      [
        {
          name: 'workers.dev subdomain checked',
          ok: false,
          severity: 'warn',
          fix: 'Nothing to check yet - the worker name or the subdomain is still missing.',
        },
      ],
      nextOk,
    )
  }

  const host = `${name}.${subdomain}.workers.dev`
  const fetchHealth = opts.fetchHealth ?? defaultFetchHealth
  const health = await fetchHealth(`https://${host}`)
  if (health.status !== 0) {
    return finalize(
      'subdomain-check',
      [
        {
          name: `workers.dev subdomain exists (${subdomain}): ${host} answered HTTP ${health.status}`,
          ok: true,
        },
      ],
      nextOk,
    )
  }
  const error = health.error ?? ''
  if (/ENOTFOUND|ERR_NAME_NOT_RESOLVED/i.test(error)) {
    return finalize(
      'subdomain-check',
      [
        {
          name: `workers.dev subdomain exists (${subdomain})`,
          ok: false,
          fix: `There is no \`${subdomain}.workers.dev\` - looking up ${host} found no such name, so a worker published there would be unreachable. Read the subdomain off the Cloudflare dashboard: ${SUBDOMAIN_DASHBOARD_ROUTE}.`,
        },
      ],
      nextOk,
    )
  }
  return finalize(
    'subdomain-check',
    [
      {
        name: `workers.dev subdomain checked (${subdomain})`,
        ok: false,
        severity: 'warn',
        fix: `Could not check ${host} from this machine (${error || 'the request failed before any HTTP response existed'}). That says nothing about your account, so the subdomain you gave is taken as given.`,
      },
    ],
    nextOk,
  )
}

// resolve-url - build the predictable worker URL up front (env-aware) so the Stripe webhook can
// be created before the single deploy. SANDBOX/top-level: `https://<name>.<subdomain>.workers.dev`.
// PRODUCTION: `https://<custom-domain>`. Any part it cannot compute non-interactively is flagged as a
// needs-input check for the orchestrator to ask. When a base resolves, it also emits the full webhook
// URL plus the raw secret_path (separately) and attaches them as `result.resolved` for the orchestrator.
// Both inputs it needs are ASKED of the deployer and passed back in as options (`domain` / `subdomain`),
// and that is the ONLY way in: this step reads no environment variable, so there is nothing here for an
// agent to reach for.
// Env-var fallbacks used to exist and were removed, not deprecated - an env-var assignment forces a
// compound, shell-specific command (`$env:X='v' && npm run ...` does not even parse in PowerShell), which
// puts the caller outside the `npm run` permission allowlist and makes the deployer approve every later
// call. An untested path kept alive only so a doc can say "do not use this" is a trap, not a mechanism.
export function resolveUrl(opts = {}) {
  const cwd = opts.cwd ?? process.cwd()
  const env = opts.env ?? null
  const label = env ?? 'sandbox'
  const config = opts.config ?? readWranglerConfig(cwd)
  if (!config) {
    return finalize(
      'resolve-url',
      [
        {
          name: 'read wrangler.jsonc',
          ok: false,
          fix: 'Could not read wrangler.jsonc - ensure the file exists and is valid',
        },
      ],
      `worker URL resolved for ${label}`,
    )
  }

  const name = config.name
  const checks = []
  checks.push({
    name: `worker name resolved (${name ?? 'MISSING'})`,
    ok: Boolean(name),
    ...(name ? {} : { fix: 'Set "name" in wrangler.jsonc' }),
  })

  let base = null
  if (name) {
    if (env === 'production') {
      const domainArg = opts.domain ?? null
      const routePattern = customDomainPattern(config, env)
      if (domainArg) {
        if (isValidHostname(domainArg)) {
          base = `https://${domainArg}`
          checks.push({
            name: `production custom domain: ${domainArg}`,
            ok: true,
          })
        } else {
          checks.push({
            name: 'production custom domain valid',
            ok: false,
            fix: `'${domainArg}' is not a valid hostname - pass a bare domain like access.example.com (no scheme, path, or port)`,
          })
        }
      } else if (routePattern) {
        base = `https://${routePattern}`
        checks.push({
          name: `production custom domain (from wrangler.jsonc routes, confirm it): ${routePattern}`,
          ok: true,
        })
      } else {
        checks.push({
          name: 'production custom domain',
          ok: false,
          needsInput: 'prod-domain',
          fix: 'No production custom domain is set yet - the setup needs it (e.g. access.example.com) to build the webhook URL. It asks you for the domain, then writes it into the wrangler.jsonc route when it saves the config.',
        })
      }
    } else {
      // The subdomain is an ASKED value and this step never guesses one - see deriveSubdomain for why no
      // honest automatic answer exists. Without an answer there is no base to build, and the check says
      // so rather than resolving a URL nobody confirmed.
      const subdomain = opts.subdomain ?? null
      if (subdomain) {
        base = `https://${name}.${subdomain}.workers.dev`
        checks.push({
          name: `workers.dev base URL (subdomain confirmed by the deployer): ${base}`,
          ok: true,
        })
      } else {
        checks.push({
          name: 'workers.dev subdomain',
          ok: false,
          needsInput: 'subdomain',
          fix: `No workers.dev subdomain yet - the setup asks you for it, and it cannot build your worker's address until you answer. Read it off the Cloudflare dashboard: ${SUBDOMAIN_DASHBOARD_ROUTE}.`,
        })
      }
    }
  }

  let resolved
  if (base) {
    const secretPath = opts.secretPath ?? generateSecretPath(opts.rand)
    const webhookUrl = `${base}/wh/stripe/${secretPath}`
    resolved = { base, webhookUrl, secretPath }
    checks.push({ name: `stripe webhook URL: ${webhookUrl}`, ok: true })
    checks.push({
      name: `secret_path (obscurity only - the worker does NOT validate it): ${secretPath}`,
      ok: true,
    })
  }

  const result = finalize(
    'resolve-url',
    checks,
    base
      ? `worker URL resolved for ${label}`
      : `need input to resolve the ${label} worker URL`,
  )
  if (resolved) result.resolved = resolved
  return result
}

// --- e2e (spec bonus 2: synthetic end-to-end chain against the deployed worker) -----------------

// SYNTHETIC only (test-secret webhook) - a repeatable check, NOT the "verified against live
// providers" moat (that stays a separate real-payment maintainer run). Targets core's Stripe adapter.

// Build the SYNTHETIC Stripe grant event the adapter parses (checkout.session.completed, paid). The
// caller passes a UNIQUE transaction_id per run so the deterministic Workflow id never dedupes.
export function buildE2eEvent({ productId, username, transactionId }) {
  return {
    id: `evt_e2e_${transactionId}`,
    type: 'checkout.session.completed',
    data: {
      object: {
        id: `cs_e2e_${transactionId}`,
        object: 'checkout.session',
        payment_status: 'paid',
        payment_intent: transactionId,
        metadata: { github_username: username, product_id: productId },
        customer_details: { email: 'e2e@repoaccess.test' },
      },
    },
  }
}

// The exact Stripe-Signature the adapter's hmac verify accepts: `t=<unix>,v1=<hex>` over the signed
// payload `${t}.${body}`, HMAC-SHA256 keyed by STRIPE_WEBHOOK_SECRET, byte-exact on the raw body.
export function stripeSignatureHeader(body, secret, timestamp) {
  const v1 = createHmac('sha256', secret)
    .update(`${timestamp}.${body}`)
    .digest('hex')
  return `t=${timestamp},v1=${v1}`
}

// --- the provider pack: the synthetic check's ONE seam -------------------------------------------
//
// The synthetic check needs four provider-specific facts, and every one of them used to be a literal
// in `e2e` below. They are now a PACK the CALLER supplies, so a downstream wizard can prove its own
// adapter's grant path with the same engine.
//
// THE BOUNDARY IS THE POINT, and it runs the other way from the usual one. Core defines the SEAM and
// exactly one pack - Stripe's, extracted verbatim from the literals that were already here. It must
// never grow a second provider's event shape, secret name, signature scheme or route: a downstream
// passes its own pack, so no provider knowledge has to enter this file to make that provider work.
// The alternative shape - `e2e({ adapter: '<some-provider>' })`, resolved against a table in here -
// reads as the smaller change and is the wrong one: it would oblige this AGPL engine to carry a
// non-core provider's payload format and canonical signing string, which is that provider's substance
// sitting in core, and it would put a core release on the critical path of every future provider. A
// reviewer must be able to grep this file for any non-core provider name and find nothing, and a test
// asserts exactly that - so this comment names none either.
//
//   webhookPath      the ADAPTER SEGMENT, and it is load-bearing in three places, not one: the
//                    `/wh/<segment>/<secret_path>` route the event is POSTed to, the
//                    `grant:<segment>:<txn>` KV key the cleanup deletes, and the `productTeamMap`
//                    key the target product resolves from. All three are the same identifier - the
//                    adapter's `name` - so the pack carries it once.
//   secretName       the NAME (never a value) whose secret signs the event; read from the run's
//                    secrets file by the script itself, and used only inside a header.
//   buildEvent       ({ productId, username, transactionId }) -> the event object to sign and send.
//   signatureHeader  (body, secret, timestamp) -> { name, value }. Both halves are provider-specific:
//                    the header NAME differs per provider as much as the signing scheme does.

export const STRIPE_E2E_PACK = {
  webhookPath: 'stripe',
  secretName: 'STRIPE_WEBHOOK_SECRET',
  buildEvent: buildE2eEvent,
  signatureHeader: (body, secret, timestamp) => ({
    name: 'stripe-signature',
    value: stripeSignatureHeader(body, secret, timestamp),
  }),
}

const PACK_FIELDS = [
  'webhookPath',
  'secretName',
  'buildEvent',
  'signatureHeader',
]

/**
 * The pack this run will use: the caller's, or Stripe's.
 *
 * A supplied pack is taken WHOLE - never merged over the default. Merging would let a partial pack
 * mix providers silently (one provider's event under another's signature), which is a forged event
 * the worker rejects for a reason no check would name. An incomplete pack is a caller bug, so it is
 * reported as a failed check rather than crashing mid-POST.
 */
export function resolveE2ePack(pack) {
  if (pack === undefined || pack === null) return { pack: STRIPE_E2E_PACK }
  const missing = PACK_FIELDS.filter((f) => !pack[f])
  if (missing.length > 0) {
    return { error: `provider pack is missing: ${missing.join(', ')}` }
  }
  const notFn = ['buildEvent', 'signatureHeader'].filter(
    (f) => typeof pack[f] !== 'function',
  )
  if (notFn.length > 0) {
    return {
      error: `provider pack fields must be functions: ${notFn.join(', ')}`,
    }
  }
  return { pack }
}

// Pick the (productId, teams) the synthetic grant will invite into, using the SAME resolution the
// worker uses (`map[adapter][productId]`). Explicit e2e.productId wins; else the first product under
// the adapter that maps to a team. Returns null if nothing maps to a team.
export function resolveE2eProduct(config, adapter = 'stripe') {
  const e2e = config?.e2e ?? {}
  const perAdapter = config?.productTeamMap?.[adapter] ?? {}
  if (e2e.productId) {
    const cfg = perAdapter[e2e.productId] ?? config?.productTeamMap?.defaults
    const teams = cfg?.teams ?? []
    return teams.length ? { productId: e2e.productId, teams } : null
  }
  for (const [pid, cfg] of Object.entries(perAdapter)) {
    if (cfg && Array.isArray(cfg.teams) && cfg.teams.length) {
      return { productId: pid, teams: cfg.teams }
    }
  }
  return null
}

const enc = encodeURIComponent

// One GitHub API call with the token in the Authorization header (never printed). Returns status + json.
async function ghRequest(doFetch, token, method, path) {
  const res = await doFetch(`https://api.github.com${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'repoaccess-wizard',
    },
  })
  let json = null
  try {
    json = await res.json()
  } catch {
    json = null
  }
  return { status: res.status, json }
}

// Poll a team membership until the invite appears (state pending|active) or the bounded window ends.
async function pollForInvite(doFetch, token, org, team, username, opts) {
  const attempts = opts.pollAttempts ?? 10
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  const intervalMs = opts.pollIntervalMs ?? 3000
  for (let i = 0; i < attempts; i++) {
    const res = await ghRequest(
      doFetch,
      token,
      'GET',
      `/orgs/${enc(org)}/teams/${enc(team)}/memberships/${enc(username)}`,
    )
    if (
      res.status === 200 &&
      (res.json?.state === 'pending' || res.json?.state === 'active')
    ) {
      return true
    }
    if (i < attempts - 1) await sleep(intervalMs)
  }
  return false
}

// Cancel the invite EVERYWHERE (idempotent): remove each team membership (404 = already gone), then
// cancel any pending org invitation for the handle. Best-effort on the invitations list.
async function cancelInvite(doFetch, token, org, teams, username) {
  let ok = true
  for (const team of teams) {
    const res = await ghRequest(
      doFetch,
      token,
      'DELETE',
      `/orgs/${enc(org)}/teams/${enc(team)}/memberships/${enc(username)}`,
    )
    if (![200, 204, 404].includes(res.status)) ok = false
  }
  const list = await ghRequest(
    doFetch,
    token,
    'GET',
    `/orgs/${enc(org)}/invitations?per_page=100`,
  )
  if (list.status === 200 && Array.isArray(list.json)) {
    for (const inv of list.json) {
      if (String(inv?.login).toLowerCase() === username.toLowerCase()) {
        const del = await ghRequest(
          doFetch,
          token,
          'DELETE',
          `/orgs/${enc(org)}/invitations/${inv.id}`,
        )
        if (![200, 204].includes(del.status)) ok = false
      }
    }
  }
  return ok
}

// e2e - the synthetic Stripe grant chain: build + sign + POST to the deployed worker, poll
// GitHub for the invite, and ALWAYS cancel it (finally). Secrets are read by the script and used only
// in headers, never printed. Every leg is a check; the injectable fetch / secret / clock seams make
// the whole flow mock-testable with no network.
export async function e2e(opts = {}) {
  const cwd = opts.cwd ?? process.cwd()
  const env = opts.env ?? null
  const config = opts.config ?? (await loadConfig(cwd, env))
  if (!config) {
    return finalize(
      'e2e',
      [
        {
          name: 'load src/config/repoaccess.config.ts',
          ok: false,
          fix: 'Could not load the config - ensure src/config/repoaccess.config.ts exists',
        },
      ],
      'synthetic end-to-end grant verified and cleaned up',
    )
  }

  // The provider pack decides WHICH adapter this check exercises. Resolved before anything else that
  // depends on it - the product lookup below is keyed by the adapter segment it carries.
  const packed = resolveE2ePack(opts.pack)
  if (packed.error) {
    return finalize(
      'e2e',
      [
        {
          name: 'provider pack usable',
          ok: false,
          fix: `The synthetic check was given an unusable provider pack (${packed.error}). A pack needs all four fields: ${PACK_FIELDS.join(', ')}. Omit it entirely to use the built-in Stripe pack.`,
        },
      ],
      'synthetic end-to-end grant verified and cleaned up',
    )
  }
  const pack = packed.pack

  const org = config.githubOrg
  const username = opts.username ?? config.e2e?.testUsername ?? null
  const url = opts.url ?? config.e2e?.url ?? null
  const secretPath = config.e2e?.secretPath ?? 'webhook'
  const target = resolveE2eProduct(config, pack.webhookPath)

  // Preconditions - report a clear fix and stop before touching the network / secrets.
  if (!username) {
    return finalize(
      'e2e',
      [
        {
          name: 'e2e test username configured',
          ok: false,
          fix: 'Set an e2e test username - a GitHub account you control (config e2e.testUsername or the CLI arg) - it receives a real GitHub invite that is auto-cancelled',
        },
      ],
      'synthetic end-to-end grant verified and cleaned up',
    )
  }
  if (!org || !target) {
    return finalize(
      'e2e',
      [
        {
          name: 'org + product->team mapping configured',
          ok: false,
          fix: 'Set githubOrg and a productTeamMap entry that maps a product to a team in src/config/repoaccess.config.ts',
        },
      ],
      'synthetic end-to-end grant verified and cleaned up',
    )
  }
  if (!url) {
    return finalize(
      'e2e',
      [
        {
          name: 'deployed worker URL provided',
          ok: false,
          fix: 'Provide the deployed worker URL (config e2e.url or --url https://...) so e2e can POST the synthetic webhook',
        },
      ],
      'synthetic end-to-end grant verified and cleaned up',
    )
  }

  // `stripeSecret` is the ORIGINAL option name and stays honoured: it predates the pack and is what
  // every existing caller passes. `secret` is its pack-neutral spelling for a caller running a
  // different provider. Either way the value is read here and leaves only inside a header.
  const providerSecret =
    opts.secret ??
    opts.stripeSecret ??
    readSecretValue(pack.secretName, cwd, { env })
  const githubToken =
    opts.githubToken ?? readSecretValue('GITHUB_TOKEN', cwd, { env })
  if (!providerSecret || !githubToken) {
    return finalize(
      'e2e',
      [
        {
          name: `e2e secrets present (${pack.secretName} + GITHUB_TOKEN)`,
          ok: false,
          fix: `Set ${pack.secretName} and GITHUB_TOKEN in ${secretsFileFor(env)} - the wizard reads them itself; you never paste them to the agent`,
        },
      ],
      'synthetic end-to-end grant verified and cleaned up',
    )
  }

  const doFetch = opts.fetch ?? fetch
  const run = opts.run ?? wranglerRunner(cwd)
  const transactionId =
    opts.transactionId ?? `pi_e2e_${randomUUID().replace(/-/g, '')}`
  const timestamp = opts.timestamp ?? Math.floor(Date.now() / 1000)
  const teams = target.teams
  const pollTeam = teams[0]

  const checks = []
  try {
    const body = JSON.stringify(
      pack.buildEvent({ productId: target.productId, username, transactionId }),
    )
    const signature = pack.signatureHeader(body, providerSecret, timestamp)
    const ackRes = await doFetch(
      `${url.replace(/\/$/, '')}/wh/${enc(pack.webhookPath)}/${enc(secretPath)}`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [signature.name]: signature.value,
          'user-agent': BROWSER_UA,
        },
        body,
      },
    )
    checks.push({ name: 'synthetic webhook signed and posted', ok: true })

    const ackOk = ackRes.status >= 200 && ackRes.status < 300
    checks.push({
      name: 'worker ack (2xx)',
      ok: ackOk,
      ...(ackOk
        ? {}
        : {
            fix: `The worker did not ack the signed webhook (status ${ackRes.status}) - check the deploy and ${pack.secretName}`,
          }),
    })

    if (ackOk) {
      const invited = await pollForInvite(
        doFetch,
        githubToken,
        org,
        pollTeam,
        username,
        opts,
      )
      checks.push({
        name: `team invite observed for ${username} (${pollTeam})`,
        ok: invited,
        ...(invited
          ? {}
          : {
              fix: 'No team invite appeared within the poll window - check the worker logs (GITHUB_TOKEN scope, product->team map)',
            }),
      })
    }
  } catch {
    checks.push({
      name: 'synthetic webhook reached the worker',
      ok: false,
      fix: `Could not reach the deployed worker at ${url} - confirm the URL and that it is deployed`,
    })
  } finally {
    // ALWAYS clean up - a failed e2e must never leave a dangling invite.
    const cleaned = await cancelInvite(
      doFetch,
      githubToken,
      org,
      teams,
      username,
    )
    checks.push({
      name: 'cleanup: invite cancelled',
      ok: cleaned,
      ...(cleaned
        ? {}
        : {
            fix: `Could not fully cancel the invite for ${username} - remove it at https://github.com/orgs/${org}/people/pending_invitations`,
          }),
    })

    // Also delete the synthetic grant record this run minted (grant:<adapter>:<transaction_id>). A grant
    // that fired wrote it to the REMOTE ENTITLEMENTS store; leaving it behind means synthetic data sits
    // in a production KV and grant-record later lists a phantom pi_ the operator has to disambiguate for
    // the refund test. Same --remote / env-aware wrangler invocation grant-record uses. Advisory (WARN):
    // a failed delete (e.g. when the ack failed and no record was ever written) must never turn a green
    // e2e red.
    const grantKey = `grant:${pack.webhookPath}:${transactionId}`
    const delRes = run([
      'kv',
      'key',
      'delete',
      grantKey,
      '--binding',
      'ENTITLEMENTS',
      '--remote',
      ...(env ? ['--env', env] : []),
    ])
    checks.push({
      name: `cleanup: synthetic grant record deleted (${grantKey})`,
      ok: delRes.ok,
      severity: 'warn',
      ...(delRes.ok
        ? {}
        : {
            fix: `Could not delete the synthetic grant record ${grantKey} from the REMOTE ENTITLEMENTS store. wrangler said: ${wranglerError(delRes)}. Remove it manually if it lingers: npx wrangler kv key delete "${grantKey}" --binding ENTITLEMENTS --remote${env ? ' --env production' : ''}`,
          }),
    })
  }

  return finalize(
    'e2e',
    checks,
    'synthetic end-to-end grant verified and cleaned up',
  )
}
