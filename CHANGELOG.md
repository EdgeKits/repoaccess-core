# Changelog

This file records every change to RepoAccess Core from **3.1.0** onward - the version at which the file was started. Everything earlier (beginning from 0.0.1) predates it and is deliberately **not** reconstructed here.

When you `git pull` an update, read this file first: it is how you decide whether a release fixes a bug you hit, touches config you set, or is worth taking at all.

The format follows [Keep a Changelog](https://keepachangelog.com/); versions follow
[Semantic Versioning](https://semver.org/) (`MAJOR.MINOR.PATCH`).

## [Unreleased]

Nothing yet.

## [3.2.1] - 2026-09-17

### Fixed

- A refund that completes while a grant is waiting - asleep in GitHub backoff, or paused from the
  Workflows dashboard - is now seen before the write, not after it. In 3.2.0 the grant checked the
  transaction on entry and again at commit; the GitHub write in between did not, so a grant that
  resumed after such a refund still added the buyer and then removed them again. Every write attempt
  now re-reads the transaction first and makes no GitHub call if it has been refunded; the grant ends
  with `access.failed`, reason `transaction_revoked`, and withdraws anything it had already written.
  What remains is the write's own in-flight latency, which the commit check covers as before. No step
  was added, so this version can be deployed with instances in flight.
- The setup guide's cost table said a `claim` sale costs 14 Workflow steps and 6 KV writes. It costs
  13 and 5: the redirect alias was counted on both instances of a claim sale and is written once. The
  free-plan figure for `claim` mode moves from about 165 to about 200 sales a day.

### Added

- The cost table is now asserted by a test against a measured run of the workflow, so a change to
  either the engine or the guide that moves them apart fails the suite.

### Changed

- The setup wizard's Quick goal says the synthetic refund half of its check applies under an automatic
  revoke policy; under Log only the refund is skipped and the run says so.
- `access.failed` with reason `transaction_revoked` and the `access.revoked` for the same transaction
  can carry the same `sequence`: they describe one transition, the refund's.

## [3.2.0] - 2026-09-16

### Fixed

- A refund or chargeback that arrives while a grant is still in flight now wins, in both grant modes.
  Before, a grant that was sleeping in GitHub backoff, or had been paused by hand, could resume after the
  refund had already run and add the buyer: the refund had found nothing to withdraw, and nothing revoked
  the membership afterwards. Reported by @jz_kronowave on Indie Hackers, who ran the engine in a sandbox
  and found it.
- A refund whose read of the grant record is stale (KV is eventually consistent for up to about a minute)
  no longer concludes there was nothing to withdraw. The claim guard, a strongly consistent Durable Object
  keyed by transaction, is now the ledger of each transaction's outcome: a grant commits to it, and a
  refund consults it before KV.
- Stripe: a buyer who pays with a delayed payment method (a bank debit, a voucher) is now granted when the
  payment settles. `checkout.session.async_payment_succeeded` is handled, and a `checkout.session.completed`
  whose payment has not settled is acknowledged with 200 instead of 400, so Stripe stops retrying it.
  **Action for an existing deployment:** add `checkout.session.async_payment_succeeded` to your Stripe
  webhook endpoint in the dashboard, or buyers who pay with a delayed method are never granted. The guides
  now list four events.
- A refund no longer removes a team that another purchase by the same buyer still entitles. Two products
  mapped to one team (two price points for one repository, an item and a bundle that contains it): before,
  refunding either removed the shared team and then the buyer's organization membership while the other
  purchase stood. The worker now keeps a record of what each buyer holds, keeps a shared team while another
  purchase entitles it, and removes it when the last one is refunded. A pending invitation is re-issued for
  the teams other purchases still entitle, at the cost of one invitation from the daily quota and a second
  email to the buyer. A grant that kept a team on the strength of a purchase still being processed removes
  it again if that purchase fails. Purchases granted before 3.2.0 are not in that record and revoke as
  before. Reported in the same sandbox run as the first item.

### Added

- `sequence` on `access.granted`, `access.revoked`, and `access.failed` with reason `transaction_revoked`:
  a per-transaction number minted by the guard. For one transaction, the event with the higher `sequence`
  is the current state, whatever order deliveries arrive in; `timestamp` is when the event was sent, not
  an ordering key. An instance that was already running when you upgraded may send its event without it;
  treat an absent `sequence` as older than any present one.
- `trigger` on `access.failed` with reason `transaction_revoked`, naming the refund or chargeback that
  decided it.
- `kept_teams` on `access.revoked`: the teams the revoke left in place because another purchase by the same
  buyer still entitles them; absent when it kept none.
- The licensing page is linked from README and LICENSING.md, and the package carries npm keywords.
- The setup guide gains "Configurations, and what the buyer sees in each": one product and one team, two
  products on two teams, two products on one team, one product on two teams, a bundle and one of its items,
  and a buyer who was already a member, with the emails GitHub sends in each case, plus two facts about the
  invitation: it goes to the buyer's GitHub primary email, and it expires after seven days.

### Changed

- The claim guard keeps a copy of each committed grant for the same 180 days as the KV record, then
  deletes it; an object that never commits a grant removes itself after 180 days.
- The cost table in the setup guide is re-derived: a `username` sale is 8 Workflow steps (was 6), a
  `claim` sale 14 steps and 6 writes, a revoke 11 to 12 steps and 1 delete. The free-plan figures move
  with them.
- Dev dependencies: hono 4.13.5 (the peer range stays `^4`; none of the patched code paths is reached
  by core), vitest 4.1.11, the sharp override 0.35.4. `npm audit` is clean at Moderate and above.
- `createWorker` refuses an adapter named `buyer`: that name is reserved for the worker's per-buyer record.
- The delivery page tells the buyer to check their GitHub notifications as well as their email for the
  invitation, as the claim page already did; the invitation goes to the GitHub account's primary address,
  which is not always the checkout address.
- The setup wizard's synthetic check now proves the revoke path too: after the synthetic purchase it sends
  a matching synthetic refund through the worker, which takes the invitation back the way a real refund
  would. Its cleanup used to cancel the invitation and delete the grant record directly, behind the
  worker's back; with the per-buyer record above, that would have left a phantom entitlement on the test
  buyer. The direct cleanup remains as a fallback after the refund. A product whose revoke policy is
  `log_only` skips the synthetic refund with a warning, since no removal is configured to come.

### Upgrade note

- Deploy this version when no grant is in flight: the Workflow's step shape changed, and an instance that
  started under the old code and resumes under the new one meets steps it did not record. A grant can
  sleep for hours in GitHub backoff, so check the Workflows dashboard for running instances before you
  deploy, not only the moment of the last purchase.

## [3.1.0] - 2026-08-24

The first release recorded in this file.
