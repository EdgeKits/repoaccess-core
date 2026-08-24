// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Gary Stupak

// Setup-wizard DRIVER. A zero-dependency Node build script - NOT worker code, and not shipped in the
// npm package (it is part of the clone, like scripts/wizard.mjs).
//
// WHY a driver. Every reliable setup tool - `wrangler login`, `gh auth login`, `create-next-app` - is
// built the same way: the TOOL drives and holds the state, and the human responds to the tool. Our
// setup was inverted: the agent was the driver and this repo's script a bag of subcommands the agent
// chose and glued together from a long prose manual. Prose is an untested surface, so every edit to it
// risked breaking the run in a way nothing could catch. The driver finishes the move that every durable
// fix here has made: the sequence, the branching, the env-carrying and the words themselves live in
// TESTED CODE, and the prose collapses to a shim that says "run the driver and render what it returns".
//
// THE CONTRACT. The driver owns the sequence, the branching, the env and the wording. The agent running
// it renders one record verbatim, collects the answer, and feeds it back. It never chooses the next
// step, never composes a shell command, and never diagnoses off-path.
//
// Record types:
//   ask - a question. Either a CLOSED CHOICE (a known set, rendered as selectable options, never
//         hand-typed) or a NAMED FREE-TEXT field (a value the human reads off a dashboard).
//   do  - a manual action the human performs, then confirms with the single word `done`.
//   say - a message to show the human. No input.
//
// MECHANISM. `currentRecord(state)` is PURE - a total function of (cursor, env, goal, answers, flags),
// so every screen is testable with no live agent and no side effects. All I/O lives in `advance`, which
// is async and takes an injectable `deps`; tests pass fakes and no network is touched. The CLI at the
// bottom is the only real edge - it persists state to a gitignored file and prints ONE JSON record per
// call, which keeps every invocation a plain `npm run wizard:drive` with no compound shell and no JSON
// to quote.
//
// `done` IS VERIFIED, NOT TRUSTED. Where the driver can check real state by API it does, by calling the
// step functions in wizard.mjs (which already do the work and are tested) or the GitHub API directly.
// A verify runs at the FIRST point a credential for it exists, which is not always the screen that
// collected the input: the org and team are private, so nothing about them is checkable until the PAT is
// pasted at 4c. So the GitHub verify runs at 4c and checks org + team + token + capability at once, and
// a failure routes recovery to the screen that OWNS the wrong input (org -> 4a, team -> 4b, token -> 4c)
// rather than stranding the user at a `done` they cannot satisfy.
//
// A FAILED VERIFY NEVER ADVANCES. It emits that step's `recovery` - the known failure modes, as DATA -
// so the agent answers from the recovery and the step context instead of improvising. A question (any
// answer to a `do` that is not `done`) does the same and returns the user to the same `do`.
//
// THE DRIVER OWNS THE DEPLOYER'S TWO CONFIG FILES. `config-write` GENERATES both
// `src/config/repoaccess.config.ts` and `wrangler.jsonc` from the answers, because nothing else can: the
// step functions in wizard.mjs read files and copy templates but never write one (kv-create REPORTS the
// namespace id it created and leaves the wiring to a human), and the old prose path had the AGENT
// hand-edit both files - a role this driver deliberately removed. So the writing lands here, as one
// mechanism for both files: fill a named slot in the existing text and leave every other byte alone, so
// the templates' comments survive and the profile this run did not configure is preserved verbatim.
// Neither generated file is committed; both are gitignored and belong to the deployer.

import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  secretsFileFor,
  preflight,
  githubVerify,
  secretsCheck,
  deploy,
  deployHealth,
  e2e,
  resolveUrl,
  kvCreate,
  grantRecord,
  kvTitle,
  readWranglerConfig,
  parseJsonc,
  customDomainPattern,
  createGithubApi,
  readToken,
  parseWhoamiAccount,
  deriveSubdomain,
  subdomainCheck,
  runCommand,
} from './wizard.mjs'

export const ENVS = ['sandbox', 'production']
export const GOALS = ['full', 'quick']

// The product id a Quick run wires, so the synthetic check has something that maps to a team without
// ever opening Stripe. A Full run uses the real `prod_...` the deployer reads off the product page.
export const QUICK_PRODUCT_ID = 'prod_e2e'

// The confirmation word, and the ONLY word the wizard ever asks a human to type. Everything else is
// either a selectable option or a value read off a dashboard.
export const DONE = 'done'

// --- screen text --------------------------------------------------------------------------------
//
// Each screen's words are the record's payload and are approved verbatim; the tests pin them, so a
// drift from the approved wording fails a test rather than reaching a deployer. Placeholders are plain
// UPPERCASE (`YOUR-ORG`), never inside angle brackets - some agent renderers HTML-escape angle brackets
// and the deployer reads a literal `&lt;team-slug&gt;`, which looks like a broken wizard.

const WELCOME = `This wizard sets up your RepoAccess worker one verified step at a time. It runs the commands and edits the config files for you; you do the dashboard clicks and paste your own secrets. It never sees your secret values.

Two quick questions first - they set the whole run.`

const ENV_NOTE = `_This choice is about your worker, not your Stripe account. Even Production runs Stripe in test mode - going live with real cards is a separate, final step._`

// The road map, and the one prerequisite that has to be stated BEFORE the run starts spending the
// deployer's time: a second GitHub account. It is needed at 4d, which is most of an hour in, and a
// deployer who reaches that screen without one is blocked on account creation with the wizard parked.
// Both goals state it, because both need it - a check run against an account already in the org greens
// without proving the buyer's path (that is the same trap 4d's own verify exists to catch).
const ROAD_MAP_FULL = `Here is the full path ahead: (1) GitHub - org, team, repo, org hardening, and the worker's access token; (2) your worker's address; (3) Stripe - product, payment link, and webhook; (4) I write the config and deploy, once; (5) a synthetic check, then a real test purchase, a refund test, and an optional mistyped-handle test.

If you are configuring everything from scratch (new GitHub org, new Stripe account), budget about an hour; if your dashboards are already set up it is much faster. You can stop and resume - every step is re-runnable.

One prerequisite for every run: a **second GitHub account** to play the test buyer - NOT your org-owner account (an account already in your org never gets an invite, so it can't test the real path). A free throwaway account works. Create it now if you don't have one - I'll ask for its handle later.`

const ROAD_MAP_QUICK = `Quick path ahead: your GitHub side, the config, one deploy, and a synthetic end-to-end check - a few minutes once your org exists.

One prerequisite: a **second GitHub account** to play the test buyer - NOT your org-owner account (an account already in your org never gets an invite, so a check against it proves nothing about the path a real buyer takes). A free throwaway account works. Create it now if you don't have one - I'll ask for its handle later.`

const roadMap = (goal) => (goal === 'quick' ? ROAD_MAP_QUICK : ROAD_MAP_FULL)

// Two renderings, selected by the real `wrangler whoami` result - never by the agent. The signed-out
// one does NOT keep asserting "login - OK" above a line telling you to log in; the bullet flips and the
// "Everything's ready" line is dropped, because the workspace is not ready.
//
// Only the SECRETS template is named here, and that is now the whole truth of what this screen puts in
// place: the config and wrangler files are GENERATED later by config-write, from answers this screen has
// not collected yet, so promising them here would describe work that has not happened.
const preflightLead = (
  env,
) => `Setting up your workspace. I've checked your tools and put the secrets template in place:

- Node, wrangler, git - OK
- secrets template (\`${secretsFileFor(env)}\`) - created`

const preflightSignedIn = (env) => `${preflightLead(env)}
- Cloudflare login - OK, signed in as \`YOUR-ACCOUNT\`

Everything's ready. Next, your GitHub side. (I'll write your config and \`wrangler.jsonc\` for you later, once we have your product and KV details.)`

const preflightSignedOut = (env) => `${preflightLead(env)}
- Cloudflare login - **not signed in**

One thing before GitHub: run \`npx wrangler login\` - it opens your browser. Approve access, then I'll continue.`

const GITHUB_ORG = `You need a GitHub **organization** that owns the private repo(s) you'll sell. A personal account has no teams, so an org is required - a free one is fine.

What's your organization's slug? (the part in the URL: \`github.com/YOUR-ORG\`)`

// 4b asks ONE thing - the slug - and explains the one way to read it wrong. The slug, not the display
// name, is what `productTeamMap` keys on, so a team shown as "Pro Buyers" whose slug is `pro-buyers`
// is the failure this screen exists to prevent.
const GITHUB_TEAM = `Create the team that will carry access: **Org -> Teams -> New team**, named after the tier (e.g. \`pro\`).

Its **slug** is the lowercased, hyphenated part of the team URL - \`github.com/orgs/YOUR-ORG/teams/TEAM-SLUG\` - NOT the display name (a team shown as "Pro Buyers" has the slug \`pro-buyers\`).

What's the team slug?`

// The attach is the whole screen; the envs differ only in whether it may be deferred. A sandbox run may
// skip it and still prove the flow, a production run may not (and the worker token cannot verify it
// either way).
const TEAM_ATTACH_SANDBOX = `**Attach your private repo(s)** to the team at **Read**: Team -> Repositories -> **Add repository**. _For this sandbox test it's optional - a grant still proves the flow - but attach one before real buyers, or a grant unlocks nothing._`

const TEAM_ATTACH_PRODUCTION = `**Attach your private repo(s)** to the team at **Read**: Team -> Repositories -> **Add repository**. **Attach the repo(s) now.** I can't verify this with the worker token, so this one is on you: a grant without an attached repo unlocks nothing for the buyer.`

// 4b2 is its own screen so the repo attach is a visible action rather than a clause buried under the
// question that collects the slug. It is ATTACH-ONLY: Base permissions used to sit here as a second
// point and moved to the hardening walk, which now carries the whole Member-privileges list - naming it
// in both places would have the deployer set it, then read it again as though they had not.
//
// SANDBOX IS A CLOSED CHOICE, NOT A `done`. The attach is OPTIONAL on sandbox, and a bare `done` cannot
// say whether the human did it or deferred it - a live run answered `skip`, which the driver could not
// attribute to anything. So the options name the two real answers, the answer is recorded, and the
// sandbox closing's repo-attach reminder rides on it rather than being shown to every run regardless.
// Production keeps the `do -> done`: there the attach is required, so there is nothing to disambiguate.
const githubTeamLock = (env) =>
  env === 'production'
    ? `${TEAM_ATTACH_PRODUCTION}

Type **done** when the repo(s) are attached.`
    : TEAM_ATTACH_SANDBOX

// `skipped` is what arms the closing's repo-attach reminder.
const TEAM_LOCK_OPTIONS = [
  {
    value: 'attached',
    label: 'Done - repo attached',
    description: 'a grant will unlock the repo(s) you attached.',
  },
  {
    value: 'skipped',
    label: 'Skip for now',
    description:
      'the closing will remind you to attach the repo(s) before real buyers.',
  },
]

// 4b3: the org-hardening walk, ported from the GitHub walkthrough's hardening section - including its
// Base permissions bullet, which leads the list because it is the floor every other toggle sits on.
// Env-neutral: an org is hardened the same way whichever worker it feeds.
//
// TWO OF THESE ARE LOAD-BEARING, NOT HYGIENE, and both fail in ways that look like nothing at all:
// fine-grained PATs must be ALLOWED or the 4c token cannot manage the org at all (grants break), and
// org-wide 2FA must NOT be required or buyers without 2FA are removed and can never accept an invite -
// the product breaks on real customers while every test the owner runs stays green. The rest restrict
// members, which is the whole framing: a member here is a paying customer, not a teammate.
//
// Nothing on this screen is verifiable with the worker PAT (repository access Public repositories; these policies are
// not readable by it), so it advances on the human's word with recovery-only guidance - the same honest
// bargain 4b2 makes rather than pretending to check.
const ORG_HARDEN = `Now lock the org down - your members are paying customers, not teammates. These switches restrict members; owners keep full access. Everything is in **Org -> Settings**, and each block has its own **Save**:

**Member privileges:**

- **Base permissions** - **No permission**. This is the floor every member gets; left at Read, everyone already sees the repos and a grant proves nothing.
- **Repository creation** - uncheck Public and Private (members don't create repos).
- **Repository forking** - off.
- **Projects base permissions** - No access.
- **Pages creation** - uncheck Public and Private.
- **App access requests** - disable.
- **GitHub Apps** ("Allow repository admins to install...") - off.
- **Admin repository permissions** - all off: visibility change, deletion and transfer, issue deletion, branch renames.
- **Member team permissions** - Team creation off.

**Authentication security:**

- Do **NOT** "Require two-factor authentication for everyone" - it removes members without 2FA (your buyers) and blocks them from accepting invites. Enable 2FA on your own owner account instead.

**Third-party Access:**

- **OAuth app policy** - keep Access restricted.

**Personal access tokens -> Settings:**

- Under **Fine-grained personal access tokens** - select **Allow access via fine-grained personal access tokens**. The worker's token needs this; "Restrict" breaks grants.
- Under **Require approval of fine-grained personal access tokens** - select **Require administrator approval**. Your own owner-minted token is ready immediately; only members' tokens wait for approval.
- Under **Set maximum lifetimes for personal access tokens** - check **Fine-grained personal access tokens must expire** and set the maximum lifetime (366 days is the longest). The worker's token expires with it - GitHub emails you a reminder ahead; rotate the token then, or grants and revokes stop.

Type **done** when the checklist is set.`

// THE PASTE LINE IS A CODE BLOCK WITH THE PLACEHOLDER INSIDE IT, and that is not a formatting whim.
// `.dev.vars` is parsed as NAME=value, so a space around the `=` yields a name with a trailing space and
// the name-check reads the secret as missing two screens later. The earlier form put the placeholder
// OUTSIDE the backticks (`` `GITHUB_TOKEN=` _your token_ ``), which renders as a space right after the
// `=` - directly under an instruction saying not to leave one. The same shape is used at S-C.
const githubPat = (
  env,
) => `Create the token the worker uses to grant and revoke access:

GitHub -> Settings -> Developer settings -> **Fine-grained tokens** -> Generate new token.

- **Resource owner**: your organization (\`YOUR-ORG\`)
- **Repository access**: Public repositories (the minimal option; GitHub no longer offers None - do
  not select your private repos)
- **Organization permissions** -> **Members**: Read and write
- Nothing else.

Note the **expiry date** you choose - when it lapses, grants and revokes stop until you rotate the token.

**GitHub shows this token only once.** Before you leave that page, open **\`${secretsFileFor(env)}\`** and paste it on its own line, no spaces around the \`=\`:

\`GITHUB_TOKEN=YOUR-TOKEN\`

The file is gitignored, never committed, and I never read it. Type **done** when it's saved.`

const TEST_BUYER = `Last GitHub piece: a **second GitHub account** to play the test buyer. Not your org-owner account - the buyer flow is invite -> accept -> refund, and an account already in your org never gets an invite, so it can't test the real path. A free throwaway account works.

What's the test buyer's GitHub handle?`

// THE SUBDOMAIN IS ASKED, ALWAYS, and it used to be guessed. A fresh Cloudflare account is named after
// its login email ("dana@example.com's Account"), and the wizard slugified that name into
// `dana-example-com-s-account` and announced it as the worker's address - while the account's real
// subdomain was `dana`. Everything downstream (the provider webhook, the health check) was then wired to
// a hostname the account does not have. Nothing available to us can resolve it without guessing: the
// exact API needs a token we refuse to require, wrangler's stored credential is not ours to read, and a
// DNS probe proves existence rather than ownership. So the deployer reads it off their dashboard, and any
// candidate we have is offered as a default to CONFIRM, never as a fact to accept.

// Where the true value is read from. Spelled out here rather than imported from the step: this file is
// the source of truth for every dashboard route in the product, and the release check reads its literal
// text to hold the step and the docs to it.
const SUBDOMAIN_ROUTE =
  'Compute -> Workers & Pages -> Account Details (the panel on the right) -> Subdomain'

const SUBDOMAIN_PANEL = `**${SUBDOMAIN_ROUTE}**. It reads \`SOMETHING.workers.dev\`, and the subdomain is the part before \`.workers.dev\`.`

const WORKER_URL_SUBDOMAIN = `Your worker runs on your Cloudflare account's \`workers.dev\` subdomain, and I can't read that reliably - so you tell me what it is.

Open the Cloudflare dashboard: ${SUBDOMAIN_PANEL}

What's the subdomain?`

const WORKER_URL_SUBDOMAIN_GUESS = `Your worker runs on your Cloudflare account's \`workers.dev\` subdomain, and I can't read that reliably - so you tell me what it is.

Open the Cloudflare dashboard: ${SUBDOMAIN_PANEL}

My best guess from your account is \`SUBDOMAIN-GUESS\` - confirm that ONLY if it matches what the dashboard shows. What's the subdomain?`

// Emitted after the answer, and only after it: the address is now the deployer's own value, checked
// against Cloudflare, rather than something this wizard read off an account name.
const WORKER_URL_SANDBOX = `Your worker's address will be:

\`https://YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev\`

That's the subdomain you confirmed. I'll wire everything to this and check it's live after deploy.`

const WORKER_URL_PRODUCTION = `Your worker will run on your own domain. Which custom domain? (e.g. \`access.example.com\`)

Its zone must be on this same Cloudflare account - that's how the deploy provisions the DNS record and certificate. If the zone isn't here yet, add it to Cloudflare first.`

const STRIPE_PRODUCT = `Now Stripe. Keep the dashboard in **Test mode** (toggle, top of the page) - even a Production worker uses test Stripe until you go live at the end.

Create your product: **Product catalog -> Create product**. Name it and set a one-time price.

Open the product and copy its **product id** (\`prod_...\`, on the product page). What is it?`

// The redirect is the buyer's delivery path, and the route it must name is the FOUR-segment
// `/claim/by-txn/:adapter/:txn` one - the worker resolves a checkout session there. The two-segment
// `/claim/:token` is a different route that expects a claim TOKEN, so a session id posted at it is not
// a slow path, it is a dead one.
//
// The button is **Create test payment link** in Test mode, not "New" - live-confirmed in the dashboard
// (2026-07-16), and the wizard only ever runs Stripe in Test mode, so that is the only name a deployer
// on this screen can see.
const PAYMENT_LINK = `Create a Payment Link: **Payment Links -> Create test payment link -> Products or subscriptions**, select your product, quantity 1. Three things matter:

1. Collect the buyer's GitHub handle: **Advanced options -> Add custom fields**, add ONE field - Type **Text**, Label **GitHub username**.
2. Wire the redirect: open the **After payment** tab, and under **Confirmation page** choose **Don't show confirmation page**, then set the redirect URL to \`https://YOUR-WORKER-URL/claim/by-txn/stripe/{CHECKOUT_SESSION_ID}\` - paste \`{CHECKOUT_SESSION_ID}\` literally, braces and all; Stripe substitutes the real checkout-session id at redirect. This lets a buyer who mistypes their handle self-correct.
3. Tell the worker which product this is: after the link is created, open its **detail page**, scroll to **Metadata**, click **Edit metadata**, and add key \`product_id\` = \`PRODUCT-ID\` (the same \`prod_...\` from the last step). Stripe's checkout webhook omits line items, so the worker reads the product from this metadata - without it the sale maps to no team and grants nothing.

Type **done** when the link is created and the metadata is set.`

// The order here is the order Stripe's current Event destinations flow really asks for: the events come
// FIRST, then the endpoint URL. Naming them the other way round leaves the deployer hunting for a URL
// field that is not on screen yet.
const webhookSecret = (
  env,
) => `Create the webhook: **Developers -> Webhooks (Event destinations) -> Add destination**. Stripe's current flow selects the EVENTS FIRST, then the endpoint:

- Events - send exactly these three: \`checkout.session.completed\`, \`charge.refunded\`, \`charge.dispute.created\`.
- **Configure destination -> Endpoint URL:** \`https://YOUR-WORKER-URL/wh/stripe/YOUR-SECRET-PATH\` _(I generated the path - obscurity only, the worker doesn't validate it)_.

Create it, then reveal the **Signing secret** (\`whsec_...\`) with the eye icon and copy it. Open **\`${secretsFileFor(env)}\`** and paste it on its own line, no spaces around the \`=\`:

\`STRIPE_WEBHOOK_SECRET=YOUR-SIGNING-SECRET\`

_You can reveal and copy it again anytime from that page._

Type **done** when it's saved.`

const REVOKE_POLICY = `When a buyer refunds or charges back, what happens to their access?`

// The revoke line states what was actually wired, so `log_only` never reads as an automatic revoke.
const REVOKE_LINE = {
  auto_revoke: 'revoke: automatic',
  log_only: 'revoke: log only - access is kept on a refund',
}

// The production route line is only on a production run, because only a production run wires one - a
// sandbox worker answers on `workers.dev` and has no route to write.
const ROUTE_LINE =
  '\n- custom-domain route `YOUR-DOMAIN` wired into `wrangler.jsonc`'

const configWritten = (
  revokePolicy,
  env,
) => `Config wired - I write your config and \`wrangler.jsonc\` for you, you never hand-edit them:

- your org: \`YOUR-ORG\`
- product \`PRODUCT-ID\` -> team \`TEAM-SLUG\`, ${REVOKE_LINE[revokePolicy]}
- test buyer: \`TEST-HANDLE\`
- KV namespace wired into \`wrangler.jsonc\`${env === 'production' ? ROUTE_LINE : ''}`

// The custom-domain line is production-only: a `workers.dev` deploy has no DNS or certificate to wait on.
// It rides the ANNOUNCEMENT, not the result: the wait it describes happens during the deploy the
// announcement is introducing, so a deployer reading it afterwards is being warned about a pause already
// spent.
const PRODUCTION_PROPAGATION = `

_A custom domain needs a moment for DNS and its certificate - I'll wait, then check._`

// This screen ANNOUNCES the deploy, because the deploy runs on arrival at the next screen. Without the
// announcement the deployer sits through that pause with nothing on screen explaining it, and then reads
// the announcement and the outcome together, after the fact.
const secretNameCheck = (
  env,
) => `Both secret names are present in \`${secretsFileFor(env)}\` - good. Ready to deploy.

Deploying now - one deploy, with your secrets uploaded from \`${secretsFileFor(env)}\`. This provisions the worker and binds KV...${env === 'production' ? PRODUCTION_PROPAGATION : ''}`

// The measured RESULT only - the announcement above is what introduced the deploy.
const deployScreen =
  () => `Checking \`/health\`... OK. Your worker is live at \`https://YOUR-WORKER-URL\`.

Next up is a synthetic check - I'll give the brand-new worker's workflow a minute to register with Cloudflare first.`

// WHY THE SYNTHETIC CHECK WAITS BEFORE IT RUNS. On a FIRST deploy the workflow is created seconds
// before this event, and the Workflows EXECUTION plane can lag the deploy: the worker acks, the
// instance is created, and it then errors "Worker not found" before its first step - a green webhook
// and no invite, for a setup that is entirely correct. So the driver pauses on arrival, before the
// check, and the deploy screen says so rather than leaving the deployer watching a stalled prompt. It
// pauses on EVERY run: a driver that guessed which deploys were "first" would be guessing about prior
// state, which is the one thing it never does. Rejected: a ping step inside the engine - that is a test
// affordance in the released money path, and this check already IS the full ping.
const WORKFLOW_REGISTER_PAUSE_MS = 45_000

// The synthetic check sends ONE signed `checkout.session.completed` and proves the GRANT path. The
// cleanup is the CHECK's own direct GitHub DELETE - it never sends `charge.refunded`, so the worker's
// revoke path is not exercised here, and the wording says so. A Full run is what tests refunds.
const syntheticCheck = (
  goal,
) => `Running a quick synthetic check, so nothing surprises you: I build a fake but correctly-signed Stripe event and send it to your worker, which sends a **real** GitHub invite to \`TEST-HANDLE\`; the check then cancels it automatically. One invite email, one cancellation - no money, nothing to accept...

Synthetic check **green**. ${
  goal === 'full'
    ? "Now let's do it for real."
    : "Your grant path works end to end - a signed event in, a real GitHub invite out. Refunds aren't tested here; a Full run does that."
}`

const PURCHASE = `Open your Payment Link and buy the product with Stripe's test card:

1. **Email** - any address you can access; it's only where Stripe sends the receipt.
2. **GitHub username** - enter \`TEST-HANDLE\` in the **GitHub username** field.
3. **Card** \`4242 4242 4242 4242\`, any future expiry, any CVC. Fill the rest (name, address, ZIP) with anything valid.
4. Click **Pay**.

Type **done** when the payment goes through.`

const AWAITING_GRANT = `Stripe redirects you to your worker's **"setting up your access"** page. It refreshes on its own - the grant can take up to a minute.

When it shows access granted, type **done**.`

// `done` here has to mean TWO things, because accepting an invitation and holding the access are two
// different states and the next step depends on the second. GitHub itself says so: the acceptance is
// answered with a banner warning that access can take a moment, so a deployer who types `done` the
// instant they click accept is reporting a state that has not arrived. The screen therefore names the
// banner, gives the one refresh that settles it, and makes the done-condition the membership rather than
// the click.
const ACCEPT_INVITE = `Now open the inbox of your **second** GitHub account - the one whose username you entered at checkout. There's an email inviting \`TEST-HANDLE\` to the organization.

Open it **in the browser tab where you're logged in as \`TEST-HANDLE\`**, not your main account, and accept the invitation. (Or skip the email: open \`https://github.com/orgs/YOUR-ORG/invitation\` in the browser where you're logged in as \`TEST-HANDLE\`.)

GitHub answers the acceptance with a banner saying access can take a moment to come through. Refresh \`https://github.com/YOUR-ORG\` in that same tab and you will see what \`TEST-HANDLE\` now has access to.

Type **done** when you've accepted AND you can see \`TEST-HANDLE\` in the organization with the team membership.`

// WHICH payment to refund, named as precisely as this run can name it. The grant-record probe reads the
// REMOTE grant record and fills `PI-ID` with the real `pi_...`, so the deployer is pointed at the exact
// transaction instead of hunting through a Transactions list - and it resolves that id by difference
// against a pre-purchase snapshot, so a store that already held other runs' grants still names this
// run's payment. When the lookup cannot single one out the screen says so in plain terms rather than
// naming a payment it did not resolve - an unfilled slot left literal would print the words `PI-ID` to
// a deployer.
const paymentRef = (piId) =>
  piId ? 'payment `PI-ID`' : 'your test payment (the `$...` one from this run)'

// The Transactions path (row -> **...** -> **Refund payment**) is maintainer-live-confirmed, 2026-07-16.
// The earlier "Payments -> the payment -> Refund" left the deployer to find both the list and the control.
const refundPath = (piId) =>
  `open **Transactions**, find ${paymentRef(piId)}, click the **...** button at the end of its row -> **Refund payment**`

// E5 branches on the 6a policy, because the two policies make OPPOSITE things true. Under `auto_revoke`
// the worker removes the buyer; under `log_only` it deliberately does not (workflow.ts returns early),
// so the honest proof there is that access was KEPT. Asserting removal under log_only would fail forever
// on a worker behaving exactly as configured.
//
// The auto_revoke done-condition names the REMOVAL, not just the refund: the verify checks membership, so
// a `done` typed the instant Stripe confirms the refund races the worker and parks a needless recovery.
// The log_only branch has no removal to wait for, which is why only this branch says it.
const refundScreen = (revokePolicy, piId) =>
  revokePolicy === 'log_only'
    ? `Now confirm your **Log only** policy. In Stripe, ${refundPath(piId)}, full amount. Because you chose Log only, the worker records the refund but keeps access - so \`TEST-HANDLE\` should **still** be in the team. Check they're still there, then type **done**.`
    : `Now test a refund. In Stripe, ${refundPath(piId)}, and refund the **full amount**. Your worker should remove \`TEST-HANDLE\` from the team.

Type **done** when the refund is through and \`TEST-HANDLE\` has been removed from the team and the org - GitHub also emails them a removal notice.`

// --- E6, the optional typo/claim test -----------------------------------------------------------
//
// The old orchestrator made this MANDATORY; here it is offered, because it costs a second purchase and a
// second refund and a deployer who has already seen the money flow may not want to pay for it in time.
// The choreography is a PORT of the validated Stripe walkthrough's typo-path section: buy with a handle
// GitHub has never heard of, get carried to the claim page by the SAME redirect a real buyer uses, enter
// the good handle there, accept, then refund the second purchase to leave the org as it was found.
//
// AUTO_REVOKE ONLY, and that is a correctness bound, not a preference. Under `log_only` E5 leaves the
// buyer on the team (workflow.ts returns before any DELETE), so the claim grant here reconciles to a
// no-op - no new invite fires, and the two verifies below would pass before the deployer did anything.
// A step whose check greens without the human is worse than no step. The walkthrough's own ordering
// assumes the same thing: the typo test reuses the handle precisely BECAUSE the refund freed it.

const TYPO_TEST_OFFER = `One more thing you can prove, optional: what a buyer sees after mistyping their GitHub username - the claim page that lets them self-correct. It takes one more test purchase and a second refund to clean up.`

const TYPO_TEST_OPTIONS = [
  {
    value: 'test',
    label: 'Test the typo path',
    description:
      'buy again with a fake handle and watch the claim page catch it.',
  },
  {
    value: 'skip',
    label: 'Skip',
    description:
      "the path is built in and ships either way; this run just won't demonstrate it.",
  },
]

// The handle GitHub has never heard of. GENERATED once per run rather than fixed: a literal example
// printed in every copy of this wizard is a handle somebody eventually registers, and then the typo test
// invites a stranger to the deployer's org. `nouser-` keeps it readable as what it is; the 12 random
// base36 characters make a collision with a real account vanishingly unlikely. 19 characters, letters,
// digits and one hyphen - inside GitHub's username shape, so the checkout field accepts it.
const TYPO_HANDLE_CHARS = 12

export function makeTypoHandle(random = Math.random) {
  let suffix = ''
  for (let i = 0; i < TYPO_HANDLE_CHARS; i++) {
    suffix += Math.floor(random() * 36).toString(36)
  }
  return `nouser-${suffix}`
}

// Same link, same card, same field order as E2 - the ONLY change is the handle, and saying so is what
// stops a deployer re-reading the whole checkout flow.
const TYPO_PURCHASE = `Buy the product once more on the same Payment Link. Everything is as it was at the first purchase except the handle:

1. **Email** - any address you can access, as before.
2. **GitHub username** - enter \`TYPO-HANDLE\` this time. That is the typo we are simulating: a handle GitHub has never heard of.
3. **Card** \`4242 4242 4242 4242\`, any future expiry, any CVC.
4. Click **Pay**.

The worker will not find that account. Instead of failing the sale it falls back to the claim page - and the redirect carries you straight there, which is the thing worth seeing. (It may show a neutral "setting up your access" state for a moment first, then resolve on its own.)

Type **done** when the payment goes through.`

// The claim page is the payoff, so the screen names what it looks like. The neutral-state warning lives on
// the PURCHASE screen above, not here: it has to be read BEFORE the redirect lands, or the deployer meets
// the state the warning describes with the warning still one screen away.
const TYPO_CLAIM = `You should be on the **claim page** now - the redirect resolved your mistyped purchase to a page that lets the buyer fix it.

Enter \`TEST-HANDLE\` there and submit. That handle is free to reuse - the refund at the last step revoked it. The grant then completes exactly as it did for the real purchase, and GitHub sends a fresh invite.

Type **done** when the claim page shows access granted.`

// Same done-condition as the first acceptance screen, and for the same reason: the click and the access
// are two states, and this run's remaining step depends on the second. It says "the same banner" because
// the deployer has met it once already on this run, so naming it again is a reminder rather than a
// lesson.
const TYPO_ACCEPT = `Accept the new invite the way you did before: open it **in the browser tab where you're logged in as \`TEST-HANDLE\`**. (Or open \`https://github.com/orgs/YOUR-ORG/invitation\` in that same tab.)

This is the half people assume is different: a claim-page grant creates a real GitHub invitation exactly like a direct one, and the buyer becomes a member only once they accept it.

The same banner appears as last time, saying access can take a moment. Refresh \`https://github.com/YOUR-ORG\` in that tab to see what \`TEST-HANDLE\` has access to now.

Type **done** when you've accepted AND you can see \`TEST-HANDLE\` in the organization with the team membership.`

// The second refund is CLEANUP, not another policy test - E5 already proved the revoke. Its `PI-ID` is a
// FRESH lookup: E5's revoke deleted the first grant record, so the probe on arrival here resolves the
// claim grant this test just created, again as the one id the pre-purchase baseline does not hold.
const typoRefund = (
  piId,
) => `Last step - clean up the second purchase exactly as you cleaned up the first. In Stripe, ${refundPath(piId)}, and refund the **full amount**. Your worker should remove \`TEST-HANDLE\` from the team again.

Type **done** when refunded and \`TEST-HANDLE\` is removed from the team again.`

// The repo-attach reminder rides only on the sandbox closings, because only a sandbox run is allowed to
// skip the attach; a production run was told to do it and could not be verified either way. It is now
// CONDITIONAL on the 4b2 answer: the driver knows whether the repo was attached, so showing "if you
// skipped it" to a run that did not skip it would be the driver misdescribing its own run.
const REPO_ATTACH_REMINDER = `_If you skipped the repo attach: attach your private repo(s) to team \`TEAM-SLUG\` at Read before any real buyer - right now a grant unlocks nothing._`

const TOKEN_EXPIRY_REMINDER = `_Your token expires on the date you set - when it lapses, grants and revokes stop until you rotate it._`

// The refund clause branches with the 6a policy for the same reason E5 does: a `log_only` run proved
// RETENTION, not revocation, so claiming "refund/revoke all worked" would describe a run that never
// happened.
const REFUND_CLAUSE = {
  auto_revoke: 'refund/revoke all worked',
  log_only:
    'the refund was recorded and access was kept, per your Log only policy',
}

// The claim-path parenthetical branches on whether E6 actually RAN. The old unconditional line said the
// run "didn't live-test it" - true of every run until E6 existed, and false the moment one does. A
// closing that describes a test the deployer just watched as untested is the same class of defect as a
// say that reports an outcome it never measured.
const CLAIM_PATH_CLAUSE = {
  tested:
    'A buyer who mistypes their handle self-corrects on the claim page - this run live-tested that path too.',
  untested:
    "A buyer who mistypes their handle self-corrects on the claim page - that path is built in; this run didn't live-test it.",
}

// The tail of a sandbox closing. The repo-attach reminder is here only when 4b2's `skip` option was the
// answer; the token-expiry one is on every closing, because every run minted a token.
const closingReminders = (repoAttached) =>
  [
    ...(repoAttached === 'skipped' ? [REPO_ATTACH_REMINDER] : []),
    TOKEN_EXPIRY_REMINDER,
  ].join('\n')

const closingFullSandbox = (
  revokePolicy,
  claimPath,
  repoAttached,
) => `Done - your sandbox worker is proven end to end: purchase -> invite -> ${REFUND_CLAUSE[revokePolicy] ?? REFUND_CLAUSE.auto_revoke}. (${CLAIM_PATH_CLAUSE[claimPath]})

**What you have:** a working worker on \`workers.dev\`, the core money flow verified.
**What you don't have yet:** this is not a selling setup. The worker is on a \`workers.dev\` subdomain and Stripe is in test mode - nothing here can take a real payment.

**To sell for real:**
1. Run this wizard again and choose **Production** - that puts the worker on your own domain.
2. Then go live in Stripe: rebuild the product, Payment Link, and webhook in your **live** dashboard, put the live product id in your config and the live signing secret in your secrets, deploy again. See \`docs/user-guide-stripe.md\`, "Going live".

${closingReminders(repoAttached)}`

const CLOSING_FULL_PRODUCTION = `Done - your production worker is live on \`YOUR-DOMAIN\` and proven end to end.

**One thing stands between you and selling: Stripe is still in test mode.** To take real money:
- Rebuild the product, Payment Link, and webhook in your **live** Stripe dashboard.
- Put the **live product id** in \`productTeamMap\` and the **live signing secret** in \`STRIPE_WEBHOOK_SECRET\` (\`.dev.vars.production\`).
- Deploy again, then prove it with one real-card purchase and a refund. Stripe keeps the processing fee on a refund - a few cents, and the cheapest certainty you'll buy.

See \`docs/user-guide-stripe.md\`, "Going live", for the two failure modes: wrong secret -> \`401\`; wrong product id -> \`200\` and nothing granted.

**Do not hand your test Payment Link to a customer.**
${TOKEN_EXPIRY_REMINDER}`

const closingQuickSandbox = (
  repoAttached,
) => `Done - your sandbox worker is deployed on \`workers.dev\`, and the synthetic test proved the grant path end to end: a signed event in, a real GitHub invite out, then cleaned up.

**What this run did NOT do:** it didn't touch Stripe, prove a real purchase, or test the refund path - a Quick check skips the dashboard on purpose. So this isn't a selling setup, and nothing here can take money.

**When you're ready to sell:** run this wizard again as a **Full setup** - it wires Stripe and proves a real test purchase - then set up **Production** and go live. See \`docs/user-guide-stripe.md\`.

${closingReminders(repoAttached)}`

const CLOSING_QUICK_PRODUCTION = `Done - your production worker is deployed on \`YOUR-DOMAIN\`, and the synthetic test proved the grant path end to end.

**What this run did NOT do:** it didn't touch Stripe, prove a real purchase, or test the refund path - a Quick check skips the dashboard. Nothing here can take money yet.

**To sell:** run a **Full setup** to wire Stripe and prove a real test purchase, then go live in your **live** Stripe dashboard. See \`docs/user-guide-stripe.md\`, "Going live".

${TOKEN_EXPIRY_REMINDER}`

// Which claim-path clause the closing earned. E6 is the only screen that can live-test it, so `tested`
// requires the answer that RAN it - not merely that the screen was in the sequence.
function claimPathOf(state) {
  return state.answers?.typoTest === 'test' ? 'tested' : 'untested'
}

const closing = (state) => {
  const env = envOf(state)
  const a = state.answers ?? {}
  if (goalOf(state) === 'quick') {
    return env === 'production'
      ? CLOSING_QUICK_PRODUCTION
      : closingQuickSandbox(a.repoAttached)
  }
  return env === 'production'
    ? CLOSING_FULL_PRODUCTION
    : closingFullSandbox(a.revokePolicy, claimPathOf(state), a.repoAttached)
}

// --- placeholders -------------------------------------------------------------------------------

// The slots the driver can fill truthfully. Most come from answers it already holds; `YOUR-ACCOUNT` comes
// from the real `wrangler whoami` the preflight probe ran, and the URL slots from the real resolve-url
// step. A slot is filled only once the value EXISTS - an unfilled slot stays literal on purpose, because
// filling it with a guess would be the same false green as reporting "OK" for a check that never ran.
export function facts(state) {
  const a = state.answers ?? {}
  const out = {}
  if (a.org) out['YOUR-ORG'] = a.org
  if (a.team) out['TEAM-SLUG'] = a.team
  if (a.testBuyer) out['TEST-HANDLE'] = a.testBuyer
  if (a.domain) out['YOUR-DOMAIN'] = a.domain
  const product = productIdFor(state)
  if (product) out['PRODUCT-ID'] = product
  if (state.flags?.account) out['YOUR-ACCOUNT'] = state.flags.account
  // The subdomain the account SUGGESTS, for the one question that offers it as a default to confirm. It
  // is filled only where a candidate exists; the screen with no candidate is a different string, not this
  // one with an empty slot.
  if (state.flags?.subdomainCandidate)
    out['SUBDOMAIN-GUESS'] = state.flags.subdomainCandidate
  // resolve-url's outputs. The worker URL arrives with its scheme, but the screens print it inside an
  // explicit `https://...` - so the slot carries the HOST, and the scheme stays in the approved text.
  const workerUrl = state.flags?.workerUrl
  if (workerUrl) {
    out['YOUR-WORKER-URL'] = workerUrl.replace(/^https:\/\//, '')
    out['YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev'] = out['YOUR-WORKER-URL']
  }
  if (state.flags?.secretPath) out['YOUR-SECRET-PATH'] = state.flags.secretPath
  // The refund screens' payment id, resolved by the grant-record probe on arrival. Unfilled when the
  // lookup could not single one out - and those screens then word themselves without the slot, because a
  // literal `PI-ID` printed at a deployer is the same false note as a guessed value.
  if (state.flags?.piId) out['PI-ID'] = state.flags.piId
  // The typo test's fake handle, minted once when the offer is taken. A slot rather than a literal so
  // every screen and recovery that names it renders the SAME handle - the deployer types it at checkout
  // and reads it back on the claim page.
  if (state.flags?.typoHandle) out['TYPO-HANDLE'] = state.flags.typoHandle
  // Recovery text names the file THIS run reads. Sourced from wizard.mjs's own secretsFileFor, so the
  // driver cannot disagree with the step about which file that is.
  if (a.env) out['SECRETS-FILE'] = `\`${secretsFileFor(a.env)}\``
  return out
}

// Quick never opens Stripe, so it wires the synthetic product id; Full wires the real one from S-A.
export function productIdFor(state) {
  const a = state.answers ?? {}
  if (a.goal === 'quick') return QUICK_PRODUCT_ID
  return a.productId ?? null
}

// Substitute the known slots. Longest key first, so a key that is a prefix of another (`YOUR-WORKER`
// inside `YOUR-WORKER-URL`) can never corrupt the longer one.
export function fill(text, factsMap) {
  const keys = Object.keys(factsMap).sort((a, b) => b.length - a.length)
  let out = text
  for (const key of keys) out = out.split(key).join(factsMap[key])
  return out
}

// --- execution seam -----------------------------------------------------------------------------
//
// Everything that touches the network, the filesystem or a child process comes through here, so the
// tests drive every verify with fakes and no live agent, no GitHub, no wrangler.

// Mirrors wizard.mjs's own private wrangler runner. Duplicated deliberately rather than exported from
// there: the `wizard:<step>` path is still the live working path, so this build leaves that file
// byte-untouched.
const wranglerRunner = (cwd) => (args) =>
  runCommand('npx', ['wrangler', ...args], { cwd })

/**
 * Translate the driver's env into the one the step functions actually speak. The driver carries
 * 'sandbox' | 'production' because those are the words the human chose; wizard.mjs carries null |
 * 'production', and its CLI collapses `sandbox` to null on the way in for exactly that reason ("null IS
 * sandbox everywhere downstream").
 *
 * This is not cosmetic. Passing the literal 'sandbox' through makes `deploy` read `env.sandbox` out of
 * wrangler.jsonc - a key that does not exist - so it refuses on a placeholder KV id even when the real
 * id is wired, and, had it got past that, would have run `deploy --env sandbox --secrets-file
 * .dev.vars.production`: the wrong environment, uploading the wrong secrets file. Every call into a step
 * goes through here.
 */
export function stepEnv(state) {
  return envOf(state) === 'production' ? 'production' : null
}

export function defaultDeps(cwd = process.cwd()) {
  return {
    cwd,
    run: wranglerRunner(cwd),
    preflight: (opts) => preflight({ cwd, ...opts }),
    githubVerify: (opts) => githubVerify({ cwd, ...opts }),
    secretsCheck: (opts) => secretsCheck({ cwd, ...opts }),
    deploy: (opts) => deploy({ cwd, ...opts }),
    // The deploy's /health half on its own, so a retry over a worker that is already published re-probes
    // it instead of publishing a second version. Takes a url, not a cwd.
    deployHealth: (opts) => deployHealth(opts),
    e2e: (opts) => e2e({ cwd, ...opts }),
    resolveUrl: (opts) => resolveUrl({ cwd, ...opts }),
    // The answered subdomain, checked for existence before anything is wired to it.
    subdomainCheck: (opts) => subdomainCheck({ cwd, ...opts }),
    kvCreate: (opts) => kvCreate({ cwd, ...opts }),
    grantRecord: (opts) => grantRecord({ cwd, ...opts }),
    readToken: (env) => readToken(cwd, { env }),
    createApi: (token) => createGithubApi(token),
    // A seam like every other: the tests drive the arrival pause without ever spending its 45 seconds.
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    // The typo handle's randomness, injectable so the tests pin a deterministic handle.
    random: () => Math.random(),
    // The generator's only contact with the disk. Seams, so the config tests run in a temp cwd (and the
    // pure-text generation is testable with no disk at all).
    readFile: (rel) => {
      const abs = join(cwd, rel)
      return existsSync(abs) ? readFileSync(abs, 'utf8') : null
    },
    writeFile: (rel, text) => writeFileSync(join(cwd, rel), text),
  }
}

// The config the driver hands the step functions. The real config file is not written until the config
// step, and the GitHub checks are needed before that, so the driver builds the config from the answers
// it already holds rather than reading a file that does not describe this run yet.
export function draftConfig(state) {
  const a = state.answers ?? {}
  // At 4c the product id is not known yet on a Full run (S-A comes later), but the TEAM is - and the
  // team is what the GitHub checks read. A placeholder key carries it; collectTeams walks the values.
  const productKey = productIdFor(state) ?? 'prod_pending'
  const mapped =
    a.team && productKey
      ? {
          [productKey]: {
            teams: [a.team],
            grant_mode: 'username',
            revoke_policy: { mode: a.revokePolicy ?? 'auto_revoke' },
          },
        }
      : {}
  return {
    githubOrg: a.org ?? '',
    productTeamMap: {
      stripe: mapped,
      defaults: {
        teams: [],
        grant_mode: 'claim',
        revoke_policy: { mode: 'log_only' },
      },
    },
    // Only once the buyer is known: testBuyerCheck is a no-op without it, which is exactly what the 4c
    // verify wants (the buyer has not been asked for yet). `url` and `secretPath` join it once
    // resolve-url has run - the synthetic check reads BOTH from here, and refuses to run without a url.
    // These are the same values config-write writes to disk, from the same answers, so the draft the
    // verifies read and the file the worker reads cannot disagree.
    ...(a.testBuyer ? { e2e: e2eBlock(state) } : {}),
  }
}

/** The `e2e` block. One source, so the draft the verifies read and the written config always match. */
function e2eBlock(state) {
  const f = state.flags ?? {}
  return {
    testUsername: state.answers?.testBuyer,
    ...(f.workerUrl ? { url: f.workerUrl } : {}),
    ...(f.secretPath ? { secretPath: f.secretPath } : {}),
  }
}

// --- the generator ------------------------------------------------------------------------------
//
// ONE mechanism for both deployer files: find a named SLOT in the file's existing text, replace just
// that slot's value, and leave every other byte exactly where it was. Never parse-and-reserialize -
// that would strip the templates' comments (which are what explain the config to the deployer) and, in
// wrangler.jsonc, the trailing commas too.
//
// Two properties fall out of "only ever touch this run's slot", and both are requirements:
//   - the profile / environment this run did NOT configure is preserved byte-for-byte, so a later
//     production run cannot clobber the sandbox values an earlier run wired (and vice versa);
//   - the `.example` templates need no wizard-shaped markers, so the manual path is untouched - a human
//     still uncomments the same route and replaces the same PLACEHOLDER id.
//
// Every write is then CHECKED by re-reading the result: the KV id and the route are confirmed by
// re-parsing the emitted JSONC through the same readers the deploy step uses. Text surgery you did not
// verify is a guess, and a guess here deploys a worker with somebody else's binding.

export const CONFIG_PATH = 'src/config/repoaccess.config.ts'
export const WRANGLER_PATH = 'wrangler.jsonc'

/**
 * Render a value as TypeScript/JSON source. Everything the deployer typed - an org slug, a team slug, a
 * product id, a handle, a domain - goes through JSON.stringify, so it is DATA: a stray quote, brace or
 * space cannot end the literal early or inject syntax. Keys get the same treatment, because a product id
 * is a key.
 */
export function emitValue(value, indent = '  ') {
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]'
    return `[${value.map((v) => emitValue(v, indent)).join(', ')}]`
  }
  if (value && typeof value === 'object') {
    const inner = `${indent}  `
    const entries = Object.entries(value).map(
      ([key, v]) => `${inner}${JSON.stringify(key)}: ${emitValue(v, inner)},`,
    )
    if (entries.length === 0) return '{}'
    return `{\n${entries.join('\n')}\n${indent}}`
  }
  return JSON.stringify(value)
}

/**
 * The config object for ONE profile, exactly as the worker will read it.
 *
 * The nesting is load-bearing: `resolveProductConfig` looks up `map[adapter][product_id]`, so the entry
 * MUST sit under the `stripe` key, keyed by the product id. A ProductConfig placed directly on the
 * adapter key still typechecks - and then resolves to nothing, falling through to `defaults`, whose
 * teams are empty. That is the trap where the webhook verifies, acks 200, and grants nobody anything.
 * `defaults` must be present for the same family of reasons: the Workflow asserts it and throws without.
 */
export function profileConfig(state) {
  const a = state.answers ?? {}
  const productId = productIdFor(state)
  return {
    githubOrg: a.org ?? '',
    productTeamMap: {
      stripe: {
        [productId]: {
          teams: [a.team],
          grant_mode: 'username',
          revoke_policy: { mode: a.revokePolicy ?? 'auto_revoke' },
        },
      },
      defaults: {
        teams: [],
        grant_mode: 'claim',
        revoke_policy: { mode: 'log_only' },
      },
    },
    e2e: e2eBlock(state),
  }
}

/**
 * Replace the right-hand side of `export const <name>: RepoAccessConfig = <RHS>`.
 *
 * The RHS is the slot. Everything else in the file - the SPDX header, the import, the explanatory
 * docblock, the neutral `base`, and the OTHER profile's export - is untouched, which is what makes a
 * second run safe: a production run rewrites `production` and cannot disturb the sandbox values.
 *
 * Returns null when the export is not found or its RHS is not a shape we recognise (an identifier such
 * as the template's `base`, or a balanced object literal). Null is reported as a failed check - never
 * repaired by guessing, because the file being unrecognisable means a deployer edited it and we are
 * about to overwrite their work.
 */
export function setProfile(text, name, rhs) {
  const anchor = `export const ${name}: RepoAccessConfig =`
  const at = text.indexOf(anchor)
  if (at === -1) return null
  let i = at + anchor.length
  while (i < text.length && (text[i] === ' ' || text[i] === '\t')) i++
  const end = text[i] === '{' ? endOfObject(text, i) : endOfIdentifier(text, i)
  if (end === null) return null
  return text.slice(0, i) + rhs + text.slice(end)
}

/** Walk a balanced `{...}`, honouring strings so a brace inside one cannot end the scan early. */
function endOfObject(text, start) {
  let depth = 0
  let quote = null
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (quote) {
      if (ch === '\\') i++
      else if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') quote = ch
    else if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return i + 1
    }
  }
  return null
}

/** The template's RHS is the bare identifier `base`; accept that and nothing more exotic. */
function endOfIdentifier(text, start) {
  const rest = text.slice(start)
  const match = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(rest)
  return match ? start + match[0].length : null
}

/**
 * Generate `src/config/repoaccess.config.ts`: this run's profile becomes a literal, the other profile is
 * left exactly as it was. On a first run "as it was" is the template's `base` - a valid, NEUTRAL config -
 * which is precisely what the unconfigured profile should be, and why the untouched-slot rule already
 * satisfies the both-profiles-must-typecheck requirement without special-casing it. `tsc` checks
 * src/index.ts (sandbox) AND src/index.production.ts (production), so a file missing either export fails
 * the build even when only one env is being deployed.
 */
export function generateConfig(text, state) {
  const env = envOf(state)
  return setProfile(text, env, emitValue(profileConfig(state)))
}

/** The id currently wired for a binding, per env. Mirrors wizard.mjs's own private reader. */
function wiredKvId(config, env, binding = 'ENTITLEMENTS') {
  const scope = env === 'production' ? config?.env?.production : config
  const list = scope?.kv_namespaces ?? []
  return list.find((ns) => ns.binding === binding)?.id ?? null
}

/**
 * Point this env's ENTITLEMENTS binding at `id`.
 *
 * The slot is located by the id currently sitting in it - read by PARSING the file, so we know exactly
 * which of the two ENTITLEMENTS blocks (top-level = sandbox, env.production) we mean - and then replaced
 * as TEXT so the comments survive. Matching on the current value is what disambiguates the two blocks
 * without pretending to know the file's layout; if that value is not uniquely findable we return null
 * rather than edit the wrong environment's binding.
 */
export function setKvId(text, env, id) {
  const current = wiredKvId(parseJsonc(text), env)
  if (current === id) return text
  if (!current) return null
  const needle = JSON.stringify(current)
  const first = text.indexOf(needle)
  if (first === -1 || first !== text.lastIndexOf(needle)) return null
  return (
    text.slice(0, first) +
    JSON.stringify(id) +
    text.slice(first + needle.length)
  )
}

// The template ships the production route COMMENTED OUT, so that a fresh clone (and the manual path)
// can deploy without a domain. This anchor is those exact lines; a test pins that the template still
// contains it, so an edit to the template fails loudly here rather than silently skipping the route.
const ROUTE_ANCHOR =
  /[ \t]*\/\/ Production custom domain \(uncomment \+ set your domain[^\n]*\n[ \t]*\/\/[^\n]*\n[ \t]*\/\/ "routes": \[\n[ \t]*\/\/[^\n]*\n[ \t]*\/\/ \]\n/

/**
 * Wire the production custom-domain route. Without it `npx wrangler deploy --env production` never serves
 * the domain at all: it publishes to workers.dev, `/health` answers there, and the run reports the
 * worker live on a hostname it is not on.
 *
 * Two shapes: the commented-out template block (first run) becomes a real route; an already-live route
 * (a re-run, or a hand-wired file) has its pattern replaced. Anything else returns null.
 */
export function setProductionRoute(text, domain) {
  const live = customDomainPattern(parseJsonc(text), 'production')
  if (live === domain) return text
  if (live) {
    const needle = JSON.stringify(live)
    const at = text.indexOf(needle)
    if (at === -1) return null
    return (
      text.slice(0, at) +
      JSON.stringify(domain) +
      text.slice(at + needle.length)
    )
  }
  const match = ROUTE_ANCHOR.exec(text)
  if (!match) return null
  const indent = /^[ \t]*/.exec(match[0])[0]
  const block =
    `${indent}// Production custom domain: the zone must be on THIS Cloudflare account, or wrangler cannot\n` +
    `${indent}// provision the DNS record + certificate on deploy.\n` +
    `${indent}"routes": [{ "pattern": ${JSON.stringify(domain)}, "custom_domain": true }],\n`
  return (
    text.slice(0, match.index) +
    block +
    text.slice(match.index + match[0].length)
  )
}

/**
 * Generate `wrangler.jsonc`: this env's KV id, plus the custom-domain route on a production run. Returns
 * { text } or { error } naming the slot that could not be filled.
 */
export function generateWrangler(text, state, kvId) {
  const env = envOf(state)
  const withKv = setKvId(text, env, kvId)
  if (withKv === null) {
    return {
      error: `Could not find the ENTITLEMENTS namespace id to replace in ${WRANGLER_PATH} (${env}).`,
    }
  }
  if (env !== 'production') return { text: withKv }
  const withRoute = setProductionRoute(withKv, state.answers.domain)
  if (withRoute === null) {
    return {
      error: `Could not find the custom-domain route slot in ${WRANGLER_PATH} - expected either the commented-out template block or a live routes entry.`,
    }
  }
  return { text: withRoute }
}

// Never throw on a failed request - report it, the same way wizard.mjs's own private helper does.
async function safeGet(api, path) {
  try {
    const res = await api.get(path)
    return { status: res.status ?? 0, json: res.json ?? null }
  } catch {
    return { status: 0, json: null }
  }
}

const enc = encodeURIComponent

/**
 * The one endpoint E3, E4 and E5 all read, and the same one the synthetic check polls:
 * 'pending' = invited, not yet accepted; 'active' = accepted; 'none' = not on the team; null = unknown
 * (an environment artifact, never proof either way). Confirming by the invite rather than by reading KV
 * is deliberate - a KV read defaults to the LOCAL store while the deployed worker writes REMOTE.
 */
export async function teamMembership(api, org, team, username) {
  const res = await safeGet(
    api,
    `/orgs/${enc(org)}/teams/${enc(team)}/memberships/${enc(username)}`,
  )
  if (res.status === 200) return res.json?.state ?? null
  if (res.status === 404) return 'none'
  return null
}

// --- verifies -----------------------------------------------------------------------------------
//
// A verify returns { ok } or { ok: false, owner, detail }. `owner` is the screen that owns the WRONG
// INPUT, which is not always the screen being verified: the GitHub checks all run at 4c (the first point
// a token exists), so a bad org routes back to 4a and a bad team slug back to 4b. Without that, a typo'd
// slug would strand the user on a `done` they can never satisfy.

/** Which screen owns the input a failing github-verify check tests. */
export function ownerForCheck(name) {
  if (/^org '.*' exists/.test(name)) return 'github-org'
  if (/^team '.*' exists/.test(name)) return 'github-team'
  if (/^at least one team configured$/.test(name)) return 'github-team'
  if (/^test buyer '.*' is not in the org$/.test(name)) return 'test-buyer'
  // Token presence, authentication, capability, and anything unrecognised: the PAT screen owns it.
  return 'github-pat'
}

/**
 * Checks the driver refuses to gate on, whatever severity the step gives them. A step's severity is the
 * right default; these are the cases where the DRIVER knows something the step does not.
 *
 * - `members cannot create public repos` is org HARDENING, not a precondition for granting access, and it
 *   is red in two very different worlds: the policy is genuinely open, or the worker PAT simply cannot
 *   read it (it is minted with repository access Public repositories). The step cannot tell those apart and neither can
 *   we, so gating risks trapping a correctly-configured deployer at 4c with no way out. The 4b3
 *   hardening checklist asks for it by name instead, where the deployer is already on that page.
 * - `wrangler.jsonc ENTITLEMENTS id set` asks whether a human pasted the id into the file. Nobody is
 *   going to: config-write writes it, moments later, from the id kv-create just reported.
 */
const NEVER_GATE = [
  'members cannot create public repos',
  /^wrangler\.jsonc ENTITLEMENTS id set/,
]

function gates(check) {
  if (check.severity === 'warn') return false
  return !NEVER_GATE.some((rule) =>
    typeof rule === 'string' ? rule === check.name : rule.test(check.name),
  )
}

/** The first blocking failure, or null. Warns never gate - the repo-attach check is a structural
 *  false-negative (the worker PAT cannot list team repos) and must never block a run. */
function firstBlocker(result) {
  return (result?.checks ?? []).find((c) => gates(c) && !c.ok) ?? null
}

async function verifyGithub(state, deps) {
  const result = await deps.githubVerify({
    env: stepEnv(state),
    config: draftConfig(state),
  })
  const bad = firstBlocker(result)
  if (!bad) return { ok: true }
  return {
    ok: false,
    owner: ownerForCheck(bad.name),
    detail: bad.fix ?? bad.name,
    check: bad.name,
  }
}

/**
 * 4d = the GitHub block, PLUS the one thing it cannot tell you: whether the handle exists at all.
 *
 * `testBuyerCheck` asks "is this account in the org?" and reads a 404 as "no" - which is the right answer
 * for a real outsider and the WRONG one for a typo, because GitHub 404s both identically. So a misspelled
 * handle sails through 4d, gets written into the config, and surfaces three screens later as E1's invite
 * poll quietly timing out. Ask GitHub whether the account exists first, at the screen that collected it.
 */
async function verifyTestBuyer(state, deps) {
  const handle = state.answers.testBuyer
  const token = await deps.readToken(stepEnv(state))
  if (token) {
    const api = deps.createApi(token)
    const res = await safeGet(api, `/users/${enc(handle)}`)
    if (res.status === 404) {
      return {
        ok: false,
        owner: 'test-buyer',
        detail: `GitHub has no account called ${handle} - check the spelling of the handle.`,
      }
    }
    // Any other non-200 is an environment artifact (rate limit, network), never proof the account is
    // missing. Say nothing and let the org checks below speak.
  }
  return verifyGithub(state, deps)
}

async function verifySecretNames(state, deps) {
  const env = stepEnv(state)
  const file = secretsFileFor(envOf(state))
  const result = await deps.secretsCheck({ env })
  // Gate on the LOCAL half only. A production run's secrets-check ALSO asserts each name is uploaded to
  // the deployed worker, and that cannot pass here - this screen runs BEFORE the one deploy, and the
  // deploy is what uploads them. Those checks are still reported; they just do not gate.
  const local = (result.checks ?? []).filter(
    (c) => c.name.endsWith(` in ${file}`) || c.name === `${file} present`,
  )
  const bad = local.find((c) => c.severity !== 'warn' && !c.ok)
  if (!bad) return { ok: true }
  return { ok: false, owner: 'secret-name-check', detail: bad.fix ?? bad.name }
}

/**
 * The deploy, checked against the host we actually wired.
 *
 * `expectBase` is what arms the step's URL-match check. Without it a production deploy has nothing to
 * compare against: with no route in wrangler.jsonc the deploy publishes to workers.dev, `/health`
 * answers there and goes green, and the screen reports the worker live on the custom domain it is not
 * on. config-write now writes the route, so the step could derive the base itself - but we pass the URL
 * this run resolved, so the check compares the deploy against what the deployer was actually TOLD.
 *
 * CONFIRMING A PARKED DEPLOY RE-PROBES; IT DOES NOT DEPLOY AGAIN. This screen is `verifyOnArrival`, and
 * the arrival guard (`verifiedAt`) only covers the case where the arrival PASSED. When the wrangler half
 * succeeded and only `/health` did not answer, nothing was measured, so `done` used to run the whole step
 * again - a second `wrangler deploy` to answer a question about the first one. Live-observed as two
 * versions two minutes apart, with the eventual green answering from the SECOND. So the resolved address
 * is recorded in `flags` on the way out, on the failure as much as on the pass (`verifyOnArrival` assigns
 * `result.flags` before it reads `ok`), and its presence is what says a worker exists to re-probe.
 *
 * The three cases that still deploy are exactly the ones with nothing to probe: a first arrival, a run
 * whose `wrangler deploy` failed, and a deploy that succeeded but resolved no address (the step returns
 * no `url` in either of the last two).
 */
async function verifyDeploy(state, deps) {
  const deployed = state.flags?.deployedUrl
  if (deployed) {
    // No pre-probe pause on the retry: the deployer has already spent their own minutes on the recovery
    // and, if they followed it, on a browser check of this very address.
    const health = await deps.deployHealth({
      env: stepEnv(state),
      url: deployed,
      preProbeDelay: 0,
    })
    const unhealthy = firstBlocker(health)
    if (!unhealthy) return { ok: true }
    return {
      ok: false,
      owner: 'deploy',
      detail: unhealthy.fix ?? unhealthy.name,
    }
  }

  const result = await deps.deploy({
    env: stepEnv(state),
    ...(state.flags?.workerUrl ? { expectBase: state.flags.workerUrl } : {}),
  })
  const flags = result?.url ? { flags: { deployedUrl: result.url } } : {}
  const bad = firstBlocker(result)
  if (!bad) return { ok: true, ...flags }
  return { ok: false, owner: 'deploy', detail: bad.fix ?? bad.name, ...flags }
}

async function verifyE2e(state, deps) {
  const result = await deps.e2e({
    env: stepEnv(state),
    config: draftConfig(state),
    // The step reads `config.e2e.url` too, but pass it explicitly as well: the config here is the
    // in-memory draft, and this is the value the whole check hangs on - without a url it does not run.
    ...(state.flags?.workerUrl ? { url: state.flags.workerUrl } : {}),
  })
  const bad = firstBlocker(result)
  if (!bad) return { ok: true }
  return { ok: false, owner: 'synthetic-check', detail: bad.fix ?? bad.name }
}

/**
 * 6b: create the KV namespace, then write both deployer files.
 *
 * Order is the point: kv-create runs FIRST because config-write writes the id it reports. The step
 * itself only ever REPORTS that id - it deliberately does not rewrite the JSONC - so the driver resolves
 * it and does the writing, and the step's own "id set" check is not a gate (nobody is going to paste it
 * by hand; we are about to write it).
 */
async function verifyConfigWrite(state, deps) {
  const kv = await deps.kvCreate({ env: stepEnv(state) })
  const bad = firstBlocker(kv)
  if (bad) {
    return { ok: false, owner: 'config-written', detail: bad.fix ?? bad.name }
  }
  const kvId = resolveKvId(state, deps)
  if (!kvId) {
    return {
      ok: false,
      owner: 'config-written',
      detail: `The ENTITLEMENTS KV namespace was reconciled but its id could not be read back, so it cannot be wired into ${WRANGLER_PATH}.`,
    }
  }
  return writeDeployerFiles(state, deps, kvId)
}

/**
 * The id of this env's ENTITLEMENTS namespace, resolved the same two ways kv-create resolves it: by the
 * convention title, else by an id already wired in wrangler.jsonc that really exists on the account.
 *
 * We re-resolve rather than read it out of kv-create's result because the step does not return it -
 * it appears only inside the prose `fix` of the check that says the id is not wired, and not at all when
 * it already is. Reading it from wrangler's own listing is both robust and the same source the step used.
 */
export function resolveKvId(state, deps) {
  const env = stepEnv(state)
  const config = deps.readWranglerConfig
    ? deps.readWranglerConfig()
    : readWranglerConfig(deps.cwd)
  const title = kvTitle(config?.name ?? 'worker', env, 'ENTITLEMENTS')
  const res = deps.run(['kv', 'namespace', 'list'])
  let namespaces = []
  if (res?.ok) {
    try {
      const parsed = JSON.parse(res.stdout)
      namespaces = Array.isArray(parsed) ? parsed : []
    } catch {
      namespaces = []
    }
  }
  const byTitle = namespaces.find((ns) => ns.title === title)?.id ?? null
  if (byTitle) return byTitle
  const wired = wiredKvId(config, env)
  if (wired && !/placeholder/i.test(wired)) {
    return namespaces.some((ns) => ns.id === wired) ? wired : null
  }
  return null
}

/** Write both files, each from its own current text, and confirm the result by re-reading it. */
function writeDeployerFiles(state, deps, kvId) {
  const configText = deps.readFile(CONFIG_PATH)
  const wranglerText = deps.readFile(WRANGLER_PATH)
  if (configText === null || wranglerText === null) {
    return {
      ok: false,
      owner: 'config-written',
      detail: `Could not read ${configText === null ? CONFIG_PATH : WRANGLER_PATH} - it should have been created from its template at the start of the run.`,
    }
  }

  const nextConfig = generateConfig(configText, state)
  if (nextConfig === null) {
    return {
      ok: false,
      owner: 'config-written',
      detail: `Could not find the \`${envOf(state)}\` profile to fill in ${CONFIG_PATH}. If you edited that file by hand, restore it from ${CONFIG_PATH.replace(/\.ts$/, '.example.ts')} and run this again.`,
    }
  }

  const wrangler = generateWrangler(wranglerText, state, kvId)
  if (wrangler.error) {
    return { ok: false, owner: 'config-written', detail: wrangler.error }
  }

  deps.writeFile(CONFIG_PATH, nextConfig)
  deps.writeFile(WRANGLER_PATH, wrangler.text)

  // Confirm what we wrote, through the same reader the deploy step uses. Text surgery that reported
  // success without re-reading would be exactly the kind of unchecked claim this driver exists to stop.
  const written = parseJsonc(deps.readFile(WRANGLER_PATH))
  if (wiredKvId(written, stepEnv(state)) !== kvId) {
    return {
      ok: false,
      owner: 'config-written',
      detail: `Wrote ${WRANGLER_PATH} but the ENTITLEMENTS id did not read back as ${kvId} - the deploy would bind the wrong namespace.`,
    }
  }
  if (envOf(state) === 'production') {
    const route = customDomainPattern(written, 'production')
    if (route !== state.answers.domain) {
      return {
        ok: false,
        owner: 'config-written',
        detail: `Wrote ${WRANGLER_PATH} but the custom-domain route did not read back as ${state.answers.domain} - the deploy would not serve your domain.`,
      }
    }
  }
  return { ok: true }
}

/** Resolve the buyer's team-membership state for E3/E4/E5, or a reason we could not. */
async function membershipFor(state, deps) {
  const token = await deps.readToken(stepEnv(state))
  if (!token) {
    return {
      state: null,
      detail: `Could not read GITHUB_TOKEN from ${secretsFileFor(envOf(state))} - it is needed to confirm this by the GitHub API.`,
    }
  }
  const api = deps.createApi(token)
  const a = state.answers
  const membership = await teamMembership(api, a.org, a.team, a.testBuyer)
  if (membership === null) {
    return {
      state: null,
      detail: `Could not read whether ${a.testBuyer} is on team ${a.team} - confirm it in your browser (Org -> Teams -> ${a.team}), then carry on.`,
    }
  }
  return { state: membership, detail: null }
}

// E3/E4/E5 each read the same endpoint and each take their `owner`, because E6 asks the same three
// questions about a SECOND purchase and must route its recoveries to its own screens. A shared verify
// hard-coding E3's id would park the typo test's failure on the screen the deployer finished two steps
// ago.

// E3: the grant fired, i.e. an invite exists. 'pending' (invited) or 'active' (already accepted, if the
// buyer was quick) both prove it. Confirming by the invite, not by reading KV, is deliberate.
async function verifyGrantFired(state, deps, owner = 'awaiting-grant') {
  const { state: membership, detail } = await membershipFor(state, deps)
  if (membership === 'pending' || membership === 'active') return { ok: true }
  return {
    ok: false,
    owner,
    detail:
      detail ??
      `No invite for ${state.answers.testBuyer} on team ${state.answers.team} yet - the grant has not fired.`,
  }
}

// E4: accepted. 'pending' means the invite is still sitting unaccepted, which is the whole point of the
// step, so it must NOT pass.
async function verifyInviteAccepted(state, deps, owner = 'accept-invite') {
  const { state: membership, detail } = await membershipFor(state, deps)
  if (membership === 'active') return { ok: true }
  if (membership === 'pending') {
    return {
      ok: false,
      owner,
      detail: `The invite for ${state.answers.testBuyer} is still pending - it has not been accepted yet.`,
    }
  }
  return {
    ok: false,
    owner,
    detail:
      detail ??
      `${state.answers.testBuyer} is not on team ${state.answers.team} at all - no invite to accept.`,
  }
}

// E5 asserts the OPPOSITE thing per policy, because the two policies make opposite things true:
// auto_revoke must REMOVE the buyer; log_only must KEEP them. Asserting removal under log_only would
// fail forever against a worker behaving exactly as configured.
async function verifyRefundOutcome(state, deps, owner = 'refund') {
  const policy = state.answers.revokePolicy
  const { state: membership, detail } = await membershipFor(state, deps)
  if (membership === null) {
    return { ok: false, owner, detail }
  }
  if (policy === 'log_only') {
    if (membership === 'pending' || membership === 'active') return { ok: true }
    return {
      ok: false,
      owner,
      detail: `${state.answers.testBuyer} is no longer on team ${state.answers.team}, but Log only should have kept their access.`,
    }
  }
  if (membership === 'none') return { ok: true }
  return {
    ok: false,
    owner,
    detail: `${state.answers.testBuyer} is still on team ${state.answers.team} - the revoke has not happened.`,
  }
}

/**
 * Screen 3, gated on the WHOLE preflight, not just the login.
 *
 * The screen asserts "Node, wrangler, git - OK" and that the secrets template is in place. Gating only
 * on the Cloudflare check meant every other one of those claims was decorative: an unsupported Node -
 * which makes the config unloadable, since the step functions import the deployer's `.ts` config
 * natively - printed OK and the run walked on to fail somewhere less obvious. Every blocking check the
 * step reports is now a gate, and the failing one's own fix is what the deployer reads.
 */
async function verifyPreflight(state, deps) {
  const probe = await probeCloudflare(state, deps)
  if (probe.preflightBlocker) {
    return {
      ok: false,
      owner: 'preflight',
      detail: probe.preflightBlocker,
      flags: probe,
    }
  }
  if (probe.cloudflareSignedIn) return { ok: true, flags: probe }
  return {
    ok: false,
    owner: 'preflight',
    detail:
      'Still not signed in to Cloudflare - `npx wrangler login` has not completed.',
    flags: probe,
  }
}

// --- probes -------------------------------------------------------------------------------------
//
// A probe runs when the driver ARRIVES at a screen and resolves what that screen needs to know before
// it can be rendered truthfully. Its result lands in state.flags, so `currentRecord` stays pure.

const AUTH_CHECK = 'Cloudflare authenticated (wrangler whoami)'

async function probeCloudflare(state, deps) {
  const result = await deps.preflight({ env: stepEnv(state) })
  const checks = result.checks ?? []
  const auth = checks.find((c) => c.name === AUTH_CHECK)
  const signedIn = !!auth?.ok
  // Everything the step checked EXCEPT the login, which has its own screen branch and its own words.
  const blocker = checks.find((c) => c.name !== AUTH_CHECK && gates(c) && !c.ok)
  let account = null
  if (signedIn) {
    const who = deps.run(['whoami'])
    account = parseWhoamiAccount(who?.stdout)?.name ?? null
  }
  return {
    cloudflareSignedIn: signedIn,
    account,
    preflightBlocker: blocker ? (blocker.fix ?? blocker.name) : null,
  }
}

/**
 * Screen 5: resolve the worker's real address, before the Stripe block that depends on it.
 *
 * The secret path is REGENERATED on every resolve-url call (16 fresh random bytes), so it is persisted
 * the first time and passed back on every later call: the deployer types it into their Stripe endpoint
 * URL, config-write writes it into `e2e.secretPath`, and a second resolve that quietly produced a
 * different one would leave the webhook and the config disagreeing about the same worker. (The path is
 * obscurity only - the worker does not validate it for HMAC adapters - so this is not about security. It
 * is about the two records matching what the human was told.)
 *
 * Runs on the ANSWER, in both envs: neither the custom domain nor the workers.dev subdomain exists until
 * this screen has collected it, so there is nothing to resolve before then.
 */
async function runResolveUrl(state, deps) {
  const a = state.answers ?? {}
  const result = await deps.resolveUrl({
    env: stepEnv(state),
    ...(a.domain ? { domain: a.domain } : {}),
    ...(a.subdomain ? { subdomain: a.subdomain } : {}),
    ...(state.flags?.secretPath ? { secretPath: state.flags.secretPath } : {}),
  })
  const resolved = result?.resolved ?? null
  if (resolved) {
    return {
      flags: { workerUrl: resolved.base, secretPath: resolved.secretPath },
    }
  }
  return {
    flags: {},
    detail: (firstBlocker(result) ?? {}).fix ?? null,
  }
}

/**
 * Screen 5's arrival probe on a sandbox run: the SUGGESTION the question offers, and nothing else.
 *
 * It never resolves a URL, and that is the point of this whole screen. The candidate is a guess by
 * construction (see deriveSubdomain), so its only job is to save the deployer a retype when it happens to
 * be right; the value the run WIRES is the one they answer with. A run whose account yields no candidate
 * asks the same question with no default, which is a difference of one sentence rather than of path.
 *
 * Production has nothing to probe: its domain arrives as this screen's own answer.
 */
async function probeWorkerUrl(state, deps) {
  if (envOf(state) === 'production') return {}
  const candidate = deriveSubdomain({ run: deps.run })
  return { subdomainCandidate: candidate?.subdomain ?? null }
}

// The synthetic check's own transaction ids. `e2e` mints `pi_e2e_<uuid>`. Its cleanup DOES delete the
// grant record it wrote, but that delete is advisory (a failed delete never reds a green check), so a
// `pi_e2e_` grant CAN still be sitting in KV at a refund screen. Filtering these out (belt-and-braces
// over the cleanup) is what keeps the refund screen from naming a synthetic id the deployer cannot refund.
const E2E_TXN_PREFIX = 'pi_e2e_'

// The transaction ids in the store that could be a payment this deployer can actually refund: this
// adapter's, and not the synthetic check's own. BOTH reads below go through it, so the snapshot and the
// later lookup are filtered the same way - filter one and not the other and a synthetic id would count
// as this run's purchase, which is the exact row the filter exists to keep off the screen.
const realGrantIds = (grants) =>
  (grants ?? [])
    .filter(
      (g) =>
        g.adapter === 'stripe' && !g.transactionId.startsWith(E2E_TXN_PREFIX),
    )
    .map((g) => g.transactionId)

/**
 * Snapshot the payments already in the store BEFORE this run buys anything, so the refund screens can
 * tell this run's purchase from every purchase that came before it.
 *
 * It sits on arrival at the purchase screen, and that position is the whole point. Earlier is not
 * possible: nothing can read the store until the namespace exists and the worker is deployed, and both
 * of those are settled only once the deploy step has passed. Later is not possible either: the very next
 * thing the deployer does is pay, and an id minted after the snapshot is exactly what the snapshot must
 * not contain. The synthetic check runs in between and writes a grant of its own, but that one is
 * filtered out of both reads by prefix, so its presence or absence changes nothing here.
 *
 * A snapshot that could not be read comes back EMPTY, and that is deliberate rather than a gap:
 * subtracting an empty baseline is the identity, so the lookup below is left with exactly the rule it
 * had before this snapshot existed - name the payment when the store holds one refundable grant, and
 * describe it otherwise. A failed read therefore costs a production run nothing it had, and costs a
 * fresh store nothing at all. It never gates, for the same reason the lookup does not.
 */
async function probeGrantBaseline(state, deps) {
  const result = await deps.grantRecord({ env: stepEnv(state) })
  return { grantBaseline: realGrantIds(result?.grants) }
}

/**
 * Resolve the `pi_...` of the purchase the refund screen is about to name.
 *
 * `grant-record` reads the REMOTE ENTITLEMENTS store (the `--remote` is baked into the step - a local
 * read is always empty, because the deployed worker writes remote) and reports EVERY grant it finds,
 * including the ones earlier runs left there. So the payment this run made is resolved by DIFFERENCE
 * against the baseline taken before the purchase: exactly one id that was not there before is this
 * run's, and the screen names it.
 *
 * Uniqueness alone used to be the rule, and it is only ever right on a store nobody has used yet. A
 * production store is the opposite of that - it belongs to a worker that keeps its name and its
 * namespace across runs, and a grant survives any run that ended before its refund - so the ambiguous
 * arm fired on every production run and the deployer read the fallback every time, while a fresh
 * sandbox store named the id correctly and hid it.
 *
 * The same baseline serves the typo cleanup screen without being retaken: by the time that screen is
 * reached, the first purchase's own refund has deleted its grant record, so the claim grant the typo
 * test just created is again the only id outside the baseline.
 *
 * Zero new, or several new, and we cannot honestly name a payment: the screen falls back to describing
 * it instead, which is worse for the deployer and still true, and that is the trade this whole driver
 * keeps making. With no snapshot at all the subtraction is the identity and the old rule is what
 * remains, which is still right on a store holding one grant - there is nothing else it could be.
 *
 * Never gates. A run whose lookup fails still refunds fine - the deployer just reads "your test payment"
 * rather than an id - so a failure here must not park a recovery on a screen the human can complete.
 */
async function probeGrantRecord(state, deps) {
  const result = await deps.grantRecord({ env: stepEnv(state) })
  const baseline = state.flags?.grantBaseline ?? []
  const fresh = realGrantIds(result?.grants).filter(
    (id) => !baseline.includes(id),
  )
  return { piId: fresh.length === 1 ? fresh[0] : null }
}

/**
 * Screen 5's verify: on sandbox, CHECK the answered subdomain before anything is wired to it, then
 * resolve the address from it.
 *
 * The check proves the subdomain EXISTS, never that it is this deployer's (that is the deploy's own
 * `/health`), so it catches the one failure a human at a dashboard actually makes - a value that names
 * nothing at all - at the screen that owns it rather than three screens later with the provider webhook
 * already pointing there. It is deliberately the only gate: an inconclusive probe (an offline machine, a
 * blocked resolver) comes back as a warning and the answer stands, because re-asking a value the deployer
 * read correctly would be a dead end.
 */
async function verifyWorkerUrl(state, deps) {
  if (envOf(state) !== 'production') {
    const probe = await deps.subdomainCheck({
      subdomain: state.answers?.subdomain,
    })
    const blocker = firstBlocker(probe)
    if (blocker) {
      return {
        ok: false,
        owner: 'worker-url',
        detail: blocker.fix ?? blocker.name,
      }
    }
  }
  const { flags, detail } = await runResolveUrl(state, deps)
  if (flags.workerUrl) return { ok: true, flags }
  return { ok: false, owner: 'worker-url', detail, flags }
}

// --- recovery -----------------------------------------------------------------------------------
//
// The known failure modes per screen, as DATA. When a verify fails - or the human asks a question
// instead of typing `done` - the driver emits these, and the agent answers from them plus the step
// context. It never improvises a diagnosis and never invents a command.
//
// This is a PORT, not new invention: the modes come from the step functions' own `fix` strings, the
// user guide's troubleshooting, and the gotchas the old prose carried. Each mode is `{ when, text }`,
// rendered as `_(when)_ text`. Placeholders are filled from state like any other screen text.

// The deploy failure that is nobody's setup. Shared verbatim by both deploy blocks below - see the note
// there for why it leads each of them. The "progress is saved, and re-running resumes right here" claim
// is not a comfort phrase: it is asserted against the driver's own resume path and pinned by the suite.
const DEPLOY_API_ERROR = {
  when: 'the deploy itself failed - wrangler reported an API or upload error',
  text: "This is Cloudflare's side, not your setup: the deploy call reached Cloudflare and Cloudflare answered with an error (a `/accounts/...` request failed, an `internal_server` error). Provider APIs have bad hours. Wait a few minutes, then type **done** to retry. You can check Cloudflare's health via the **System Status** link at the bottom of the Cloudflare dashboard. Do not change your account, zone, or settings over this - nothing in your setup causes an API-side error. If it still fails after a retry or two, stop and come back later: your progress is saved, and re-running the wizard resumes right here - `npm run wizard:drive`, no extra words.",
}

const RECOVERY = {
  preflight: [
    {
      when: 'the browser did not open',
      text: '`npx wrangler login` opens a browser tab and waits for you to approve it. If no tab opened, the terminal prints a URL - paste that into your browser yourself. Approve access, then type **done**.',
    },
    {
      when: 'it says signed in but I still see not signed in',
      text: 'You may have approved a different Cloudflare account than the one this terminal uses. Run `npx wrangler logout`, then `npx wrangler login` again, and pick the account that will own the worker.',
    },
  ],
  'github-org': [
    {
      when: 'no organization at that slug',
      text: "GitHub doesn't show an organization at `github.com/YOUR-ORG`. Usually that's a typo in the slug, or a personal account name given instead of an org. The slug is the part right after `github.com/` in your org's URL.",
    },
    {
      when: "it's a personal account, not an org",
      text: 'A personal account has no teams, so it cannot gate access - there is nothing to fix on the account itself. Create a free organization (your avatar -> Your organizations -> New organization) and use its slug.',
    },
    {
      when: 'the org exists but the token cannot see it',
      text: "The PAT's **Resource owner** is probably your personal account rather than the org. Regenerate the token with `YOUR-ORG` as the resource owner.",
    },
  ],
  'github-team': [
    {
      when: 'team not found',
      text: "I can't find team `TEAM-SLUG` in `YOUR-ORG`. If you haven't created it yet, create it now (Org -> Teams -> New team). If you have, check the **slug** rather than the display name: a team shown as \"Pro Buyers\" has the slug `pro-buyers`. It is the part after `/teams/` in the team's URL.",
    },
  ],
  // The attach screen. Sandbox is a closed choice, so a wrong answer is refused rather than parked and
  // the skip is an OPTION, not a question - this mode is the production run's, where the attach cannot be
  // deferred and the question is the one the sandbox option makes people ask.
  'github-team-lock': [
    {
      when: 'can I skip this on a production run?',
      text: "No - a production run cannot skip the attach: a grant without an attached repo unlocks nothing for a real buyer, and I can't verify it with the worker token (its repository access is the minimal Public repositories option), so this one is on you. Attach the repo(s) at Team -> Repositories -> **Add repository**, then type **done**.",
    },
  ],
  // The hardening walk. Its modes are a PORT of the walkthrough's own rationales for the two switches
  // that are load-bearing, plus the question the checklist reliably provokes ("does this lock me out?"),
  // plus Base permissions - which moved here with the bullet it belongs to when 4b2 became attach-only.
  'org-harden': [
    {
      when: 'base permissions not set to No permission',
      text: 'Base permissions are what keep non-buyers out of your repos. Set them to **No permission** at Org -> Settings -> Member privileges. The worker token cannot verify this, so it is on you: left at Read, every org member can already see the repos and a grant proves nothing.',
    },
    {
      when: 'two-factor is already required for everyone',
      text: 'Turn it off at Org -> Settings -> Authentication security. Requiring 2FA org-wide removes members who do not have it - your buyers - and blocks them from accepting invites, so the grant fires and unlocks nothing. Enable 2FA on your own owner account instead. An IP allow list carries the same risk.',
    },
    {
      when: 'fine-grained tokens are restricted',
      text: "Set **Allow access via fine-grained personal access tokens** at Org -> Settings -> Personal access tokens -> **Settings**, under Fine-grained personal access tokens. The worker's token is a fine-grained PAT, so while this is on **Restrict** it cannot manage members and every grant fails. You can still require administrator approval for members' tokens - that is a separate switch, and an owner's own token is ready immediately.",
    },
    {
      when: 'do these switches lock me out too?',
      text: 'No - every one of them restricts members, never owners. You keep full access to `YOUR-ORG` and its repos throughout. That is the point of the walk: a member here is a paying customer, not a teammate, so the floor they stand on should be as low as the product allows.',
    },
  ],
  'github-pat': [
    {
      when: 'no token found',
      text: "I couldn't read a `GITHUB_TOKEN` from **SECRETS-FILE**. It goes on its own line as `GITHUB_TOKEN=` followed by the token - no quotes, no spaces around the `=`. This run reads **SECRETS-FILE** and no other file.",
    },
    {
      when: 'token invalid or expired',
      text: 'GitHub rejected the token. Regenerate the fine-grained PAT and paste the new value into **SECRETS-FILE**. GitHub shows a token only once, so if you left that page without copying it, generate a new one.',
    },
    {
      when: 'the token cannot manage members',
      text: 'It authenticates but lacks the one permission the worker needs: **Organization permissions -> Members: Read and write**. Regenerate it with that. **Repository access** stays at the minimal **Public repositories** option - the worker never reads your code.',
    },
    {
      when: 'wrong resource owner',
      text: 'If the token was minted with your personal account as the **Resource owner**, it cannot see the org at all, whatever its permissions. Regenerate it with `YOUR-ORG` as the resource owner.',
    },
    {
      when: 'the org restricts fine-grained tokens',
      text: "Your token may be sitting in **pending approval** - an owner approves it at the org Settings -> Personal access tokens. An org owner's own token is active immediately.",
    },
  ],
  'test-buyer': [
    {
      when: 'already in the org',
      text: '`TEST-HANDLE` is already a member or owner of `YOUR-ORG`, so it will never receive an invite - GitHub adds an existing member to the team outright, and the check would green a grant path no real buyer ever walks. Either use a second GitHub account that is not in the org, or remove `TEST-HANDLE` from the org first.',
    },
    {
      when: 'no such account',
      text: 'GitHub has no account with that handle. Check the spelling: it is the handle from the profile URL (`github.com/THAT-HANDLE`), not a display name and not an email address.',
    },
    {
      when: "it's your own account",
      text: 'Your org-owner account cannot play the buyer - it is already in the org, so it never gets an invite, and the flow you would be testing is not the one a buyer walks. A free throwaway account is fine.',
    },
    {
      when: 'membership could not be read',
      text: "The token couldn't read org membership (GitHub answered 403). Confirm in your browser (Org -> People) that `TEST-HANDLE` is NOT listed as a member, then give me the handle again. Don't widen the token's permissions for this.",
    },
  ],
  // The SANDBOX half of screen 5. Its failure is always the same shape - the answer names no subdomain
  // Cloudflare has - so every mode here sends the deployer back to the same panel to read it again.
  'worker-url-sandbox': [
    {
      when: 'nothing answers at that subdomain',
      text: `Cloudflare has no such \`workers.dev\` subdomain, so a worker published there would be unreachable. Read it again off the dashboard - **${SUBDOMAIN_ROUTE}** - and give me exactly what that panel shows.`,
    },
    {
      when: 'I gave the whole hostname',
      text: 'Give the subdomain ALONE, not the full host: for `dana.workers.dev` the answer is `dana`. I add your worker name in front and `.workers.dev` after it.',
    },
    {
      when: 'the panel shows no subdomain',
      text: `Then this Cloudflare account has not got one yet, and nothing can be published to \`workers.dev\` until it has. The subdomain is configured on that same panel - **${SUBDOMAIN_ROUTE}** - set or change it there, then give me the value the panel shows. If you would rather run on your own domain, stop here and start again choosing **Production**.`,
    },
  ],
  'worker-url': [
    {
      when: 'the zone is not on this Cloudflare account',
      text: "The deploy provisions the DNS record and the certificate for you, and it can only do that if the zone for `YOUR-DOMAIN` sits on this same Cloudflare account. Add the domain to Cloudflare first - it's under **Domains** in the dashboard, which walks you through pointing your nameservers - and once the zone is active, give me the domain again.",
    },
    {
      when: 'which hostname do I give',
      text: 'Give the exact hostname the worker will answer on, e.g. `access.example.com`. It does not need to exist as a DNS record yet - the deploy creates it.',
    },
  ],
  'stripe-product': [
    {
      when: 'the dashboard is in live mode',
      text: 'Check the **Test mode** toggle at the top of the Stripe dashboard. A product created in live mode has a different id and will not match what this run wires. Switch to Test mode and create it there.',
    },
    {
      when: "that doesn't look like a product id",
      text: "A product id starts with `prod_`. Something starting `price_` is the price, not the product - the product id is on the product's own page. The payment-link id is a third, different thing.",
    },
  ],
  'payment-link': [
    {
      when: 'the metadata is not set',
      text: "This is the one that bites silently. Stripe's checkout webhook omits line items, so the worker reads the product from `metadata.product_id` on the link. Without it the sale matches no product, falls through to a default that grants nothing, and the webhook still answers `200` - green on both sides, no invite. Open the link's **detail page** -> **Metadata** -> **Edit metadata** -> add `product_id` = `PRODUCT-ID`.",
    },
    {
      when: 'a valid handle still lands on the claim page',
      text: 'The **Label** is what drives this. Stripe derives the field\'s key from the label, and the worker reads any key that contains "github" - so the label **GitHub username** yields a key that matches, and no manual key is needed (the no-code builder does not expose one anyway). If the label was renamed to something with no "github" in it, the derived key no longer contains it either and a valid handle falls through to the claim page. Set the label back to **GitHub username**.',
    },
    {
      when: 'the redirect does not come back to the worker',
      text: 'Paste `{CHECKOUT_SESSION_ID}` literally, braces and all - Stripe substitutes it per checkout. Replaced with a real session id, every buyer lands on the same dead link.',
    },
  ],
  'webhook-secret': [
    {
      when: 'I cannot find the signing secret',
      text: "It is on the endpoint's own details page, under **Signing secret**, behind a click-to-reveal. It starts `whsec_`. You can reveal and copy it again any time - it is not a one-time value.",
    },
    {
      when: 'wrong events selected',
      text: 'Send exactly these three: `checkout.session.completed`, `charge.refunded`, `charge.dispute.created`. Fewer, and refunds or chargebacks never reach the worker; more is just noise it answers `400` to.',
    },
    {
      when: 'the endpoint URL is wrong',
      text: "It must be the worker's URL including the generated path segment. If you have already deployed and the host turned out different, edit the endpoint URL to the deployed host - the path segment stays the same, it is obscurity only.",
    },
    {
      when: 'pasted into the wrong file',
      text: 'This run reads **SECRETS-FILE** and no other. The secret goes there, on its own line, as `STRIPE_WEBHOOK_SECRET=` followed by the value.',
    },
  ],
  'config-written': [
    {
      when: 'config-write failed',
      text: "This is unusual - I couldn't write a valid config from your answers. It's almost always a local issue (no write permission, or a full disk), not anything you did in a dashboard. Check the folder is writable and try again; if it keeps failing, that's a bug worth reporting, not something to hand-fix.",
    },
  ],
  'secret-name-check': [
    {
      when: 'a name is missing',
      text: 'I check NAMES only, never values - and one of them is not in **SECRETS-FILE**. Each secret is its own line, `NAME=value`, with no quotes and no spaces around the `=`. `GITHUB_TOKEN` was pasted at the token step, `STRIPE_WEBHOOK_SECRET` at the webhook step.',
    },
    {
      when: 'the file is missing',
      text: '**SECRETS-FILE** is created for you from its template at the start of the run. If it has gone missing, start the wizard again rather than hand-copying it.',
    },
  ],
  // The deploy block BRANCHES BY ENV, like the refund block, because the two runs fail differently. A
  // production run has a custom domain whose DNS and certificate really do need to propagate; a sandbox
  // run has no domain to propagate at all, so leading with that advice sends a `workers.dev` deployer
  // hunting a problem they cannot have. The host-differs mode is real in both.
  // The API-side mode leads BOTH blocks and is byte-identical in each: a Cloudflare outage is not
  // env-specific, and it is the one deploy failure where every other mode's advice is actively wrong -
  // each of them sends the deployer to inspect a setup that is fine. Live-confirmed on run 6, where the
  // dashboard itself was returning `workflows.api.error.internal_server`.
  //
  // BOTH health modes NAME WHO ACTS, and that is a fix for an observed failure, not politeness. The
  // wizard is agent-driven, so "open this in your browser" has two possible readers, and on a live run
  // the AGENT took it as an instruction to itself and reached for a browser tool - work the deployer
  // never asked for, off the documented path, and no substitute for the probe the driver owns. So each
  // mode addresses the deployer by name, states in the same breath what the AGENT does instead (it
  // re-probes from the machine it is on), and says what `done` does not do: deploy a second time. That
  // last clause is a claim about `verifyDeploy`, which re-probes a recorded address rather than
  // re-running the step, and it is asserted against the driver rather than trusted.
  'deploy-production': [
    DEPLOY_API_ERROR,
    {
      when: 'health fails on a brand-new custom domain',
      text: 'A new custom domain needs DNS and a certificate to propagate - usually just a few minutes, though in the worst cases up to about 30. `NXDOMAIN` or `ERR_NAME_NOT_RESOLVED` on a brand-new name is usually your own resolver\'s cached "does not exist" answer, not a failed deploy. Check from outside your cache with `nslookup YOUR-DOMAIN 1.1.1.1`; on Windows `ipconfig /flushdns` clears the stale answer.',
    },
    {
      when: 'it loads in my browser but the check fails',
      text: 'Deployer, this one is yours to look at, not mine: open `https://YOUR-WORKER-URL/health` in your own browser. I do not open a browser - I re-probe the worker from here. If it answers for you, the worker is fine and my automated probe was filtered; type **done** and I will re-probe it. That only re-probes the worker already published - it never deploys a second one. Do not change your Cloudflare zone, WAF, or bot settings over this.',
    },
    {
      when: 'the deployed host differs from the wired URL',
      text: "If the deploy reports a different host than the one your Stripe webhook points at, edit the webhook's Endpoint URL to the deployed host. The path segment stays the same.",
    },
  ],
  'deploy-sandbox': [
    DEPLOY_API_ERROR,
    {
      when: 'health fails right after a sandbox deploy',
      text: "I couldn't confirm `/health` yet - that doesn't always mean the deploy failed: a fresh deploy can take a short while to answer everywhere. Deployer, this one is yours to look at, not mine: open `https://YOUR-WORKER-URL/health` in your own browser. I do not open a browser - I re-probe the worker from here. If it shows `{status:'ok'}`, the worker is live - type **done** and I'll re-probe it and confirm. If it doesn't answer yet, wait a minute and look again, then type **done** once it does. Typing **done** only re-probes the worker already published - it never deploys a second one. If it still doesn't answer after a few minutes, check the deploy output above for errors.",
    },
    {
      when: 'the deployed host differs from the wired URL',
      text: "If the deploy reports a different host than the one your Stripe webhook points at, edit the webhook's Endpoint URL to the deployed host. The path segment stays the same.",
    },
  ],
  'synthetic-check': [
    {
      when: 'the worker did not accept the event',
      text: 'A `401` means the secret the worker holds is not the one that signed the event - the deploy may not have picked up your `STRIPE_WEBHOOK_SECRET`. Anything else usually means the worker is not reachable at the URL I used.',
    },
    {
      when: 'the check reports status 404',
      text: "A 404 right after a fresh deploy is usually the `workers.dev` name still propagating - especially when a previous run's worker with the same name was deleted minutes earlier. Nothing is misconfigured: wait a minute, then type **done** to retry. If it keeps returning 404, open `https://YOUR-WORKER-URL/health` in your browser - if that answers, retry once more; if it does not, the deploy did not land - check the deploy output.",
    },
    // Leads the no-invite pair: when the execution plane is simply late, every other cause below is a
    // deployer sent to inspect a setup that is fine.
    {
      when: 'no invite right after the FIRST deploy',
      text: 'On a brand-new worker the Workflows engine can lag the deploy by a minute or two - the event is accepted, but the workflow errors before its first step ("Worker not found" in the Cloudflare dashboard). Nothing is misconfigured: wait another minute, then type **done** to retry.',
    },
    {
      when: 'no invite appeared',
      text: 'The event was accepted but no invite showed up in the poll window. Usually the product is not mapped to a team, or the token cannot manage members.',
    },
    {
      when: 'the invite was not cleaned up',
      text: 'The check always cancels the invite it created. If it could not, remove it by hand at `https://github.com/orgs/YOUR-ORG/people/pending_invitations` so a stale invite does not confuse the real test.',
    },
  ],
  purchase: [
    {
      when: 'the card was declined',
      text: "Use Stripe's test card `4242 4242 4242 4242`, any future expiry, any CVC. A real card declines in test mode. Where Stripe asks for a name, address or ZIP, anything valid works.",
    },
    {
      when: 'there is no github field at checkout',
      text: 'That field is the custom field on the Payment Link. If it is not on the checkout page, the link was created without it - add it, then use a fresh link.',
    },
  ],
  'awaiting-grant': [
    {
      when: 'the page never shows granted',
      text: 'The grant runs right after payment and normally lands within a minute. If it does not, the likeliest cause is that the sale matched no product: a `200` from the webhook only means the signature was good, not that anything was granted. Check the link carries `metadata.product_id` = `PRODUCT-ID`.',
    },
    {
      when: 'the page will not load at all',
      text: "The redirect opens in YOUR browser, so it needs the domain to resolve on YOUR machine; the webhook reaches the worker from Stripe's servers either way. If the page will not load but the invite still arrives, that is DNS, not the grant.",
    },
  ],
  'accept-invite': [
    {
      when: 'not in org after done',
      text: "I don't see `TEST-HANDLE` in the organization yet. Two usual reasons: the invite email went to your **second** account's inbox, not your main one; and you must accept it while logged into GitHub **as `TEST-HANDLE`**. Accept it, then type **done**.",
    },
    {
      when: 'already a member',
      text: "If GitHub says the account is already a member, it was already in the org before this test - that account can't receive an invite, so it can't prove the flow. Use a different throwaway account as the test buyer.",
    },
  ],
  refund: [
    {
      when: 'still in the team',
      text: "The revoke runs on Stripe's `charge.refunded` event. Check the refund actually completed in Stripe, and that `charge.refunded` is one of the events selected on your webhook endpoint - if it is not, the worker never hears about the refund at all.",
    },
    {
      when: 'the grant record is gone',
      text: "A revoke resolves the buyer's teams from the grant record written at purchase. If that record was deleted, the worker has nothing to reconcile against and logs a warning instead of revoking. Run the purchase again to get a fresh record.",
    },
  ],
  'refund-log-only': [
    {
      when: 'they were removed anyway',
      text: 'Under **Log only** the worker records the refund and leaves access alone, so `TEST-HANDLE` should still be in the team. If they are gone, something else removed them - a still-pending invite that was cancelled, or a manual removal. That is not the worker acting on the refund.',
    },
  ],
  // E6. The modes are the typo-path halves of the blocks above: the same checkout and refund advice,
  // plus the two things only this test can hit - a fake handle that turns out to be real, and a claim
  // page the redirect did not reach.
  'typo-test': [
    {
      when: 'is this worth doing',
      text: 'It is optional and it costs one more test purchase and one more refund. Skip it if you have seen enough: the claim page ships and works either way, and nothing about your setup changes. Take it if you want to watch what a buyer with a fat-fingered handle actually sees.',
    },
  ],
  'typo-purchase': [
    {
      when: 'the handle I invented turned out to exist',
      text: 'Then it is not a typo test - GitHub would find that account and grant it, inviting a stranger to your org. Refund the payment and try again with a handle you have checked is free: open `https://github.com/THE-HANDLE` and confirm it 404s first.',
    },
    {
      when: 'the card was declined',
      text: "Use Stripe's test card `4242 4242 4242 4242`, any future expiry, any CVC. A real card declines in test mode. Where Stripe asks for a name, address or ZIP, anything valid works.",
    },
  ],
  'typo-claim': [
    {
      when: 'I was not redirected to the claim page',
      text: 'The redirect is the **Confirmation page** setting on your Payment Link, and it is the same one that carried the first purchase - so if that one landed, this one should too. If the page will not load in your browser at all, that is DNS on your machine, not the worker - the first purchase already used this same address.',
    },
    {
      when: 'it just says setting up your access',
      text: 'That is the neutral state, and it is normal for a moment - the page refreshes on its own while the claim record settles. If it stays there, the sale may have matched no product: check the link still carries `metadata.product_id` = `PRODUCT-ID`.',
    },
    {
      when: 'the claim page rejected my handle',
      text: '`TEST-HANDLE` should be free to reuse here, because the refund at the last step revoked it. If the page says the handle is already granted, the revoke did not complete - go back and confirm the refund really went through in Stripe.',
    },
  ],
  'typo-accept': [
    {
      when: 'not in org after done',
      text: "I don't see `TEST-HANDLE` in the organization yet. This is a NEW invite - the one the claim page just created - so an old accepted invite does not count for it. Accept this one while logged into GitHub **as `TEST-HANDLE`**, then type **done**.",
    },
  ],
  'typo-refund': [
    {
      when: 'still in the team',
      text: "The revoke runs on Stripe's `charge.refunded` event, exactly as it did for the first refund. Check this second refund actually completed in Stripe - it is a different payment from the one you refunded before, so refunding the first one again is a common miss.",
    },
    {
      when: 'which payment do I refund',
      text: 'The second one - the purchase you just made with the fake handle. The first is already refunded, so it has nothing left to give back. In **Transactions** the newest payment is at the top.',
    },
  ],
}

// --- screens ------------------------------------------------------------------------------------
//
// One entry per logical screen, in run order. `applies` decides whether the screen is in THIS run's
// sequence (the only axis is the goal); `build` returns the record, and is where the env variants live.
// `verify` runs on `done` and is the REAL gate; `probe` runs on arrival and resolves what the screen
// needs to know before it can be rendered truthfully. Sequence is a pure function of the answers so far
// - the agent never chooses.

// E6's choreography. Every one of these is in the run only when the offer was TAKEN, so `skip` walks
// straight from the offer to the closing and nothing here is ever built. The three verifies are E3's,
// E4's and E5's, each given its OWN screen as the recovery owner - the questions are identical, only the
// purchase they are asked about is new.
const typoTaken = (state) =>
  goalOf(state) === 'full' &&
  state.answers?.revokePolicy === 'auto_revoke' &&
  state.answers?.typoTest === 'test'

const TYPO_SCREENS = [
  {
    id: 'typo-purchase',
    applies: typoTaken,
    build: () => ({ type: 'do', text: TYPO_PURCHASE }),
  },
  {
    // The claim page's own grant, asked exactly as E3 asks it: did an invite appear.
    id: 'typo-claim',
    applies: typoTaken,
    verify: (state, deps) => verifyGrantFired(state, deps, 'typo-claim'),
    build: () => ({ type: 'do', text: TYPO_CLAIM }),
  },
  {
    id: 'typo-accept',
    applies: typoTaken,
    verify: (state, deps) => verifyInviteAccepted(state, deps, 'typo-accept'),
    build: () => ({ type: 'do', text: TYPO_ACCEPT }),
  },
  {
    // A FRESH lookup against the SAME baseline: E5's revoke deleted the first grant record, so the one
    // id outside the baseline here is the claim grant the typo test just created - not the payment
    // already refunded.
    id: 'typo-refund',
    applies: typoTaken,
    probe: probeGrantRecord,
    verify: (state, deps) => verifyRefundOutcome(state, deps, 'typo-refund'),
    build: (state) => ({ type: 'do', text: typoRefund(state.flags?.piId) }),
  },
]

const SCREENS = [
  {
    id: 'welcome',
    envAware: false,
    applies: () => true,
    build: () => ({ type: 'say', text: WELCOME }),
  },
  {
    id: 'env',
    envAware: false,
    applies: () => true,
    field: 'env',
    build: () => ({
      type: 'ask',
      kind: 'choice',
      text: '**Which environment are you setting up?**',
      options: [
        {
          value: 'sandbox',
          label: 'Sandbox / test',
          description:
            "recommended for your first run. The worker runs on a free `*.workers.dev` URL, and you prove the whole flow with Stripe's test card. Nothing here touches real money.",
        },
        {
          value: 'production',
          label: 'Production',
          description:
            "the worker runs on your own custom domain, with a separate production config and secrets file. Choose this once a sandbox run has worked and you're setting up the real worker.",
        },
      ],
      note: ENV_NOTE,
    }),
  },
  {
    id: 'goal',
    envAware: false,
    applies: () => true,
    field: 'goal',
    build: () => ({
      type: 'ask',
      kind: 'choice',
      text: '**What should this run do?**',
      options: [
        {
          value: 'full',
          label: 'Full setup',
          description:
            'deploy the worker and walk the Stripe dashboard (product, payment link, webhook), then prove it with a real test purchase. Budget about an hour the first time - much less if your GitHub org and Stripe account are already set up. Choose this to actually take buyers.',
        },
        {
          value: 'quick',
          label: 'Quick check',
          description:
            'deploy the worker and run a synthetic end-to-end test that proves the grant path: a signed event resolves to a team and produces a real GitHub invite. It does not test refunds - a Full run does that. No Stripe dashboard, faster. Choose this to verify the wiring.',
        },
      ],
    }),
  },
  {
    // Both answers are in, so the run can finally describe itself: what is ahead, roughly how long, and
    // the one thing the deployer has to go get BEFORE the wizard needs it. It sits here rather than at
    // the welcome because the path it describes is the one the goal answer just chose.
    id: 'road-map',
    applies: () => true,
    build: (state) => ({ type: 'say', text: roadMap(goalOf(state)) }),
  },
  {
    // The probe runs the real preflight (which copies the templates AND checks auth), so the screen
    // reports what actually happened. Signed out, it becomes a `do` whose `done` re-checks.
    id: 'preflight',
    applies: () => true,
    probe: probeCloudflare,
    verify: verifyPreflight,
    build: (state) =>
      state.flags?.cloudflareSignedIn === false
        ? { type: 'do', text: preflightSignedOut(envOf(state)) }
        : {
            type: 'say',
            text: preflightSignedIn(envOf(state)),
            action: { step: 'preflight', env: envOf(state) },
          },
  },
  {
    id: 'github-org',
    applies: () => true,
    field: 'org',
    build: () => ({ type: 'ask', kind: 'text', text: GITHUB_ORG }),
  },
  {
    // 4b asks ONE thing: the slug. The org actions that used to be crammed in here are their own screen
    // below, so each has a `done` of its own and a recovery block that belongs to it.
    id: 'github-team',
    applies: () => true,
    field: 'team',
    build: () => ({ type: 'ask', kind: 'text', text: GITHUB_TEAM }),
  },
  {
    // 4b2: the two org actions. Nothing here is verifiable with the worker PAT (it is minted with
    // repository access Public repositories, and base permissions are not readable by it), so this screen advances on
    // the human's word with recovery-only guidance - it is honest about that rather than pretending to
    // check. Sandbox asks WHICH of the two actions that word covers; production has only one answer.
    id: 'github-team-lock',
    applies: () => true,
    field: (state) => (envOf(state) === 'production' ? null : 'repoAttached'),
    build: (state) =>
      envOf(state) === 'production'
        ? { type: 'do', text: githubTeamLock('production') }
        : {
            type: 'ask',
            kind: 'choice',
            text: githubTeamLock('sandbox'),
            options: TEAM_LOCK_OPTIONS,
          },
  },
  {
    // 4b3: the hardening walk. Env-neutral, and like 4b2 it advances on the human's word - the worker
    // PAT cannot read any of these policies. It comes BEFORE 4c on purpose: one of its switches decides
    // whether the token the next screen mints can work at all.
    id: 'org-harden',
    applies: () => true,
    build: () => ({ type: 'do', text: ORG_HARDEN }),
  },
  {
    // The FIRST point a credential exists, so this is where every GitHub check runs: the token
    // authenticates, the org (4a) exists, the team (4b) exists, and the PAT can manage members. A
    // failure routes to whichever screen owns the wrong input.
    id: 'github-pat',
    applies: () => true,
    verify: verifyGithub,
    build: (state) => ({ type: 'do', text: githubPat(envOf(state)) }),
  },
  {
    id: 'test-buyer',
    applies: () => true,
    field: 'testBuyer',
    verify: verifyTestBuyer,
    build: () => ({ type: 'ask', kind: 'text', text: TEST_BUYER }),
  },
  {
    // EVERY run answers this screen: production names its own domain, sandbox names its workers.dev
    // subdomain. The two sandbox renderings differ only in whether there is a candidate to offer as a
    // default - both ask, and neither accepts a value the deployer did not give.
    id: 'worker-url',
    applies: () => true,
    probe: probeWorkerUrl,
    verify: verifyWorkerUrl,
    // A sandbox failure here is a subdomain that names nothing; a production failure is a zone on the
    // wrong account. Sharing one block would lead a workers.dev run into DNS advice for a custom domain
    // it does not have.
    recovery: (state) =>
      envOf(state) === 'production' ? 'worker-url' : 'worker-url-sandbox',
    field: (state) => (envOf(state) === 'production' ? 'domain' : 'subdomain'),
    build: (state) => {
      if (envOf(state) === 'production') {
        return { type: 'ask', kind: 'text', text: WORKER_URL_PRODUCTION }
      }
      return {
        type: 'ask',
        kind: 'text',
        text: state.flags?.subdomainCandidate
          ? WORKER_URL_SUBDOMAIN_GUESS
          : WORKER_URL_SUBDOMAIN,
      }
    },
  },
  {
    // The address announcement, and it is a screen of its own because of WHEN it has to happen: it can
    // only be made once the subdomain has been answered AND checked, which is after the screen above has
    // advanced. Folding it back into that screen is what made it a guess announced as fact.
    //
    // Sandbox only. A production run's address is the domain it just typed, so there is nothing to tell
    // it that it does not already know, and its ask is left exactly as it was.
    id: 'worker-url-confirmed',
    applies: (state) => envOf(state) !== 'production',
    build: (state) => ({
      type: 'say',
      text: WORKER_URL_SANDBOX,
      action: { step: 'resolve-url', env: envOf(state) },
    }),
  },
  {
    id: 'stripe-product',
    applies: (state) => goalOf(state) === 'full',
    field: 'productId',
    build: () => ({ type: 'ask', kind: 'text', text: STRIPE_PRODUCT }),
  },
  {
    id: 'payment-link',
    applies: (state) => goalOf(state) === 'full',
    build: () => ({ type: 'do', text: PAYMENT_LINK }),
  },
  {
    id: 'webhook-secret',
    applies: (state) => goalOf(state) === 'full',
    build: (state) => ({ type: 'do', text: webhookSecret(envOf(state)) }),
  },
  {
    id: 'revoke-policy',
    applies: () => true,
    field: 'revokePolicy',
    build: () => ({
      type: 'ask',
      kind: 'choice',
      text: REVOKE_POLICY,
      options: [
        {
          value: 'auto_revoke',
          label: 'Automatically revoke',
          description:
            "remove them from the team and cancel any pending invite. This is what most sellers want, and it's what the refund test checks later.",
        },
        {
          value: 'log_only',
          label: 'Log only',
          description:
            'record the refund but keep their access. Choose this only if you revoke by hand.',
        },
      ],
    }),
  },
  {
    // Two steps behind one screen, in the order the spec's map gives them: kv-create makes the namespace,
    // then config-write writes both deployer files (the id it reports among them). There is no separate
    // KV screen because there is nothing to tell the deployer - it is the one place the wizard provisions
    // something without asking - so the outcome is reported here, on the line that says it was wired.
    id: 'config-written',
    applies: () => true,
    verify: verifyConfigWrite,
    verifyOnArrival: true,
    build: (state) => ({
      type: 'say',
      text: configWritten(state.answers.revokePolicy, envOf(state)),
      action: { step: 'config-write', env: envOf(state) },
    }),
  },
  {
    id: 'secret-name-check',
    applies: () => true,
    verify: verifySecretNames,
    verifyOnArrival: true,
    build: (state) => ({
      type: 'say',
      text: secretNameCheck(envOf(state)),
      action: { step: 'secrets-check', env: envOf(state) },
    }),
  },
  {
    // The step already owns the pre-probe timing (7s sandbox, ~30s production) and the retry budget.
    // The recovery block branches by env: only a production run has a custom domain to propagate.
    id: 'deploy',
    applies: () => true,
    verify: verifyDeploy,
    verifyOnArrival: true,
    recovery: (state) =>
      envOf(state) === 'production' ? 'deploy-production' : 'deploy-sandbox',
    build: (state) => ({
      type: 'say',
      text: deployScreen(),
      action: { step: 'deploy', env: envOf(state) },
    }),
  },
  {
    // "Synthetic check **green**" is an assertion, so the check really runs and only reports green when
    // it is.
    id: 'synthetic-check',
    applies: () => true,
    verify: verifyE2e,
    verifyOnArrival: true,
    arrivalPauseMs: WORKFLOW_REGISTER_PAUSE_MS,
    build: (state) => ({
      type: 'say',
      text: syntheticCheck(goalOf(state)),
      action: { step: 'e2e', env: envOf(state) },
    }),
  },
  {
    // The probe here changes nothing the deployer reads on this screen: it snapshots the store on
    // arrival so the two refund screens further down can name the payment this run is about to make.
    id: 'purchase',
    applies: (state) => goalOf(state) === 'full',
    probe: probeGrantBaseline,
    build: () => ({ type: 'do', text: PURCHASE }),
  },
  {
    // Labelled "say -> done" in the design, but it needs the word `done`, and a `say` takes no input -
    // so it is a `do`: the human's action is watching the page until it grants.
    id: 'awaiting-grant',
    applies: (state) => goalOf(state) === 'full',
    verify: verifyGrantFired,
    build: () => ({ type: 'do', text: AWAITING_GRANT }),
  },
  {
    id: 'accept-invite',
    applies: (state) => goalOf(state) === 'full',
    verify: verifyInviteAccepted,
    build: () => ({ type: 'do', text: ACCEPT_INVITE }),
  },
  {
    // The probe reads the grant record on arrival, so the screen can name the exact payment rather than
    // sending the deployer to hunt one. It fills a slot; it never gates - see probeGrantRecord.
    id: 'refund',
    applies: (state) => goalOf(state) === 'full',
    probe: probeGrantRecord,
    verify: verifyRefundOutcome,
    // The recovery block differs per policy too: under log_only the failure mode is the inverse.
    recovery: (state) =>
      state.answers.revokePolicy === 'log_only' ? 'refund-log-only' : 'refund',
    build: (state) => ({
      type: 'do',
      text: refundScreen(state.answers.revokePolicy, state.flags?.piId),
    }),
  },
  {
    // E6, offered after the refund. `auto_revoke` only: under log_only the buyer is still on the team, so
    // the claim grant below reconciles to a no-op and its verifies would green without the human. See the
    // E6 text block above.
    id: 'typo-test',
    applies: (state) =>
      goalOf(state) === 'full' && state.answers.revokePolicy === 'auto_revoke',
    field: 'typoTest',
    build: () => ({
      type: 'ask',
      kind: 'choice',
      text: TYPO_TEST_OFFER,
      options: TYPO_TEST_OPTIONS,
    }),
  },
  ...TYPO_SCREENS,
  {
    id: 'closing',
    applies: () => true,
    build: (state) => ({ type: 'say', text: closing(state) }),
  },
]

export const SCREEN_IDS = SCREENS.map((s) => s.id)

// --- state machine ------------------------------------------------------------------------------

export function envOf(state) {
  return state.answers?.env ?? null
}

export function goalOf(state) {
  return state.answers?.goal ?? null
}

// A driver-contract violation: the answer did not fit the record that asked for it. Distinct from any
// setup problem - nothing about the deployer's account is wrong, the input was.
export class DriverError extends Error {}

export function initialState() {
  return { cursor: 'welcome', answers: {}, flags: {} }
}

export function isComplete(state) {
  return state.cursor === null
}

function screenById(id) {
  const screen = SCREENS.find((s) => s.id === id)
  if (!screen) throw new DriverError(`unknown screen: ${id}`)
  return screen
}

// The screens this run will walk, given the answers so far. Only the goal changes membership.
export function sequence(state) {
  return SCREENS.filter((s) => s.applies(state)).map((s) => s.id)
}

// The field a screen collects, if any (some screens choose it by state).
function fieldOf(screen, state) {
  if (typeof screen.field === 'function') return screen.field(state)
  return screen.field ?? null
}

// Which recovery block a screen uses (some pick by state, e.g. E5's inverse modes under log_only).
function recoveryKeyFor(screen, state) {
  if (typeof screen.recovery === 'function') return screen.recovery(state)
  return screen.recovery ?? screen.id
}

// --- the command a record prints ----------------------------------------------------------------
//
// Every record carries the LITERAL next invocation, so the agent COPIES a string instead of COMPOSING
// a shell command. That is not a convenience: a live acceptance run on a cheap model composed
// `cd <path> && npm run wizard:drive -- next 2>&1 | head -50` and drew an approval prompt on EVERY
// call - a compound command falls outside the repo's `Bash(npm run:*)` allowlist however wide the
// allowlist is, the pipe can truncate the very record about to be rendered, and the `-- next` is doubly
// wrong: bash reads `next` (which the driver ignored) while PowerShell CONSUMES the bare `--` as its own
// stop-parsing token, so npm then reads the following word as an npm flag and errors `EUNKNOWNCONFIG`.
//
// So the command surface is BARE WORDS, and only bare words: `next`, `answer YOUR-ANSWER`, `answer done`
// (plus `start` to begin). No `--`, because `--` is exactly the token PowerShell and npm fight over; no
// quotes, chaining, redirection or variables - the string is byte-identical in PowerShell and bash. A
// test pins both properties, and the flag forms are not accepted at all, so the shell-broken form is
// inexpressible rather than merely discouraged.

const NEXT_COMMAND = 'npm run wizard:drive next'
const ANSWER_PREFIX = 'npm run wizard:drive answer '
const ANSWER_COMMAND = `${ANSWER_PREFIX}YOUR-ANSWER`
// Built from DONE, so the word the driver COMPARES against and the word it TELLS you to type cannot drift.
const DONE_COMMAND = `${ANSWER_PREFIX}${DONE}`
// The one command a human types to begin - the record's `command` never emits it (there is no record yet).
export const START_COMMAND = 'npm run wizard:drive start'

/**
 * The command a record prints, given its type and - for a recovery - the type of the screen it is
 * parked on.
 *
 * A recovery does NOT simply take its parked screen's form. `advance` only re-attempts a parked verify
 * on `done` (or, at a parked `ask`, on a corrected value); anything else returns early, running nothing
 * and moving nothing. So a `next` at a recovery parked on one of the six screens that render a `say`
 * (preflight, worker-url, config-written, secret-name-check, deploy, synthetic-check) re-emits the
 * identical record forever - the say's own form is a dead end at a recovery. Only the parked `ask` keeps
 * its form, because that is the one place a value means something.
 */
function commandFor(type, parkedType = null) {
  if (type === 'recovery')
    return parkedType === 'ask' ? ANSWER_COMMAND : DONE_COMMAND
  if (type === 'ask') return ANSWER_COMMAND
  if (type === 'do') return DONE_COMMAND
  return NEXT_COMMAND
}

/**
 * A closed choice's options, each carrying the LITERAL call that answers with it.
 *
 * The record-level `command` on a choice can only be the `YOUR-ANSWER` placeholder - it is written before
 * anyone has chosen. That placeholder is what a live run turned back into the very thing the closed choice
 * exists to prevent: the env question rendered as a numbered type-your-answer list, and the deployer was
 * asked to hand-type `sandbox`. Filling the placeholder is a composing step, and composing is what the
 * command surface removes. So every option arrives pre-composed: whatever an agent's UI can or cannot do,
 * the string to run is already on the option it picked, and there is nothing left to assemble.
 *
 * Built from the option's own `value` through the same prefix the record-level forms use, so the word the
 * driver ACCEPTS and the word its command TYPES cannot drift apart.
 */
function withOptionCommands(options) {
  return options.map((option) => ({
    ...option,
    command: `${ANSWER_PREFIX}${option.value}`,
  }))
}

export function currentRecord(state) {
  if (isComplete(state)) throw new DriverError('the run is complete')
  const screen = screenById(state.cursor)

  // Every env-aware screen names its env or the driver refuses to build it. Sandbox writes `.dev.vars`
  // and the sandbox profile; production writes `.dev.vars.production` and the production profile, and a
  // screen that guessed would send a live secret to the file the run does not read.
  if (screen.envAware !== false && envOf(state) === null) {
    throw new DriverError(
      `screen '${screen.id}' is env-aware but no environment is set`,
    )
  }

  const factsMap = facts(state)

  // A pending recovery wins: a failed verify (or a question) must show the failure modes and return the
  // human to this same step, never the next one.
  if (state.recovery) {
    const key = recoveryKeyFor(screen, state)
    const modes = (RECOVERY[key] ?? []).map((m) => ({
      when: m.when,
      text: fill(m.text, factsMap),
    }))
    return {
      id: screen.id,
      type: 'recovery',
      env: envOf(state),
      goal: goalOf(state),
      modes,
      ...(state.recovery.detail
        ? { detail: fill(state.recovery.detail, factsMap) }
        : {}),
      // The step this returns to - always the one that owns the wrong input, never the next.
      retry: screen.id,
      command: commandFor('recovery', underlyingRecord(screen, state).type),
    }
  }

  const record = screen.build(state)
  const field = fieldOf(screen, state)
  return {
    id: screen.id,
    env: envOf(state),
    goal: goalOf(state),
    ...record,
    text: fill(record.text, factsMap),
    ...(record.options ? { options: withOptionCommands(record.options) } : {}),
    ...(field ? { field } : {}),
    command: commandFor(record.type),
  }
}

/** The command the record at this state asks for, or null if no record can be built from it. */
function commandAt(state) {
  try {
    return currentRecord(state).command ?? null
  } catch {
    return null
  }
}

/** Is this answer the confirmation word? Anything else at a `do` is a QUESTION, not a refusal. */
function isDone(answer) {
  return (
    String(answer ?? '')
      .trim()
      .toLowerCase() === DONE
  )
}

/**
 * The record a screen WOULD emit if it were not parked on a recovery.
 *
 * This is what an answer AT a recovery has to be read against. A recovery record carries `modes` - not
 * `kind`, `options` or `field` - so reading an answer against it accepts anything and stores nothing,
 * which is exactly how a corrected value used to be silently discarded. The underlying `ask` is the only
 * thing that knows whether the answer is one of the options, or a value at all, and which field it goes to.
 */
function underlyingRecord(screen, state) {
  return {
    id: screen.id,
    ...screen.build(state),
    field: fieldOf(screen, state),
  }
}

// Validate an answer against the record that asked for it, and return the value to store.
// `{ question: true }` means "not `done`" at a step that wanted it: the human asked something, which is
// answered from the recovery data rather than treated as an error.
function readAnswer(record, answer) {
  if (record.type === 'say' || record.type === 'recovery') return null
  if (record.type === 'do') {
    return isDone(answer) ? null : { question: true }
  }
  const value = String(answer ?? '').trim()
  if (record.kind === 'choice') {
    const values = record.options.map((o) => o.value)
    if (!values.includes(value)) {
      throw new DriverError(
        `screen '${record.id}' is a closed choice - expected one of ${values.join(', ')}, got '${answer ?? ''}'`,
      )
    }
    return value
  }
  if (!value) {
    throw new DriverError(`screen '${record.id}' expects a value`)
  }
  return value
}

/**
 * Run a screen's verify AT the moment the cursor lands on it, so a `say` whose text REPORTS a result is
 * emitted only once that result was measured.
 *
 * The four autonomous says - config written, secret names present, `/health` OK, synthetic check green -
 * all assert an outcome. Rendering them before the verify ran made every one of them a PREDICTION: a live
 * run printed "Checking `/health`... OK" and the health check then failed, because the record contract
 * emitted the say first and only ran the step when the agent advanced past it. So the step runs here, on
 * arrival, and its say is emitted only on a pass; on a failure the screen's `recovery` is emitted in its
 * place and the cursor stays put. The user never reads an OK that was not measured.
 *
 * This is the same arrival principle the `probe` above already follows - resolve what the screen needs to
 * know before it can be rendered truthfully - applied to the screens whose text is itself the claim.
 */
async function verifyOnArrival(screen, state, deps) {
  // A screen whose step cannot be trusted the instant the cursor lands on it waits first. Only the
  // ARRIVAL pauses: a retry off the recovery has already spent the deployer's own minute reading it.
  if (screen.arrivalPauseMs) await deps.sleep(screen.arrivalPauseMs)
  const result = await screen.verify(state, deps)
  if (result.flags) Object.assign(state.flags, result.flags)
  if (result.ok) {
    // Remember the pass, so advancing off the say does not run the step a second time.
    state.verifiedAt = screen.id
    return
  }
  state.cursor = result.owner ?? state.cursor
  state.recovery = { detail: result.detail ?? null }
}

/**
 * The state machine. Given the current record and an answer, produce the next state.
 *
 * Async because this is where the verifies run: `done` is checked against real state, not trusted. A
 * failed verify NEVER advances - it parks a recovery on the state, and `currentRecord` then emits that
 * step's failure modes. All I/O arrives through `deps`, so tests drive every branch with fakes.
 */
export async function advance(state, answer, deps = defaultDeps()) {
  const record = currentRecord(state)
  const screen = screenById(state.cursor)

  const next = {
    ...state,
    answers: { ...state.answers },
    flags: { ...state.flags },
    recovery: null,
    // Scoped to the screen the cursor is on; cleared here and re-set only by an arrival verify.
    verifiedAt: null,
  }

  // What an answer at a parked recovery MEANS depends on the screen it is parked on:
  //
  //   ask  + a value -> a CORRECTED VALUE. Read it exactly as that ask reads it, store it, re-check.
  //   ask  + `done`  -> re-attempt with the value already stored.
  //   do   + `done`  -> re-attempt (the verify decides).
  //   else           -> still a question: run nothing, move nothing.
  //
  // The corrected-value path is what makes the failed-verify routing work at all. Without it the driver re-asks
  // and then DISCARDS the answer: a fixed org or team slug never reached `answers`, so 4c failed on the
  // same wrong input and routed back forever, and test-buyer - whose own verify re-parked every
  // non-`done` answer - could never accept a corrected handle at all. The re-ask was a dead end.
  const onRecovery = record.type === 'recovery'
  const parked = onRecovery ? underlyingRecord(screen, state) : null
  const corrected = onRecovery && parked.type === 'ask' && !isDone(answer)

  // A question at a parked recovery runs nothing and moves nothing. This return also covers the `do`
  // screens with no verify of their own (payment-link, webhook-secret, purchase, github-team-lock): the
  // verify block below used to be the only thing holding the cursor, so on those a SECOND question walked
  // silently to the next screen.
  if (onRecovery && !corrected && !isDone(answer)) {
    next.recovery = { detail: state.recovery?.detail ?? null }
    return next
  }

  const value = corrected
    ? readAnswer(parked, answer)
    : onRecovery
      ? null
      : readAnswer(record, answer)

  if (value && value.question) {
    // A question returns the human to this same `do` with the recovery data, and never runs a command.
    next.recovery = { detail: null }
    return next
  }
  const field = (onRecovery ? parked : record).field
  if (field && value !== null && !value?.question) {
    next.answers[field] = value
  }

  // Mint the typo handle at the moment the offer is TAKEN, and only once - it lives in the run's state
  // from here on, so the purchase screen, the claim page and any recovery all name the same handle.
  if (field === 'typoTest' && value === 'test' && !next.flags.typoHandle) {
    next.flags.typoHandle = makeTypoHandle(deps.random ?? Math.random)
  }

  // The gate: whenever the screen has something real to check, it is checked - on `done`, on an answered
  // `ask`, on an auto `say`, and on re-attempting a recovery.
  //
  // `ask` used to be excluded here, which silently disabled the verifies on the two screens that collect
  // a value the driver can check. 4d looked verified only because 4c's GitHub block routes ITS failures
  // back to 4d; the test-buyer screen's own verify never ran once. A question at a `do` still returns
  // above without running anything - that path is untouched.
  // An arrival verify already ran this screen's step and measured it - running it again here would
  // deploy twice, or re-send the synthetic event, to answer a question already answered.
  const alreadyMeasured =
    screen.verifyOnArrival && state.verifiedAt === screen.id

  // A question already returned above, so anything reaching here is a real attempt: `done`, an answered
  // ask, an auto say, or a CORRECTED value at a parked recovery - which must be checked against the value
  // just stored, not re-parked. Re-parking it unconditionally is what deadlocked test-buyer: its verify
  // is the only thing that can clear its own recovery, and it never got to run.
  if (screen.verify && !alreadyMeasured) {
    const result = await screen.verify(next, deps)
    if (result.flags) Object.assign(next.flags, result.flags)
    if (!result.ok) {
      // Park the recovery on the screen that OWNS the wrong input - which may be an EARLIER screen than
      // the one being verified, because the GitHub checks can only run once the token exists.
      next.cursor = result.owner ?? state.cursor
      next.recovery = { detail: result.detail ?? null }
      return next
    }
    if (screen.verifyOnArrival) {
      // A retry off the recovery just passed, so the result is now measured - emit the say rather than
      // walking past it. The cursor stays here; advancing off the say is what moves on.
      next.verifiedAt = screen.id
      return next
    }
  }

  // Recompute the sequence from the NEW answers, so a screen the just-given answer brings into (or out
  // of) the run is honoured immediately - that is what makes the goal branch work at the goal screen.
  const list = sequence(next)
  const index = list.indexOf(state.cursor)
  next.cursor = index === -1 ? null : (list[index + 1] ?? null)

  // Arriving at a screen, resolve what it needs to know before it can be rendered truthfully - the probe
  // for what the words must NAME, the arrival verify for what the words must CLAIM.
  if (next.cursor) {
    const arriving = screenById(next.cursor)
    if (arriving.probe) {
      Object.assign(next.flags, await arriving.probe(next, deps))
    }
    if (arriving.verifyOnArrival) {
      await verifyOnArrival(arriving, next, deps)
    }
  }
  return next
}

// --- edges (state file + stdout; not exercised by the pure state-machine tests) -----------------

export const STATE_FILE = '.wizard-driver-state.json'

export function readState(cwd = process.cwd()) {
  const path = join(cwd, STATE_FILE)
  if (!existsSync(path)) return null
  return JSON.parse(readFileSync(path, 'utf8'))
}

export function writeState(state, cwd = process.cwd()) {
  writeFileSync(join(cwd, STATE_FILE), `${JSON.stringify(state, null, 2)}\n`)
}

export function clearState(cwd = process.cwd()) {
  const path = join(cwd, STATE_FILE)
  if (existsSync(path)) rmSync(path)
}

/**
 * The ONE invocation surface: bare words, no flags. `start` begins a NEW run, `reset` discards a saved one
 * and begins fresh, `next` advances a say, `answer <value...>` feeds a value back, and NO word at all
 * resumes. The flag forms (`--start`, `--next`, `--answer`) are NOT accepted - `--` is the token
 * PowerShell consumes before npm sees it, so a flag form errors on Windows; removing it makes the
 * shell-broken form inexpressible rather than merely warned against.
 *
 * `answer` takes EVERYTHING after it, joined with single spaces, so a multi-word value carries across
 * without a quote in either shell (`answer my org name` -> `my org name`). Every real wizard answer is a
 * single token, but joining costs nothing and removes the one place a value would have needed quoting.
 */
export function parseDriverArgs(rest = []) {
  const [head, ...tail] = rest
  if (head === 'start') return { start: true }
  // `reset` is no longer a synonym for `start`: `start` REFUSES over a saved run, and reset is the word
  // that says discard it anyway. Collapsing them would leave no way to express the discard.
  if (head === 'reset') return { reset: true }
  if (head === 'next') return { next: true }
  if (head === 'answer') return { answer: tail.join(' ') }
  return {}
}

// One record per call, on stdout, as JSON. The agent renders it and calls back with the answer.
// Async because advancing runs the verifies - the step functions and the GitHub API live behind it.
export async function main(argv, cwd = process.cwd(), deps = defaultDeps(cwd)) {
  const opts = parseDriverArgs(argv)

  // `start` REFUSES over a saved run rather than erasing it. The wizard tells a blocked deployer their
  // progress is saved and to come back later; `start` is the word the shim documents for beginning, so
  // the deployer who comes back and follows it would have destroyed exactly what they were promised. It
  // refuses WITHOUT touching the file - the run is still there after the refusal - and names both real
  // options, because a refusal that does not say what to do instead just moves the dead end.
  //
  // Gated on the file EXISTING, not on reading it: parsing it here would make `start` fail outright on a
  // state file too corrupt to read, which is the one case where beginning again is what you want, and
  // `reset` is the way out of it either way.
  if (opts.start && existsSync(join(cwd, STATE_FILE))) {
    throw new DriverError(
      'A run is already in progress here and `start` would erase it. To RESUME where it left off, run `npm run wizard:drive` with no extra words. To DISCARD the saved run and begin fresh, run `npm run wizard:drive reset`.',
    )
  }

  let state = opts.start || opts.reset ? initialState() : readState(cwd)
  if (!state) state = initialState()
  else if (
    !opts.start &&
    !opts.reset &&
    (opts.next || opts.answer !== undefined)
  ) {
    const answered = state
    try {
      state = await advance(state, opts.answer, deps)
    } catch (err) {
      // A rejected answer runs nothing and moves nothing - the state file is not rewritten - so the
      // call to make next is the one the record just answered already asked for. Carry that form on
      // the error, or the single response the agent most needs a command on is the only one without.
      if (err instanceof DriverError) err.command = commandAt(answered)
      throw err
    }
  }

  if (isComplete(state)) {
    clearState(cwd)
    return { done: true }
  }
  writeState(state, cwd)
  return currentRecord(state)
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  try {
    const record = await main(process.argv.slice(2))
    process.stdout.write(`${JSON.stringify(record, null, 2)}\n`)
  } catch (err) {
    if (!(err instanceof DriverError)) throw err
    process.stdout.write(
      `${JSON.stringify({ error: err.message, ...(err.command ? { command: err.command } : {}) }, null, 2)}\n`,
    )
    process.exit(1)
  }
}
