# Contributing to RepoAccess

Short version: **bug reports and questions are very welcome. Code contributions are not accepted.**

That is unusual, so here is the honest reason.

## Why this project does not accept code contributions

RepoAccess is open core. The engine you are reading is free and AGPL-licensed, and it is funded by a
commercial edition (RepoAccess Pro) that is sold under a separate, proprietary license.

Offering the same code under two licenses is only legally possible while **one person holds the copyright to
all of it**. The moment an outside patch is merged, its author owns that piece, and the project can no longer
be licensed commercially as a whole. Some projects solve this with a Contributor License Agreement, where you
would sign your rights over before your patch is accepted. We would rather not ask you to sign anything, so we
simply do not take outside code. SQLite has run this way for two decades, for the same reason.

This is not a judgement about your patch. It is a structural constraint, and it is what keeps the free engine
free.

## Running it from a fresh clone

Two files a clone does not carry are needed before anything builds: `src/config/repoaccess.config.ts`
(your org and product map) and `wrangler.jsonc` (your account's KV ids). Both are gitignored on purpose,
so that an update pulled with `git pull` can never overwrite yours. You do not have to create them by
hand: `npm test` and `npm run typecheck` each run a bootstrap step first that copies them from their
committed `.example` templates, but only when they are missing, and it prints whatever it created. It
never touches a file that already exists, so your own values are safe. Run it on its own with
`npm run bootstrap` if you want the files before you run anything else.

## What IS welcome

- **Bug reports.** Open an issue. Tell us what you did, what happened, and what you expected. A minimal
  reproduction is worth a hundred words of description.
- **Questions and discussion.** If the docs did not answer it, that is a documentation bug, and we want to
  hear it.
- **Provider quirks you have hit.** If a payment provider changed a webhook payload or its refund semantics,
  telling us is genuinely valuable, and we will act on it.
- **Forks.** AGPL-3.0 gives you the right to fork and modify. Please read [LICENSING.md](LICENSING.md) first,
  particularly the network clause: if you run a modified version as a service for others, you must offer them
  its source.

## One request about issues

**Please do not paste patches, diffs, or code you want us to use into an issue.** Anything you write is
yours, and copying it into this codebase would create exactly the copyright problem described above. If you
have found a fix, describe the fix in words: what is wrong, and what the code should do instead. That is
enough, and it lets us implement it cleanly.

Pull requests will be closed unread. That is not rudeness, it is the policy above, and we would rather you did
not spend an evening on work we cannot merge.

## If you want to build on RepoAccess commercially

If you need to embed RepoAccess in a closed-source product, or you do not want the AGPL's network clause to
apply to your deployment, that is what **RepoAccess Pro** is for: the same engine under a commercial license,
plus the additional payment adapters. See [LICENSING.md](LICENSING.md) and the [RepoAccess page](https://edgekits.dev/en/tools/repoaccess/).
