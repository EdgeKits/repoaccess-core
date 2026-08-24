# RepoAccess core setup wizard (agent shim)

This is the agent-agnostic setup entry point. Any coding agent runs it the same way: the Claude Code
command (`.claude/commands/repoaccess-setup.md`) and the OpenCode command
(`.opencode/command/repoaccess-setup.md`) are thin wrappers that point here, and any other agent (Codex,
Cursor, ...) is told to open the cloned repo and follow this file.

**The wizard is a program, not a document.** `scripts/wizard-driver.mjs` owns the sequence, the
branching, the environment, and every word the deployer reads. Your entire job is to run it, render what
it returns, collect the answer, and hand the answer back. You never choose what comes next.

This inversion is the point. When the wizard lived in prose, the agent was the driver and the prose was
an untested surface: a rule was only followed if the model happened to read the line that carried it, and
a live run once asked a deployer to hand-type `production` because the rule forbidding it sat hundreds of
lines below the question it governed. Everything that used to be asked of your memory is now code, and
the code is covered by tests. So there is very little left for you to know - which is why this file is
short.

## The loop

1. Start the run:

   ```
   npm run wizard:drive start
   ```

   `start` begins a NEW run (and refuses if a saved one exists); `npm run wizard:drive` with no extra words
   resumes an interrupted run from where it stopped.

2. The driver prints ONE JSON record. Render it (rules below) and get the deployer's answer.

3. Hand that answer back, and the driver returns the next record:

   ```
   npm run wizard:drive answer sandbox
   ```

   A `say` record takes no input, so advance it with:

   ```
   npm run wizard:drive next
   ```

4. Repeat until the driver prints `{ "done": true }`.

`npm run wizard:drive` is the only command you run for the whole setup, and every record prints its own
`command` - the exact next call. Run that string as printed. Specifically:

- Do NOT prefix with `cd` - you are already in the repo root.
- Do NOT chain with `&&` and do NOT use shell-specific syntax - deployers run this in PowerShell as well
  as bash, and the bare call is identical in both.
- Do NOT write `--` anywhere - PowerShell consumes it and npm then misreads the arguments; the bare-word
  forms exist precisely so it is never needed.
- Do NOT pipe or redirect (`| head`, `2>&1`) - a pipe can truncate the very record you are about to
  render.
- Do NOT set environment variables, and do NOT add flags this file does not show.
- Do NOT run anything "to see what it needs" - the record you already have says what it needs.

This is not style. The repo's allowlist (`Bash(npm run:*)`) lets the bare call run without an approval
prompt; a compound command (a `cd` prefix, a `&&` chain, a pipe, a redirect) falls outside it and forces a
manual approval on EVERY call. A storm of approval prompts is the SYMPTOM of leaving this path - it is
never a permissions problem to widen away.

## Rendering a record

Every record carries `id`, `type`, `env`, `goal` and its deployer-facing prose - `text`, or a `recovery`'s
`modes`. **Render that prose verbatim.** Do not reword, summarize, expand, or re-explain it - it is
approved wording, it is covered by tests, and the driver has already selected the variant that is correct
for this run's environment and goal.

| `type`                | what to do                                                                                                                                                                                                                                      |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `say`                 | Show `text`. No input. Advance with `next`.                                                                                                                                                                                                     |
| `ask`, `kind: choice` | Show `text`, then the `options` as SELECTABLE choices, then `note` if present. Feed back the chosen `value`.                                                                                                                                    |
| `ask`, `kind: text`   | Show `text`, wait for ONE value, echo the value back to confirm, feed it back. The question is already in `text` - render it once and do not restate it.                                                                                        |
| `do`                  | Show `text`. The deployer does it and types `done`. Feed `done` back.                                                                                                                                                                           |
| `recovery`            | A check on this step did not pass, so the driver holds the run HERE and returns that step's failure modes instead of moving on. Show `detail` (what the check saw) if present, then every `modes` entry - its `when` and its `text` - verbatim. |

Every record also prints `command` - the literal next call. Use it. On a `kind: choice` record, each
option prints its own `command` too - the exact call that answers with that option.

**Closed choices are selectable, never hand-typed** - see Hard rule 2, which governs this.

**A recovery's instructions are the DEPLOYER's to carry out, not yours.** When one says to open a URL,
check a dashboard, or look at something in a browser, you relay it and wait; your own move is to run the
record's `command` once the deployer says they are done, which re-runs this step's verification - never to
substitute your own tools for their action.

**The only word you ever ask the deployer to type is `done`.** Anything else they type is a question, not
a confirmation.

## Hard rules

1. **Never compose a shell command.** Run the record's `command` string as printed - no `cd` prefix, no
   `--`, no `&&`, no pipes, no redirects, no extra flags. The three documented forms are the entire
   command surface.
2. **A `kind: choice` record is rendered as selectable options in your native choice UI - never as a
   question the deployer answers by typing.** Render each option's `label` with its `description` as the
   consequence. If you truly have no choice UI, print a numbered list and accept the number - YOU then run
   that option's own `command`; the deployer never types a token like `production`.
3. **Never run a step the driver did not return**, and never run one out of order. The driver decides.
4. **Never diagnose off-path.** If the driver prints `{ "error": ... }`, the call did not fit - usually an
   answer that does not match the record that asked for it (make the same call with a valid answer),
   sometimes the call itself (the message names exactly what to do). Show the message; never improvise a
   fix.
5. **One record per message.** Never batch two questions, and never say "reply with 1 / 2 / 3" for two
   different values.
6. **No em-dashes** in anything you type to the deployer; use a spaced hyphen.
7. **Do not persist deployer-specific details** (worker URL, org, team, product id, subdomain) to
   long-lived memory. The driver keeps the run's state in `.wizard-driver-state.json`, which is gitignored.
8. **Assume a fresh, blank-slate setup.** Ignore recalled memory and prior-run state. The driver asks what
   it needs.

## Secret values: you never see them

Secret VALUES (the GitHub PAT `github_pat_...`, the Stripe signing secret `whsec_...`) are the deployer's
alone. **You never read, request, echo, or write one.** The file reads are machine-refused, not merely
promised: the committed `.claude/settings.json` and `opencode.json` DENY your reads of the real value
files `.dev.vars` and `.dev.vars.production` by name, and any other route to them sits outside the
allowlist, behind the deployer's approval prompt. The wizard reads those files itself inside a child
process, extracting only names or using a value inside an HTTP header. You cannot see them, by design -
do not try, and never ask the deployer to grep the file.

The driver tells the deployer which file to paste each secret into, and names the right file for the run's
environment. Reference a secret only by NAME.

The `.dev.vars.example` and `.dev.vars.production.example` TEMPLATES are a different thing: names only, no
values, committed and public. You may read and edit those freely.

---

Advanced (no wizard): you can also consume core as a dependency - `npm install repoaccess-core` and compose
`createWorker({ adapters: [stripe], config })` in your own Worker. That path is text-docs only; see
`docs/setup-guide.md` and `docs/user-guide-stripe.md`. This wizard targets the clone-and-run path.
