# Deliver GitHub repo access on payment - setup guide

> _There are two ways to run RepoAccess Core, and this guide covers one of them._
>
> - _**Embed it in your own worker** (`npm install repoaccess-core`) - you are in the right place, read on._
> - _**Clone this repo and deploy it as it is** - see [user-guide-stripe.md](user-guide-stripe.md), which walks
>   that setup by hand, dashboard by dashboard. The setup wizard drives those same steps for you if you would
>   rather it did (see the README)._

This guide gets your **self-hosted RepoAccess Worker** live: a buyer pays through your payment
provider, and they're automatically added to the right GitHub team (which carries access to your
private repo). It runs as a single Cloudflare Worker on your own account: no server, no SaaS fees,
and no cut of your sales.

**Target: ~10 minutes** once you have the accounts below.

## Prerequisites

- A **Cloudflare account** (free) + the `wrangler` CLI (add it to your project as a dev dependency:
  `npm i -D wrangler`, then `npx wrangler login`).
- A **GitHub organization** that owns the private repo(s) you sell.
- A **Stripe** account (core ships the Stripe adapter; the engine itself is provider-agnostic).
- Node.js + npm.

---

## What this costs to run

RepoAccess charges you nothing and takes no cut of a sale. The only resources it uses are Cloudflare's,
and it uses them at the moment a buyer pays you. Inside the free plan's limits that costs you nothing
at all; past them you are paying Cloudflare, never us.

Two of Cloudflare's free-plan limits are the ones that bind here: **1,000 KV writes a day** and
**3,000 Workflow steps a day**. A sale spends a handful of each.

| What happens                                                  | Workflow steps | KV writes | KV deletes |
| ------------------------------------------------------------- | -------------- | --------- | ---------- |
| Sale in `username` mode (the handle arrived with the payment) | 6              | 2         | 0          |
| Sale in `claim` mode (the buyer enters their handle)          | 12             | 5         | 2          |
| Refund or chargeback, access revoked                          | 8 to 12        | 0         | 1 to 3     |

Those figures are for the Stripe adapter, one team per product, and a buyer who is not already a
member. One step and one write of each sale is the alias that lets your `success_url` redirect resolve
to the purchase; an adapter whose redirect already carries the transaction id does not pay it. A revoke costs
more the more teams your product map names, because the last thing it does before removing anyone
from the organization is check every configured team to see what their other purchases still entitle
them to.

Divide the limits by the table and the free plan carries roughly:

- **500 sales a day** in `username` mode,
- **200 a day** in `claim` mode,
- **150 a day** even if every single sale is refunded.

Which limit binds first changes with the mode: `username` runs out of steps and writes at the same
point, `claim` runs out of writes first.

If you outgrow that, the Workers Paid plan is **$5 a month** and lifts the same two limits to 1
million KV writes and 500,000 Workflow steps per month, with anything past that costing under a cent
per thousand operations. At the rates in the table that is tens of thousands of sales a month before
usage adds anything to the $5. By the time it does, the bill is a fraction of revenue you have already
taken.

Two smaller ceilings, so you know they exist: the free plan allows 100,000 Worker requests a day
across everything on the account, and 50 outbound calls per invocation. A revoke pages through your
organization's pending invitations, so the second one is worth knowing if your organization runs to
thousands of open invites.

**The table counts writes, not reads, and there is one place where that gap is worth naming.** While a
purchase is still waiting on its grant, the buyer's status page refreshes itself every four seconds, up
to twenty-five times, and each refresh re-reads a few keys. A grant that lands in a second or two costs
one or two of those refreshes; a grant stuck behind a GitHub rate-limit backoff can cost a single buyer
around a hundred KV reads and twenty-five Worker requests instead of one of each. Reads are still not
what runs out first - the free plan allows 100,000 KV reads a day against 1,000 writes, so at the sale
rates above the writes are gone long before the reads are. It is worth knowing as a multiplier you
cannot see in the table, not as a limit you are likely to hit.

---

## Step 1 - Get the worker

Install the core (or, for the Pro adapters, use your Pro build):

```bash
npm install repoaccess-core
```

Your entry composes the adapters you use and passes your typed config. It exports the three things the
Cloudflare runtime needs - the worker (`fetch`), the Workflow class, and the claim-guard Durable Object:

```ts
// src/index.ts
import { createWorker, createAccessWorkflow, ClaimGuard } from 'repoaccess-core'
import { stripe } from 'repoaccess-core/adapters/stripe'
import { config } from './repoaccess.config'

// Pass the SAME adapter list to both: createWorker (verifies + acks the webhook) and
// createAccessWorkflow (the Workflow that grants/revokes - and, for api_callback adapters, fetches
// the authoritative entity). Keep the two lists identical.
const adapters = [stripe]

export default createWorker({ adapters, config })
export class AccessWorkflow extends createAccessWorkflow(config, adapters) {}
export { ClaimGuard }
```

Your settings live in a typed `repoaccess.config.ts` (Step 5) - no escaped-JSON env vars. Secrets stay
in the runtime env (Step 6).

### Your tsconfig

RepoAccess core ships its TypeScript source (AGPL-open, no build step), so YOUR project's build compiles it.
Your `tsconfig.json` `compilerOptions` need:

```jsonc
{
  "compilerOptions": {
    "module": "ESNext",
    "moduleResolution": "Bundler", // or "NodeNext" - to resolve repoaccess-core's source exports
    "jsx": "react-jsx", // honors core's per-file `@jsxImportSource hono/jsx` pragmas (claim/delivery pages)
    "types": ["./worker-configuration.d.ts"], // your CF Env bindings - generate with the command below
    "strict": true,
    "skipLibCheck": true,
    "target": "ESNext",
  },
}
```

- `moduleResolution: "Bundler"` (or `NodeNext`) resolves `repoaccess-core` and `repoaccess-core/adapters/*`
  from source.
- `jsx: "react-jsx"` is required: core's claim / delivery pages are Hono JSX, and the per-file
  `@jsxImportSource hono/jsx` pragmas need this mode. You do NOT need a global `jsxImportSource` unless you
  also write your own Hono JSX.
- Install `hono` (the peer dependency) so `hono/jsx` resolves.
- `types: ["./worker-configuration.d.ts"]` - generate it with

  ```bash
  npx wrangler types --env-interface CloudflareBindings
  ```

  **The `--env-interface` flag is required, not decorative.** Plain `npx wrangler types` names the generated
  interface `Env`, while core's source refers to the global `CloudflareBindings`; without the flag every file
  you import from core fails with "Cannot find name 'CloudflareBindings'". This is the modern replacement for
  the deprecated `@cloudflare/workers-types` package, and it carries the Workers runtime types + your Env
  bindings. You do NOT need `"node"` in `types`: core's worker source is Node-free (the `node:` builtins in
  this repo live only in the clone-only setup wizard, never in the shipped worker code).

## Step 2 - Cloudflare bindings

Core reads three bindings from your worker's environment. Here is the whole of what it needs, as a
file you can start from - fill in your own `name`, `main` and KV id:

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "my-worker",
  "main": "src/index.ts", // YOUR entry - the file that calls createWorker() and exports the two classes
  "compatibility_date": "2026-08-09", // YOUR date. Core does not constrain it (see the note below).

  "workflows": [
    {
      "name": "my-worker-access",
      "binding": "ACCESS_WORKFLOW",
      "class_name": "AccessWorkflow",
    },
  ],

  "kv_namespaces": [
    { "binding": "ENTITLEMENTS", "id": "PASTE_YOUR_NAMESPACE_ID" },
  ],

  "durable_objects": {
    "bindings": [{ "name": "CLAIM_GUARD", "class_name": "ClaimGuard" }],
  },
  // REQUIRED alongside the Durable Object: without a migration entry the class cannot be deployed.
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["ClaimGuard"] }],

  "secrets": {
    "required": ["GITHUB_TOKEN", "STRIPE_WEBHOOK_SECRET"],
  },
}
```

**Binding names and class names are different things, and swapping them is the easiest mistake to make
here.** `ACCESS_WORKFLOW`, `ENTITLEMENTS` and `CLAIM_GUARD` are the names core's source reads off the env,
so they are not yours to rename. `AccessWorkflow` and `ClaimGuard` are the CLASSES, and both must be
exported from whatever file `main` points at, or wrangler cannot resolve the binding at all.

**`secrets.required` is also what gives you types.** `npx wrangler types` types only the names listed
there, and declaring a `secrets` block switches off name-inference from `.dev.vars` - so a secret you use
but do not list is a secret your editor does not know about. The values never go in this file: they live
in `.dev.vars` locally and are set on the deployed worker with `npx wrangler secret put` (Step 6).

**On `compatibility_date`: use your own.** It is the one value here that is genuinely yours, and core
imposes no floor on it - that was measured across dates from 2020 to 2030 with identical results, not
assumed. If you hit type errors inside core's `workflow.ts`, the cause is a missing or misnamed binding
above, not the date.

There are **no `vars`** - your non-secret config lives in `repoaccess.config.ts` (Step 5), not in
`wrangler.jsonc`. Create the KV namespace env-correctly:

```bash
# sandbox / dev
npx wrangler kv namespace create <worker-name>-ENTITLEMENTS
# production
npx wrangler kv namespace create <worker-name>-production-ENTITLEMENTS
```

Pass the full prefixed title, not a bare `ENTITLEMENTS`: wrangler titles the namespace exactly what you
type, titles are account-wide, and several workers on one account would collide on the bare name. So the
env-aware convention - `<worker-name>-ENTITLEMENTS` (sandbox) or `<worker-name>-production-ENTITLEMENTS`
(production), with `<worker-name>` the `name` in your `wrangler.jsonc` - is something you type, not
something the tool derives for you. The **binding stays `ENTITLEMENTS`** (the code reads
`env.ENTITLEMENTS`; never rename the binding). Then paste the returned id into `wrangler.jsonc` for the
matching env. (Workflows are available on the free plan.)

> **The Workflow `name` must be unique per worker.** A Workflow `name` is account-global and belongs
> to exactly one worker. If you run more than one RepoAccess worker on the same Cloudflare account
> (e.g. a Pro worker alongside this one, or separate staging/production deploys), give each a
> **distinct** workflow `name` - otherwise the later deploy silently reassigns the Workflow and breaks
> the other worker's binding.

## Step 3 - GitHub

1. **Teams = product tiers.** In your org, create a team per tier (e.g. `pro`). Buyers get added here.
2. **Attach your private repo(s) to the team** (Team → Repositories → **Add repository**). The team
   carries repo access - the worker never adds direct collaborators.
3. **⚠️ Set org Base permissions to `No permission`** (Org → Settings → Member privileges). This is the
   setting that makes per-product isolation actually work. Base permissions are the floor that **every**
   org member gets to **every** repo in the org. If it is `Read` (or higher) -
   and on many orgs the default is `Read` - then any buyer of any product can see all your private repos,
   and team scoping buys you nothing. With `No permission`, members get access **only** through their
   team(s), so buying product A (team A → repo A) grants repo A alone and other products' repos stay
   invisible. Keep the repos **private** (paid repos already are).
4. **Fine-grained PAT** (GitHub → Settings → Developer settings → **Fine-grained tokens** → Generate
   new token):
   - Resource owner = **your org** (enable fine-grained PATs first: Org → Settings → Personal access tokens
     → **Settings**, under Fine-grained personal access tokens).
   - Repository access = **Public repositories** (the minimal option; GitHub no longer offers None - the
     token only manages membership, so do not select your private repos).
   - Organization permissions → **Members: Read and write** (and nothing else).
   - This token → secret `GITHUB_TOKEN` (Step 6). Your org slug goes in `config.githubOrg` (Step 5).
   - ⚠️ New orgs cap invitations at **50/24h for the first month** - age the org before a big launch.

### Harden the org (members = paying customers)

In this org, **"members" are buyers, not teammates** - treat them as untrusted and disable every member
privilege. Access comes **only** through team membership. Org **Owners keep full access regardless** -
these toggles restrict members, never you.

**Org → Settings → Member privileges** (each block has its own Save):

- **Base permissions → `No permission`** - the critical one (above).
- **Repository creation** → uncheck **Public and Private** (members don't create repos).
- **Repository forking** → off (no forking of private repos into member accounts).
- **Projects base permissions** → `No access`.
- **Pages creation** → uncheck **Public and Private**.
- **App access requests** → `Disable app access requests`.
- **GitHub Apps** ("Allow repository admins to install…") → off.
- **Admin repository permissions** → off for all: **Repository visibility change** (else a member-admin
  could flip a private paid repo to **public**), **Repository deletion and transfer**, **Issue deletion**,
  **Branch renames**.
- **Member team permissions → Team creation** → off.

**Org → Settings → Authentication security:**

- **Do NOT** "Require two-factor authentication for everyone" - it **removes** members without 2FA (your
  buyers) and blocks them from accepting invites. Same goes for an IP allow list. Enable 2FA on your own
  **owner** account instead.

**Org → Settings → Third-party Access:**

- **OAuth app policy** → keep **Access restricted** (approved apps only).

**Org → Settings → Personal access tokens → Settings** (this block lives on its own **Settings** subpage,
with three titled sections):

- Under **Fine-grained personal access tokens** → select **Allow access via fine-grained personal access
  tokens** (the worker's `GITHUB_TOKEN` needs this; **Restrict** breaks grants).
- Under **Require approval of fine-grained personal access tokens** → select **Require administrator
  approval**. Your own **owner**-minted token is ready immediately; only members' tokens wait for approval.
- Under **Set maximum lifetimes for personal access tokens** → check **Fine-grained personal access tokens
  must expire** and set the maximum lifetime (**366 days** is the longest). The worker's token expires with
  it - see rotation below.

**Token rotation (operational).** The worker's `GITHUB_TOKEN` is a fine-grained PAT and **will expire**.
Before it does: issue a new token with the same scope → update the `GITHUB_TOKEN` secret
(`npx wrangler secret`) → re-approve it if approval is required. GitHub emails a warning before expiry; set a
calendar reminder too. If it lapses, grants/revokes stop until you rotate.

**Optional - Discussions as a feedback channel.** Enabling "Allow users with read access to create
discussions" gives buyers a built-in Q&A/feedback space. Note: discussions in a **private** repo are
visible to **everyone with access to that repo** (your other buyers) - a shared space, not private 1:1
support.

## Step 4 - Stripe

1. **Create your product + price** in the Stripe dashboard. Note the **product id** (`prod_…`).
2. **Create a webhook** (Developers → Webhooks (Event destinations) → Add destination) pointing at your
   worker:
   `https://<your-worker-url>/wh/stripe/<SECRET_PATH>`
   - `<SECRET_PATH>` = a random string you choose
     (`node -e "console.log(require('crypto').randomBytes(16).toString('hex'))"`) - a hard-to-guess URL
     segment for obscurity. It lives **only in this webhook URL** (and your own notes) - it is **not** a
     worker secret. Stripe signs every delivery, and signature verification is the real gate, so the
     worker doesn't validate the path.
   - **Subscribe to exactly these three events:** `checkout.session.completed` (the purchase),
     `charge.refunded`, and `charge.dispute.created` (the chargeback).
3. **Copy the webhook signing secret** (`whsec_…`) - it becomes the `STRIPE_WEBHOOK_SECRET` secret in
   Step 6.
4. **Set `metadata.product_id`** on your Checkout Session / Payment Link (and, for `username` mode,
   `metadata.github_username`). Stripe's checkout webhook omits line items, so the worker reads the
   product from metadata; if it is missing, the buyer falls through to your `defaults` mapping.
   _No-code Payment Link:_ the link _builder_ has no metadata field, but the **created link's detail page
   has an editable Metadata section** - add `product_id` there (Stripe copies a Payment Link's metadata
   onto every Checkout Session it creates). One-time per link.

You can also test locally with the Stripe CLI. For the same steps click by click, against the current
dashboard, see [user-guide-stripe.md](user-guide-stripe.md).

## Step 5 - Configure (`repoaccess.config.ts`)

All non-secret config is a **typed object** you author - full editor autocomplete, real comments, no
escaped-JSON env vars. Write it from scratch, as below; it is short, and every field is explained
underneath.

**Do not copy the template out of `node_modules`.** The package does ship
`src/config/repoaccess.config.example.ts`, but it is written for the clone-and-deploy path: it exports
`sandbox` and `production` rather than the `config` this page imports, and it pulls its type in over a
relative path that only resolves inside the package. Read it if you want the annotated version of every
field; do not lift it into your project.

(If you clone-and-deploy core's own repo instead of npm-installing it, that template IS the file you
edit, and the setup wizard writes it into place for you - see `docs/user-guide-stripe.md`. Either way the
file you edit is gitignored, so a later update never overwrites it.)

```ts
// src/repoaccess.config.ts
import type { RepoAccessConfig } from 'repoaccess-core'

export const config: RepoAccessConfig = {
  githubOrg: 'your-org',
  productTeamMap: {
    // adapter → product_id → mapping
    stripe: { prod_ABC: { teams: ['pro'], grant_mode: 'username' } },
    // reserved fallback for any unmapped product (keep it neutral - see the warning)
    defaults: {
      teams: [],
      grant_mode: 'claim',
      revoke_policy: { mode: 'log_only' },
    },
  },
  branding: { name: 'Acme', logoUrl: '', faviconUrl: '' }, // optional - claim-page look
  // eventWebhook: { url: "https://you.example/events", allowlist: ["you.example"] }, // optional
}
```

**Where these values come from.** Three of them are read off a provider's or GitHub's own screens, and
two have a form that looks wrong the first time.

- **`githubOrg` is the org SLUG** - the part in the URL, `github.com/YOUR-ORG`. Not the organization's
  display name.
- **`teams` are team SLUGS** - the lowercased, hyphenated tail of the team URL,
  `github.com/orgs/YOUR-ORG/teams/TEAM-SLUG`. **Not the display name.** A team shown as "Pro Buyers" has
  the slug `pro-buyers`, and putting `Pro Buyers` in the map grants nothing at all: the worker looks up
  a team that does not exist, the buyer pays, and nothing happens.
- **`product_id` is the provider's product identifier**, not its price identifier. With Stripe that is
  the `prod_…` id from the product's own page, never `price_…`, and it reaches the worker because you
  set it as `metadata.product_id` in Step 4.

The options, in full:

- **`githubOrg`** (required) - the org slug above. Everything grants and revokes inside this one org.
- **`productTeamMap`** (required) - keyed **adapter → product_id → mapping**. The adapter key is the
  adapter's `name` (`stripe`) and matches its webhook route `/wh/stripe/…`; there is no separate
  "which provider" switch.
  - **`teams`** - the team slugs this product grants. More than one is allowed; the buyer joins all of
    them, and a refund removes them from all of them.
  - **`grant_mode`** (optional) - declares how the buyer's GitHub handle is meant to reach the worker:
    `username` if your checkout collects it, `claim` if it does not. **The route is decided by the event
    itself**, not by this value: a valid handle on the paid event grants directly, and an absent or
    malformed one falls back to the claim page. Set it to match your setup so the config describes it
    truthfully.
  - **`revoke_policy.mode`** - `auto_revoke` removes access on refund or chargeback; `log_only` records
    and does nothing.
  - **`revoke_policy.full_refund_only`** (optional) - when true, only a FULL refund revokes. It gates
    refund events ONLY: under `auto_revoke` a chargeback always revokes, whatever this is set to. To be
    exact, it skips any refund the adapter did not mark as full - Stripe always marks it, but an adapter
    that left that unset would be skipped too.
  - **`defaults`** (required key) - the fallback for any product not in the map. See the warning below;
    keep it empty unless you mean it.
- **`branding`** (optional) - the look of the claim and delivery pages.
  - **`name`**, **`logoUrl`**, **`faviconUrl`** - a URL may be `http`, `https` or relative. A dangerous
    scheme (`javascript:`, `data:`) is dropped rather than rendered, and the page falls back to your
    name as text.
  - **`theme`** - design tokens that override core's neutral defaults: a `light` and a `dark` palette,
    plus `radius` (the card's corner radius) and `font` (the font stack). Each palette takes `brand`,
    `brandContrast`, `bg`, `surface`, `text`, `textMuted` and `border`. Anything you leave out keeps
    core's value, so you can set one token and nothing else.
  - **`customCss`** - raw CSS appended after the base theme. Your rules genuinely win: every selector
    in the worker's own stylesheet is held at or below one class of specificity - a shipped test holds
    that line - so a single-class rule of yours, arriving later, overrides it. The one exception is
    `button[disabled]`: a disabled control refuses to look pressable, and out-styling that takes more
    than one class, on purpose. A `</style>` inside it is ESCAPED, not deleted, so a stray closing tag
    cannot break out of the block and your CSS is never silently truncated.
- **`eventWebhook`** (optional) - outbound delivery of `access.granted` / `access.revoked` / `claim.*`.
  - **`url`** - unset or empty means delivery is a no-op and the events are logged only.
  - **`allowlist`** - the SSRF host allowlist, matched exactly or by suffix. **Unset or empty means ANY
    public host is accepted**, so set it whenever you set a `url`.
  - **`origin`** - an event carries it when the worker knows how the grant was authorized: `webhook`
    when a provider webhook the worker verified started it, `rpc` when a worker you compose around this
    engine enqueued it directly instead. It is absent only where the worker never recorded the answer.
    It is there so a month's grants can be reconciled against your provider's dashboard by channel
    rather than by hand.
- **`e2e`** (optional) - settings for the synthetic end-to-end check, read by setup tooling only and
  never on the request or Workflow path. **`testUsername` must be an account YOU own**: the check sends
  it a real org invitation and then cancels it. `productId` pins which product mapping to grant into
  (omitted, it takes the first Stripe product that maps to a team); `url` is the deployed worker to hit;
  `secretPath` is the `/wh/stripe/:path` segment.

**Auto-revoke horizon:** the worker keeps each grant record for **180 days**, so `auto_revoke` covers
refunds and card chargebacks within that window (a typical refund window plus the ~120-day chargeback
window). A dispute after 180 days won't auto-revoke - handle it manually.

> **Chargebacks & disputes.** A chargeback (the buyer's bank reverses the charge, bypassing you) is
> handled separately from a refund. Under `auto_revoke` the worker revokes access **when the dispute
> is raised** (`charge.dispute.created`), while pre-dispute _early-warning_ signals are deliberately
> ignored. The worker
> **never auto-restores** access if you later win the dispute - re-grant manually (Team → Members → **Add a
> member**, or re-issue the claim link); it reconciles around manual changes.

### What a revoke actually removes (and what it leaves alone)

A refund revokes **the product that was refunded** - not the buyer. This matters the moment you sell more
than one thing, so it is worth being precise:

1. **The teams on that grant only.** The worker removes the buyer from the teams mapped to the refunded
   product. Teams that came from a _different_ purchase are not touched.
2. **Any pending invitation** for that buyer is cancelled (an unaccepted invite is still a grant in flight).
3. **Org membership is then reconciled against live GitHub state.** The worker asks GitHub which of your
   configured teams the buyer is still in. If they are still in **any** of them, they **keep their org
   membership** and everything that other purchase entitles them to. Only when they are in **no** product
   team at all does the worker remove them from the organization - because an org member with no team gets
   nothing anyway (Base permissions are `No permission`), so leaving them there would be untidy, not
   generous.

So the case sellers worry about is already handled: a buyer who owns product A, then buys product B and
refunds B, loses B and **keeps A**. The check is made against GitHub itself, not against the worker's
records, so it stays correct even after a grant record has aged out of the 180-day window.

> **One caveat worth knowing.** That reconciliation only looks at teams **declared in your
> `productTeamMap`**. If you manually put a buyer in some other team (a `beta-testers` team, say), the worker
> cannot see it, may conclude they hold nothing, and remove them from the org - which drops every team
> membership, that manual one included. If a team should protect a buyer's org membership, declare it in the
> config (an entry with an empty product mapping is enough).

> **Keep `defaults` empty / `log_only` unless you mean it.** Any product that isn't in the map - and
> any stray webhook from an adapter you composed - falls through to `defaults`. Empty `defaults.teams`
> is a safe no-op; a real team there becomes a **catch-all** that grants on anything. Only set a
> non-empty `defaults` if you genuinely want a catch-all tier.

### Sandbox vs production (optional)

`env` isn't available at module load in Workers, so pick the profile **at build time**, not from a
runtime var. Two clean options:

- **Single env (simplest):** export one `config` and point both `createWorker` / `createAccessWorkflow`
  at it (as in Step 1). Most deployers need only this.
- **Sandbox/prod split:** export two profiles from `repoaccess.config.ts` (e.g. `sandbox` and
  `production` sharing a base), add a second tiny entry `src/index.production.ts` that imports
  `production`, and set `[env.production].main = "src/index.production.ts"` in `wrangler.jsonc`.
  `npx wrangler deploy --env=""` then uses the sandbox profile; `npx wrangler deploy --env production` uses the prod one.

### Collecting the buyer's GitHub username

The buyer always supplies their own username - you never type it per-buyer. Two ways, matching the
two `grant_mode`s:

- **At checkout (`username` mode).** Add a **custom field** to your Stripe checkout, so the buyer fills
  it in while paying. On the Payment Link create form: **Advanced options → Add custom fields**, add one
  field - Type **Text**, Label **GitHub username**. On a link that already exists: open the link, use
  the **...** menu, choose **Edit**, then **Advanced options → Add custom fields**. (Or set
  `custom_fields` when creating the Checkout Session.) The label is not an example - Stripe derives the
  field's key from it, and the worker resolves the field by matching a key that contains `github`, so
  give it exactly that label. The worker reads it from the `checkout.session.completed` event. Leave the
  field **optional** - an empty or mistyped handle is not a dead end, it falls back to the claim page.
  - _Your own checkout page:_ if you collect the username yourself before checkout, pass it through as
    `metadata.github_username` and the worker reads it from the same event.
- **After checkout (`claim` mode).** Collect nothing at checkout. The buyer receives a one-time claim
  link after paying and enters their username on the claim page. Use this if you can't (or don't want
  to) add a checkout field. `username` mode automatically falls back to `claim` when no username is
  present.

> **Where a purchase has a pending claim, treat its transaction id as a delivery credential - even
> though your provider doesn't.** The post-checkout redirect hands the worker a transaction (or checkout
> session) id and the worker answers with that purchase's state. **If that purchase is waiting on a
> claim, the answer is its claim page**, so anyone holding the id can enter a GitHub username there until
> it is claimed or expires. That covers every `claim`-mode purchase, and any `username`-mode purchase
> where no handle arrived and the worker fell back to a claim. A `username`-mode purchase that granted
> directly has no claim to reach - the id answers with a neutral "access is set up" page and nothing
> else. Your provider treats that id as an ordinary reference and puts it in dashboards, receipts and
> logs, so wherever a claim may be pending, keep it out of shared channels: don't paste one into a group
> chat, a public ticket or a screenshot.

**What if the buyer mistypes it?** The worker never grants access directly - GitHub sends an
**invitation that only the real owner of that account can accept**. A wrong or non-existent handle
just means the invite is never accepted (the buyer contacts you to fix it); it can't silently let the
wrong person in. There's deliberately **no "Login with GitHub"** step - the invite-acceptance is the
ownership check, and the worker never phones home.

## Step 6 - Secrets

**Only secrets** go in the runtime env - everything non-secret is in `repoaccess.config.ts` (Step 5).
Local dev → `.dev.vars`; production → `npx wrangler secret put <NAME>` (add `--env production` for a
separate prod environment):

```
GITHUB_TOKEN           # the fine-grained PAT (Step 3)
STRIPE_WEBHOOK_SECRET  # Stripe's signing secret, whsec_... (Step 4)
EVENT_WEBHOOK_SECRET   # optional - signs outbound events (32-byte hex; same node one-liner with 32)
```

Not secrets, so **not** here (they're in `repoaccess.config.ts`): `githubOrg`, the product map,
branding, and `eventWebhook` (url + allowlist). Your webhook path segment isn't a secret either - it
lives in the webhook URL (Step 4), not the env, and the worker doesn't validate it. Never commit
`.dev.vars` (git-ignored by default).

## Step 7 - Deploy

```bash
npx wrangler deploy --env="" --secrets-file .dev.vars
```

(`--env=""` targets the top-level (sandbox) environment explicitly - without it wrangler warns that
several environments exist and picks one for you, so you cannot tell which worker you shipped to.
`secrets.required` in `wrangler.jsonc` gates the deploy, so upload the secrets inline the first time.
For a separate prod env: `npx wrangler deploy --env production --secrets-file .dev.vars.production`.)

Take the resulting `https://<worker>.workers.dev` URL and make sure your Stripe webhook points at
`…/wh/stripe/<SECRET_PATH>`. (Optional: put it on a custom domain via `wrangler` routes.)

## Step 8 - Test it

Do a **test-mode purchase** in Stripe (card `4242 4242 4242 4242`, any future expiry / CVC). Use a
**second GitHub account** as the buyer, not your org-owner account: the buyer loop is invite, accept, then
refund, and an account already in the org never receives an invite at all. You should see:

- the buyer added to the right team (username mode), **or** a `claim.pending` event with a claim
  link (claim mode) → buyer opens it, enters their GitHub username, gets added;
- a refund/chargeback (if `auto_revoke`) removes them and cancels any pending invite.

`npx wrangler tail` shows structured logs of exactly what the worker did and why.

## Troubleshooting

- **Signature verification fails:** the worker must see the raw request body byte-for-byte. If you
  proxy/transform requests, don't re-serialize the body before it reaches the worker.
- **Buyer not added:** check `config.productTeamMap` has the exact Stripe `product_id` (`prod_…`, not a
  price id); check `metadata.product_id` is set on the link; check the PAT has `Members: Read & write` on
  the org; check the team is attached to the repo.
- **`429` from GitHub:** invitation rate limit - the worker backs off and retries automatically;
  if you're launching, age the org first.
- **Webhook never arrives:** verify the URL + secret path; re-send the event from the Stripe dashboard
  (the endpoint is idempotent - replays are safe).

## A buyer says they didn't get access

Most "I paid but I'm not in" tickets are an **unaccepted invite** or a **mistyped username** - both
are quick to resolve. Work down this list.

**First, tell the buyer to check for the invite.** Adding someone to a team sends a GitHub
**invitation** they must accept - access isn't active until they do.

1. Check email (incl. spam) for a GitHub invite to your org, **and** the dashboard:
   `https://github.com/orgs/<your-org>` shows a pending-invitation banner; the org invite link is
   `https://github.com/orgs/<your-org>/invitation`.
2. Accept it → they land in the team that carries the repo. Done in the common case.

**If there's no invite, diagnose on your side:**

1. **Read the event / logs.** Your outbound events tell you exactly what happened:
   `access.granted` (it worked - it's an unaccepted invite, see above), `access.failed` with a
   `reason` (e.g. user not found, rate-limited), or `claim.pending` (claim mode - they never opened
   the link). No event store? Run `npx wrangler tail` and re-send the event from Stripe.
2. **`access.failed → user not found`** = mistyped/non-existent username. Cancel any stale pending
   invite (Org → People → **Pending invitations**), then re-collect: re-send the claim link, or just
   invite them by hand (Team → Members → **Add a member**).
3. **`access.failed → github_token_degraded`** = the worker's GitHub token can no longer manage
   members (expired, revoked, or the org restricted fine-grained tokens). **On a refund this is the
   one reason that needs your hands right away: the buyer's access was NOT revoked.** Rotate the
   token first - mint a fresh fine-grained PAT, paste it into your secrets file, redeploy - then
   finish that revoke manually: Org → People → remove the buyer from the product team (and from the
   org if they hold no other product team). The event carries the username and teams, and the grant
   record is kept in KV as your diagnostic.
4. **`access.failed → rate-limited` (`429`)** = new-org invite cap (50/24h in the first month). The
   worker backs off and retries automatically - it'll land within the window. For a launch, age the
   org first.
5. **`claim.pending`, never completed** = the buyer didn't finish the claim page. Claim links are
   **single-use and expire after 30 days** - re-issue a fresh link if theirs lapsed.
6. **No event at all** = the webhook didn't arrive or didn't verify. Check Stripe sent it (re-send it
   from the dashboard), the URL + secret path are right, and signature verification passed (a
   transformed/re-serialized body breaks the HMAC - see above).

**Fastest manual override (any case):** as an org owner, add them directly - Team → Members → **Add a
member** → their GitHub username. The worker reconciles around manual changes, so this won't conflict
with it.

> **Why there's no "Login with GitHub":** the worker never logs the buyer in or phones home. The
> GitHub invitation _is_ the identity check - only the real owner of an account can accept it.
>
> **That makes a mistyped handle harmless in one case and not the other, so treat them apart.** If the
> handle belongs to **nobody**, nothing happens: the invitation sits unaccepted, and you fix it by
> re-issuing to the correct handle. If it belongs to **somebody else**, that person can accept it, and
> the identity check has done its job on the wrong person. Act on which stage it is in. **Still
> pending:** cancel it (Org → People → **Pending invitations**) and invite the correct handle.
> **Already accepted:** remove that account from the product team, then from the organization if that
> team was the only thing they held - the same reconciliation the worker does, and the same caveat
> applies, so leave the org membership alone if they legitimately bought something else. Then invite
> the buyer.
>
> **What bounds this:** the worker only ever grants against a signature-verified paid event. So the
> worst a wrong handle can cost you is a purchase delivered to the wrong account - never access
> without payment.

## A buyer refunded one thing and asks if they lost everything

This ticket writes itself, so here is the answer before it arrives. GitHub's own emails are the cause, and
there are two of them. Every revoke sends a **team**-removal notice, which is accurate and unalarming. A
buyer left in no team at all - which is what refunding your **only** product does - gets a SECOND one saying
they were removed from the **organization**, and that is the one that reads as if their account was banned.
It was not, and nothing else was touched.

What actually happened: the refund removed that product's team, and nothing else. Organization membership
went with it only because that team was the last one the buyer was in - an organization member with no team
has no access to anything, so there was nothing left to be a member for. A buyer who still holds another
purchase stays in that purchase's team, keeps that product, and never sees the organization email.

If a buyer with a _second, still-paid_ product does somehow lose access, that is a real bug and not this
behavior - check that the team backing the second product is declared in your `productTeamMap` (see the
caveat under "What a revoke actually removes"). A team the config does not know about is invisible to the
reconciliation.

---

## Other providers

The engine itself is provider-agnostic - it normalizes any webhook-capable provider behind the adapter
contract, and the exported types (`PaymentAdapter`, `VerificationStrategy`) are what an adapter
implements. Core ships Stripe as the reference adapter. Ready-made adapters for Paddle
(Merchant-of-Record), Lemon Squeezy (Merchant-of-Record), Gumroad, Razorpay and Telegram Stars ship in
**RepoAccess Pro**, along with their provider-specific wiring. See the
[RepoAccess page](https://edgekits.dev/en/tools/repoaccess/).
