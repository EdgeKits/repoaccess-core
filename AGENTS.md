# AGENTS.md

You are in a clone of `repoaccess-core`. Almost certainly you are here to help someone SET IT UP, and
that job has exactly one entry point.

## Setting it up

The wizard is a program, not a document. Run it:

```
npm install
npm run wizard:drive start
```

It prints one JSON record at a time. Render the record, get the deployer's answer, hand the answer back,
and repeat until it prints `{ "done": true }`. The full contract is `docs/setup-wizard.md` - read that
file and follow it exactly. (In Claude Code and OpenCode the same thing is a slash command,
`/repoaccess-setup`.)

**Do not read the source to work out what to do.** The wizard owns the sequence, the branching, and
every word the deployer sees, and all of it is covered by tests. Reconstructing the setup from `src/`
produces a worse installation than running the wizard, and it is not what you are here for.

**Do not read `.dev.vars` or `.dev.vars.production`.** They hold secret VALUES. The deployer pastes
their own secrets there and the wizard uploads them from a child process; you never need to see them,
and this repo's permission configs deny you the read.

**Do not invent commands.** If something looks missing, say so instead of substituting a command you
believe ought to exist.

## Not that job?

- Deploying by hand instead of with the wizard: `docs/setup-guide.md`
- Selling with Stripe: `docs/user-guide-stripe.md`
- Working on the code itself: `CONTRIBUTING.md`
