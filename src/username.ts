// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Gary Stupak

// GitHub username grammar: ≤39 chars, alphanumeric + single internal hyphens,
// no leading/trailing/consecutive hyphens. A malformed handle is treated as "no username" → claim
// fallback (so it never burns the org's 50/24h invitation quota). Same regex runs inline on the
// claim POST. Format validation is necessary-but-not-sufficient: a well-formed handle for a
// non-existent account still surfaces as a 404 from the membership call → access.failed.
const GITHUB_USERNAME = /^[a-zA-Z0-9](?:[a-zA-Z0-9]|-(?=[a-zA-Z0-9])){0,38}$/

export function isValidGithubUsername(
  value: string | null | undefined,
): value is string {
  return typeof value === 'string' && GITHUB_USERNAME.test(value)
}
