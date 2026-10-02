---
name: hawk
description: Run one "hawk" t3code thread per effort (a Linear project with its GitHub PRs and t3code agent threads). A deterministic scan turns state changes into events, a small CLI does the mechanical steps (naming, spawning, reviews, settling, report lines), detached watchers deliver callbacks and wake-ups, and the hawk-duty contract says how to route each callback. Use for "/hawk", "take over hawk duty", "what changed on <effort>", "any red CI or stuck threads", "scan the effort", or when a "Hawk callback" or "⏰ wake-up" message arrives.
---

# Hawk

The hawk is one [t3code](https://github.com/pingdotgg/t3code) thread per effort. It watches the effort's child threads and PRs, routes what they report to the human, and keeps the board clean. Children do the work. The hawk does work itself only when the human asks it to.

Before the first callback, read the house rules if they exist: `~/.t3/desk/rules.md`, then `~/.t3/desk/<slug>/rules.md`. They take precedence over the standing rules below. Put team-specific rules there, for example a PR-description gate, a shared build slot, or who reviews what.

Requires `t3cli` (signed in), `gh`, `git`, Node 20 or later, and a Linear API key in `LINEAR_API_KEY` or `~/.config/linear/api_key`.

## CLI

Use the CLI for every mechanical step. Do not hand-roll `t3cli start`, `git worktree add`, a title, or a sleep loop. Every command takes `--json`. Sweeps change nothing without `--apply`. `spawn` and `review` take `--dry-run`.

```bash
H=~/.agents/skills/hawk/scripts/hawk.mjs   # executable, and one word, so it works in zsh too
$H name   --effort <slug> "Split the preview PR"        # → [✉️ email] 🦊 Split the preview PR (a free emoji; keeps yours if it is free)
$H names  --effort <slug> [--apply]                     # naming pass: missing prefix, missing or duplicate emoji
$H spawn  --effort <slug> --title "…" --brief-file brief.md   # --no-track worktree + start + register + hold title + rearm
$H review --effort <slug> --pr <n> [--focus "…"]        # reviewer thread on a detached worktree at the PR head
$H send   --thread <id> [--effort <slug>] "message"     # adds the options the thread's provider needs
$H scan   --effort <slug>                               # events since the last scan
$H settle --effort <slug> [--apply]                     # settle sweep from the last scan; removes finished /tmp review worktrees
$H board  --effort <slug>                               # report lines: emoji, GitHub and Linear links, blockers or "ready for you"
$H watch  rearm|wake|settle|retitle|list|stop …         # detached watchers
```

Effort setup and takeover go through `scan`:

```bash
$H scan --effort <slug> --init --linear-project <uuid> --repo <owner/name> --t3-project <t3code project id> --tag "✉️ email" --hawk self
$H scan --effort <slug> --baseline                      # first run: snapshot only, no events for old history
$H scan --effort <slug> --register-thread <id> [--reviewer]
$H scan --effort <slug> --set-hawk self                 # "self" = T3CODE_THREAD_ID, else the thread whose worktree holds the cwd
$H watch wake --effort <slug> --in 150 --prompt-file ~/.t3/desk/<slug>/wake.md
```

`t3cli project list` gives the project id. A tick is `$H scan`, then routing, then `$H names --apply`, `$H settle --apply`, and `$H board` for the report.

### Launch profiles

`spawn` and `review` take `--provider`, `--model` and `--option key=value` (repeatable). Those flags override the `spawn` and `review` objects in `effort.json`, which override the defaults:

| profile | default |
| --- | --- |
| `spawn` | `claudeAgent`, `claude-opus-5-5`, `effort=high` |
| `review` | `codex`, `gpt-6.1-sol`, `reasoningEffort=high`, `serviceTier=default` |
| `send` | per provider: `codex` gets `reasoningEffort=high`, `serviceTier=default` |

Codex reads `reasoningEffort`, not t3cli's `--effort`. Its `priority` tier is fast mode. A plain `t3cli send` reapplies the thread settings with codex's defaults. So message codex threads only with `$H send`.

## Hawk duty

A callback names a child and its turn. For each one:

1. If you already handled that turn, reply nothing. Callbacks can arrive twice.
2. Run the scan. Read the child's last assistant message: `t3cli transcript --thread <id> --format json`.
3. Route the turn:
   - **Pause for the human** (a design question, a video of a failed run, a secret or deploy step, a ready PR): relay it with the video embedded. Never answer a design question or approve a secret or deploy step on their behalf.
   - **Review findings:** forward code-level findings to the child as they are. Bring architecture-level findings (endpoints, state machines, data layer, package boundaries) to the human first, and forward only what they approve.
   - **Still working, or idle with background work pending:** re-arm. Do not relay "still waiting".
   - **Done:** settle (see Settling).
4. Re-arm every child that still has work: `$H watch rearm`. Do not use raw `t3cli thread callback`. It fixes the target hawk when armed, so it breaks a takeover. It can also fire on the turn that is running now.
5. Report. If nothing needs the human, say so in one line, then list what moved. Use `$H board` for the PR lines.

Standing rules. They are here, so callback prompts do not repeat them:

- **Links:** link a PR to GitHub and an issue to Linear. Name a thread by its emoji and its PR link, for example "the 🐝 ([#42](https://github.com/acme/app/pull/42))". Never give a t3code link or a bare id.
- **Ready** means a `pr.ready` event on the current head: real CI is green (a draft's green does not count), the PR is mergeable with no conflicts, and no review thread is open. After any merge, check the sibling PRs for `pr.conflicts`.
- **Drafts:** keep PRs as drafts while your own reviews run, if the human wants that. A draft may get no real CI, so mark a PR ready only when the human says so.
- **CI flake:** rerun a failed job once without asking. If it fails again, tell the human.
- **Reviews:** start every review with `$H review --pr <n>`, in its own thread. If it fails with "model at capacity", retry once with `$H send` in the same thread and tell the human.
- **Scope:** one thread per PR, and one PR per issue. If a PR grows past its issue, split it into a new issue, PR and thread. Two simple threads are better than one thread doing several jobs.
- **Altitude:** bring the human architecture and big decisions. Do not bring them one-line commits.
- **Questions:** ask decisions with AskUserQuestion, one decision per question. Ask only at the end of the turn, after all routing. Never ask when the human is leaving, or when the usage window is closing (see Usage window).
- **Shared machine:** when another effort holds a shared resource, message that effort's hawk. Never stop its processes.

## Naming

- Hawk: `[🔺 hawk // <tag>] <emoji> <title>`, for example `[🔺 hawk // ✉️ email] 🐢 Assess email PRs`.
- Children and reviewers: `[<tag>] <emoji> <title>`, for example `[✉️ email] 🐝 Preview before send`.
- Each thread has a random emoji that is unique in the effort. Reports name the thread by its emoji. A live thread keeps its emoji over a settled thread it replaced.
- Get every title from `$H name`, or let `$H spawn` and `$H review` pick it. t3code replaces a title on the first turn. `spawn` and `review` arm `watch retitle`, which re-applies the title until it holds. For anything else, run `$H names --apply`. The scan raises `thread.untagged` until the title is correct.

## Settling

Settle without being asked. Do a settle sweep on every callback and every wake-up:

- `thread.settleable` reasons: `pr-merged`, `pr-closed`, `reviewer-done` (after you relayed its findings), and `waits-on-human` (its PR is ready, so only the human can move it).
- Also settle threads that are parked or replaced.
- Run `$H settle --apply` after each scan. t3code refuses to settle a thread while its turn runs, so `settle` queues `watch settle` for those threads, and it settles them when the turn ends.
- A settled thread still wakes when it gets a message. So settling never loses a thread you need again.
- Never settle the hawk while it is on duty.

## Usage window

Claude threads on one account share its 5-hour usage window. When the window runs out, the hawk and every Claude child stop together. When the human says usage is running low, or that they are leaving:

1. Write `~/.t3/desk/<slug>/handoff.md`. For each thread, give its emoji, id, PR, next step and parked condition. Add the decisions that wait on the human.
2. Leave no open AskUserQuestion. Put decisions in the handoff and in the message text. An open question holds the hawk's turn, and every wake-up and callback waits behind it. In one real case, a question asked in the evening held the turn until the next morning, so neither wake-up ran. In another, a callback that arrived during an open question dismissed it, and the turn hung until the human interrupted it. `watch` holds delivery while the hawk has an open question, but it cannot answer one.
3. Schedule two wake-ups with `$H watch wake`: one after the expected reset and a backup an hour later. Do not use CronCreate. It lives in the session, and in practice the first fire was lost. Do not use ScheduleWakeup. It works only in `/loop` and is limited to 1 hour.
4. Write the wake prompt so that a second run is safe: "Read handoff.md. If an earlier wake-up already did this, do a status check only."
5. Give every time with its timezone.

On wake-up, a thread is dead if:
- its turn ended with `error` or `interrupted`;
- `thread.error` shows a limit;
- it went idle partway through a task with no background work.

Resume each dead thread with `$H send`: "Continue where you left off: <its next step>". Then re-arm each one, do the settle sweep, check every open PR (CI, `pr.conflicts`, open review threads), and report.

## Takeover

When a hawk thread wedges or its context is full, a new thread takes over:

1. Set the hawk: `$H scan --effort <slug> --set-hawk self`. `watch` reads the hawk when it delivers, so the watchers that are already armed now reach the new thread.
2. Stop any helper that still targets the old thread: hand-written loops and `t3cli thread callback` processes (`pgrep -fl "thread callback"`). Re-arm each live child with `$H watch rearm`. Then run `$H names --apply` for the new hawk title.
3. Read `handoff.md` and the old hawk's last 3 assistant messages.
4. Settle the old hawk.

After a context compaction, read this skill, the house rules and `handoff.md` again before you route the next callback.

## State

State lives in `~/.t3/desk/<slug>/`. Each file has one writer:

- `effort.json` (`tag`, `hawk`, `threads`, `reviewers`; optional `spawn`, `review`, `send` profiles): written by `--init`, `--register-thread`, `--set-hawk` and `--set-tag`. You can edit the profiles by hand.
- `snapshot.json`, `events.ndjson`: written only by `scan`.
- `handoff.md`, `wake.md`: written only by the hawk thread.
- `rules.md` (here or in `~/.t3/desk/`): written only by the human.
- `watch/*.pid`, `watch/*.log`: written only by `watch`. There is one rearm per child, so re-arming replaces the old watcher.

`t3cli list` resolves its project from the working directory, so `effort.json` stores `t3Project`. A second scan exits 3 while another scan holds `scan.lock`.

## Events

An event fires once, when its condition becomes true. Its key includes the head SHA or the turn id, so a new push or a new turn can fire it again. The hawk thread raises only `thread.untagged`.

A PR belongs to an issue only when its body, title or branch names the issue key; an attachment alone is not enough. The thread that owns a PR is the newest unsettled thread on its head branch.

| event | condition |
| --- | --- |
| `checks.red` | the current-head rollup is FAILURE or ERROR; `failing` lists the jobs, with links |
| `checks.green` | the current-head rollup is SUCCESS, and it is not a vacuous draft |
| `draft.vacuous-green` | a draft is green, but some jobs were skipped, so the checks did not really run |
| `pr.ready` | open, not a draft, green, mergeable, not DIRTY or BEHIND, and no open review thread |
| `pr.conflicts` | `mergeable: CONFLICTING` on the current head |
| `mergeability.unknown` | `mergeable: UNKNOWN` on the same head for 10 minutes or more |
| `review.thread.new` | an open review thread appeared |
| `pr.merged`, `pr.closed` | the PR merged, or closed without merging |
| `pr.no-issue` | a registered thread's PR names no issue in the project |
| `issue.no-pr` | a started issue owns no PR |
| `thread.error` | the latest turn ended in error; `limit` marks usage, rate or capacity limits, so resume the thread after the reset and do not debug it |
| `thread.interrupted` | the latest turn was interrupted |
| `thread.awaiting-input` | the thread has an open question or approval |
| `thread.stalled` | the turn has run with no update for 30 minutes or more, and it is not waiting on a question |
| `thread.dead-ask` | no turn ever started, 5 minutes or more after creation |
| `thread.provider-mismatch` | the session provider differs from the selected one, or a Claude model is on `codex`, or a GPT model is on `claudeAgent` |
| `thread.tracks-main` | the worktree branch tracks `origin/main`; t3code then links the thread to an old merged PR and auto-settles it |
| `thread.untagged` | the title does not start with the effort prefix (or the hawk prefix, for the hawk) |
| `thread.settleable` | an unsettled, idle thread with no background work and no open question: `pr-merged`, `pr-closed`, `reviewer-done`, or `waits-on-human` |
| `owner.reported` | the thread that owns a PR completed a turn |

## Change it

Pure logic lives in `scripts/lib.mjs`. I/O lives in `scripts/hawk.mjs` (the CLI), `scan.mjs`, `watch.mjs` and `t3.mjs` (every `t3cli` call). After any change, run `node --test scripts/*.test.mjs`.

- `scan.test.mjs` has a fixture case for each event type, plus one for a run with no changes.
- `watch.test.mjs` and `hawk.test.mjs` run the CLIs against a fake `t3cli` and `gh`, and a temporary git repo.

When a hawk keeps getting a mechanical step wrong, add a command here instead of another rule above.
