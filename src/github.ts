// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Gary Stupak

// Minimal GitHub REST client over `fetch` - no Octokit/SDK, no Node APIs (Workers-only). Auth is a
// fine-grained PAT (Members: R&W) from env.GITHUB_TOKEN (a secret); the org is passed in by the
// caller from `config.githubOrg`. Teams are addressed by SLUG (the product→team map
// carries slugs).

import type { Json } from './types'

const GITHUB_API = 'https://api.github.com'
const USER_AGENT = 'repoaccess-worker' // GitHub rejects requests without a User-Agent.
const API_VERSION = '2022-11-28'

// Page size for the org-invitations listing (GitHub's max). Exported so the revoke path's
// pagination loop can tell a full page (maybe more) from a short one (the last page) without drift.
export const INVITE_PAGE_SIZE = 100

/** Serializable result - it is JSON-stringified across a durable step boundary, so it must not
 * contain a live Response. */
export interface GithubResult {
  status: number
  json: Json
  retryAfterSec: number | null
  rateLimitRemaining: number | null
  rateLimitResetSec: number | null
}

function header(value: string | null): number | null {
  if (value === null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

async function githubRequest(
  env: CloudflareBindings,
  method: string,
  path: string,
  body?: unknown,
): Promise<GithubResult> {
  const init: RequestInit = {
    method,
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': API_VERSION,
      'User-Agent': USER_AGENT,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  }
  const res = await fetch(`${GITHUB_API}${path}`, init)
  const text = await res.text()
  let json: Json = null
  if (text) {
    try {
      json = JSON.parse(text)
    } catch {
      json = text
    }
  }
  return {
    status: res.status,
    json,
    retryAfterSec: header(res.headers.get('retry-after')),
    rateLimitRemaining: header(res.headers.get('x-ratelimit-remaining')),
    rateLimitResetSec: header(res.headers.get('x-ratelimit-reset')),
  }
}

// Path segments are URL-encoded as defense-in-depth (usernames are validated upstream and
// slugs come from trusted config, but never interpolate raw user input into a URL path).
const enc = encodeURIComponent

export const github = {
  getTeamMembership: (
    env: CloudflareBindings,
    org: string,
    slug: string,
    username: string,
  ) =>
    githubRequest(
      env,
      'GET',
      `/orgs/${enc(org)}/teams/${enc(slug)}/memberships/${enc(username)}`,
    ),

  addTeamMembership: (
    env: CloudflareBindings,
    org: string,
    slug: string,
    username: string,
  ) =>
    githubRequest(
      env,
      'PUT',
      `/orgs/${enc(org)}/teams/${enc(slug)}/memberships/${enc(username)}`,
    ),

  removeTeamMembership: (
    env: CloudflareBindings,
    org: string,
    slug: string,
    username: string,
  ) =>
    githubRequest(
      env,
      'DELETE',
      `/orgs/${enc(org)}/teams/${enc(slug)}/memberships/${enc(username)}`,
    ),

  listInvitations: (env: CloudflareBindings, org: string, page = 1) =>
    githubRequest(
      env,
      'GET',
      `/orgs/${enc(org)}/invitations?per_page=${INVITE_PAGE_SIZE}&page=${page}`,
    ),

  cancelInvitation: (
    env: CloudflareBindings,
    org: string,
    invitationId: number,
  ) =>
    githubRequest(
      env,
      'DELETE',
      `/orgs/${enc(org)}/invitations/${invitationId}`,
    ),

  removeOrgMembership: (
    env: CloudflareBindings,
    org: string,
    username: string,
  ) =>
    githubRequest(
      env,
      'DELETE',
      `/orgs/${enc(org)}/memberships/${enc(username)}`,
    ),
}

/** 429, or 403 carrying a rate-limit signal (primary or secondary limit). */
export function isRateLimited(result: GithubResult): boolean {
  if (result.status === 429) return true
  if (result.status === 403) {
    return result.rateLimitRemaining === 0 || result.retryAfterSec !== null
  }
  return false
}
