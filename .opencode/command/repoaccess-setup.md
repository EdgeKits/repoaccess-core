---
description: Guided wizard to stand up and live-test your own RepoAccess core worker (GitHub + Stripe + Cloudflare)
---

# repoaccess-setup: stand up your RepoAccess core worker

Run the shared setup wizard in **`docs/setup-wizard.md`**: read it in full, then drive the
deployer through it exactly as written. That file is the single source of truth for this wizard - the
OpenCode and Claude Code commands and any other agent all run the same wizard, so they stay in
lockstep. Do not paraphrase or re-derive its steps here (that causes drift).

For every record with `kind: "choice"`, present the options in your native choice UI if you have one -
labels and descriptions verbatim - and feed back the chosen option's `value`. If you have none, print the
options as a numbered list, accept the number, and run that option's own `command` yourself. Either way the
deployer never types a token like `production`. Use a choice UI ONLY for `kind: "choice"` records: a
`kind: "text"` record is rendered verbatim as plain text, and you wait for the deployer to type the value.
