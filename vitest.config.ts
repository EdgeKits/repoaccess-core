// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Gary Stupak

import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

// Three projects. The `worker` project runs the worker suite inside workerd via
// @cloudflare/vitest-pool-workers, loading the real bindings from wrangler.jsonc. The
// `wizard-worker` project runs the one test that needs workerd WITH Node compatibility -
// see the note on its own plugin block below. The `node` project runs the tests that need a
// real filesystem in a plain Node environment - the setup-wizard build-script tests
// (scripts/wizard.mjs and scripts/wizard-driver.mjs, which also need node:child_process) and
// the public-surface guard, which reads the source text of src/lib.ts and the exported
// unions. workerd provides neither module.
export default defineConfig({
  test: {
    passWithNoTests: true,
    projects: [
      {
        plugins: [
          cloudflareTest({
            wrangler: { configPath: './wrangler.jsonc' },
          }),
        ],
        test: {
          name: 'worker',
          include: ['test/**/*.test.ts'],
          exclude: [
            'test/wizard.test.ts',
            'test/wizard-driver.test.ts',
            'test/wizard-synthetic-check.test.ts',
            'test/public-surface.test.ts',
          ],
        },
      },
      {
        plugins: [
          cloudflareTest({
            wrangler: { configPath: './wrangler.jsonc' },
            // The ONLY project that runs workerd with Node compatibility, and it is scoped to one
            // file for that reason. The setup wizard is a Node build script, so a test that runs it
            // against the real worker has to load `node:fs` / `node:crypto` / `node:child_process`
            // alongside worker code. Enabling that on the `worker` project would silently accept a
            // Node import in `src/` too, which the deploy would then refuse - so the flag lives here
            // and the worker suite keeps running on Web Standards alone.
            miniflare: { compatibilityFlags: ['nodejs_compat'] },
          }),
        ],
        test: {
          name: 'wizard-worker',
          include: ['test/wizard-synthetic-check.test.ts'],
        },
      },
      {
        test: {
          name: 'node',
          environment: 'node',
          include: [
            'test/wizard.test.ts',
            'test/wizard-driver.test.ts',
            'test/public-surface.test.ts',
          ],
        },
      },
    ],
  },
})
