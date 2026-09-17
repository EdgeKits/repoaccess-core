// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Gary Stupak

/// <reference types="@cloudflare/vitest-pool-workers/types" />

// Type the bindings exposed to tests via `cloudflare:test` as the worker's real env.
declare module 'cloudflare:test' {
  interface ProvidedEnv extends CloudflareBindings {}
}

// `?raw` markdown imports. `test/cost-table.test.ts` asserts the published cost table against a
// measured run, so it needs the guide's TEXT inside workerd, where there is no filesystem. Vite
// inlines the file at build time and the import is a plain string at runtime.
declare module '*.md?raw' {
  const content: string
  export default content
}
