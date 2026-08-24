# RepoAccess - Stripe setup and test guide (Core)

> _This guide is the **clone-and-deploy** path (you `git clone` this repo and run it as your worker). To
> embed core into your own worker via npm instead, see `docs/setup-guide.md`._

This is the **manual path**: set up and live-test a self-hosted RepoAccess **Core** worker with
**Stripe**, by hand, end to end. For the guided path instead, run `/repoaccess-setup` in Claude Code,
OpenCode, or another coding agent - the setup wizard drives every step below for you. This document is
for people who would rather do it by hand (or just want to understand each step).

**Two things about the guided path, both one-off.** The first time you start your assistant in this
folder it may ask whether you trust the files here - say yes, or it cannot read or write the project
and the wizard cannot run. And if the assistant starts asking you to approve every single step, close
that session, start a new one in the same folder and run the command again: your progress is saved,
and the wizard resumes where it stopped.

What you are building: a buyer pays through your Stripe checkout, and the worker automatically adds them
to the GitHub team that carries your private repo. A refund or chargeback revokes that access. It runs
as a single Cloudflare Worker on your own account - no server, no SaaS subscription, no per-sale cut.
Cloudflare's free plan carries hundreds of sales a day.

Do a first run in **Stripe Test mode** with test cards. No live activation is needed to prove it works.

## Before you start

- A **Cloudflare account** (free). `wrangler` ships with the repo as a dev dependency, so there is
  nothing to install globally - run it as `npx wrangler` (first `npx wrangler login`).
- A **GitHub organization** you own. Personal accounts have no teams, so an org is required (a Free org
  is fine). The private repo(s) you sell live in this org.
- A **second GitHub account** to play the **test buyer** - a free throwaway account, or a friend's you can
  coordinate with. It must NOT be your org-owner account: the buyer flow is invite, accept, then
  refund/revoke, and the owner (already in the org) cannot play the buyer faithfully. One such buyer account
  covers the whole test run below.
- **Node** and **git**. Clone the repo and install dependencies:

  ```bash
  git clone https://github.com/EdgeKits/repoaccess-core.git
  cd repoaccess-core
  npm install
  ```

  `npm install` matters: the worker bundles a runtime dependency, so a deploy fails without it.

  **Dependency install scripts stay off by design, so npm prints no warning about them.** This repo ships an
  explicit `allowScripts` deny-list in `package.json` (`esbuild`, `sharp`, `workerd`, `fsevents` set to
  `false`), so on npm 12+ those lifecycle scripts stay blocked and you do not see the "install scripts blocked"
  notice. This toolchain does not need those scripts: the packages deliver their platform binaries as ordinary
  optional packages, and everything works with the scripts off (`wrangler` runs, the test suite passes).
  **Never run `npm install-scripts approve`** - for `sharp` the install command is `node install/check.js ||
npm run build`, so approving can fall through to building sharp from source and fail on a machine with no
  build toolchain, and it re-enables the install-time script execution npm 12 disabled. If an older or unusual
  npm setup ever does surface the warning, leave the scripts blocked and continue.

The order below minimizes back-and-forth: GitHub first, then the worker config and a first deploy (to
learn your worker URL), then Stripe (which needs that URL), then a re-deploy with the secret, then the
live test.

## 1. GitHub: org, team, and the worker token

1. **Create a team per product tier** (Org, then Teams, then New team), named after the tier (e.g.
   `pro`). The worker adds buyers to this team; the team carries the repo access.
2. **Attach the private repo(s)** to the team (Team, then Repositories, then Add repository) with
   **Read** (buyers clone, they do not push). Keep the repos private.
3. **Set org Base permissions to `No permission`** (Org, then Settings, then Member privileges). This is
   the isolation floor: without it, every member could see every private repo in the org, and team
   scoping buys you nothing. With it, members get access only through their team(s).
4. **Harden the org** - treat members as paying customers, not teammates (Org, then Settings, then
   Member privileges; each block has its own Save):
   - Repository creation: uncheck Public and Private. Repository forking: off. Projects base
     permissions: No access. Pages creation: uncheck Public and Private. App access requests: disabled.
     GitHub Apps: off.
   - Admin repository permissions: off for all, especially **Repository visibility change** (so a
     member-admin cannot flip a paid private repo to public). Team creation: off.
   - Org, then Settings, then Authentication security: do **NOT** require org-wide 2FA - it ejects
     buyers without 2FA and blocks them from accepting invites. Enable 2FA on your own owner account
     instead.
   - Third-party Access: OAuth app policy - keep Access restricted.
   - Org, then Settings, then Personal access tokens, then **Settings** (its own subpage, three titled
     sections): under Fine-grained personal access tokens, select **Allow access via fine-grained
     personal access tokens** (the worker token needs this; Restrict breaks grants). Under Require
     approval of fine-grained personal access tokens, select **Require administrator approval** - your
     own owner-minted token is ready immediately, only members' tokens wait. Under Set maximum lifetimes
     for personal access tokens, check **Fine-grained personal access tokens must expire** and set the
     maximum lifetime (366 days is the longest); the worker token expires with it, so note the date and
     rotate before it lapses.
5. **Create the worker's fine-grained PAT** (GitHub, then Settings, then Developer settings, then
   Fine-grained tokens, then Generate new token):
   - **Resource owner:** your **org** (not your personal account).
   - **Repository access:** **Public repositories** - the minimal option, and nothing in practice: every
     fine-grained token can read public repos anyway, and this token only manages membership, never
     repositories. Do NOT pick your private repos - the token does not need them. (GitHub used to offer a
     literal **None** here; **Public repositories** is today's equivalent.)
   - **Organization permissions**, then **Members: Read and write** (and nothing else).
   - Pick an **expiration** and note it for rotation.
   - Generate, then copy the token (`github_pat_...`). You will paste it into `.dev.vars` in Step 3. An
     owner-created token is ready immediately even if the org requires token approval.

## 2. Configure the worker

Two files a fresh clone does not carry are needed before anything builds:
`src/config/repoaccess.config.ts` (your org and product map) and `wrangler.jsonc` (your account's ids).
Both are gitignored on purpose, so an update pulled later with `git pull` can never overwrite your values.
Create them from their committed templates:

```bash
npm run bootstrap
```

It copies each file only when that file is missing, prints what it created, and never touches one that
already exists.

Now open `src/config/repoaccess.config.ts`. It hands you one neutral `base` object and exports it under
two names, `sandbox` and `production`: the repo has two deploy entries and each loads one of them
(`src/index.ts` takes `sandbox`, `src/index.production.ts` takes `production`). For a test run you fill
in `base` and both profiles follow it. You split them later, if and when production needs to differ.

```ts
const base: RepoAccessConfig = {
  githubOrg: 'your-org-slug',
  productTeamMap: {
    stripe: { 'prod_...': { teams: ['pro'], grant_mode: 'username' } }, // product id filled in Step 4
    defaults: {
      teams: [],
      grant_mode: 'claim',
      revoke_policy: { mode: 'log_only' },
    },
  },
}

export const sandbox: RepoAccessConfig = base
export const production: RepoAccessConfig = base
```

- `githubOrg` is your org slug (the `github.com/orgs/<slug>` value).
- Map each Stripe **product id** (you get it in Step 4) to the team(s) that carry the repo.
- `grant_mode`: **`username`** (the buyer types their GitHub handle at checkout; auto-falls back to a
  claim link if the handle is missing, malformed, or does not exist) or **`claim`** (always send a
  one-time claim link).
- `revoke_policy`: `{ mode: 'auto_revoke' }` to remove access on refund/chargeback, or
  `{ mode: 'log_only' }` to only log. Keep `defaults` neutral so an unmapped product grants nothing.

Provision KV and wire it:

```bash
npx wrangler kv namespace create repoaccess-core-ENTITLEMENTS
```

Pass the full prefixed title, not a bare `ENTITLEMENTS`: wrangler titles the namespace exactly what you
type, titles are account-wide, and several workers on one account would collide on the bare name. The
prefix is the worker name from `wrangler.jsonc`, so if you renamed the worker, use your own name here.

Paste the **real** returned id into `wrangler.jsonc` (`kv_namespaces`), replacing the placeholder. If an
`ENTITLEMENTS` namespace already exists, reuse its id rather than creating a duplicate. A placeholder id
will not bind. Then confirm `npm run typecheck` is clean.

## 3. First deploy (to learn your worker URL)

Copy the secrets template and add your PAT:

```bash
cp .dev.vars.example .dev.vars
```

In `.dev.vars`, replace `GITHUB_TOKEN=__REPLACE_ME__` with your fine-grained PAT (paste it yourself).
Leave `STRIPE_WEBHOOK_SECRET` as its placeholder for now - it counts as present for this first deploy.

```bash
npx wrangler deploy --env="" --secrets-file .dev.vars
```

The first deploy creates the worker and prints its `https://<worker>.workers.dev` URL - note it; Stripe
needs it. Open `/health` and confirm `{"status":"ok"}`.

## 4. Stripe: product, link, metadata, webhook

1. **Create the product** (Product catalog, then Create product - this is the current label, not the
   older "Products, then Add product"). Set a one-time price. Copy the **product id** (`prod_...`) and
   wire it into `productTeamMap` from Step 2.
2. **Create a Payment Link** (Payment Links, then Create test payment link - the label that button
   carries while the dashboard is in Test mode - then Products or subscriptions; select your product,
   quantity 1). Leave the options off
   (no managed payments, tax, address collection). For **`username` mode**, under **Advanced options,
   then Add custom fields**, add ONE field - Type **Text**, Label **GitHub username** (Stripe derives
   the field key from the label, and the worker matches a key that contains "github"); for **`claim`
   mode**, add no field. Copy the link URL.

   In `username` mode the field lives on Stripe's checkout, so it is the last thing you control before
   the money moves and there is nothing after it to catch a slip. Access goes to whatever account the
   buyer names: a handle nobody owns simply fails and the buyer can be re-invited, but a handle that
   belongs to somebody else is granted to them. It is worth saying plainly on your own sales page, next
   to the buy button, that the GitHub username decides who gets access. In `claim` mode the buyer types
   the handle on your worker's own claim page instead, and that page reads it back for confirmation
   before anything is granted.

3. **Set `metadata.product_id` on the link** (open the link's detail page, then Metadata, then Edit
   metadata; add key `product_id`, value `prod_...`). This is the step people miss: the
   `checkout.session.completed` webhook omits line items, so the worker reads the product from metadata.
4. **Create the webhook destination** (Developers, then Webhooks (Event destinations), then Add
   destination). The current flow takes the **events first**, then the destination URL:
   - **Events (select these three):** `checkout.session.completed`, `charge.refunded`,
     `charge.dispute.created`.
   - **Payload style:** pick **Snapshot** if the option appears; the current flow may not show it (it
     defaults to the full snapshot payload).
   - **Endpoint URL:** `https://<your-worker>.workers.dev/wh/stripe/<SECRET_PATH>`, where `<SECRET_PATH>`
     is a random hard-to-guess string you generate:

     ```bash
     node -e "console.log(require('crypto').randomBytes(16).toString('hex'))"
     ```

     It is obscurity only (the HMAC signature is the real gate; the worker never reads the path), so it
     is NOT a worker secret. Keep it in your notes.

   - Reveal the **Signing secret** (`whsec_...`) for the next step.

## 5. Add the secret and re-deploy

In `.dev.vars`, replace `STRIPE_WEBHOOK_SECRET=__REPLACE_ME__` with the `whsec_...` value (paste it
yourself), then re-deploy so the now-filled secret uploads with the code:

```bash
npx wrangler deploy --env="" --secrets-file .dev.vars
```

Confirm the Stripe endpoint URL matches your deployed worker URL plus the secret path.

## 6. Test it live (in this order)

Start streaming logs before you pay:

```bash
npx wrangler tail <worker-name>
```

Run the three flows **in this order** - refund before the typo test, so each test stays clean:

1. **Grant.** Open the Payment Link and pay with test card `4242 4242 4242 4242` (any future expiry, any
   CVC, any ZIP, any email). In `username` mode, type the test-buyer handle. Expect `POST /wh/stripe/...`,
   then `checkout.session.completed`, then a direct grant with `access.granted`. **`access.granted` means
   the worker created the GitHub invitation, not that the buyer joined.** GitHub emails the buyer the
   invitation - **open it and accept** (or accept at `https://github.com/orgs/<org>/invitation`). Only
   after accepting does the buyer show under Org, then People, in the right team.
2. **Refund and revoke.** In Stripe, open **Transactions**, find that test payment, click the **...**
   button at the end of its row, then **Refund payment** (full
   amount). Expect `charge.refunded`, then `access.revoked`, and the buyer removed from the team (any
   pending invite cancelled). Doing the refund **before** the typo test means revoke runs against a
   single clean grant, and the same handle is free to reuse on the claim page next - so a single
   test-buyer account (separate from your org-owner account) covers the whole run.

   In this test the buyer also gets a GitHub email saying they were removed from the **organization**, which
   looks alarming and is not: they held exactly one product, so after losing its team they held nothing, and
   an org member with no team has no access anyway. **A refund revokes the refunded product, not the buyer.**
   If they still hold another purchase, the worker sees them in that product's team and leaves their org
   membership alone - so a customer who refunds one of two products keeps the other, and never gets the
   org-removal email at all. Full rules: [setup-guide.md](setup-guide.md), "What a revoke actually removes".

3. **Typo path and claim fallback** (`username` mode). Pay again, this time typing a
   valid-format-but-nonexistent handle (e.g. `someone-nope-xyz`). Expect a team-add 404, then NOT
   `access.failed` but a `grant -> claim fallback`, then `claim.pending`. The claim link is redacted from
   `npx wrangler tail`; find it in the **Workflow dashboard** (Cloudflare, then Workflows, then your
   workflow, then the run, then the `emit:claim.pending` step output, which carries `claim_url`). Open
   `https://<worker>.workers.dev/claim/<token>`, enter a real handle (reuse the Step-1 handle, now that
   it was revoked), and submit. The claim grant creates a NEW GitHub invitation too - **accept the email
   invite** (or at `https://github.com/orgs/<org>/invitation`) to become a member. A typo never strands a
   paying buyer. (In production you do not dig this link out by hand: Step 7 wires a post-payment redirect
   that lands the buyer on the claim page automatically.)

That single live grant verifies the whole chain: the PAT, the org hardening, the config, the webhook
signature, and the deploy.

## 7. Deliver the claim link automatically (the post-payment redirect)

In `claim` mode every buyer needs the one-time claim link, and in `username` mode a buyer who mistypes
their handle falls back to one (Step 6, flow 3). Rather than make them dig it out of a dashboard, send
them straight there: point your Stripe checkout's post-payment redirect at the worker, which resolves the
buyer's transaction to their claim page.

The worker exposes a resolver: `GET /claim/by-txn/stripe/<id>`. Hand it the buyer's transaction and it
302-redirects to the live claim page (`/claim/<token>`); if access was already granted directly (the
`username` happy path) it shows a short "you are all set, accept the GitHub invite" page; and while the grant
workflow is still finishing it shows a neutral "setting up your access" page that refreshes itself. **Expect
that page to sit there for up to about a minute** - the grant runs asynchronously after the webhook ack
returns, and a KV key-miss is edge-cached for ~60s, so even a fully successful grant can read as pending for that
long. It is not a hang, and the page self-refreshes to the result. Tell buyers a minute, not "a few seconds":
a buyer promised seconds opens a support ticket at second fifteen, against a system that is working. The
resolver is read-only and re-queryable, so a buyer who closes the tab can open the same link again.

Wire it on the Payment Link: open the link, then the **After payment** tab, and under **Confirmation
page** choose **Don't show confirmation page**. Set the redirect URL to

```
https://<your-worker>.workers.dev/claim/by-txn/stripe/{CHECKOUT_SESSION_ID}
```

Stripe substitutes `{CHECKOUT_SESSION_ID}` with the real id at redirect time. That id is the **checkout
session** (`cs_...`), while the worker keys the claim by the **payment intent** (`pi_...`); the worker
bridges the two automatically (it recorded the mapping when the payment arrived), so the path just works.
For a custom, API-created Checkout Session, set `success_url` to the same path with the same
`{CHECKOUT_SESSION_ID}` placeholder.

To test it, repeat the Step 6 grant in `claim` mode (or the typo fallback) with the redirect configured:
after paying you land on the claim page directly, no dashboard lookup. The Workflow-dashboard method in
Step 6 stays available as a manual fallback.

## 8. Going live and operating

- **Add more products:** map each new Stripe product id to a team in `productTeamMap` and re-deploy. If
  you set up with the guided wizard instead of this document, you can also simply ask it in the same
  session to add a product or a team - it edits the config and re-deploys for you.
- **Production:** repeat with the `production` config profile and `.dev.vars.production`, deploying with
  `npx wrangler deploy --env production --secrets-file .dev.vars.production`.
- **Token rotation:** the fine-grained PAT expires (the org caps its lifetime). Before it lapses, issue a
  new token with the same scope (org owner, repository access Public repositories, Members Read and write) and update
  the `GITHUB_TOKEN` secret, then re-deploy. If it lapses, grants and revokes stop until you rotate.
- **If you use Cloudflare security rules, keep this worker out of them.** Skip this if you have not
  written any - a default Cloudflare zone lets everything through, and there is nothing for you to
  do here. But if you filter traffic by user agent, ASN, bot score or country, those filters will
  stop your sales, and they fail invisibly: the request never reaches the worker, so its logs stay
  empty while Stripe's queue quietly grows and its retries burn down. Stripe's webhook does not look
  like a browser: it arrives with the user agent `Stripe/1.0`, and it delivers from AWS address
  space (AS16509), so a rule aimed at "datacenter traffic" by ASN catches it too. A managed
  challenge is as fatal as a block, because the caller gets a challenge page instead of a `200`.
  Exempt this worker's hostname from any such rule, or at least the `/wh/` paths and `/health`, and
  do not count on `cf.client.bot` to spare you: that verified-bot list is Cloudflare's, and it
  covers some providers and not others. One setting has no exception at all - **Bot Fight Mode** on
  the free plan cannot be skipped by any rule, so if it is on, turn it off. The wizard cannot warn
  you about this: its own probes deliberately look like a browser, so they pass through exactly the
  rule that would refuse Stripe's webhook, and a clean deploy check is not evidence that your zone
  lets your sales in. It does read a `403` correctly if one reaches it - as a rule standing in front
  of the worker rather than as a failed deploy - but it only sees rules that would refuse a browser
  too. To find the rule, open the Cloudflare **dashboard**, go to **Domains**, select your domain,
  then **Security -> Analytics** and the **Events** tab.

### The wizard's "production" is your WORKER, not your Stripe account

If you took the guided path, read this first, because the two words look alike and mean different things.

The wizard asks whether you are setting up **sandbox** or **production**. That choice is about **your
worker**: the config profile, `.dev.vars.production`, and a custom domain instead of `*.workers.dev`. It
is not about Stripe. **Neither environment puts Stripe into live mode.** Whenever the wizard buys
anything it is the test card `4242 4242 4242 4242`, and the dashboard has to be in test mode, because a
test card is refused in live mode.

So after a successful "production" wizard run you have a production **worker**, on your own domain,
proven end to end - and a Stripe account still in test. You are two values away from selling, and they
are below. (The wizard has no third mode that spends real money, on purpose. Charging your own card to
prove a setup is a decision you make deliberately, not one a script walks you into.)

### Going live: two values, then a deploy

Stripe keeps test and live data apart, so nothing you built in test mode exists in live mode. **The
steps are the ones you already did**, and you already know how to do them - only now in the live
dashboard: create the product, create the Payment Link (with the same GitHub-handle field and the same
redirect), and add the webhook endpoint (same worker URL, same three events -
`checkout.session.completed`, `charge.refunded`, `charge.dispute.created`).

The labels are not necessarily the ones section 4 names, because those are the Test-mode ones. The three
actions are the same three, in the same order.

Two of the things you create there have a copy inside your worker, and they are the only two:

| From the live dashboard | Where it goes in your worker                                 |
| ----------------------- | ------------------------------------------------------------ |
| the **product id**      | `productTeamMap.stripe` in `src/config/repoaccess.config.ts` |
| the **signing secret**  | `STRIPE_WEBHOOK_SECRET` in `.dev.vars.production`            |

A live product id is a different id from your test one; a live webhook endpoint has its own signing
secret. Neither value carries over, and neither is guessable - you copy both.

Then deploy: `npm run deploy:production`.

Finally, **buy your own product once with a real card, and refund it.** That is the only thing that
proves the live webhook reaches the live worker. It costs you the processing fee, which Stripe does not
return on a refund - a few cents, and the cheapest certainty you will buy all year.

**If you change the webhook secret and forget the product id, or the other way round, everything looks
fine and nothing works.** Stripe accepts the payment and the buyer is charged. With the wrong secret,
your worker rejects the webhook as unsigned - green in Stripe, `401` in your log. With the wrong product
id, the webhook verifies but the product maps to no team, so nothing is granted. Either way the buyer
has paid and is waiting. Both are in Troubleshooting below.

### Keeping a working test setup next to the live one

You do not have to give up your sandbox to go live. In the config, `sandbox` and `production` start as
the same object - so if you simply overwrite the product id, your test setup starts pointing at the live
product too.

If you want both, split the profiles: leave the **test** product id in the `sandbox` profile and put the
**live** one in `production`. The config template shows the shape. The two profiles are loaded by
different entry points (`src/index.ts` and `src/index.production.ts`), so each environment sees only its
own - and you keep a place to test a change with a test card before it reaches paying buyers.

## Troubleshooting

- **A live payment succeeds in Stripe but the worker logs `401` and nobody is invited:** the worker is
  still holding the **test** `STRIPE_WEBHOOK_SECRET` while Stripe is sending **live** events. A live
  webhook endpoint has its own signing secret. Copy it from the live endpoint into
  `.dev.vars.production` and deploy again. Stripe's webhook page shows the same thing from its side: the
  deliveries are there, each answered with a `401`. Nothing is lost - once the secret is right, replay
  the failed events from that page and the invitations go out.
- **A live payment is accepted, the webhook returns `200`, and still nobody is invited:** the signature
  was fine, so this is the other half of the pair - the config still carries your **test** product id.
  The live product matches no entry in `productTeamMap`, so `defaults` applies - and `defaults.teams` is
  empty, so there is nothing to grant. (`revoke_policy: log_only` in the same `defaults` block is about
  refunds, not grants; it is not what is stopping you here.) Put the live product id in
  `productTeamMap.stripe` and deploy again. The events can be replayed from Stripe's webhook page
  afterwards, exactly as above.
- **Grant fails 401 / 403:** the PAT is missing Members Read and write, or fine-grained PATs are
  restricted at the org, or the token is pending approval or expired.
- **Grant fails 404 (user not found):** the GitHub username does not exist - a buyer typo, not a token
  problem. In `username` mode the buyer automatically gets a claim link to self-correct.
- **A valid handle still routes to the claim page:** the custom-field key did not contain "github". Use
  `metadata.github_username` on the checkout instead.
- **Buyer paid but is not in the repo:** the invite is created right after payment and the buyer must
  **accept** it (via the GitHub email). Confirm the sale and `access.granted` in the Workflow run; if
  those are there, you are waiting on the buyer to accept.
- **New-org invite cap:** 50 invitations per 24h for the first month - age the org before a big launch.
- **A secret has leaked, or you think it has.** These are different keys kept in different places, so
  work through them in this order. (1) **`GITHUB_TOKEN`** is the widest - it can add and remove members
  of your organisation. Revoke it on GitHub, issue a new one with the same scope (section 1), put it on
  its line in the secrets file for that environment, and re-deploy (section 5). (2)
  **`STRIPE_WEBHOOK_SECRET`** is what proves an event really came from Stripe. Roll it where you set it
  (section 4), put the new value on its line, and re-deploy (section 5). Between the roll and the deploy
  the worker rejects arriving events as unsigned, so open Stripe's delivery log afterwards and re-send
  anything that failed in that window. (3) The secret segment in the webhook URL is NOT a third key, and
  this is the moment the instinct to rotate it is strongest. On this rail the worker never reads it -
  the signature above is the gate, and the segment is obscurity only, exactly as section 4 says. So a
  leaked URL is not by itself a leak, and changing the segment protects nothing: re-point Stripe's
  endpoint if you want the tidiness, but the thing to roll is the signing secret. Your Cloudflare
  account, your KV data and your GitHub organisation are untouched by any of this - only the keys
  change.

---

RepoAccess is part of [EdgeKits](https://edgekits.dev/).
