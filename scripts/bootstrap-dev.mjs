// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Gary Stupak

// Fresh-clone bootstrap. A zero-dependency Node build script - NOT worker code.
//
// A clone cannot typecheck or run its worker tests until two files exist that git deliberately does
// not carry. Both are gitignored BECAUSE they are yours: `src/config/repoaccess.config.ts` holds your
// org and your product map, and `wrangler.jsonc` holds your account's KV namespace ids, so an update
// pulled with `git pull` must never overwrite either. But the tracked deploy entries import that
// config, and the worker test project reads its bindings out of that wrangler file, so in a clone
// `typecheck` fails on an unresolved import and the worker suite has no configuration to load.
//
// The gap was worth closing because it was INVISIBLE: the gate ran green for anyone whose tree already
// had the two files, could not run at all for anyone who had just cloned, and both results were
// reported with the same words. A green run has to mean the same thing wherever it happens.
//
// So this runs before `test`, `typecheck` and `check:release`, and copies each file from its committed
// template ONLY when it is absent. It never overwrites, so your edited config and your real KV ids are
// safe, and it prints whatever it created - a file that appears in your tree should never appear
// silently. The copying itself is `ensureConfigFiles` from the setup wizard's step library, which
// already makes exactly these two copies for a deployer; reusing it keeps one behaviour rather than
// two that can drift.
//
// It is deliberately NOT a `prepare` hook. `prepare` also fires on `npm pack` and `npm publish`, and
// these two files are gitignored and excluded from the published package on purpose - the package must
// never create them, and packing must never depend on them.

import { ensureConfigFiles } from './wizard.mjs'

const created = []
const problems = []

for (const check of ensureConfigFiles()) {
  // The step library reports one check per file, named `<path> present`, with the "I just made this"
  // fact on `detail` - absent when the file was already there.
  const file = check.name.replace(/ present$/, '')
  if (!check.ok) problems.push(`${file}: ${check.fix}`)
  else if (check.detail) created.push(`${file} (${check.detail})`)
}

if (created.length > 0) {
  console.log(`bootstrap: created ${created.join(', ')}`)
  console.log(
    'bootstrap: both are gitignored and stay out of the published package - fill in your own values before you deploy',
  )
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`bootstrap: ${problem}`)
  process.exit(1)
}
