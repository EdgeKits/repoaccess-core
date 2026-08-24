/** @jsxRuntime automatic */
/** @jsxImportSource hono/jsx */
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Gary Stupak

import { raw } from 'hono/html'
import type { Branding } from '../types'
import { themeVars, baseThemeCss, sanitizeCustomCss } from '../themes/theme'

/**
 * Claim-page template contract. The claim CONTROLLER
 * (`claim.tsx`) owns all logic - token validation, inline username validation, ClaimGuard single-flight, workflow
 * enqueue, `harden()` headers, and the JSON projections - and renders each HTML state through an
 * injected `ClaimTemplate`. This module is the PUBLIC extension point: a downstream worker (or Pro, in
 * its own repo) supplies its own `ClaimTemplate` via `createWorker({ claimTemplate })` to
 * restyle every claim state without forking the controller. Core ships ONLY this contract +
 * `defaultClaimTemplate`. JSON responses stay controller-owned - templates render HTML only.
 */

/**
 * Seller-configurable branding, resolved from `config.branding` by the controller.
 * The shape lives in `types.ts` (the config contract); re-exported here for template authors.
 */
export type { Branding } from '../types'

/**
 * The view the controller hands the template - one variant per claim state. The `form` and `confirm`
 * variants carry `submitScript`: core's central submit-feedback JS (kept core-owned so the
 * disable-button + spinner behaviour is uniform across templates). A template MUST embed it as
 * `<script>{raw(view.submitScript)}</script>` and give its form `id="claim-form"` + its submit
 * button `id="claim-btn"` (the script targets those ids); it should style a `.spinner` but degrades
 * gracefully if absent.
 */
export type ClaimView =
  // `value` is what the buyer last typed, echoed back into the field: the form is re-rendered on a
  // format error and when the buyer returns from `confirm` to correct a character, and an emptied
  // field would make them retype the whole handle at the exact moment they are hunting a typo.
  | {
      kind: 'form'
      token: string
      error?: string
      value?: string
      submitScript: string
    }
  // The step between typing a handle and granting to it. The buyer reads back the handle they
  // entered and either confirms it or goes back and corrects it. It exists because the field has an
  // UNRECOVERABLE failure mode: a well-formed handle that belongs to a REAL account which is not the
  // buyer's grants to that stranger, consumes the claim token, and leaves the buyer with no access
  // and no retry.
  //
  // `username` is the handle EXACTLY as typed, un-normalized - the buyer is being asked to spot a
  // typo, and a value silently cleaned up on the way back hides the very thing they are checking.
  //
  // `handle` is the SAME handle after trimming: the value that passed validation and that the grant
  // will actually use. The two exist separately because they answer different questions. `username`
  // answers "what did I write?", so it must not be cleaned up. `handle` answers "which account gets
  // access?", so it must be the value the engine will act on. Anything that names a real account -
  // a profile link above all - is built from `handle`, never from `username`: a link built from the
  // raw string would point at an account other than the one being granted, which is the exact
  // mistake this screen exists to catch.
  //
  // A template MUST render `username` verbatim and MUST offer BOTH actions as ordinary submissions,
  // each carrying `<input type="hidden" name="github_username">` with that value: confirm adds
  // `<input type="hidden" name="confirmed" value="1">`, and the way back adds
  // `<input type="hidden" name="edit" value="1">` (which re-renders the form with the value still in
  // the field, spending nothing). Neither marker may ride on a submit button, and the way back may
  // not be `history.back()` or a bare "use your browser's back button" - a POSTed screen reached
  // without JavaScript does not necessarily return to a populated form. The whole step has to work
  // with JavaScript disabled.
  | {
      kind: 'confirm'
      token: string
      username: string
      handle: string
      submitScript: string
    }
  | { kind: 'submitted'; token: string; username: string }
  | { kind: 'busy'; token: string }
  | { kind: 'invalid' }
  // Resolve-by-transaction (claim-link delivery): the neutral "preparing" state shown when
  // the claim is not yet resolvable by transaction (the grant workflow runs async after the webhook
  // ack, so `claim_txn` may be absent at the instant of the post-checkout redirect). No token here.
  // Carries `pollScript`: core's central auto-poll JS (kept core-owned, like `form`'s submitScript) so
  // the page self-refreshes across the KV eventual-consistency window and the loop self-terminates once
  // a terminal view replaces it. A template MUST embed it as `<script>{raw(view.pollScript)}</script>`.
  | { kind: 'pending'; pollScript: string }
  // Resolve-by-transaction: the access has already been granted directly (grant_mode
  // `username` happy path, which produces no claim) - so one redirect URL serves both grant modes.
  // No handle/teams/grant detail echoed.
  | { kind: 'granted' }
  // Resolve-by-transaction (0.2.5): a TERMINAL grant failure was recorded for this transaction (bad
  // handle on a username grant / un-correctable GitHub error / exhausted retries). Neutral copy, no
  // detail echoed - so the buyer gets a definite signal instead of looping on `pending` forever.
  | { kind: 'failed' }

/**
 * A claim-page template: pure `(brand, view) → HTML`. Injected via `createWorker({ claimTemplate })`.
 * The return is whatever `c.html()` accepts - a Hono JSX node satisfies this (a JSX node is an
 * `HtmlEscapedString`, i.e. a `string` subtype), as does a plain HTML string or a Promise of one.
 */
export type ClaimTemplate = (ctx: {
  brand: Branding
  view: ClaimView
}) => string | Promise<string>

// --- default template --------------------------------------------------------

/**
 * The HTML5 doctype, emitted as the first thing in the page shell below.
 *
 * Without it a browser parses the document in QUIRKS mode, and that is not a cosmetic difference: the
 * same stylesheet lays the page out differently. Measured on a downstream page built on this sheet -
 * in quirks mode a flex-centred card's height pins to the viewport while its content overflows it, and
 * the body's bottom padding is swallowed. It shows on long pages and not on short ones, which is what
 * makes it look like a content bug rather than a parsing mode.
 *
 * `raw()` because it is markup rather than text: the JSX runtime would otherwise escape the angle
 * brackets and the document would open with a visible `&lt;!doctype html&gt;`.
 */
const DOCTYPE = raw('<!doctype html>\n')

const Layout = (props: {
  brand: Branding
  title: string
  children: unknown
}) => (
  <>
    {DOCTYPE}
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>
          {props.title} · {props.brand.name}
        </title>
        {props.brand.faviconUrl ? (
          <link rel="icon" href={props.brand.faviconUrl} />
        ) : null}
        {/* One style block, in cascade order, so a page a downstream composes wears the same brand as
          this one: seller tokens over neutral defaults, the unified component stylesheet, then any
          seller customCss (with `</style>` escaped rather than deleted, so it can't break out and the
          seller's CSS is not truncated). */}
        <style>
          {raw(themeVars(props.brand.theme))}
          {raw(baseThemeCss)}
          {raw(
            props.brand.customCss
              ? sanitizeCustomCss(props.brand.customCss)
              : '',
          )}
        </style>
      </head>
      <body>
        <main class="card">
          {props.brand.logoUrl ? (
            <img
              class="logo"
              src={props.brand.logoUrl}
              alt={props.brand.name}
            />
          ) : (
            <p class="brand">{props.brand.name}</p>
          )}
          {props.children as never}
        </main>
      </body>
    </html>
  </>
)

/**
 * Step 1 of the claim: type a handle. Submitting does NOT grant - it renders `ClaimConfirm` below.
 *
 * The placeholder DESCRIBES what to type and never shows a value that could be typed. That is the
 * rule, not the particular string: people type what a placeholder shows, and on this field the cost
 * of doing so is the whole purchase - a concrete-looking example that happens to be a registered
 * account grants to its owner. GitHub's grammar (`../username.ts`) forbids spaces, so this text can
 * never be mistaken for a handle by the validator either.
 */
const ClaimForm = (props: {
  brand: Branding
  token: string
  error?: string
  value?: string
  submitScript: string
}) => (
  <Layout brand={props.brand} title="Claim your access">
    <h2>Claim your access</h2>
    <p>
      Enter your GitHub username to be added to the {props.brand.name}{' '}
      repositories for your purchase.
    </p>
    {props.error ? <p class="error">{props.error}</p> : null}
    <form id="claim-form" method="post" action={`/claim/${props.token}`}>
      <label for="github_username">GitHub username</label>
      <input
        id="github_username"
        name="github_username"
        autocomplete="off"
        autofocus
        required
        placeholder="your GitHub username"
        value={props.value ?? ''}
      />
      <button id="claim-btn" type="submit">
        Claim access
      </button>
    </form>
    <script>{raw(props.submitScript)}</script>
  </Layout>
)

/**
 * Step 2 of the claim: read the handle back, then either confirm it or go back and correct it.
 *
 * TWO forms, both plain HTML, and that shape is the requirement rather than a style choice. A
 * confirmation that only offers "proceed" is worse than none - it shows the buyer their mistake and
 * gives them nowhere to take it - so the way back is a visible, one-click SUBMISSION that carries
 * the handle with it and re-renders the form with the value still in the field. It is a second
 * `<form>` rather than a second button in the first, because `submitScript` disables the submit
 * button on submit and a disabled submitter's name/value can be dropped from the entry list; keeping
 * each marker in a hidden input of its own form means neither decision can be lost. Nothing here
 * needs JavaScript, and going back spends nothing - the controller only reads.
 *
 * The profile link is what makes "check it" an instruction the buyer can follow. Reading a handle
 * back only asks someone to re-read a typo they already failed to notice once; opening the profile
 * asks them whose account it is, which is a check that can actually fail. It is a plain anchor with
 * no handler, so it works on the scriptless page like everything else here.
 */
const ClaimConfirm = (props: {
  brand: Branding
  token: string
  username: string
  handle: string
  submitScript: string
}) => (
  <Layout brand={props.brand} title="Confirm your GitHub username">
    <h2>Confirm your GitHub username</h2>
    <p>
      You entered <strong>{props.username}</strong>. Check it against your
      GitHub profile before you continue.
    </p>
    {/* The href is built from `handle` (validated, trimmed), never from `username` (raw), so the
        link names the account that will actually receive access. Two things make the concatenation
        safe, and they cover different failures. The URL is safe because `isValidGithubUsername` has
        already passed by the time the controller renders this view: the grammar is anchored
        alphanumerics with single internal hyphens, so the value cannot contain `/`, `.`, `?`, `#`,
        `%` or whitespace and cannot escape its path segment. The ATTRIBUTE is safe because the
        renderer escapes attribute values, which holds whatever the value is. Loosen the handle
        grammar and the second protection remains while the first does not.

        `target` and `rel` are literals in the markup rather than computed, so no code path can
        render this anchor without them. Only the href and the link text vary.

        `noopener` denies the opened tab a handle on this page through window.opener. `noreferrer`
        keeps this page's URL, which carries the claim token in its path, out of the request to
        github.com. To be accurate about what that buys: current browsers already default to sending
        only the ORIGIN cross-origin, not the path, so this is not the only thing standing between a
        claim URL and a third party. The point is that the guarantee must not DEPEND on the client's
        default. In-app webviews and older engines are unreliable here, and a claim link is very
        often opened inside one. */}
    <p>
      <a
        id="claim-profile-link"
        href={`https://github.com/${props.handle}`}
        target="_blank"
        rel="noopener noreferrer"
      >
        Open github.com/{props.handle} in a new tab
      </a>
    </p>
    <p>
      Access is granted to this account and to no other. If the username is
      wrong, the access goes to whoever owns that name and you do not get it -
      that is on you, not on the seller, and it cannot be undone from this page.
    </p>
    <form id="claim-form" method="post" action={`/claim/${props.token}`}>
      <input type="hidden" name="github_username" value={props.username} />
      <input type="hidden" name="confirmed" value="1" />
      <button id="claim-btn" type="submit">
        Yes, add {props.username}
      </button>
    </form>
    <form
      method="post"
      action={`/claim/${props.token}`}
      style="margin-top:.75rem"
    >
      <input type="hidden" name="github_username" value={props.username} />
      <input type="hidden" name="edit" value="1" />
      <button type="submit" class="back">
        Change the username
      </button>
    </form>
    <script>{raw(props.submitScript)}</script>
  </Layout>
)

const ClaimSubmitted = (props: {
  brand: Branding
  token: string
  username: string
}) => (
  <Layout brand={props.brand} title="Processing your claim">
    <h2>Processing your claim</h2>
    <p>
      We&apos;re adding <strong>{props.username}</strong> to your repositories.
      Watch for a GitHub invitation in your email and notifications.
    </p>
    <p>
      If you don&apos;t receive a GitHub invitation (email + notifications)
      within a minute, you may have mistyped your username -{' '}
      <a href={`/claim/${props.token}`}>reload this page</a> to correct it and
      try again.
    </p>
  </Layout>
)

const ClaimBusy = (props: { brand: Branding; token: string }) => (
  <Layout brand={props.brand} title="Claim in progress">
    <h2>This claim is already being processed</h2>
    <p>
      A submission for this link is in flight or already completed.{' '}
      <a href={`/claim/${props.token}`}>Reload this page</a> in a moment to see
      the result - if no GitHub invitation arrives (email + notifications)
      within a minute, the username may have been mistyped, and you&apos;ll be
      able to correct it and try again.
    </p>
  </Layout>
)

const ClaimPending = (props: { brand: Branding; pollScript: string }) => (
  <Layout brand={props.brand} title="Setting up your access">
    <h2>Setting up your access</h2>
    <p>
      This normally takes up to about a minute - the page refreshes itself
      automatically, so just keep this tab open.
    </p>
    <p id="bytxn-slow" class="error" style="display:none">
      This is taking longer than usual - refresh the page, and if it still does
      not resolve, contact the seller with your order details.
    </p>
    <script>{raw(props.pollScript)}</script>
  </Layout>
)

const ClaimGranted = (props: { brand: Branding }) => (
  <Layout brand={props.brand} title="Access granted">
    <h2>Access granted</h2>
    <p>
      Your access is set up. Check your email for the GitHub invitation and
      accept it.
    </p>
  </Layout>
)

const ClaimFailed = (props: { brand: Branding }) => (
  <Layout brand={props.brand} title="Access setup failed">
    <h2>Something went wrong setting up your access</h2>
    <p>
      We could not finish setting up your access. Please contact support with
      your order details and we&apos;ll sort it out.
    </p>
  </Layout>
)

const ClaimInvalid = (props: { brand: Branding }) => (
  <Layout brand={props.brand} title="Claim unavailable">
    <h2>This claim link is invalid or no longer active</h2>
    <p>
      If you just submitted your username, your access may already be granted -
      check your GitHub invitations and notifications. Otherwise this link may
      have expired; contact support with your order details.
    </p>
  </Layout>
)

/**
 * Core's default claim template - one component per `ClaimView` variant, and the only claim markup
 * core ships. A downstream template can replace it wholesale via `createWorker({ claimTemplate })`;
 * whatever it renders, the `confirm` contract above is binding, because the controller reaches the
 * grant only through a submission the buyer confirmed.
 */
export const defaultClaimTemplate: ClaimTemplate = ({ brand, view }) => {
  switch (view.kind) {
    case 'form':
      return (
        <ClaimForm
          brand={brand}
          token={view.token}
          error={view.error}
          value={view.value}
          submitScript={view.submitScript}
        />
      )
    case 'confirm':
      return (
        <ClaimConfirm
          brand={brand}
          token={view.token}
          username={view.username}
          handle={view.handle}
          submitScript={view.submitScript}
        />
      )
    case 'submitted':
      return (
        <ClaimSubmitted
          brand={brand}
          token={view.token}
          username={view.username}
        />
      )
    case 'busy':
      return <ClaimBusy brand={brand} token={view.token} />
    case 'pending':
      return <ClaimPending brand={brand} pollScript={view.pollScript} />
    case 'granted':
      return <ClaimGranted brand={brand} />
    case 'failed':
      return <ClaimFailed brand={brand} />
    case 'invalid':
      return <ClaimInvalid brand={brand} />
  }
}
