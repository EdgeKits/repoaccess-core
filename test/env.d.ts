// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Gary Stupak

/// <reference types="@cloudflare/vitest-pool-workers/types" />

// Type the bindings exposed to tests via `cloudflare:test` as the worker's real env.
declare module 'cloudflare:test' {
  interface ProvidedEnv extends CloudflareBindings {}
}
