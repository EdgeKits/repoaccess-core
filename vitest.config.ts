// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Gary Stupak

import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

// Two projects. The `worker` project runs the worker suite inside workerd via
// @cloudflare/vitest-pool-workers, loading the real bindings from wrangler.jsonc. The
// `node` project runs the tests that need a real filesystem in a plain Node environment -
// the setup-wizard build-script tests (scripts/wizard.mjs and scripts/wizard-driver.mjs,
// which also need node:child_process), and the public-surface guard, which reads the
// source text of src/lib.ts and the exported unions. workerd provides neither module.
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
            'test/public-surface.test.ts',
          ],
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
