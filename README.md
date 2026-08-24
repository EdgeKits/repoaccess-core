# RepoAccess

**Sell access to a private GitHub repo on your own infrastructure, with the payment provider you
already use.**

A buyer pays, and they're automatically invited to the GitHub team that carries access to your private
repo. A refund or chargeback revokes it. It runs as a single **Cloudflare Worker** on your own
account: no server, no SaaS subscription, no per-sale cut. Cloudflare's free plan carries hundreds of
sales a day.

**Your coding agent sets this up without ever seeing your secrets** - and the rules that enforce that are
committed in this repo, so you can check them before you start.

Use it to sell SaaS boilerplates, starter kits, courses, AI notebooks, private modules, or paid
community resources. Anything delivered as a repo.

`repoaccess-core` is the free, open-source (AGPL-3.0) core. It ships the **Stripe** adapter plus the
full grant and revoke engine. **RepoAccess Pro** (see below) adds more payment providers (including
Merchant-of-Record options) for sellers who can't use Stripe, several customizable claim-page
templates, and support.

## Why this exists

Tools like Polar, Dodo, and GitHub Sponsors also solve "pay, then GitHub access", but they're **billing
platforms**: you adopt their checkout and they take a per-transaction cut. Two consequences:

- **They're Stripe-bound.** If you're somewhere Stripe isn't available (much of CIS, MENA, Africa,
  Asia, and beyond), you're locked out.
- **They own the rail.** You can't bring the provider you already sell with, and you pay a % forever.

RepoAccess is the opposite: a light, single-purpose access-grant worker you self-host and wire to
**any** webhook-capable provider. This repository ships the engine with a complete Stripe
adapter, and the adapter seam is a small, typed, public contract - the provider you already sell
with is one implementation of it away, or already packaged in **Pro** (see below). Keep your
checkout, your margins, and your region.

## How it works

1. Your provider fires a webhook to your worker on a sale (and on refunds or chargebacks).
2. The worker **verifies** the signature, **normalizes** the event, and runs a durable **Workflow**.
3. The buyer lands in the GitHub team that carries your repo. By default they open a one-time **claim
   link** and enter their GitHub username; if your checkout already collected the username, they're
   added directly.
4. On a refund or chargeback (within a 180-day window), access is **revoked** and any pending invite is
   cancelled.

No "Login with GitHub", no phoning home: GitHub's own invitation _is_ the identity check. Only the real
account owner can accept it.

## What a refund actually removes (and what it leaves alone)

**A refund revokes the product that was refunded. Not the buyer.** This matters the moment you sell more
than one thing:

1. **Only the teams on that grant.** Teams that came from a _different_ purchase are not touched.
2. **Any pending invitation** for that buyer is cancelled - an unaccepted invite is still a grant in flight.
3. **Then org membership is reconciled against live GitHub state.** The worker asks GitHub which of your
   configured teams the buyer is still in. If they are in **any** of them they **keep their org membership**,
   and everything their other purchases entitle them to. Only when they are in **no** product team at all is
   the buyer removed from the organization - an org member with no team gets nothing anyway (your base
   permissions are `No permission`), so leaving them there would be untidy, not generous.

So the case sellers worry about is already handled: **a buyer who owns product A, buys product B, then
refunds B, loses B and keeps A.** The check is made against GitHub itself, never against the worker's own
records, so it stays correct even after a grant record has aged out.

**The support ticket this saves you.** GitHub's own emails are what cause the panic, not the software. Every
revoke sends a **team**-removal notice, which is accurate and reads like what it is. The alarming one is the
SECOND email: a buyer left in no team at all is also told they were removed from the **organization**, which
reads like a ban. It is not, and nothing else was touched. A buyer who still holds another purchase stays in
that purchase's team, so they get the team notice and never the organization one. Full rules, including the
one caveat about teams you add by hand, are in the [setup guide](./docs/setup-guide.md).

## Guided setup (recommended)

![RepoAccess setup wizard - guided, verified, step by step (shown in OpenCode)](https://raw.githubusercontent.com/EdgeKits/repoaccess-core/main/docs/assets/setup-wizard-opencode.gif)

**Before you start.** A free **Cloudflare account**. A **GitHub organization** you own - personal accounts
have no teams, so an org is required, and a Free org is fine. A **second GitHub account** to play the test
buyer: your org-owner account is already in the org, so it never receives an invite and cannot test the real
path. And **Node** and **git**. Budget about an hour if you are setting all of that up from scratch; much
less if your GitHub org and payment account already exist.

The fastest way in is the built-in **setup wizard**. Clone the repo and run it in
[Claude Code](https://claude.com/claude-code):

```bash
git clone https://github.com/EdgeKits/repoaccess-core.git
cd repoaccess-core
npm install
claude            # then type: /repoaccess-setup
```

`/repoaccess-setup` hand-walks you through the entire setup, one verified step at a time: your GitHub
org and team plus the privacy settings that keep your repos private, the Stripe product and webhook,
your secrets, deploy, and a live end-to-end test. It edits the config files for you and guides the
dashboard clicks (no digging through docs).

During the wizard, your coding agent runs a single setup command (`npm run wizard:drive`) and the wizard
does the rest: it runs the wrangler and npm work and edits two config files
(`src/config/repoaccess.config.ts` and `wrangler.jsonc`) for you.

**How it never sees your secrets.** The wizard is a program, not a set of instructions your agent
improvises from. The agent runs one command, renders what the program prints, and hands your
answer back; the file work happens inside that program, in a child process, not through the
agent.

You paste your secret values into `.dev.vars` yourself, and the deploy hands that FILE to
`wrangler`, which reads it itself - so the wizard does not read your secret values for the upload
at all. Where it does need one, to call an API on your behalf, it reads it inside that child
process and puts it straight into a request header. Either way they never pass through the agent
at any point.

And the restriction is not a promise: `.claude/settings.json` and `opencode.json` in this repo
deny the agent's file reads of `.dev.vars` and `.dev.vars.production` by name, every other route
to them sits outside the allowlist and stops at your approval prompt, and both files are
committed, so you can read them before you run anything.

The wizard needs exactly one call, `npm run wizard:drive`, and the allowlist is what lets you
approve it once (pick 'yes, and don't ask again' the first time) instead of step by step. Read
the allowlist rather than take our word for its size: it covers `npm run` scripts and
`npm install`, plus edits to the two config files the wizard writes. What it does not cover is
your secrets file, which is denied by name.

If you would rather see it than read it: a test in this repo plants fake secret values through
the setup's end-to-end check and asserts they never appear in anything the agent sees.

This is a configuration you can inspect rather than a sandbox: the guarantee is that the agent is never
asked to touch your secrets, its reads of those two files are refused by name, and anything else it
might reach for has to come past you first.

**Other agents (Codex, Cursor, Amp, ...):** open the cloned repo in your agent. The repo carries an
`AGENTS.md` at its root - the file coding agents look for - and it points at the same wizard. Claude Code
and [OpenCode](https://opencode.ai) also expose it as the `/repoaccess-setup` command.

**Rather not use an agent at all?** The wizard is a convenience, not a requirement - nothing in RepoAccess
needs one. The [manual setup guide](./docs/user-guide-stripe.md) walks this same clone-and-deploy path by
hand, dashboard click by dashboard click, and ends with the same live end-to-end test.

Rather wire RepoAccess into an existing worker by hand instead of cloning? Use **Compose it yourself** below.

## Compose it yourself

```bash
npm install repoaccess-core hono
```

`hono` is a peer dependency (RepoAccess is built on Hono). npm 7+ installs it automatically, but pnpm and
Yarn require it listed explicitly, so install it alongside.

Compose the adapters you use and pass a typed config:

```ts
// src/index.ts
import { createWorker, createAccessWorkflow, ClaimGuard } from 'repoaccess-core'
import { stripe } from 'repoaccess-core/adapters/stripe'
import { config } from './repoaccess.config'

// Pass the SAME adapter list to both factories.
const adapters = [stripe]

export default createWorker({ adapters, config })
export class AccessWorkflow extends createAccessWorkflow(config, adapters) {}
export { ClaimGuard }
```

> `adapters` is optional for hmac-only setups (Stripe), but pass it to both so adding an
> `api_callback` adapter later just works.

```ts
// src/repoaccess.config.ts
import type { RepoAccessConfig } from 'repoaccess-core'

export const config: RepoAccessConfig = {
  githubOrg: 'your-org',
  productTeamMap: {
    stripe: { prod_ABC: { teams: ['pro'], grant_mode: 'username' } },
    defaults: {
      teams: [],
      grant_mode: 'claim',
      revoke_policy: { mode: 'log_only' },
    },
  },
}
```

Add the Cloudflare bindings (Workflow, KV, Durable Object), put your secrets (`GITHUB_TOKEN`,
`STRIPE_WEBHOOK_SECRET`) in `.dev.vars`, and `npx wrangler deploy --env=""`. Full walkthrough:
[**setup guide**](./docs/setup-guide.md).

## What's in core

- **Stripe** adapter: HMAC-verified `checkout.session.completed`, `charge.refunded`,
  `charge.dispute.created`.
- **Grant and revoke** engine: a durable Cloudflare Workflow, idempotent on retried webhooks, GitHub
  rate-limit backoff, and reconciliation around manual changes.
- **Claim flow**: a one-time claim link plus a single-flight Durable Object so two submissions can't
  over-grant. The claim page is a pluggable, seller-brandable template.
- **Config as code**: a typed config object, no escaped-JSON env vars.
- **Safe outbound events** (optional): signed `access.*` and `claim.*` webhooks with an SSRF allowlist.
- **Runs on Cloudflare's free plan at real volume** - hundreds of sales a day. You upgrade because
  your sales outgrew it, not because the software asked you to.

Every release is recorded in [`CHANGELOG.md`](CHANGELOG.md). Read it before you `git pull`: it says what
a version fixes, whether it touches config you set, and whether it is worth taking at all.

## RepoAccess Pro

Core is everything you need to self-host with Stripe. **Pro** is for sellers who need more:

- **More payment providers**: **Paddle** and **Lemon Squeezy** (Merchant-of-Record, with tax handled
  for you), **Gumroad**, **Razorpay** (India), and **Telegram Stars** (in-Telegram checkout). Sell from
  the regions, and with the providers, a Stripe-only setup can't reach. More providers are on the way.
- **Your brand on every page the buyer sees.** The claim form, the "setting up your access" page, "access
  granted", the failure page: all rendered by your worker. Pro ships designed presets, each with a **light
  and a dark palette**, contrast-checked, on system fonts so they load instantly. Pick one in a single file,
  override any token, and the buyer's own browser decides light or dark.
- **A worker-hosted checkout page** for Paddle, so you can sell through a Merchant of Record without owning a
  website at all.
- **An embeddable service**: another Worker on your account can call grant and revoke directly over a service
  binding - no public URL, no signature, the binding is the authorization.
- **The recipe to add any provider yourself**, written so a coding agent can follow it unaided: the adapter
  contract, three worked examples, and our per-provider notes on what each one's documentation gets wrong.
- **Support and a year of updates**, which mostly means keeping the adapters correct as the providers quietly
  change their webhooks underneath you.
- One-time license, your own infra, no per-sale cut.

Pricing and how to get it are on the [RepoAccess page](https://edgekits.dev/en/tools/repoaccess/).

## License

AGPL-3.0-or-later. Copyright © 2026 Gary Stupak. See [LICENSE](LICENSE).

If you run a modified RepoAccess as a service for others, the AGPL's network-use terms apply (see the FAQ
below). For a closed-source or otherwise proprietary use, the licensed edition is **RepoAccess Pro** - there
is no separate commercial license for core.

## License and AGPL FAQ

RepoAccess core is licensed under **AGPL-3.0**. Plain-English answers to the questions people actually ask
(this is not legal advice - for edge cases, consult a lawyer):

**Can I self-host it to sell access to my own private repos?**
Yes, freely - that is the intended use. If you run it unmodified, its source is already public (this repo),
so you have nothing extra to do. AGPL covers the RepoAccess source itself; it does not require you to open
your repositories, your buyers' data, or your business.

**What if I modify core and run it as a service?**
AGPL's network clause (section 13) applies: if you modify RepoAccess and let users interact with your
modified version over a network, you must offer those users the complete corresponding source of your
version - by providing a public download (a public git repo or archive), prominently, at no charge. That is
an accessible offer to the people using your service, not private correspondence. In practice: publish your
fork's source and link it from the running service.

**Does importing core into my own worker make my whole app AGPL?**
Combining AGPL code into your worker generally makes the combined work subject to AGPL, so if you offer it
over a network you would owe its corresponding source to your users. If you need a **closed-source**
commercial product, that is exactly what **RepoAccess Pro** is for: a proprietarily licensed
edition (including the embeddable RPC service) with no AGPL obligation. Use core (AGPL) for open /
self-hosted; use Pro for closed commercial.

**Is there a commercial license for core?**
Not sold on its own. The proprietary path is Pro, which licenses this same core code to you on
Pro's terms instead of the AGPL. Core on its own is AGPL-only by design: the copyleft is what stops
someone from privately forking it into a closed, competing service.

(Not legal advice. The "derivative work" vs "mere aggregation" boundary has nuance; consult a professional
for your specific situation.)

---

RepoAccess is part of [EdgeKits](https://edgekits.dev/).
